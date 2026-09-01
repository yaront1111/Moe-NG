/**
 * `readCurrentProviderRun` — the decision-verified provider run for one attempt.
 *
 * EVERY CANDIDATE ROW IS COMMITTED BY PRODUCTION `commitProviderRunRecord`, and
 * every activation by production `runEffectActivateCommand`. A hand-built event
 * would make each byte-identity assertion below a statement about the fixture:
 * the reader's whole claim is about what the LEDGER committed, so the ledger has
 * to be what commits it. The four unreachable-by-any-real-sequence cases —
 * corrupt durable bytes, a malformed page, a drifting cursor, a throwing store —
 * are the only instrumented ones, and each delegates every other method to the
 * real store so only the one fact under test is chosen.
 *
 * THE ACCEPTED CONTROL IS LOAD-BEARING. A reader that refuses everything reports
 * every refusal below correctly and proves nothing; the accepted arms are what
 * make the refusal table mean anything.
 *
 * THE READER IS PROVEN READ-ONLY BY MEASUREMENT. Every arm snapshots the raw
 * event count, the raw command-decision count and the horizon, asserts those
 * counts POSITIVE first — an all-zero snapshot compares equal to itself — and
 * asserts the read moved none of them.
 *
 * THREE REFUSAL VOCABULARIES CAN ANSWER HERE and none may swallow another: this
 * reader's `ProviderRunCode` at `PROVIDER_RUN_READER`, the activation binding's
 * own code at `FOUNDATION_ACTIVATION_BINDING_LAYER`, and the store's
 * `DurableStoreErrorCode` preserved verbatim in `storeCode`. Every arm pins the
 * code AND the layer AND the storeCode, because a test asserting only that the
 * call refused would stay green if one family started answering for another.
 *
 * Every store is opened inside its `it` and released by `cleanupRestoreHarnesses`
 * in `afterEach`: a handle held into teardown kills the vitest worker outright.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderFactUnknown, ProviderRunRef } from "@moe/runner";
import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandReceipt,
  CursorPage,
  EffectsCommittedDecision,
  SqliteEventStore,
  StoredEvent,
} from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { ACTIVATION_LEDGER_EVENT_TYPE } from "../activation/activation-ledger-contracts.js";
import { FOUNDATION_ACTIVATION_BINDING_LAYER } from "../activation/foundation-activation-transition.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  cleanupRestoreHarnesses,
  openHarnessStore,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  PROVIDER_RUN_EVENT_TYPE,
  PROVIDER_RUN_RECORD_VERSION,
  deriveProviderRunAggregateId,
} from "./provider-run-contracts.js";
import type { ProviderRunRecord } from "./provider-run-contracts.js";
import { commitProviderRunRecord } from "./provider-run-ledger.js";
import {
  PROVIDER_RUN_READER_PAGE_SIZE,
  readCurrentProviderRun,
} from "./provider-run-reader.js";
import type {
  ProviderRunReadRequest,
  ProviderRunReadResult,
  ProviderRunReadStore,
  ProviderRunReadSuccess,
} from "./provider-run-reader.js";
import { PROVIDER_RUN_LEDGER_LAYERS } from "./provider-run-refusals.js";
import type { ProviderRunRefusal } from "./provider-run-refusals.js";

const encoder = new TextEncoder();
const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
/** Wall SECONDS; the scheduler's overdue rule is `seconds > deadline`. */
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;
const READER = PROVIDER_RUN_LEDGER_LAYERS[3];

interface ActivationSpec {
  readonly attemptId: string;
  readonly epoch: number;
  readonly sessionId: string;
  readonly slug: string;
}

/**
 * The exact `effect.activate` request body the daemon ingress accepts. Nothing
 * here computes a grant, a digest or an aggregate id: the ingress does, which is
 * what makes the committed bytes evidence rather than a fixture agreeing with
 * itself. Copied from the attempt-reader suite, which owns the canonical shape.
 */
function activationBytes(spec: ActivationSpec): Uint8Array {
  const { attemptId, epoch, sessionId, slug } = spec;
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch, kind: "ASSIGNMENT",
    leaseId: `lease-${slug}`, leaseToken: `token-${slug}`, monotonicObservation: 500,
    ownerSessionRef: sessionId, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch, expectedVersion: 7, leaseToken: `token-${slug}`,
    ownerSessionRef: sessionId,
  } as const;
  const claim = {
    claimId: `claim-${slug}`, claimedAt: DECIDED_AT, intentId: `intent-${slug}`,
    lockIdentity: `lock-${slug}`, wrapperIdentity: `wrapper-${slug}`,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${slug}`, correlationId: `corr-${slug}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        attempt: {
          aggregateId: `agg-${slug}`, attemptId, intentId: `intent-${slug}`,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${slug}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${slug}`,
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${slug}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${slug}`, inputBinding: DIGEST, intentId: `intent-${slug}`,
          leaseBinding: lease, predecessorCursor: `cursor-${slug}`,
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: slug, slotRef: `held-${slug}`, state: "RESERVED" }],
      slot: {
        dimension: slug, requestId: `req-${slug}`, slotRef: `slot-${slug}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${slug}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${slug}`, state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/** Commits one activation through production ingress and refuses to guess. */
function activate(store: SqliteEventStore, spec: ActivationSpec): ActivationSpec {
  const outcome = runEffectActivateCommand(store, activationBytes(spec));
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.code}`);
  return spec;
}

/** Every provider fact in the fixture is an honest blind, which is a legal run. */
const blind: ProviderFactUnknown = {
  known: false,
  code: "TELEMETRY_USAGE_ABSENT",
  layer: "TELEMETRY_RESULT",
};

interface RunSpec {
  readonly attemptRef: string;
  readonly effectIntentId: string;
  readonly epoch: number;
  /** The DECISION key's principal. The reader requires it to be the lease's session. */
  readonly principalId: string;
  readonly runRef: string;
  readonly slug: string;
}

const refOf = (spec: RunSpec): ProviderRunRef => ({
  provider: "claude",
  runRef: spec.runRef,
  effectIntentId: spec.effectIntentId,
  attemptRef: spec.attemptRef,
  epoch: spec.epoch,
});

const recordOf = (spec: RunSpec): ProviderRunRecord => ({
  recordVersion: PROVIDER_RUN_RECORD_VERSION,
  providerRunRef: refOf(spec),
  launch: {
    kind: "REFUSED", truthClass: "UNKNOWN", reasonCode: null, reasonLayer: null, exit: null,
    effectDigest: null, activationDigest: null, runtimeBindingDigest: null,
    quotedRuntimeDigest: null, freshRuntimeDigest: null, pinnedClosureDigest: null,
    observationDigest: null, startedAt: null, completedAt: null,
  },
  declared: blind,
  observedModel: { modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind },
  terminal: "UNKNOWN",
  infrastructure: "EXIT_UNOBSERVED",
  tokens: {
    inputTokens: blind, outputTokens: blind, cacheCreationInputTokens: blind,
    cacheReadInputTokens: blind, coverage: "UNKNOWN",
  },
  steps: { turns: blind, coverage: "UNKNOWN" },
  sequence: { known: true, value: 3 },
  concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: blind, achieved: blind },
  observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
  observedEnd: null,
  usage: [],
  usageRefusals: [],
  upstreamRefusal: null,
  // Distinct per run, so the success arm's echo of it cannot come from a neighbour.
  stdoutReceiptDigest: { known: true, value: `stdout-${spec.slug}` },
  stderrReceiptDigest: { known: true, value: `stderr-${spec.slug}` },
  recordDigest: "",
});

interface Committed {
  readonly aggregateId: string;
  readonly digest: string;
  readonly record: ProviderRunRecord;
  readonly spec: RunSpec;
}

/** Commits one provider run through the production ledger and refuses to guess. */
function commitRun(store: SqliteEventStore, spec: RunSpec): Committed {
  const key: CommandDecisionKey = {
    commandId: `cmd-run-${spec.slug}`,
    principalId: spec.principalId,
    projectId: PROJECT_ID,
  };
  const outcome = commitProviderRunRecord(store, {
    correlationId: `corr-run-${spec.slug}`,
    decidedAt: DECIDED_AT,
    key,
    record: recordOf(spec),
    requestBytes: encoder.encode(`provider-run-request-${spec.slug}`),
  });
  if (outcome.ok) {
    return {
      aggregateId: outcome.aggregateId,
      digest: outcome.digest,
      record: outcome.record,
      spec,
    };
  }
  throw new Error(`provider run refused: ${outcome.code} at ${outcome.layer}`);
}

function openStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-run-reader-${label}-`));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

