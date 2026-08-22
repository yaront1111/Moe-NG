import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore, StoredEvent } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import {
  FOUNDATION_VERIFICATION_EVENT_TYPES,
} from "../evidence/foundation-verification-contracts.js";
import {
  deriveVerificationAggregateId, readStoredReceipt,
} from "../evidence/foundation-verification-store.js";
import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION,
} from "../journal/journal-contracts.js";
import { runJournalAppendCommand } from "../journal/journal-append.js";
import { readCurrentAttemptJournal } from "../journal/journal-reader.js";
import {
  DECIDED_AT, NODE_KEY, activate, entry, journalBody, plantJournalEvent,
} from "../journal/journal-test-harness.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
  trackHarnessRoot,
} from "../recovery/restore-test-harness.js";
import { PROVIDER_RUN_RECORD_VERSION } from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRecord } from "../telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../telemetry/provider-run-ledger.js";
import {
  DAEMON_ATTEMPT_RELEASE, deriveAttemptReleaseAggregateId, readAttemptRelease,
  recordAttemptRelease,
} from "./attempt-release-disposition.js";
import type {
  AttemptReleaseOutcome, AttemptReleaseRequest,
} from "./attempt-release-disposition.js";
import { applyAttemptResourceReport } from "./attempt-resource-authority.js";
import { recordTerminalEffect } from "./effect-terminal-ledger.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import {
  RELEASE_HANDOFF_BINDING_CODES, RELEASE_HANDOFF_BINDING_EVENT_TYPE,
  RELEASE_HANDOFF_BINDING_RECORD_VERSION, deriveReleaseHandoffAggregateId,
  readReleaseHandoffBinding,
} from "./release-handoff-binding.js";
import type { HandoffBindingOutcome } from "./release-handoff-binding.js";

import type { ProviderFactUnknown, ProviderRunRef } from "@moe/runner";

/**
 * THE TWO DURABLE FACTS A RELEASE OWES `ExpansionReleaseEvidence` — the worker
 * handoff binding and the receipt ref — over a REAL SqliteEventStore, a REAL
 * activation committed by the production ingress, a REAL journal committed by
 * `journal.append`, and the REAL `releaseWork` kernel.
 *
 * NOTHING HERE COMPOSES THE HANDOFF IT ASSERTS. The digest every arm compares
 * against is read back out of the journal the PRODUCTION writer folded, so a
 * binding that merely echoed a value this file wrote would prove nothing. The
 * receipt half keeps the same discipline against `readStoredReceipt`.
 *
 * TWO LAYERS CAN REFUSE THIS PATH — the daemon's release seam and the scheduler
 * kernel — so every refusal arm pins the exact code AND the layer that answered,
 * and every "no binding" arm reads the aggregate rather than trusting a return.
 */

const encoder = new TextEncoder();

afterEach(cleanupRestoreHarnesses);

const blindFact: ProviderFactUnknown = Object.freeze({
  known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT",
});

function runRecord(ref: ProviderRunRef): ProviderRunRecord {
  return {
    concurrency: { achieved: blindFact, declaredCeiling: blindFact, fact: "NO_CONCURRENCY_FACTS" },
    declared: blindFact,
    infrastructure: "NONE",
    launch: {
      activationDigest: null, completedAt: DECIDED_AT, effectDigest: null,
      exit: { code: 0, kind: "EXITED" },
      freshRuntimeDigest: null, kind: "OBSERVED", observationDigest: null,
      pinnedClosureDigest: null, quotedRuntimeDigest: null, reasonCode: null, reasonLayer: null,
      runtimeBindingDigest: null, startedAt: DECIDED_AT, truthClass: "PROVEN",
    },
    observedEnd: null,
    observedModel: { modelId: blindFact, snapshotEvidence: blindFact, snapshotKind: "UNKNOWN" },
    observedStart: { bootId: "boot-1", monotonicObservation: 12, serverWallSeconds: 1_700_000_000 },
    providerRunRef: ref,
    recordDigest: "",
    recordVersion: PROVIDER_RUN_RECORD_VERSION,
    sequence: { known: true, value: 3 },
    steps: { coverage: "UNKNOWN", turns: blindFact },
    stderrReceiptDigest: { known: true, value: "stderr-release" },
    stdoutReceiptDigest: { known: true, value: "stdout-release" },
    terminal: "COMPLETED",
    tokens: {
      cacheCreationInputTokens: blindFact, cacheReadInputTokens: blindFact, coverage: "UNKNOWN",
      inputTokens: blindFact, outputTokens: blindFact,
    },
    upstreamRefusal: null, usage: [], usageRefusals: [],
  };
}

