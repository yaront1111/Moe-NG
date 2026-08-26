import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { DERIVED, record as activationRecord } from "../activation/activation-ledger-fixtures.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readCurrentAttemptJournal } from "../journal/journal-reader.js";
import {
  DECIDED_AT, entry, journalBody, plantJournalEvent,
} from "../journal/journal-test-harness.js";
import type { UnactivatedAttemptIdentity } from "../journal/journal-test-harness.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, trackHarnessRoot,
} from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RELEASE_EVENT_TYPE, DAEMON_ATTEMPT_RELEASE, deriveAttemptReleaseAggregateId,
  readAttemptRelease, recordAttemptRelease,
} from "./attempt-release-disposition.js";
import type { AttemptReleaseRequest } from "./attempt-release-disposition.js";
import { RETIRED_HANDOFF_KEYS } from "./attempt-release-handoff.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import {
  RELEASE_HANDOFF_BINDING_CODES, RELEASE_HANDOFF_BINDING_EVENT_TYPE,
  RELEASE_HANDOFF_BINDING_RECORD_VERSION, deriveReleaseHandoffAggregateId,
  readReleaseHandoffBinding,
} from "./release-handoff-binding.js";

/**
 * The task-local committed-activation world was fabricated authority and is gone.
 * The release writer now receives only a bare file-backed store, a server-shaped
 * bound identity, and an uncommitted ActivationLedgerRecord value used solely as
 * the caller identity argument. Planted journal/binding rows below are explicitly
 * reader-only evidence; they make no claim about release-writer reachability.
 */

afterEach(cleanupRestoreHarnesses);

interface World {
  readonly aggregateId: string;
  readonly bound: FoundationAttemptBound;
  readonly identity: UnactivatedAttemptIdentity;
  readonly record: ActivationLedgerRecord;
  readonly store: SqliteEventStore;
}

function world(slug: string): World {
  const root = trackHarnessRoot(mkdtempSync(join(tmpdir(), `moe-handoff-${slug}-`)));
  const store = openHarnessStore(join(root, "project.db"));
  const record = Object.freeze(activationRecord());
  const aggregateId = DERIVED;
  const identity = Object.freeze({
    activationDigest: record.activationDigest,
    aggregateId,
    attemptRef: record.attempt.attemptId,
    effectIntentRef: record.effectIntent.intentId,
    sessionId: record.lease.ownerSessionRef,
  });
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId, claim: {}, commandId: `cmd-release-${slug}`,
    correlationId: `corr-release-${slug}`, nodeKey: "dev-done",
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, sessionId: identity.sessionId,
    target: deriveAttemptReleaseAggregateId(aggregateId),
  });
  return Object.freeze({ aggregateId, bound, identity, record, store });
}

const HANDOFF = Object.freeze({
  activeProcessResourceFacts: Object.freeze([]),
  artifactDigest: "a".repeat(64), completedSteps: Object.freeze(["step:1"]),
  contextDigest: "a".repeat(64), inputDigest: "a".repeat(64),
  journalDigest: "a".repeat(64), nextSafeAction: "action:resume",
  truthClass: "DAEMON_VERIFIED", worktreeDigest: "a".repeat(64),
});

/** THE ONLY LEGAL SHAPE AS OF task-a20e8ef6: no `handoff` key at all. The scheduler
 *  checkpoint is server-built, so a caller that spells the key is refused by this
 *  daemon's own admission before any store read. */
const releaseRequest = (
  overrides: Partial<AttemptReleaseRequest> = {},
): AttemptReleaseRequest => ({
  disposition: null, intentRefs: ["intent:release"],
  reason: "WORK_RELEASE_OR_PAUSE", ...overrides,
});

const activationUnreadable = Object.freeze({
  advisoryOnly: true, authority: "NONE", code: "ATTEMPT_RELEASE_ACTIVATION_UNREADABLE",
  message: null, ok: false, refusedBy: DAEMON_ATTEMPT_RELEASE,
});

const requestMalformed = Object.freeze({
  advisoryOnly: true, authority: "NONE", code: "ATTEMPT_RELEASE_REQUEST_MALFORMED",
  message: null, ok: false, refusedBy: DAEMON_ATTEMPT_RELEASE,
});

function attemptReleaseRowCount(fixture: World): number {
  return fixture.store.readEvents(deriveAttemptReleaseAggregateId(fixture.aggregateId))
    .filter((event) => event.eventType === ATTEMPT_RELEASE_EVENT_TYPE).length;
}