interface Snapshot {
  readonly decisions: number;
  readonly events: number;
  readonly horizon: string;
}

function snapshot(store: SqliteEventStore): Snapshot {
  let events = 0;
  for (let cursor = 0n; ; ) {
    const page = store.readEventsAfter(cursor, 500);
    events += page.items.length;
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  let decisions = 0;
  for (let cursor = 0n; ; ) {
    const page = store.readCommandDecisionsAfter(cursor, 500);
    decisions += page.items.length;
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { decisions, events, horizon: store.readEventHorizon().toString() };
}

/** Positive by assertion, not by hope: an all-zero snapshot compares equal to
 *  itself and would let a WRITING reader pass this suite unnoticed. */
function positiveSnapshot(store: SqliteEventStore): Snapshot {
  const taken = snapshot(store);
  expect(taken.events).toBeGreaterThan(0);
  expect(taken.decisions).toBeGreaterThan(0);
  expect(BigInt(taken.horizon)).toBeGreaterThan(0n);
  return taken;
}

function accepted(result: ProviderRunReadResult): ProviderRunReadSuccess {
  if ("ok" in result && result.ok) return result;
  const described = "ok" in result ? `${result.code} at ${result.layer}` : result.status;
  throw new Error(`expected an accepted read, got ${described}`);
}

/** Narrows to THIS family's refusal, so an activation refusal cannot answer for it. */
function refusedHere(result: ProviderRunReadResult): ProviderRunRefusal {
  if (!("ok" in result)) throw new Error(`expected a reader refusal, got ${result.status}`);
  if (result.ok) throw new Error("expected a refusal, but the reader accepted the read");
  return result;
}

/**
 * A CRASH IS NOT A REFUSAL. Calling through this and asserting the recorded
 * throw is null states that explicitly, rather than leaving it to a test that
 * merely happens to fail with a stack trace instead of an assertion.
 */
function readWithoutThrowing(
  store: ProviderRunReadStore, request: ProviderRunReadRequest,
): ProviderRunReadResult {
  let thrown: unknown = null;
  let result: ProviderRunReadResult | null = null;
  try {
    result = readCurrentProviderRun(store, request);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeNull();
  if (result === null) throw new Error("the reader threw where it had to refuse");
  return result;
}

/** All six readers delegated to the real store; each case overrides exactly one. */
function delegate(store: SqliteEventStore): ProviderRunReadStore {
  return {
    getCommandDecision: (key) => store.getCommandDecision(key),
    getCommandReceipt: (commandId) => store.getCommandReceipt(commandId),
    getHealth: () => store.getHealth(),
    readEventHorizon: () => store.readEventHorizon(),
    readEvents: (aggregateId) => store.readEvents(aggregateId),
    readEventsByTypeAfter: (eventType, after, limit) =>
      store.readEventsByTypeAfter(eventType, after, limit),
  };
}

/**
 * Rewrites ONLY the provider-run pages. The activation join underneath pages the
 * activation event type through the same method, so a blanket override would
 * starve it and the case would refuse for a reason it never meant to test.
 */
function withRunPages(
  store: SqliteEventStore,
  rewrite: (page: CursorPage<StoredEvent, bigint>) => unknown,
): ProviderRunReadStore {
  const port = delegate(store);
  return {
    ...port,
    readEventsByTypeAfter: (eventType, after, limit) => {
      const page = store.readEventsByTypeAfter(eventType, after, limit);
      if (eventType !== PROVIDER_RUN_EVENT_TYPE) return page;
      return rewrite(page) as CursorPage<StoredEvent, bigint>;
    },
  };
}

/** One provider-run row rewritten in place, everything else real. */
function withRunEvents(
  store: SqliteEventStore,
  rewrite: (event: StoredEvent) => StoredEvent,
): ProviderRunReadStore {
  return withRunPages(store, (page) => ({ ...page, items: page.items.map(rewrite) }));
}

const ATTEMPT = "attempt-target";
const SESSION = "session-owner";
const EPOCH = 41;

/** The activation and the run that agree on attempt, effect, epoch and session. */
function seedBoundPair(store: SqliteEventStore): Committed {
  activate(store, { attemptId: ATTEMPT, epoch: EPOCH, sessionId: SESSION, slug: "target" });
  return commitRun(store, {
    attemptRef: ATTEMPT, effectIntentId: "intent-target", epoch: EPOCH,
    principalId: SESSION, runRef: "run-target", slug: "target",
  });
}

/** Foreign committed runs for OTHER attempts, enough to force `count / PAGE_SIZE` pages. */
function seedForeignRuns(store: SqliteEventStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    commitRun(store, {
      attemptRef: `attempt-foreign-${String(index)}`,
      effectIntentId: `intent-foreign-${String(index)}`,
      epoch: index + 1,
      principalId: `session-foreign-${String(index)}`,
      runRef: `run-foreign-${String(index)}`,
      slug: `foreign-${String(index)}`,
    });
  }
}

afterEach(cleanupRestoreHarnesses);

describe("readCurrentProviderRun accepts a decision-verified run", () => {
  it("returns the durable record, the lease session, both digests and the horizon", () => {
    const store = openStore("bound");
    const target = seedBoundPair(store);
    const before = positiveSnapshot(store);

    const result = accepted(readCurrentProviderRun(store, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result.record).toStrictEqual(target.record);
    expect(result.recordDigest).toBe(target.digest);
    expect(result.record.recordDigest).toBe(target.digest);
    // The session is the DURABLE lease's, and the fixture keeps it distinct from
    // the ingress principal so the two can never be confused for one another.
    expect(result.sessionId).toBe(SESSION);
    expect(SESSION).not.toBe(PRINCIPAL_ID);
    expect(result.stdoutReceiptDigest).toStrictEqual({ known: true, value: "stdout-target" });
    expect(result.horizon).toBe(store.readEventHorizon());
    expect(Object.keys(result).sort()).toEqual([
      "horizon", "ok", "record", "recordDigest", "sessionId", "stdoutReceiptDigest",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.providerRunRef)).toBe(true);
    expect(Object.isFrozen(result.stdoutReceiptDigest)).toBe(true);
    expect(snapshot(store)).toEqual(before);
  });

  it("pages past more than one page of foreign runs to reach the match", () => {
    const store = openStore("paged");
    // Strictly more than one page of OTHER attempts ahead of the match, so a
    // reader that read a single batch would answer ABSENT here.
    seedForeignRuns(store, PROVIDER_RUN_READER_PAGE_SIZE + 5);
    const target = seedBoundPair(store);
    const before = positiveSnapshot(store);

    const result = accepted(readCurrentProviderRun(store, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result.record.providerRunRef).toStrictEqual(target.record.providerRunRef);
    expect(result.recordDigest).toBe(target.digest);
    expect(result.sessionId).toBe(SESSION);
    // The scan really did span pages: the foreign rows are on the ledger, and the
    // reserved-type row count exceeds one page.
    const first = store.readEventsByTypeAfter(
      PROVIDER_RUN_EVENT_TYPE, 0n, PROVIDER_RUN_READER_PAGE_SIZE);
    expect(first.items).toHaveLength(PROVIDER_RUN_READER_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(snapshot(store)).toEqual(before);
  });
});

describe("readCurrentProviderRun refuses on candidate count", () => {
  it("answers EVIDENCE_ABSENT when no committed run names the attempt", () => {
    const store = openStore("absent");
    activate(store, { attemptId: ATTEMPT, epoch: EPOCH, sessionId: SESSION, slug: "target" });
    seedForeignRuns(store, 3);
    const before = positiveSnapshot(store);

    const result = refusedHere(readCurrentProviderRun(store, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_ABSENT",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it("answers EVIDENCE_AMBIGUOUS for a duplicate that lands after a page boundary", () => {
    const store = openStore("ambiguous");
    const target = seedBoundPair(store);
    // The duplicate is placed BEYOND the first page on purpose: a reader that
    // returns on its first match passes every other case in this file, and only
    // a second match on a LATER page can tell the two apart.
    seedForeignRuns(store, PROVIDER_RUN_READER_PAGE_SIZE);
    const duplicate = commitRun(store, {
      attemptRef: ATTEMPT, effectIntentId: "intent-target", epoch: EPOCH,
      principalId: SESSION, runRef: "run-target-duplicate", slug: "target-duplicate",
    });
    expect(duplicate.aggregateId).not.toBe(target.aggregateId);
    const before = positiveSnapshot(store);
    const firstPage = store.readEventsByTypeAfter(
      PROVIDER_RUN_EVENT_TYPE, 0n, PROVIDER_RUN_READER_PAGE_SIZE);
    expect(firstPage.hasMore).toBe(true);
    const onFirstPage = firstPage.items.some(
      (event) => event.aggregateId === duplicate.aggregateId);
    expect(onFirstPage).toBe(false);

    const result = refusedHere(readCurrentProviderRun(store, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_AMBIGUOUS",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });
});

describe("readCurrentProviderRun refuses a malformed query or project", () => {
  it.each([
    ["an empty attemptRef", { attemptRef: "", projectId: PROJECT_ID }],
    ["an empty projectId", { attemptRef: ATTEMPT, projectId: "" }],
    ["a lone surrogate", { attemptRef: "\uD800", projectId: PROJECT_ID }],
  ])("answers EVIDENCE_MALFORMED for %s", (_label, request) => {
    const store = openStore("query");
    seedBoundPair(store);
    const before = positiveSnapshot(store);

    const result = refusedHere(readCurrentProviderRun(store, request));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_MALFORMED",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it("answers BINDING_MISMATCH for a foreign project, before reading any page", () => {
    const store = openStore("foreign-project");
    seedBoundPair(store);
    const before = positiveSnapshot(store);
    // Every pager throws. A BINDING_MISMATCH here therefore proves the project
    // gate answered FIRST and nothing was scanned; had the scan run, the store's
    // own code would have arrived as EVIDENCE_UNREADABLE instead. This is the
    // observable that keeps the foreign-project arm distinct from the
    // foreign-session arm below, which shares the code but not the layer order.
    const port: ProviderRunReadStore = {
      ...delegate(store),
      readEventsByTypeAfter: () => {
        throw new DurableStoreError("STORE_UNAVAILABLE", "no pager for a foreign project");
      },
    };

    const result = refusedHere(readCurrentProviderRun(port, {
      attemptRef: ATTEMPT, projectId: "project-elsewhere",
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_BINDING_MISMATCH",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it("answers BINDING_MISMATCH when the committing principal is not the lease session", () => {
    const store = openStore("foreign-session");
    activate(store, { attemptId: ATTEMPT, epoch: EPOCH, sessionId: SESSION, slug: "target" });
    // Committed by a session that never held the lease. Everything else agrees:
    // attempt, effect and epoch all match, so only the principal join can refuse.
    commitRun(store, {
      attemptRef: ATTEMPT, effectIntentId: "intent-target", epoch: EPOCH,
      principalId: "session-intruder", runRef: "run-target", slug: "target",
    });
    const before = positiveSnapshot(store);

    const result = refusedHere(readCurrentProviderRun(store, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_BINDING_MISMATCH",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });
});

describe("readCurrentProviderRun preserves the activation binding's own refusal", () => {
  it("returns FOUNDATION_BINDING_NOT_FOUND with its own layer when no activation exists", () => {
    const store = openStore("no-activation");
    // A committed, fully decision-verified run whose attempt was never activated.
    commitRun(store, {
      attemptRef: ATTEMPT, effectIntentId: "intent-target", epoch: EPOCH,
      principalId: SESSION, runRef: "run-target", slug: "target",
    });
    const before = positiveSnapshot(store);

    const result = readCurrentProviderRun(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });

    // Its OWN vocabulary and layer, not restamped into this family's codes: an
    // absent activation and an unreadable store must stay distinguishable.
    expect(result).toStrictEqual({
      code: "FOUNDATION_BINDING_NOT_FOUND",
      layer: FOUNDATION_ACTIVATION_BINDING_LAYER,
      status: "ABSENT",
    });
    expect("ok" in result).toBe(false);
    expect(snapshot(store)).toEqual(before);
  });

  it("preserves the activation binding's mandatory storeCode when its scan throws", () => {
    const store = openStore("activation-unreadable");
    seedBoundPair(store);
    const before = positiveSnapshot(store);
    // Only the ACTIVATION pager throws; the provider-run scan runs for real, so
    // the candidate is found and verified and the join is what fails.
    const port: ProviderRunReadStore = {
      ...delegate(store),
      readEventsByTypeAfter: (eventType, after, limit) => {
        if (eventType === ACTIVATION_LEDGER_EVENT_TYPE) {
          throw new DurableStoreError("STORE_UNAVAILABLE", "activation pager is down");
        }
        return store.readEventsByTypeAfter(eventType, after, limit);
      },
    };

    const result = readCurrentProviderRun(port, { attemptRef: ATTEMPT, projectId: PROJECT_ID });

    expect(result).toStrictEqual({
      code: "FOUNDATION_BINDING_EVIDENCE_UNREADABLE",
      layer: FOUNDATION_ACTIVATION_BINDING_LAYER,
      status: "UNKNOWN",
      storeCode: "STORE_UNAVAILABLE",
    });
    expect(snapshot(store)).toEqual(before);
  });
});

describe("readCurrentProviderRun refuses unreadable bytes, pages and stores", () => {
  it("answers RECORD_UNREADABLE for corrupt canonical bytes on the reserved row", () => {
    const store = openStore("corrupt");
    const target = seedBoundPair(store);
    const before = positiveSnapshot(store);
    const port = withRunEvents(store, (event) => {
      if (event.aggregateId !== target.aggregateId) return event;
      const payload = Uint8Array.from(event.payload);
      // One flipped byte inside the sealed body: the frame still parses, the
      // canonical bytes no longer hash to the digest they carry.
      const at = payload.length - 40;
      payload[at] = (payload[at] ?? 0) ^ 0xff;
      return { ...event, payload };
    });

    const result = refusedHere(readCurrentProviderRun(port, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_RECORD_UNREADABLE",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it.each([
    ["hasMore is not a boolean", (page: CursorPage<StoredEvent, bigint>) =>
      ({ ...page, hasMore: "yes" })],
    ["items is not an array", (page: CursorPage<StoredEvent, bigint>) =>
      ({ ...page, items: { length: 1 } })],
    ["nextCursor is not a bigint", (page: CursorPage<StoredEvent, bigint>) =>
      ({ ...page, nextCursor: 12 })],
    ["the page is not an object", () => null],
    ["items overflow the requested limit", (page: CursorPage<StoredEvent, bigint>) => ({
      ...page,
      items: Array.from(
        { length: PROVIDER_RUN_READER_PAGE_SIZE + 1 },
        (_unused, index) => ({ ...(page.items[0] as StoredEvent), globalPosition: BigInt(index + 1) }),
      ),
    })],
    ["a row carries a foreign event type", (page: CursorPage<StoredEvent, bigint>) => ({
      ...page,
      items: page.items.map((event) => ({ ...event, eventType: "SomethingElseHappened" })),
    })],
    ["a row's globalPosition is not a bigint", (page: CursorPage<StoredEvent, bigint>) => ({
      ...page,
      items: page.items.map((event) => ({ ...event, globalPosition: 1 })),
    })],
    // `[null]` satisfies `Array.isArray`, so without a per-ROW shape check the
    // first field read throws and the reader crashes where it must refuse.
    ["a row is not an object at all", (page: CursorPage<StoredEvent, bigint>) =>
      ({ ...page, items: [null] })],
    ["a row is a primitive", (page: CursorPage<StoredEvent, bigint>) =>
      ({ ...page, items: ["not-an-event"] })],
  ])("answers EVIDENCE_MALFORMED when %s", (_label, rewrite) => {
    const store = openStore("malformed-page");
    seedBoundPair(store);
    const before = positiveSnapshot(store);

    const result = refusedHere(readWithoutThrowing(withRunPages(store, rewrite), {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_MALFORMED",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it("answers EVIDENCE_UNREADABLE for a row beyond the captured horizon", () => {
    const store = openStore("past-horizon");
    seedBoundPair(store);
    const before = positiveSnapshot(store);
    // A row the pager serves from BEYOND the horizon the scan captured is the
    // ledger having grown under it — the same fact the settling re-read refuses
    // on, so it must carry the same code. Calling it MALFORMED would tell an
    // operator the bytes were bad when the pager in fact answered correctly.
    const port = withRunPages(store, (page) => ({
      ...page,
      items: page.items.map((event) => ({ ...event, globalPosition: 1_000_000n })),
      nextCursor: 1_000_000n,
    }));

    const result = refusedHere(readWithoutThrowing(port, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_UNREADABLE",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it("answers EVIDENCE_MALFORMED when a reserved row carries no decision trace", () => {
    const store = openStore("no-trace");
    const target = seedBoundPair(store);
    const before = positiveSnapshot(store);
    // Evidence that never ARRIVED, not evidence that disagrees: without the trace
    // there is no command to key the decision by, so this cannot be a mismatch.
    // The key is DELETED, not set to undefined: `exactOptionalPropertyTypes`
    // makes those two different shapes, and only the deletion is what a store
    // that never wrote a trace would actually hand back.
    const port = withRunEvents(store, (event) => {
      if (event.aggregateId !== target.aggregateId) return event;
      const { decisionTrace: _absent, ...withoutTrace } = event;
      return withoutTrace;
    });

    const result = refusedHere(readWithoutThrowing(port, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_MALFORMED",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it("answers EVIDENCE_UNREADABLE with a null storeCode when a non-store error escapes", () => {
    const store = openStore("foreign-throw");
    seedBoundPair(store);
    const before = positiveSnapshot(store);
    const port: ProviderRunReadStore = {
      ...delegate(store),
      readEventsByTypeAfter: (eventType, after, limit) => {
        if (eventType !== PROVIDER_RUN_EVENT_TYPE) {
          return store.readEventsByTypeAfter(eventType, after, limit);
        }
        throw new TypeError("something that is not a DurableStoreError");
      },
    };

    const result = refusedHere(readWithoutThrowing(port, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    // No store code exists to carry, so none is invented. A restamped code here
    // would send an operator hunting a store fault that never happened.
    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_UNREADABLE",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it("answers EVIDENCE_MALFORMED for a cursor that does not advance", () => {
    const store = openStore("cursor-drift");
    seedBoundPair(store);
    const before = positiveSnapshot(store);
    // A pager claiming more while handing back a cursor that never moves is how a
    // scan silently loops forever or, worse, re-counts one row as a duplicate.
    const port = withRunPages(store, (page) => ({ ...page, hasMore: true, nextCursor: 0n }));

    const result = refusedHere(readCurrentProviderRun(port, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_MALFORMED",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it("answers EVIDENCE_UNREADABLE with the store's own code when a page read throws", () => {
    const store = openStore("throwing-pager");
    seedBoundPair(store);
    const before = positiveSnapshot(store);
    const port: ProviderRunReadStore = {
      ...delegate(store),
      readEventsByTypeAfter: (eventType, after, limit) => {
        if (eventType !== PROVIDER_RUN_EVENT_TYPE) {
          return store.readEventsByTypeAfter(eventType, after, limit);
        }
        throw new DurableStoreError("STORE_UNAVAILABLE", "the pager is down");
      },
    };

    const result = refusedHere(readCurrentProviderRun(port, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    // The store's own code rides VERBATIM. Flattening it would tell an operator
    // to hunt corruption in a page that was never read.
    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_UNREADABLE",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: "STORE_UNAVAILABLE",
    });
    expect(snapshot(store)).toEqual(before);
  });

  it.each([
    ["the decision is absent", (port: ProviderRunReadStore): ProviderRunReadStore =>
      ({ ...port, getCommandDecision: () => null })],
    ["the receipt is absent", (port: ProviderRunReadStore): ProviderRunReadStore =>
      ({ ...port, getCommandReceipt: () => null })],
  ])("answers EVIDENCE_UNREADABLE with a null storeCode when %s", (_label, wrap) => {
    const store = openStore("absent-evidence");
    seedBoundPair(store);
    const before = positiveSnapshot(store);

    const result = refusedHere(readCurrentProviderRun(wrap(delegate(store)), {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    // Nothing threw, so there is no upstream code to carry and inventing one
    // would be a fabricated provenance.
    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_UNREADABLE",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

  it.each([
    ["the decision read throws", (store: SqliteEventStore): ProviderRunReadStore => ({
      ...delegate(store),
      getCommandDecision: () => {
        throw new DurableStoreError("STORE_BUSY", "decision read is contended");
      },
    })],
    ["the receipt read throws", (store: SqliteEventStore): ProviderRunReadStore => ({
      ...delegate(store),
      getCommandReceipt: () => {
        throw new DurableStoreError("STORE_BUSY", "receipt read is contended");
      },
    })],
    ["the horizon read throws", (store: SqliteEventStore): ProviderRunReadStore => ({
      ...delegate(store),
      readEventHorizon: () => {
        throw new DurableStoreError("STORE_BUSY", "horizon read is contended");
      },
    })],
  ])("answers EVIDENCE_UNREADABLE carrying STORE_BUSY when %s", (_label, build) => {
    const store = openStore("throwing-evidence");
    seedBoundPair(store);
    const before = positiveSnapshot(store);

    const result = refusedHere(readCurrentProviderRun(build(store), {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_UNREADABLE",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: "STORE_BUSY",
    });
    expect(snapshot(store)).toEqual(before);
  });

  it("answers EVIDENCE_UNREADABLE when the horizon moves under the scan", () => {
    const store = openStore("horizon-race");
    seedBoundPair(store);
    const before = positiveSnapshot(store);
    // The SECOND horizon read reports a ledger that grew. A scan judged against a
    // horizon that no longer exists cannot claim uniqueness, so there is no
    // partial answer to hand back.
    let reads = 0;
    const port: ProviderRunReadStore = {
      ...delegate(store),
      readEventHorizon: () => {
        reads += 1;
        return reads === 1 ? store.readEventHorizon() : store.readEventHorizon() + 5n;
      },
    };

    const result = refusedHere(readCurrentProviderRun(port, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(reads).toBeGreaterThan(1);
    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_UNREADABLE",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });

});

/* -------------------------------------------------------------------------
 * Termination comes from the captured horizon, not from page/candidate caps.
 * ----------------------------------------------------------------------- */

/**
 * THE NUMBERS ARE WRITTEN OUT ON PURPOSE, exactly as the launch-authority suite
 * pins the activation twin: the scan used to stop after 64 pages or 6,400
 * candidates and refuse EVIDENCE_UNREADABLE forever after — a cap on TOTAL
 * COMMITTED RUNS, not on anything about the queried attempt, so one busy
 * append-only ledger bricked every run lookup at once. Deriving these from
 * surviving constants would make the proof move with the bound it exists to
 * bury.
 */
const OLD_SCAN_CEILING = 6_400;
const CANDIDATES_PAST_THE_OLD_CEILING = 6_500;
const OLD_PAGE_CEILING = 64;

describe("readCurrentProviderRun is bounded by the horizon alone", () => {
  // The default 5s budget is not enough, and that is the point: clearing the
  // retired ceiling means more than 6,400 real rows are decoded and each one's
  // decision and receipt are read from a file-backed store. The wall clock is
  // evidence the horizon was walked rather than short-circuited.
  it("still answers a run that sits past the retired 6,400-candidate ceiling", () => {
    const store = openStore("past-ceiling");
    const target = seedBoundPair(store);
    seedForeignRuns(store, 2);
    const before = positiveSnapshot(store);
    const targetEvent = store.readEvents(target.aggregateId)[0];
    if (targetEvent === undefined) throw new Error("the target run committed no event");
    // Real committed FOREIGN rows re-paged across the first 6,500 positions,
    // then the ONE real target row: the ledger of a project whose run count
    // outgrew the retired caps, where every lookup used to refuse
    // EVIDENCE_UNREADABLE forever. Every row verifies and only the last one
    // matches, so nothing but the horizon decides how far the walk reaches.
    const foreign = store.readEventsByTypeAfter(PROVIDER_RUN_EVENT_TYPE, 0n, 100).items
      .filter((event) => event.aggregateId !== target.aggregateId);
    expect(foreign.length).toBeGreaterThan(0);
    const horizon = BigInt(CANDIDATES_PAST_THE_OLD_CEILING + 1);
    let served = 0;
    const port: ProviderRunReadStore = {
      ...delegate(store),
      readEventHorizon: () => horizon,
      readEventsByTypeAfter: (eventType, after, limit) => {
        if (eventType !== PROVIDER_RUN_EVENT_TYPE) {
          return store.readEventsByTypeAfter(eventType, after, limit);
        }
        if (after >= BigInt(CANDIDATES_PAST_THE_OLD_CEILING)) {
          served += 1;
          return {
            hasMore: false,
            items: [{ ...targetEvent, globalPosition: horizon }],
            nextCursor: horizon,
          };
        }
        const items = Array.from(
          { length: PROVIDER_RUN_READER_PAGE_SIZE },
          (_unused, index) => ({
            ...(foreign[index % foreign.length] as StoredEvent),
            globalPosition: after + BigInt(index + 1),
          }),
        );
        served += items.length;
        return {
          hasMore: true,
          items,
          nextCursor: after + BigInt(PROVIDER_RUN_READER_PAGE_SIZE),
        };
      },
    };

    const result = accepted(readWithoutThrowing(port, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(served).toBeGreaterThan(OLD_SCAN_CEILING);
    expect(result.record.providerRunRef).toStrictEqual(target.record.providerRunRef);
    expect(result.recordDigest).toBe(target.digest);
    expect(result.sessionId).toBe(SESSION);
    expect(result.horizon).toBe(horizon);
    expect(snapshot(store)).toEqual(before);
  }, 180_000);

  it("ends a pager that never stops claiming more at the horizon, not a page count", () => {
    const store = openStore("endless-pager");
    const target = seedBoundPair(store);
    seedForeignRuns(store, 1);
    const before = positiveSnapshot(store);
    // ONE real foreign row per page, forever: past the retired 64-page ceiling
    // the pager still claims more with a strictly advancing cursor, so nothing
    // but the captured horizon can end this walk. 200 single-row pages against
    // a horizon of 200 is the whole assertion, and the answer is the honest
    // ABSENT for a never-committed attempt rather than a refusal at a cap.
    const foreign = store.readEventsByTypeAfter(PROVIDER_RUN_EVENT_TYPE, 0n, 100).items
      .filter((event) => event.aggregateId !== target.aggregateId);
    expect(foreign.length).toBeGreaterThan(0);
    let served = 0;
    const port: ProviderRunReadStore = {
      ...delegate(store),
      readEventHorizon: () => 200n,
      readEventsByTypeAfter: (eventType, after, limit) => {
        if (eventType !== PROVIDER_RUN_EVENT_TYPE) {
          return store.readEventsByTypeAfter(eventType, after, limit);
        }
        served += 1;
        return {
          hasMore: true,
          items: [{ ...(foreign[0] as StoredEvent), globalPosition: after + 1n }],
          nextCursor: after + 1n,
        };
      },
    };

    const result = refusedHere(readWithoutThrowing(port, {
      attemptRef: "attempt-never-committed", projectId: PROJECT_ID,
    }));

    expect(served).toBe(200);
    expect(served).toBeGreaterThan(OLD_PAGE_CEILING);
    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_ABSENT",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  }, 60_000);
});

interface MutationCase {
  readonly name: string;
  readonly port: (store: SqliteEventStore, target: Committed) => ProviderRunReadStore;
}

/** One committed decision, re-shaped by a single field. */
function withDecision(
  store: SqliteEventStore,
  mutate: (decision: EffectsCommittedDecision) => CommandDecisionRecord,
): ProviderRunReadStore {
  return {
    ...delegate(store),
    getCommandDecision: (key) => {
      const decision = store.getCommandDecision(key);
      if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED") return decision;
      return mutate(decision);
    },
  };
}

/** One committed receipt, re-shaped by a single field. */
function withReceipt(
  store: SqliteEventStore,
  mutate: (receipt: CommandReceipt) => CommandReceipt,
): ProviderRunReadStore {
  return {
    ...delegate(store),
    getCommandReceipt: (commandId) => {
      const receipt = store.getCommandReceipt(commandId);
      return receipt === null ? null : mutate(receipt);
    },
  };
}

/**
 * A row whose event, decision and receipt are rewritten TOGETHER, so the forged
 * value agrees with itself everywhere it is stored.
 *
 * This is the only fixture shape that can reach the identity derivations. Drift
 * one stored id alone and a downstream cross-check answers first — a lone
 * `event.aggregateId` is caught by the receipt's own `aggregateId` comparison,
 * so the derivation over the DECODED ref is never what refuses and a drill
 * against it would survive while proving nothing.
 */
function withForgedRow(
  store: SqliteEventStore, target: Committed,
  rewrite: {
    readonly decision: (decision: EffectsCommittedDecision) => CommandDecisionRecord;
    readonly event: (event: StoredEvent) => StoredEvent;
    readonly receipt: (receipt: CommandReceipt) => CommandReceipt;
  },
): ProviderRunReadStore {
  const mine = (id: string): boolean => id === target.aggregateId;
  return {
    ...withRunEvents(store, (event) => (mine(event.aggregateId) ? rewrite.event(event) : event)),
    getCommandDecision: (key) => {
      const decision = store.getCommandDecision(key);
      if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED") return decision;
      return mine(decision.targetAggregateId) ? rewrite.decision(decision) : decision;
    },
    getCommandReceipt: (commandId) => {
      const receipt = store.getCommandReceipt(commandId);
      if (receipt === null) return null;
      return mine(receipt.aggregateId) ? rewrite.receipt(receipt) : receipt;
    },
  };
}

const FORGED_AGGREGATE = "moe-provider-run-record/1|aggregate|sha256:" + "c".repeat(64);
const FORGED_EVENT = "moe-provider-run-record/1|event|sha256:" + "d".repeat(64);

/**
 * Every binding DoD item 2 enumerates, mutated one at a time on the REAL
 * committed evidence. Each must refuse with the exact BINDING_MISMATCH code — a
 * crash is not a refusal, and a reader that threw here would take the daemon
 * down on evidence it was built to decline.
 */
const MUTATIONS: readonly MutationCase[] = Object.freeze([
  {
    name: "the aggregate id no longer matches the one derived from the decoded ref",
    port: (store, target) => withRunEvents(store, (event) =>
      event.aggregateId === target.aggregateId
        ? { ...event, aggregateId: `${event.aggregateId}-drifted` }
        : event),
  },
  {
    name: "the event id no longer matches the one derived from the decoded ref",
    port: (store, target) => withRunEvents(store, (event) =>
      event.aggregateId === target.aggregateId
        ? { ...event, eventId: `${event.eventId}-drifted` }
        : event),
  },
  {
    name: "the aggregate sequence is not the ledger's first",
    port: (store, target) => withRunEvents(store, (event) =>
      event.aggregateId === target.aggregateId ? { ...event, aggregateSequence: 2 } : event),
  },
  {
    name: "the decision trace names a foreign project",
    port: (store, target) => withRunEvents(store, (event) =>
      event.aggregateId === target.aggregateId && event.decisionTrace !== undefined
        ? { ...event, decisionTrace: { ...event.decisionTrace, projectId: "project-elsewhere" } }
        : event),
  },
  {
    name: "the decision trace names a foreign command kind",
    port: (store, target) => withRunEvents(store, (event) =>
      event.aggregateId === target.aggregateId && event.decisionTrace !== undefined
        ? { ...event, decisionTrace: { ...event.decisionTrace, commandKind: "some.other.command" } }
        : event),
  },
  {
    name: "the decision trace's request digest disagrees with the decision's",
    port: (store, target) => withRunEvents(store, (event) =>
      event.aggregateId === target.aggregateId && event.decisionTrace !== undefined
        ? { ...event, decisionTrace: { ...event.decisionTrace, requestSha256: "f".repeat(64) } }
        : event),
  },
  {
    name: "the decision reports a command kind that is not the exported provider-run kind",
    port: (store) => withDecision(store, (decision) =>
      ({ ...decision, commandKind: "some.other.command" })),
  },
  {
    name: "the decision committed no business effect",
    port: (store) => withDecision(store, (decision) => ({
      ...decision,
      auditEventId: "audit-1",
      businessEventIds: [] as const,
      currentVersion: null,
      effectDisposition: "NO_BUSINESS_EFFECT" as const,
      outboxMessageIds: [] as const,
      previousVersion: null,
      replayRequestSha256: null,
      resultCode: "EXPECTED_VERSION_CONFLICT" as const,
    })),
  },
  {
    name: "the decision did not move the aggregate from version 0 to version 1",
    port: (store) => withDecision(store, (decision) =>
      ({ ...decision, currentVersion: 2, previousVersion: 1 })),
  },
  {
    name: "the decision names no business event",
    port: (store) => withDecision(store, (decision) => ({ ...decision, businessEventIds: [] })),
  },
  {
    name: "the decision names a foreign business event",
    port: (store) => withDecision(store, (decision) =>
      ({ ...decision, businessEventIds: ["event-elsewhere"] })),
  },
  {
    name: "the decision enqueued an outbox message",
    port: (store) => withDecision(store, (decision) =>
      ({ ...decision, outboxMessageIds: ["outbox-1"] })),
  },
  {
    name: "the decision's result bytes are not the committed payload",
    port: (store) => withDecision(store, (decision) =>
      ({ ...decision, resultBytes: new Uint8Array([1, 2, 3]) })),
  },
  {
    // A contract-breaking store, not a disagreeing one. Without the production
    // comparison's `instanceof Uint8Array` pair this reaches `.every` on a value
    // that has no such method and CRASHES where the reader must refuse.
    name: "the decision's result bytes are not binary at all",
    port: (store) => withDecision(store, (decision) =>
      ({ ...decision, resultBytes: "not-bytes" as unknown as Uint8Array })),
  },
  {
    name: "the decision targets a foreign aggregate",
    port: (store) => withDecision(store, (decision) =>
      ({ ...decision, targetAggregateId: "aggregate-elsewhere" })),
  },
  {
    name: "the receipt's effect digest disagrees with the decision's",
    port: (store) => withReceipt(store, (receipt) =>
      ({ ...receipt, effectSha256: "b".repeat(64) })),
  },
  {
    name: "the receipt names no event",
    port: (store) => withReceipt(store, (receipt) => ({ ...receipt, eventIds: [] })),
  },
  {
    name: "the receipt names a foreign event",
    port: (store) => withReceipt(store, (receipt) =>
      ({ ...receipt, eventIds: ["event-elsewhere"] })),
  },
  {
    name: "the receipt enqueued an outbox message",
    port: (store) => withReceipt(store, (receipt) =>
      ({ ...receipt, outboxMessageIds: ["outbox-1"] })),
  },
  {
    name: "the receipt is bound to a foreign aggregate",
    port: (store) => withReceipt(store, (receipt) =>
      ({ ...receipt, aggregateId: "aggregate-elsewhere" })),
  },
  {
    name: "the receipt did not move the aggregate from version 0 to version 1",
    port: (store) => withReceipt(store, (receipt) =>
      ({ ...receipt, currentVersion: 2, previousVersion: 1 })),
  },
  {
    // Every OTHER field still says the run committed, so the disposition is the
    // only thing that can refuse it. The lone-field version of this case is
    // caught by the null-version comparisons instead, which would leave the
    // disposition guard looking load-bearing while nothing tested it.
    name: "the decision reports NO_BUSINESS_EFFECT while every other field says it committed",
    port: (store) => withDecision(store, (decision) => ({
      ...decision,
      effectDisposition: "NO_BUSINESS_EFFECT",
      resultCode: "EXPECTED_VERSION_CONFLICT",
    } as unknown as CommandDecisionRecord)),
  },
  {
    // Event, decision and receipt all name the SAME forged aggregate, so every
    // cross-check between them agrees. Only the derivation over the decoded
    // `providerRunRef` disagrees, which is the whole point of deriving it.
    name: "every stored aggregate id agrees with itself but not with the decoded ref",
    port: (store, target) => withForgedRow(store, target, {
      decision: (decision) => ({ ...decision, targetAggregateId: FORGED_AGGREGATE }),
      event: (event) => ({ ...event, aggregateId: FORGED_AGGREGATE }),
      receipt: (receipt) => ({ ...receipt, aggregateId: FORGED_AGGREGATE }),
    }),
  },
  {
    // The same shape for the event id: the decision's singleton and the receipt's
    // singleton both name the forgery, so only the derivation can catch it.
    name: "every stored event id agrees with itself but not with the decoded ref",
    port: (store, target) => withForgedRow(store, target, {
      decision: (decision) => ({ ...decision, businessEventIds: [FORGED_EVENT] }),
      event: (event) => ({ ...event, eventId: FORGED_EVENT }),
      receipt: (receipt) => ({ ...receipt, eventIds: [FORGED_EVENT] }),
    }),
  },
  {
    // THE DERIVED AGGREGATE ID IS CONSUMED TWICE — once against the event's own
    // field and once as the decision's `targetAggregateId`. Forging all three
    // stored copies lets the SECOND consumer answer, which leaves the first
    // untested. Here the decision still names the DERIVED id, so the event/receipt
    // pair is internally consistent and every downstream cross-check passes:
    // only `event.aggregateId !== deriveProviderRunAggregateId(...)` can refuse.
    name: "the event and its receipt agree on a forged aggregate id the decision does not name",
    port: (store, target) => withForgedRow(store, target, {
      decision: (decision) => decision,
      event: (event) => ({ ...event, aggregateId: FORGED_AGGREGATE }),
      receipt: (receipt) => ({ ...receipt, aggregateId: FORGED_AGGREGATE }),
    }),
  },
]);

describe("readCurrentProviderRun refuses every mutated binding", () => {
  // A generated table that silently produced zero cases would pass while testing
  // nothing, so the count is asserted before any outcome is.
  it("generates the full binding table", () => {
    expect(MUTATIONS.length).toBeGreaterThan(0);
    expect(MUTATIONS).toHaveLength(25);
    expect(new Set(MUTATIONS.map((mutation) => mutation.name)).size).toBe(MUTATIONS.length);
  });

  it.each(MUTATIONS.map((mutation) => [mutation.name, mutation] as const))(
    "answers BINDING_MISMATCH when %s",
    (_name, mutation) => {
      const store = openStore("mutation");
      const target = seedBoundPair(store);
      const before = positiveSnapshot(store);

      const result = refusedHere(readWithoutThrowing(mutation.port(store, target), {
        attemptRef: ATTEMPT, projectId: PROJECT_ID,
      }));

      expect(result).toStrictEqual({
        code: "PROVIDER_RUN_BINDING_MISMATCH",
        layer: READER,
        ok: false,
        outcome: "UNKNOWN",
        storeCode: null,
      });
      expect(snapshot(store)).toEqual(before);
    },
  );

  it.each([
    ["a foreign effect intent", "intent-elsewhere", EPOCH],
    ["a foreign epoch", "intent-target", EPOCH + 1],
  ])("answers BINDING_MISMATCH for a run bound to %s", (_label, effectIntentId, epoch) => {
    const store = openStore("join");
    activate(store, { attemptId: ATTEMPT, epoch: EPOCH, sessionId: SESSION, slug: "target" });
    commitRun(store, {
      attemptRef: ATTEMPT, effectIntentId, epoch,
      principalId: SESSION, runRef: "run-target", slug: "target",
    });
    const before = positiveSnapshot(store);

    const result = refusedHere(readCurrentProviderRun(store, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    }));

    expect(result).toStrictEqual({
      code: "PROVIDER_RUN_BINDING_MISMATCH",
      layer: READER,
      ok: false,
      outcome: "UNKNOWN",
      storeCode: null,
    });
    expect(snapshot(store)).toEqual(before);
  });
});

describe("readCurrentProviderRun keeps its identity checks honest", () => {
  it("re-derives the aggregate id from the DECODED ref, not from the event's own field", () => {
    const store = openStore("derived");
    const target = seedBoundPair(store);

    // The committed row's aggregate id IS the derivation over the decoded ref, so
    // the check compares two independently produced values rather than one with
    // itself. The mutation table above proves the comparison can fail.
    expect(target.aggregateId).toBe(deriveProviderRunAggregateId(refOf({
      attemptRef: ATTEMPT, effectIntentId: "intent-target", epoch: EPOCH,
      principalId: SESSION, runRef: "run-target", slug: "target",
    })));
    expect(accepted(readCurrentProviderRun(store, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    })).record.providerRunRef.attemptRef).toBe(ATTEMPT);
  });

  it("declares the page size this module owns rather than trusting the pager's default", () => {
    expect(PROVIDER_RUN_READER_PAGE_SIZE).toBeGreaterThan(0);
  });
});