/** The observed run, committed through the PRODUCTION ledger writer with its ref
 *  read out of the durable activation binding rather than hand-guessed. */
function seedProviderRun(store: SqliteEventStore, slug: string): void {
  const binding = readFoundationActivationByAttempt(store, PROJECT_ID, `attempt-${slug}`);
  if (binding.status !== "BOUND") {
    throw new Error(`attempt unbound: ${binding.status}/${binding.code}`);
  }
  const outcome = commitProviderRunRecord(store, {
    correlationId: `corr-run-${slug}`, decidedAt: DECIDED_AT,
    key: {
      commandId: `cmd-run-${slug}`, principalId: binding.ownerSessionRef, projectId: PROJECT_ID,
    },
    record: runRecord({
      attemptRef: binding.attemptId, effectIntentId: binding.effectIntentId, epoch: binding.epoch,
      provider: "claude", runRef: `run-${slug}`,
    }),
    requestBytes: encoder.encode(`provider-run-request-${slug}`),
  });
  if (!outcome.ok) throw new Error(`provider run refused: ${outcome.code} at ${outcome.layer}`);
}

/** Both terminality families, through their own production writers. */
function seedTerminality(store: SqliteEventStore, slug: string, aggregateId: string): void {
  const effect = recordTerminalEffect(store, {
    attemptRef: `attempt-${slug}`, projectId: PROJECT_ID,
  });
  if (!effect.ok) throw new Error(`terminal effect refused: ${effect.code}`);
  const resources = applyAttemptResourceReport(store, {
    activationAggregateId: aggregateId, commandId: `cmd-resources-${slug}`,
    correlationId: `corr-resources-${slug}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  }, { disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: `res-${slug}` });
  if (!resources.ok) throw new Error(`resource report refused: ${resources.code}`);
}

/** The journal, appended through `journal.append` itself: the digest every arm
 *  below compares against is the one the PRODUCTION writer folded and stored. */
function appendJournal(
  store: SqliteEventStore, aggregateId: string, record: ActivationLedgerRecord,
  sessionId: string, slug: string,
): void {
  const bytes = encoder.encode(JSON.stringify({
    commandId: `cmd-journal-${slug}`, correlationId: `corr-journal-${slug}`,
    decidedAt: DECIDED_AT, expectedVersion: 0, kind: JOURNAL_APPEND_COMMAND_KIND,
    payload: {
      attemptAggregateId: aggregateId, effectId: record.effectIntent.intentId,
      entries: [entry(`journal-${slug}`)],
    },
    // The journal seam reads its SESSION out of the envelope principal, so the
    // activation's own owner session is the only value that can bind here.
    principalId: sessionId, projectId: PROJECT_ID,
    schemaVersion: JOURNAL_APPEND_SCHEMA_VERSION,
  }));
  const outcome = runJournalAppendCommand(store, bytes);
  if (!outcome.ok) {
    throw new Error(`journal append refused: ${outcome.code} at ${outcome.refusedBy}`);
  }
}

interface World {
  readonly aggregateId: string;
  readonly bound: FoundationAttemptBound;
  readonly record: ActivationLedgerRecord;
  readonly sessionId: string;
  readonly store: SqliteEventStore;
}

interface WorldOptions {
  /** `false` omits the journal — the release-with-no-handoff-evidence world. */
  readonly journal?: boolean;
}

/** A releasable attempt: activation + dispatch reservation through the production
 *  writers, an observed provider run, both terminality families, and (by default)
 *  one durable journal. */
function world(slug: string, options: WorldOptions = {}): World {
  const root = trackHarnessRoot(mkdtempSync(join(tmpdir(), `moe-handoff-${slug}-`)));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  const attempt = activate(store, slug);
  seedProviderRun(store, slug);
  seedTerminality(store, slug, attempt.aggregateId);
  if (options.journal !== false) {
    appendJournal(store, attempt.aggregateId, attempt.record, attempt.sessionId, slug);
  }
  const history = readFoundationActivationHistory(
    attempt.aggregateId, store.readEvents(attempt.aggregateId), PROJECT_ID);
  if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: attempt.aggregateId, claim: {}, commandId: `cmd-release-${slug}`,
    correlationId: `corr-release-${slug}`, nodeKey: NODE_KEY, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId: attempt.sessionId,
    target: deriveAttemptReleaseAggregateId(attempt.aggregateId),
  });
  return {
    aggregateId: attempt.aggregateId, bound, record: history.history.record,
    sessionId: attempt.sessionId, store,
  };
}

/**
 * The nine-key SCHEDULER handoff the kernel demands before it composes any
 * transition. It is NOT this row's binding: core's two-key `{digest, ref}` is a
 * separate durable fact, and the `journalDigest` here is deliberately a literal
 * that does NOT match the durable journal — so an arm that read the binding out
 * of this relay instead of out of the journal would answer the wrong value.
 */
const HANDOFF = Object.freeze({
  activeProcessResourceFacts: Object.freeze([]),
  artifactDigest: "a".repeat(64), completedSteps: Object.freeze(["step:1"]),
  contextDigest: "a".repeat(64), inputDigest: "a".repeat(64), journalDigest: "a".repeat(64),
  nextSafeAction: "action:resume", truthClass: "DAEMON_VERIFIED", worktreeDigest: "a".repeat(64),
});

const releaseRequest = (
  overrides: Partial<AttemptReleaseRequest> = {},
): AttemptReleaseRequest => ({
  disposition: null, handoff: HANDOFF, intentRefs: ["intent:release"],
  reason: "WORK_RELEASE_OR_PAUSE",
  ...overrides,
});

/** A request carrying a key this row RETIRES, built outside the narrowed type
 *  because the type is exactly what stops an honest caller composing one. */
const withRetiredKey = (key: string, value: unknown): AttemptReleaseRequest =>
  ({ ...releaseRequest(), [key]: value }) as AttemptReleaseRequest;

function release(
  fixture: World, request: AttemptReleaseRequest = releaseRequest(),
): AttemptReleaseOutcome {
  return recordAttemptRelease(fixture.store, fixture.bound, fixture.record, request);
}

/** The digest the PRODUCTION journal writer folded, read back through the
 *  production reader — never a value this suite composed. */
function durableJournalDigest(fixture: World): string {
  const journal = readCurrentAttemptJournal(
    fixture.store, fixture.record.activationDigest, PROJECT_ID);
  if (!journal.ok) throw new Error(`journal unreadable: ${journal.code} at ${journal.layer}`);
  return journal.journalDigest;
}

function bindingOf(fixture: World, projectId: string = PROJECT_ID): HandoffBindingOutcome {
  return readReleaseHandoffBinding(fixture.store, {
    attemptAggregateId: fixture.aggregateId, projectId,
  });
}

function refusalOf(outcome: { ok: boolean }): { code: string; layer: string } {
  const refused = outcome as { code?: string; layer?: string };
  return { code: refused.code ?? "UNEXPECTEDLY_ADMITTED", layer: refused.layer ?? "NO_LAYER" };
}

function releaseRefusalOf(outcome: AttemptReleaseOutcome): { code: string; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, received a recorded row");
  return { code: outcome.code, refusedBy: outcome.refusedBy };
}

/** Binding rows read OUT of the store: "it did not throw the second time" is also
 *  exactly what a double write looks like. */
function bindingRowCount(fixture: World): number {
  return fixture.store
    .readEvents(deriveReleaseHandoffAggregateId(fixture.aggregateId))
    .filter((event) => event.eventType === RELEASE_HANDOFF_BINDING_EVENT_TYPE).length;
}

/**
 * A binding row this suite did not compose through the writer, so the reader's
 * guards are reached by evidence rather than by a stub. A `null` handoff plants
 * bytes that are not a binding at all.
 */
function plantBinding(
  fixture: World, handoff: { digest: string; ref: string } | null,
  options: { duplicate?: boolean } = {},
): void {
  const aggregateId = deriveReleaseHandoffAggregateId(fixture.aggregateId);
  const version = fixture.store.readEvents(aggregateId).length;
  const body = handoff === null
    ? { notABinding: true }
    : {
      attemptAggregateId: fixture.aggregateId, attemptRef: fixture.record.attempt.attemptId,
      derivedAt: DECIDED_AT, handoff, projectId: PROJECT_ID, receipt: null,
      recordVersion: RELEASE_HANDOFF_BINDING_RECORD_VERSION,
      releaseCommandId: `cmd-plant-${version}`,
    };
  const encoded = encodeFoundationPayload(body);
  if (!encoded.ok) throw new Error(`planted binding refused by the codec: ${encoded.code}`);
  const committed = fixture.store.commitExpectedVersionDecision({
    commandKind: "attempt.release", committedResultBytes: encoded.bytes,
    correlationId: `corr-plant-binding-${version}`, decidedAt: DECIDED_AT,
    // TWO events in ONE decision is the only way two rows can share an aggregate
    // sequence — which is exactly the durable ambiguity the reader must refuse.
    events: (options.duplicate === true ? [0, 1] : [0]).map((index) => ({
      eventId: `planted-binding-${fixture.aggregateId.slice(0, 8)}-${version}-${index}`,
      eventType: RELEASE_HANDOFF_BINDING_EVENT_TYPE, payload: encoded.bytes,
    })),
    expectedVersion: version,
    key: {
      commandId: `cmd-plant-binding-${version}`, principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    },
    requestBytes: encoded.bytes,
    targetAggregateId: aggregateId,
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`planting refused: ${committed.decision.effectDisposition}`);
  }
}

/**
 * A durable RECEIPTED row naming an attempt, planted at STORE level and then read
 * back through `readStoredReceipt` — the production reader — so the arm still
 * grades the producer against the store rather than against this literal.
 *
 * DISCLOSED, not hidden: the real verification chain writes its receipt against a
 * PROVEN attempt record, and proving moves the attempt out of the RUNNING state
 * `journal.append` requires — so one world cannot carry both a journal and a
 * chain-produced receipt today. The scan-then-re-read discipline under test is
 * identical either way, and the foreign-receipt arm below plants nothing of this
 * attempt's at all.
 */
function plantReceipt(
  store: SqliteEventStore, attemptAggregateId: string, verificationId: string, sha: string,
): void {
  const encoded = encodeFoundationPayload({
    attemptAggregateId, receipt: { graphIdentity: NODE_KEY, sha256: sha },
    receiptSha256: sha, verdict: "PASSED", verificationId,
  });
  if (!encoded.ok) throw new Error(`receipt fixture refused by the codec: ${encoded.code}`);
  const committed = store.commitExpectedVersionDecision({
    commandKind: "foundation.verify", committedResultBytes: encoded.bytes,
    correlationId: `corr-receipt-${verificationId}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `receipt-${verificationId}`,
      eventType: FOUNDATION_VERIFICATION_EVENT_TYPES.RECEIPTED, payload: encoded.bytes,
    }],
    expectedVersion: 0,
    key: {
      commandId: `cmd-receipt-${verificationId}`, principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    },
    requestBytes: encoded.bytes,
    targetAggregateId: deriveVerificationAggregateId(verificationId),
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`receipt fixture was not committed: ${committed.decision.effectDisposition}`);
  }
}