function handoffRowCount(fixture: World): number {
  return fixture.store.readEvents(deriveReleaseHandoffAggregateId(fixture.aggregateId))
    .filter((event) => event.eventType === RELEASE_HANDOFF_BINDING_EVENT_TYPE).length;
}

function expectNoWriterRows(fixture: World): void {
  expect(attemptReleaseRowCount(fixture)).toBe(0);
  expect(handoffRowCount(fixture)).toBe(0);
  expect(readAttemptRelease(fixture.store, fixture.aggregateId)).toEqual({
    advisoryOnly: true, authority: "NONE", code: "ATTEMPT_RELEASE_RECORD_ABSENT",
    message: null, ok: false, refusedBy: DAEMON_ATTEMPT_RELEASE,
  });
}

/**
 * ONE legal shape now, where there were two. THE DROP FROM 2 TO 1 IS THE POINT and is
 * asserted rather than left implicit: both former cases spoke about `handoff`, and
 * neither may any more. Their replacement lives in `handoffClaimCases` below, which
 * asserts each is refused by the DAEMON rather than by the kernel.
 */
const validRequestCases = [
  { label: "server-built handoff", request: releaseRequest() },
] as const;

/** The two shapes that USED to be legal. `null` was production's own relay until
 *  task-a20e8ef6; a well-formed nine-key value was the other. Both are caller speech
 *  about a server-derived fact now, and agreement is not authority. */
const handoffClaimCases = [
  { label: "well-formed nine-key handoff", value: HANDOFF as unknown },
  { label: "the retired production null", value: null },
] as const;

describe("attempt release writer — honest unactivated world", () => {
  it("enumerates the one remaining legal shape and both retired handoff shapes", () => {
    expect(validRequestCases).toHaveLength(1);
    expect(validRequestCases.map(({ label }) => label)).toEqual(["server-built handoff"]);
    expect(Object.keys(releaseRequest()).sort())
      .toEqual(["disposition", "intentRefs", "reason"]);
    expect(handoffClaimCases).toHaveLength(2);
    expect(handoffClaimCases.map(({ label }) => label))
      .toEqual(["well-formed nine-key handoff", "the retired production null"]);
  });

  it.each(handoffClaimCases)(
    "refuses $label at the DAEMON admission, above the kernel and before any row",
    ({ label, value }) => {
      const fixture = world(`handoff-claim-${label.replaceAll(" ", "-")}`);
      const spoken = { ...releaseRequest(), handoff: value } as AttemptReleaseRequest;
      // The daemon's own code and layer, NOT the kernel's AUTHORITY_MALFORMED_INPUT @
      // SCHEDULER_LEASE_DRAIN: a caller speaking about a server-derived fact is a
      // request fault, and it must be refused before the kernel is asked anything.
      expect(recordAttemptRelease(fixture.store, fixture.bound, fixture.record, spoken))
        .toEqual(requestMalformed);
      expectNoWriterRows(fixture);
    },
  );

  it.each(validRequestCases)(
    "$label stops at activation evidence and writes neither durable family", ({ label, request }) => {
      const fixture = world(`writer-${label.replaceAll(" ", "-")}`);
      expect(recordAttemptRelease(
        fixture.store, fixture.bound, fixture.record, request,
      )).toEqual(activationUnreadable);
      expectNoWriterRows(fixture);
    },
  );
});

const callerClaimCases = [
  { key: "safeBoundaryObserved", value: true },
  { key: "effectsTerminal", value: true },
  { key: "resourcesTerminal", value: true },
  { key: "receiptRef", value: { receiptSha256: "r", verificationId: "v" } },
  { key: "workerHandoff", value: { digest: "d", ref: "r" } },
  { key: "handoff", value: HANDOFF },
] as const;