const RECEIPT_SHA = "e".repeat(64);

describe("release handoff binding — what a released attempt durably records", () => {
  it("binds the handoff to the DURABLE journal, not to the caller's relay", () => {
    const fixture = world("released");
    expect(release(fixture).ok).toBe(true);
    const binding = bindingOf(fixture);
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    // Core's `ExpansionHandoffBinding` is EXACTLY two keys: a third would fail
    // its parser and a missing one would fail `safeRelease`'s value comparison.
    expect(Object.keys(binding.binding.handoff).sort()).toEqual(["digest", "ref"]);
    expect(binding.binding.handoff.digest).toBe(durableJournalDigest(fixture));
    expect(binding.binding.handoff.ref).toBe(fixture.record.activationDigest);
    // THE ANTI-TAUTOLOGY: the caller's relay carries a DIFFERENT journalDigest,
    // so a binding that echoed the request would hold that literal here.
    expect(binding.binding.handoff.digest).not.toBe(HANDOFF.journalDigest);
    expect(binding.binding.attemptRef).toBe(fixture.record.attempt.attemptId);
  });

  it("records the binding on the PRODUCTION path, where the kernel then refuses", () => {
    // `noteRelease` passes a null scheduler handoff on both production call
    // sites, so this is the shape production actually reaches today.
    const fixture = world("production-path");
    const outcome = release(fixture, releaseRequest({ handoff: null }));
    expect(releaseRefusalOf(outcome)).toEqual({
      code: "AUTHORITY_MALFORMED_INPUT", refusedBy: "SCHEDULER_LEASE_DRAIN",
    });
    // The binding is derived BEFORE the kernel is asked, so the fact survives a
    // refused release. An inert binding is a FACT; only a consumer that also
    // sees RELEASED may act on it.
    const binding = bindingOf(fixture);
    expect(binding.ok && binding.binding.handoff.digest).toBe(durableJournalDigest(fixture));
  });

  it("writes NO binding when the attempt journalled nothing, and still releases", () => {
    // ABSENT is the one journal answer that means "nothing was ever written".
    // Refusing on it would make every release depend on `journal.append`, which
    // NO production caller sends today; an empty digest would be manufactured
    // evidence. So the release stands and the evidence simply does not exist.
    const fixture = world("journal-absent", { journal: false });
    expect(release(fixture).ok).toBe(true);
    expect(bindingRowCount(fixture)).toBe(0);
    expect(refusalOf(bindingOf(fixture)).code).toBe("RELEASE_HANDOFF_BINDING_ABSENT");
  });

  it("REFUSES the release when the journal exists but cannot be trusted", () => {
    // Every other journal answer is a durable inconsistency, not an absence, and
    // it refuses under the JOURNAL's own layer rather than this daemon's.
    const fixture = world("journal-unreadable", { journal: false });
    plantJournalEvent(fixture.store, fixture.record.activationDigest, journalBody(
      { aggregateId: fixture.aggregateId, record: fixture.record, sessionId: fixture.sessionId },
      [entry("untrusted")], { journalDigest: "c".repeat(64) }), 0);
    expect(releaseRefusalOf(release(fixture))).toEqual({
      code: "JOURNAL_DIGEST_MISMATCH", refusedBy: "DAEMON_JOURNAL_APPEND",
    });
    // All-or-none: no release row, and no binding either.
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.aggregateId)).code)
      .toBe("ATTEMPT_RELEASE_RECORD_ABSENT");
    expect(bindingRowCount(fixture)).toBe(0);
  });
});

describe("release handoff binding — the digest is recomputed on read", () => {
  it("refuses its OWN digest mismatch when the journal itself is intact", () => {
    const fixture = world("digest-drift");
    expect(release(fixture).ok).toBe(true);
    // A SECOND binding row whose stored digest disagrees with the journal the
    // reader re-derives. The journal is untouched, so the answer must be the
    // binding's own comparison rather than the journal reader's.
    plantBinding(fixture, { digest: "f".repeat(64), ref: fixture.record.activationDigest });
    expect(refusalOf(bindingOf(fixture)).code).toBe("RELEASE_HANDOFF_BINDING_DIGEST_MISMATCH");
  });

  it("carries the JOURNAL reader's own refusal when the journal is the broken one", () => {
    const fixture = world("journal-drift");
    expect(release(fixture).ok).toBe(true);
    // Corrupt the JOURNAL, not the binding: a body whose stored journalDigest
    // disagrees with the entries it carries.
    plantJournalEvent(fixture.store, fixture.record.activationDigest, journalBody(
      { aggregateId: fixture.aggregateId, record: fixture.record, sessionId: fixture.sessionId },
      [entry("drifted")], { journalDigest: "b".repeat(64) }), 1);
    expect(refusalOf(bindingOf(fixture))).toEqual({
      code: "JOURNAL_DIGEST_MISMATCH", layer: "DAEMON_JOURNAL_APPEND",
    });
  });
});