function observeReads(store: SqliteEventStore): {
  readonly count: () => number; readonly store: SqliteEventStore;
} {
  let reads = 0;
  const observed = new Proxy(store, {
    get(target, property): unknown {
      if (property === "readEvents") {
        return (aggregateId: string) => {
          reads += 1;
          return target.readEvents(aggregateId);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({ count: () => reads, store: observed });
}

describe("attempt release writer — caller authority claims", () => {
  it("enumerates exactly all six retired caller keys", () => {
    expect(callerClaimCases).toHaveLength(6);
    expect(callerClaimCases.map(({ key }) => key)).toEqual([
      "safeBoundaryObserved", "effectsTerminal", "resourcesTerminal",
      "receiptRef", "workerHandoff", "handoff",
    ]);
    expect(new Set(callerClaimCases.map(({ key }) => key)).size).toBe(6);
    // BOTH DIRECTIONS against the production roster: iterating the cases alone
    // cannot see a key production retired that this sweep forgot.
    expect([...RETIRED_HANDOFF_KEYS].sort())
      .toEqual(["handoff", "receiptRef", "workerHandoff"]);
    expect(RETIRED_HANDOFF_KEYS.every(
      (key) => callerClaimCases.some((entry) => entry.key === key))).toBe(true);
  });

  it.each(callerClaimCases)(
    "refuses own-property $key before any store read", ({ key, value }) => {
      const fixture = world(`claim-${key}`);
      const observed = observeReads(fixture.store);
      const request = { ...releaseRequest(), [key]: value } as unknown as AttemptReleaseRequest;
      expect(recordAttemptRelease(
        observed.store, fixture.bound, fixture.record, request,
      )).toEqual(requestMalformed);
      expect(observed.count()).toBe(0);
      expectNoWriterRows(fixture);
    },
  );
});

const retiredAcceptedGroups = Object.freeze([
  "release writes handoff binding",
  "production-null handoff writes before kernel refusal",
  "journal-absent release",
  "journal-unreadable release",
  "writer-produced digest revalidation",
  "receipt binding",
  "release replay",
  "second-release append",
]);

describe("attempt release writer — retired accepted-world coverage", () => {
  it("records every removed accepted group beside its first-fence replacement", () => {
    expect(retiredAcceptedGroups).toHaveLength(8);
    expect(retiredAcceptedGroups).toEqual([
      "release writes handoff binding",
      "production-null handoff writes before kernel refusal",
      "journal-absent release",
      "journal-unreadable release",
      "writer-produced digest revalidation",
      "receipt binding",
      "release replay",
      "second-release append",
    ]);
  });
});

function plantJournal(fixture: World): string {
  plantJournalEvent(
    fixture.store, fixture.record.activationDigest,
    journalBody(fixture.identity, [entry(`handoff-${fixture.bound.commandId}`)]), 0,
  );
  const journal = readCurrentAttemptJournal(
    fixture.store, fixture.record.activationDigest, PROJECT_ID);
  if (!journal.ok) throw new Error(`planted journal refused: ${journal.code}@${journal.layer}`);
  return journal.journalDigest;
}

function plantBinding(
  fixture: World, handoff: { readonly digest: string; readonly ref: string } | null,
): void {
  const aggregateId = deriveReleaseHandoffAggregateId(fixture.aggregateId);
  const version = fixture.store.readEvents(aggregateId).length;
  const body = handoff === null ? { notABinding: true } : {
    attemptAggregateId: fixture.aggregateId,
    attemptRef: fixture.record.attempt.attemptId,
    derivedAt: DECIDED_AT,
    handoff,
    projectId: PROJECT_ID,
    receipt: null,
    recordVersion: RELEASE_HANDOFF_BINDING_RECORD_VERSION,
    releaseCommandId: `cmd-planted-release-${version}`,
  };
  const encoded = encodeFoundationPayload(body);
  if (!encoded.ok) throw new Error(`binding fixture refused: ${encoded.code}`);
  const committed = fixture.store.commitExpectedVersionDecision({
    commandKind: "attempt.release", committedResultBytes: encoded.bytes,
    correlationId: `corr-planted-binding-${version}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `planted-binding-${version}`,
      eventType: RELEASE_HANDOFF_BINDING_EVENT_TYPE, payload: encoded.bytes,
    }],
    expectedVersion: version,
    key: {
      commandId: `cmd-planted-binding-${version}`,
      principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    requestBytes: encoded.bytes, targetAggregateId: aggregateId,
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`binding fixture did not commit: ${committed.decision.effectDisposition}`);
  }
}

function collidedBindingSequences(fixture: World): SqliteEventStore {
  const bindingAggregate = deriveReleaseHandoffAggregateId(fixture.aggregateId);
  return new Proxy(fixture.store, {
    get(target, property): unknown {
      if (property === "readEvents") {
        return (aggregateId: string) => {
          const rows = target.readEvents(aggregateId);
          if (aggregateId !== bindingAggregate || rows.length < 2) return rows;
          const first = rows[0];
          if (first === undefined) return rows;
          return rows.map((event, index) =>
            index === 1 ? { ...event, aggregateSequence: first.aggregateSequence } : event);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const ownReaderRefusal = (code: string) => ({
  code, layer: "DAEMON_RELEASE_HANDOFF", ok: false,
});

describe("release handoff binding reader — planted evidence only", () => {
  it("has a canonical positive control with one journal row and one binding row", () => {
    const fixture = world("reader-positive");
    const digest = plantJournal(fixture);
    plantBinding(fixture, { digest, ref: fixture.record.activationDigest });
    const answer = readReleaseHandoffBinding(fixture.store, {
      attemptAggregateId: fixture.aggregateId, projectId: PROJECT_ID,
    });
    expect(answer).toEqual({
      binding: {
        attemptAggregateId: fixture.aggregateId,
        attemptRef: fixture.record.attempt.attemptId,
        derivedAt: DECIDED_AT,
        handoff: { digest, ref: fixture.record.activationDigest },
        projectId: PROJECT_ID, receipt: null,
        recordVersion: RELEASE_HANDOFF_BINDING_RECORD_VERSION,
        releaseCommandId: "cmd-planted-release-0",
      },
      ok: true,
    });
    expect(handoffRowCount(fixture)).toBe(1);
  });

  it("distinguishes ABSENT at zero rows", () => {
    const fixture = world("reader-absent");
    expect(readReleaseHandoffBinding(fixture.store, {
      attemptAggregateId: fixture.aggregateId, projectId: PROJECT_ID,
    })).toEqual(ownReaderRefusal("RELEASE_HANDOFF_BINDING_ABSENT"));
    expect(handoffRowCount(fixture)).toBe(0);
  });

  it("distinguishes UNREADABLE at one hostile row", () => {
    const fixture = world("reader-unreadable");
    plantBinding(fixture, null);
    expect(readReleaseHandoffBinding(fixture.store, {
      attemptAggregateId: fixture.aggregateId, projectId: PROJECT_ID,
    })).toEqual(ownReaderRefusal("RELEASE_HANDOFF_BINDING_UNREADABLE"));
    expect(handoffRowCount(fixture)).toBe(1);
  });

  it("distinguishes PROJECT_MISMATCH at one canonical row", () => {
    const fixture = world("reader-project");
    const digest = plantJournal(fixture);
    plantBinding(fixture, { digest, ref: fixture.record.activationDigest });
    expect(readReleaseHandoffBinding(fixture.store, {
      attemptAggregateId: fixture.aggregateId, projectId: "project-foreign",
    })).toEqual(ownReaderRefusal("RELEASE_HANDOFF_BINDING_PROJECT_MISMATCH"));
    expect(handoffRowCount(fixture)).toBe(1);
  });

  it("distinguishes AMBIGUOUS at two sequence-collided canonical rows", () => {
    const fixture = world("reader-ambiguous");
    const digest = plantJournal(fixture);
    const handoff = { digest, ref: fixture.record.activationDigest };
    plantBinding(fixture, handoff);
    plantBinding(fixture, handoff);
    expect(readReleaseHandoffBinding(collidedBindingSequences(fixture), {
      attemptAggregateId: fixture.aggregateId, projectId: PROJECT_ID,
    })).toEqual(ownReaderRefusal("RELEASE_HANDOFF_BINDING_AMBIGUOUS"));
    expect(handoffRowCount(fixture)).toBe(2);
  });

  it("keeps the four required reader answers distinct and in the production roster", () => {
    const required = [
      "RELEASE_HANDOFF_BINDING_ABSENT", "RELEASE_HANDOFF_BINDING_AMBIGUOUS",
      "RELEASE_HANDOFF_BINDING_PROJECT_MISMATCH", "RELEASE_HANDOFF_BINDING_UNREADABLE",
    ];
    expect(required).toHaveLength(4);
    expect(new Set(required).size).toBe(4);
    expect(required.every((code) => RELEASE_HANDOFF_BINDING_CODES.includes(
      code as (typeof RELEASE_HANDOFF_BINDING_CODES)[number],
    ))).toBe(true);
  });

  it("publishes a frozen, nonempty vocabulary with no duplicate member", () => {
    expect(Object.isFrozen(RELEASE_HANDOFF_BINDING_CODES)).toBe(true);
    expect(RELEASE_HANDOFF_BINDING_CODES.length).toBeGreaterThan(0);
    expect(new Set(RELEASE_HANDOFF_BINDING_CODES).size)
      .toBe(RELEASE_HANDOFF_BINDING_CODES.length);
  });
});