describe("release handoff binding — a caller may not speak either fact", () => {
  const RETIRED_KEYS: readonly string[] = Object.freeze(["receiptRef", "workerHandoff"]);

  it("names every retired key exactly once", () => {
    expect([...RETIRED_KEYS].sort()).toEqual(["receiptRef", "workerHandoff"]);
    expect(new Set(RETIRED_KEYS).size).toBe(RETIRED_KEYS.length);
  });

  for (const key of RETIRED_KEYS) {
    it(`refuses a request carrying ${key}, before any store read`, () => {
      const fixture = world(`retired-${key.toLowerCase()}`);
      const outcome = release(fixture, withRetiredKey(key, { digest: "z", ref: "z" }));
      expect(releaseRefusalOf(outcome)).toEqual({
        code: "ATTEMPT_RELEASE_REQUEST_MALFORMED", refusedBy: DAEMON_ATTEMPT_RELEASE,
      });
      // Refused BEFORE any write: no release row and no binding row.
      expect(bindingRowCount(fixture)).toBe(0);
      expect(refusalOf(readAttemptRelease(fixture.store, fixture.aggregateId)).code)
        .toBe("ATTEMPT_RELEASE_RECORD_ABSENT");
    });
  }

  it("refuses even a caller value that AGREES with the durable answer", () => {
    const fixture = world("retired-agreeing");
    const agreeing = withRetiredKey("workerHandoff", {
      digest: durableJournalDigest(fixture), ref: fixture.record.activationDigest,
    });
    expect(releaseRefusalOf(release(fixture, agreeing)).code)
      .toBe("ATTEMPT_RELEASE_REQUEST_MALFORMED");
    expect(bindingRowCount(fixture)).toBe(0);
  });
});

describe("release handoff binding — every unknown has its own code", () => {
  it("answers ABSENT when no release ever bound this attempt", () => {
    const fixture = world("reader-absent");
    expect(refusalOf(bindingOf(fixture)).code).toBe("RELEASE_HANDOFF_BINDING_ABSENT");
  });

  it("answers AMBIGUOUS when two rows share one aggregate sequence", () => {
    const fixture = world("reader-ambiguous");
    expect(release(fixture).ok).toBe(true);
    plantBinding(fixture, {
      digest: durableJournalDigest(fixture), ref: fixture.record.activationDigest,
    });
    // The rows are REAL store rows; only the sequence of the second is drifted,
    // because the store assigns sequences itself and will not mint a duplicate.
    // Same instrument the journal reader's own ambiguity arm uses.
    const collided = {
      ...fixture,
      store: {
        readEvents: (aggregateId: string): readonly StoredEvent[] => {
          const rows = fixture.store.readEvents(aggregateId);
          const first = rows[0];
          if (first === undefined) return rows;
          return rows.map((event, index) =>
            index === 1 ? { ...event, aggregateSequence: first.aggregateSequence } : event);
        },
        readEventsByTypeAfter: fixture.store.readEventsByTypeAfter.bind(fixture.store),
      } as unknown as SqliteEventStore,
    };
    expect(bindingOf(fixture).ok).toBe(true);
    expect(refusalOf(bindingOf(collided)).code).toBe("RELEASE_HANDOFF_BINDING_AMBIGUOUS");
  });

  it("answers PROJECT_MISMATCH rather than a binding for a foreign project", () => {
    const fixture = world("reader-foreign");
    expect(release(fixture).ok).toBe(true);
    expect(refusalOf(bindingOf(fixture, "project-2")).code)
      .toBe("RELEASE_HANDOFF_BINDING_PROJECT_MISMATCH");
  });

  it("answers UNREADABLE for bytes that are not a binding at all", () => {
    const fixture = world("reader-unreadable");
    plantBinding(fixture, null);
    expect(refusalOf(bindingOf(fixture)).code).toBe("RELEASE_HANDOFF_BINDING_UNREADABLE");
  });

  it("keeps those four answers DISTINCT — zero rows and two rows differ", () => {
    const distinct = [
      "RELEASE_HANDOFF_BINDING_ABSENT", "RELEASE_HANDOFF_BINDING_AMBIGUOUS",
      "RELEASE_HANDOFF_BINDING_PROJECT_MISMATCH", "RELEASE_HANDOFF_BINDING_UNREADABLE",
    ];
    expect(new Set(distinct).size).toBe(4);
    for (const code of distinct) {
      expect(RELEASE_HANDOFF_BINDING_CODES as readonly string[]).toContain(code);
    }
  });
});

describe("release handoff binding — the receipt is a measured fact, never a guess", () => {
  it("records receipt ABSENT when the attempt was never verified", () => {
    const fixture = world("receipt-absent");
    expect(release(fixture).ok).toBe(true);
    const binding = bindingOf(fixture);
    expect(binding.ok && binding.binding.receipt).toBe(null);
    // The handoff still binds: an unverified release is legitimate (WORK_CANCEL).
    expect(binding.ok && binding.binding.handoff.digest).toBe(durableJournalDigest(fixture));
  });

  it("does NOT adopt a receipt that names another attempt", () => {
    const fixture = world("receipt-foreign");
    plantReceipt(fixture.store, `${fixture.aggregateId}-other`, "verify-foreign", RECEIPT_SHA);
    expect(release(fixture).ok).toBe(true);
    const binding = bindingOf(fixture);
    expect(binding.ok && binding.binding.receipt).toBe(null);
  });

  it("binds the receipt through readStoredReceipt, not through the scanned bytes", () => {
    const fixture = world("receipt-bound");
    plantReceipt(fixture.store, fixture.aggregateId, "verify-bound", RECEIPT_SHA);
    expect(release(fixture).ok).toBe(true);
    const stored = readStoredReceipt(fixture.store, "verify-bound");
    if (!stored.ok) throw new Error(`receipt unreadable: ${stored.code}`);
    const binding = bindingOf(fixture);
    expect(binding.ok && binding.binding.receipt).toEqual({
      receiptSha256: stored.row["receiptSha256"], verificationId: "verify-bound",
    });
  });

  it("refuses the release when two receipts name one attempt", () => {
    const fixture = world("receipt-ambiguous");
    plantReceipt(fixture.store, fixture.aggregateId, "verify-one", RECEIPT_SHA);
    plantReceipt(fixture.store, fixture.aggregateId, "verify-two", "d".repeat(64));
    expect(releaseRefusalOf(release(fixture)).code)
      .toBe("RELEASE_HANDOFF_BINDING_RECEIPT_AMBIGUOUS");
    expect(bindingRowCount(fixture)).toBe(0);
  });
});

describe("release handoff binding — replay writes no second truth", () => {
  it("keeps exactly one row when the same release is replayed", () => {
    const fixture = world("replay");
    expect(release(fixture).ok).toBe(true);
    expect(bindingRowCount(fixture)).toBe(1);
    const again = release(fixture);
    expect(again.ok ? again.outcome : refusalOf(again)).toBe("NO_OP");
    expect(bindingRowCount(fixture)).toBe(1);
  });

  it("cannot append a second binding TODAY — the boundary producer refuses first", () => {
    // The aggregate is per-attempt and APPEND-ONLY rather than content-addressed,
    // because a re-release after further work carries a DIFFERENT handoff digest.
    // That path is not reachable yet, and this arm MEASURES the wall rather than
    // asserting a capability: a second release under a new command id is refused
    // by task-ded026d6's boundary producer, one derivation BEFORE this row's.
    const fixture = world("append");
    expect(release(fixture).ok).toBe(true);
    const first = durableJournalDigest(fixture);
    appendJournal(
      fixture.store, fixture.aggregateId, fixture.record, fixture.sessionId, "append-second");
    expect(durableJournalDigest(fixture)).not.toBe(first);
    const reReleased: World = Object.freeze({
      ...fixture,
      bound: Object.freeze({ ...fixture.bound, commandId: "cmd-release-append-2" }),
    });
    expect(releaseRefusalOf(release(reReleased))).toEqual({
      code: "SAFE_BOUNDARY_COMMIT_CONFLICT", refusedBy: "DAEMON_SAFE_BOUNDARY_OBSERVATION",
    });
    // Refused BEFORE this row's derivation runs, so the binding aggregate is
    // untouched — exactly one row, describing the release that happened.
    expect(bindingRowCount(fixture)).toBe(1);
    // AND THE CONSEQUENCE, asserted rather than left to be discovered: the
    // standing row now refuses on READ, because the digest it stored is no
    // longer the digest the journal STREAM re-derives. The binding references a
    // stream, not a frozen event, so a later append is indistinguishable from a
    // tamper. Recorded and routed — binding the journal EVENT instead of the
    // stream needs a reader capability this row does not own.
    expect(refusalOf(bindingOf(fixture)).code)
      .toBe("RELEASE_HANDOFF_BINDING_DIGEST_MISMATCH");
  });
});

describe("release handoff binding — the vocabulary is closed", () => {
  it("publishes a frozen roster with no duplicate member", () => {
    expect(Object.isFrozen(RELEASE_HANDOFF_BINDING_CODES)).toBe(true);
    expect(new Set(RELEASE_HANDOFF_BINDING_CODES).size)
      .toBe(RELEASE_HANDOFF_BINDING_CODES.length);
    expect(RELEASE_HANDOFF_BINDING_CODES.length).toBeGreaterThan(0);
  });
});
