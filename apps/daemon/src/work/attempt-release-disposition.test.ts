import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DRAIN_REASONS } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RELEASE_CODES, ATTEMPT_RELEASE_COMMAND_KIND, ATTEMPT_RELEASE_EVENT_TYPE,
  ATTEMPT_RELEASE_RECORD_VERSION, DAEMON_ATTEMPT_RELEASE, SCHEDULER_LEASE_DRAIN,
  deriveAttemptReleaseAggregateId, readAttemptRelease, recordAttemptRelease,
} from "./attempt-release-disposition.js";
import type { AttemptReleaseOutcome, AttemptReleaseRequest } from "./attempt-release-disposition.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";

/**
 * The attempt-level release disposition, over a REAL SqliteEventStore, a REAL
 * activation committed by the production ingress, and the REAL `releaseWork`
 * kernel reached through the bare `@moe/scheduler` root.
 *
 * NOTHING HERE HAND-FORGES AN ACTIVATION. `parseActivationGrant` demands a hex64
 * grantId derived from the whole successor intent, so the only coherent
 * activation is the one `runEffectActivateCommand` commits — which is also what
 * makes the durable lease and provider-slot facts below genuinely durable rather
 * than a fixture this suite wrote and then read back.
 *
 * TWO LAYERS CAN REFUSE THIS PATH, so every refusal case asserts WHICH one said
 * no as well as the exact code, and that NO durable row exists afterwards. A
 * handler that wrote a row and then refused sails through a return-value
 * assertion, and a daemon code standing in for a kernel refusal hides the fact
 * that the daemon no longer judges dispositions at all.
 */

const encoder = new TextEncoder();

afterEach(cleanupRestoreHarnesses);

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const SESSION_ID = "session-1";
const NODE_KEY = "dev-done";

const LEASE_RECORD = {
  authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT", leaseId: "lease-1",
  leaseToken: "token-1", monotonicObservation: 500, ownerSessionRef: SESSION_ID,
  serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;
const LEASE_PROOF = {
  authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: "token-1",
  ownerSessionRef: SESSION_ID,
} as const;
const RESOURCE_ROW = {
  capacityUnits: 1, effectIntentRef: "intent-ref-1", epoch: 1, external: false, fenceable: true,
  resourceId: "res-1", state: "ACTIVE",
} as const;
const BUDGET_VIEW = {
  accountId: "acct-1",
  meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
  state: "OPEN", version: 2,
} as const;
const ADMISSION = {
  admissionRef: "adm-1",
  amounts: [
    { meter: "usd", purpose: "EXECUTION", quantity: 10 },
    { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
    { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
    { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
    { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
  ],
  expectedVersion: 2,
} as const;
const GATE = { allowance: { decisionRef: "dec-1", outcome: "ALLOW" }, approval: null } as const;
const EFFECT_INTENT = {
  aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4, idempotencyKey: "idem-1",
  inputBinding: DIGEST, intentId: "intent-1", leaseBinding: LEASE_RECORD,
  predecessorCursor: "cursor-1", protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST, state: "PENDING", version: 0,
} as const;
const CLAIM = {
  claimId: "claim-1", claimedAt: DECIDED_AT, intentId: "intent-1", lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
} as const;
const ACTIVATION_SECTION = {
  attempt: {
    aggregateId: "agg-1", attemptId: "attempt-1", intentId: "intent-1",
    state: "LAUNCH_REQUESTED", version: 0,
  },
  claim: CLAIM, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DIGEST, tombstone: null,
  wrapperIdentity: "wrapper-1",
} as const;

const ACTIVATION_AGGREGATE = deriveActivationAggregateId(
  EFFECT_INTENT.aggregateId, EFFECT_INTENT.idempotencyKey);

function activationBytes(): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: "cmd-release-1", correlationId: "corr-release", decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: ACTIVATION_SECTION,
      budget: { admission: ADMISSION, gate: GATE, view: BUDGET_VIEW },
      effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

interface Fixture {
  readonly bound: FoundationAttemptBound;
  readonly record: ActivationLedgerRecord;
  readonly store: SqliteEventStore;
}

/** A committed activation, read BACK from the store rather than kept from the
 *  command result, so the record this suite calls "durable" really is. */
function activated(label: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `moe-release-${label}-`));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  const outcome = runEffectActivateCommand(store, activationBytes());
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.code}`);
  const history = readFoundationActivationHistory(
    ACTIVATION_AGGREGATE, store.readEvents(ACTIVATION_AGGREGATE), PROJECT_ID);
  if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: ACTIVATION_AGGREGATE, claim: CLAIM, commandId: "cmd-release-1",
    correlationId: "corr-release", nodeKey: NODE_KEY, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId: SESSION_ID,
    target: deriveAttemptReleaseAggregateId(ACTIVATION_AGGREGATE),
  });
  return { bound, record: history.history.record, store };
}

/** The handoff the kernel demands before it will compose ANY transition: five
 *  digest families, a next safe action and a truth class. Its durable producer
 *  is task-af9454f4, so this suite supplies it as an INPUT. */
const HANDOFF = Object.freeze({
  activeProcessResourceFacts: Object.freeze([]),
  artifactDigest: DIGEST, completedSteps: Object.freeze(["step:1"]), contextDigest: DIGEST,
  inputDigest: DIGEST, journalDigest: DIGEST, nextSafeAction: "action:resume",
  truthClass: "DAEMON_VERIFIED", worktreeDigest: DIGEST,
});

/** A settled boundary. The three flags have NO durable producer yet
 *  (task-ded026d6, task-6d400781), so the suite drives them as inputs; the
 *  daemon must never synthesize or upgrade one of its own accord. */
const settledRequest = (
  overrides: Partial<AttemptReleaseRequest> = {},
): AttemptReleaseRequest => ({
  disposition: null, effectsTerminal: true, handoff: HANDOFF, intentRefs: ["intent:release"],
  reason: "WORK_RELEASE_OR_PAUSE", resourcesTerminal: true, safeBoundaryObserved: true,
  ...overrides,
});

function refusalOf(
  outcome: AttemptReleaseOutcome,
): { code: string; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, received a recorded row");
  return { code: outcome.code, refusedBy: outcome.refusedBy };
}

function rowOf(outcome: AttemptReleaseOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`expected a recorded row, refused with ${outcome.code}`);
  return outcome.record;
}

/** Every refusal must leave the aggregate EMPTY. Read through the module's own
 *  reader, so a row written and then refused cannot hide behind a return value. */
function expectNoDurableRow(fixture: Fixture): void {
  const stored = readAttemptRelease(fixture.store, fixture.bound.aggregateId);
  expect(refusalOf(stored)).toEqual({
    code: "ATTEMPT_RELEASE_RECORD_ABSENT", refusedBy: DAEMON_ATTEMPT_RELEASE,
  });
}

/** Counts the rows OUT OF THE STORE rather than trusting a return value: "it did
 *  not throw the second time" is also exactly what a double write looks like. */
function durableRowCount(fixture: Fixture): number {
  return fixture.store.readEvents(deriveAttemptReleaseAggregateId(fixture.bound.aggregateId))
    .filter((event) => event.eventType === ATTEMPT_RELEASE_EVENT_TYPE).length;
}

describe("attempt release disposition — frozen vocabulary", () => {
  it("publishes a closed code list with no duplicate member", () => {
    expect(ATTEMPT_RELEASE_CODES.length).toBeGreaterThan(0);
    expect(new Set(ATTEMPT_RELEASE_CODES).size).toBe(ATTEMPT_RELEASE_CODES.length);
    // Seven, not twelve. The five disposition and drain-reason codes were retired
    // with the daemon-side validator that raised them: `releaseWork` owns that
    // judgement now and refuses in its own words, under its own layer.
    expect([...ATTEMPT_RELEASE_CODES].sort()).toEqual([
      "ATTEMPT_RELEASE_ACTIVATION_UNREADABLE", "ATTEMPT_RELEASE_BINDING_MISMATCH",
      "ATTEMPT_RELEASE_COMMIT_UNAVAILABLE", "ATTEMPT_RELEASE_RECORD_ABSENT",
      "ATTEMPT_RELEASE_RECORD_AMBIGUOUS", "ATTEMPT_RELEASE_RECORD_DRIFT",
      "ATTEMPT_RELEASE_RECORD_UNREADABLE",
    ].sort());
    for (const retired of ["ATTEMPT_RELEASE_REASON_UNKNOWN", "ATTEMPT_RELEASE_REASON_NOT_UNIONED",
      "ATTEMPT_RELEASE_DISPOSITION_MALFORMED", "ATTEMPT_RELEASE_DISPOSITION_DOWNGRADED",
      "ATTEMPT_RELEASE_TARGET_MISMATCH"]) {
      expect([...ATTEMPT_RELEASE_CODES]).not.toContain(retired);
    }
  });

  it("names both refusing layers, disjoint from the sibling dispatch layer", () => {
    expect(DAEMON_ATTEMPT_RELEASE).toBe("DAEMON_ATTEMPT_RELEASE");
    expect(SCHEDULER_LEASE_DRAIN).toBe("SCHEDULER_LEASE_DRAIN");
    expect(DAEMON_ATTEMPT_RELEASE).not.toBe(SCHEDULER_LEASE_DRAIN);
    expect(DAEMON_ATTEMPT_RELEASE).not.toBe("DAEMON_FOUNDATION_ATTEMPT");
    expect([ATTEMPT_RELEASE_RECORD_VERSION, ATTEMPT_RELEASE_EVENT_TYPE,
      ATTEMPT_RELEASE_COMMAND_KIND]).toEqual(
      ["moe-attempt-release-record/1", "AttemptReleaseRecorded", "work.attempt_release"]);
  });

  it("derives a release aggregate distinct from the activation it reads", () => {
    const derived = deriveAttemptReleaseAggregateId(ACTIVATION_AGGREGATE);
    expect(derived).not.toBe(ACTIVATION_AGGREGATE);
    expect(derived).toBe(deriveAttemptReleaseAggregateId(ACTIVATION_AGGREGATE));
    expect(derived).not.toBe(deriveAttemptReleaseAggregateId(`${ACTIVATION_AGGREGATE}x`));
  });
});

describe("attempt release disposition — the kernel refuses, the daemon carries", () => {
  it("carries the KERNEL's refusal for a disposition it will not compose", () => {
    const fixture = activated("malformed");
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ disposition: { reasons: [], strongestReason: "WORK_RELEASE_OR_PAUSE" } }));
    // The layer is the discriminator: a DAEMON_ATTEMPT_RELEASE code here would
    // mean the daemon kept a second disposition validator of its own.
    expect(refusalOf(outcome)).toEqual({
      code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
    });
    expectNoDurableRow(fixture);
  });

  it("carries the KERNEL's refusal for a DOWNGRADED strongest reason", () => {
    const fixture = activated("downgraded");
    // URGENT_REVOKE is rank 70 and sits in the set, so WORK_RELEASE_OR_PAUSE
    // (rank 20) cannot honestly be the strongest one.
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ disposition: {
        reasons: ["URGENT_REVOKE", "WORK_RELEASE_OR_PAUSE"], resumable: true,
        strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
      } }));
    expect(refusalOf(outcome)).toEqual({
      code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
    });
    expectNoDurableRow(fixture);
  });

  it("refuses a reason the frozen drain vocabulary does not declare", () => {
    const fixture = activated("unknown-reason");
    const unknown = "WORK_RELEASE_OR_RESUME";
    // The case cannot go vacuous the day the vocabulary grows: if this string
    // ever became a real reason, THIS assertion fails before the refusal does.
    expect([...DRAIN_REASONS]).not.toContain(unknown);
    const outcome = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest({ reason: unknown }));
    expect(refusalOf(outcome)).toEqual({
      code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
    });
    expectNoDurableRow(fixture);
  });

  it("refuses an uncommittable handoff BEFORE any transition is composed", () => {
    const fixture = activated("handoff");
    for (const handoff of [null, { ...HANDOFF, inputDigest: "not-a-digest" }]) {
      const outcome = recordAttemptRelease(
        fixture.store, fixture.bound, fixture.record, settledRequest({ handoff }));
      expect(refusalOf(outcome)).toEqual({
        code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
      });
    }
    expectNoDurableRow(fixture);
  });

  it("refuses an OMITTED boundary flag rather than defaulting it either way", () => {
    // The three flags have no durable producer. A daemon that defaulted a missing
    // one to false would silently record DRAINING; one that defaulted it to true
    // would manufacture the safe boundary this whole epic exists to prove.
    const flags = ["effectsTerminal", "resourcesTerminal", "safeBoundaryObserved"] as const;
    let driven = 0;
    for (const flag of flags) {
      const fixture = activated(`omitted-${flag}`);
      const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
        settledRequest({ [flag]: undefined }));
      expect(refusalOf(outcome), flag).toEqual({
        code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
      });
      expectNoDurableRow(fixture);
      driven += 1;
    }
    // A sweep that generated nothing would pass every assertion above vacuously.
    expect(driven).toBe(3);
  });

  it("refuses when the durable activation it must read is not there", () => {
    const fixture = activated("no-activation");
    const orphan: FoundationAttemptBound = Object.freeze({
      ...fixture.bound, aggregateId: `${ACTIVATION_AGGREGATE}-absent`,
      target: deriveAttemptReleaseAggregateId(`${ACTIVATION_AGGREGATE}-absent`),
    });
    const outcome =
      recordAttemptRelease(fixture.store, orphan, fixture.record, settledRequest());
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_ACTIVATION_UNREADABLE", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expect(refusalOf(readAttemptRelease(fixture.store, orphan.aggregateId)).code)
      .toBe("ATTEMPT_RELEASE_RECORD_ABSENT");
  });

  it("refuses a caller record whose IDENTITY contradicts the committed activation", () => {
    const fixture = activated("identity");
    const forged: ActivationLedgerRecord = {
      ...fixture.record, activationDigest: "f".repeat(64),
    };
    expect(forged.activationDigest).not.toBe(fixture.record.activationDigest);
    const outcome =
      recordAttemptRelease(fixture.store, fixture.bound, forged, settledRequest());
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_BINDING_MISMATCH", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expectNoDurableRow(fixture);
  });
});

/** The exact fields `ExpansionReleaseEvidence` names, read from durable bytes. */
const RELEASE_FIELDS = Object.freeze([
  "attemptState", "leaseRef", "leaseState", "providerSlotRef", "providerSlotState", "reason",
] as const);

function dispositionOf(row: Record<string, unknown>): Record<string, unknown> {
  const value = row["disposition"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("the recorded row carries no disposition record");
  }
  return value as Record<string, unknown>;
}

function leaseOf(row: Record<string, unknown>): Record<string, unknown> {
  const value = row["lease"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("the recorded row carries no lease record");
  }
  return value as Record<string, unknown>;
}

describe("attempt release disposition — a lease durably reaches RELEASED", () => {
  it("records leaseState RELEASED from durable bytes, which no path could reach before", () => {
    const fixture = activated("released");
    // THE PLAIN FACT THIS CASE EXISTS FOR: before this task the daemon recorded
    // the ACTIVATION-TIME lease state, so the row said "ACTIVE" forever and
    // `leaseState === "RELEASED"` was unreachable in the whole repository.
    expect(fixture.record.lease.state).toBe("ACTIVE");
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    // EVERY assertion below is against the READER's answer, never `written`.
    const answer = readAttemptRelease(fixture.store, fixture.bound.aggregateId);
    const row = rowOf(answer);
    expect(row["leaseState"]).toBe("RELEASED");
    expect(RELEASE_FIELDS.filter((field) => !(field in row))).toEqual([]);
    expect({
      attemptState: row["attemptState"], leaseRef: row["leaseRef"],
      providerSlotRef: row["providerSlotRef"], providerSlotState: row["providerSlotState"],
      reason: row["reason"],
    }).toEqual({
      attemptState: fixture.record.attempt.state, leaseRef: fixture.record.lease.leaseId,
      providerSlotRef: fixture.record.providerSlot.slotRef,
      // The provider-slot transition is task-4731ba34's; `releaseWork` does not
      // touch slots, so this stays the durable activation-time fact.
      providerSlotState: fixture.record.providerSlot.state, reason: "WORK_RELEASE_OR_PAUSE",
    });
    // The kernel's whole lease answer, not just the projection: the version was
    // bumped by the kernel and the daemon supplied neither field.
    expect([leaseOf(row)["state"], leaseOf(row)["version"], fixture.record.lease.version])
      .toEqual(["RELEASED", 8, 7]);
    expect(row["leaseState"]).toBe(leaseOf(row)["state"]);
    expect([row["outcome"], row["releasePending"], row["resumable"]])
      .toEqual(["RELEASED", false, true]);
    expect(dispositionOf(row)).toEqual({
      resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
    });
    expect([row["recordVersion"], row["truthClass"], row["attemptAggregateId"]]).toEqual(
      [ATTEMPT_RELEASE_RECORD_VERSION, "DAEMON_VERIFIED", ACTIVATION_AGGREGATE]);
    expect(row["handoff"]).toEqual(HANDOFF);
  });

  it("records a NON-RESUMABLE release under a different drain reason", () => {
    const fixture = activated("non-resumable");
    const other = "WORK_CANCEL";
    // The two reasons really are different members of the same frozen list, so
    // this case cannot pass by accidentally re-driving the resumable one.
    expect(other).not.toBe("WORK_RELEASE_OR_PAUSE");
    expect([...DRAIN_REASONS]).toContain(other);
    const written = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ reason: other }));
    expect(written.ok && written.outcome).toBe("RELEASED");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["reason"], row["leaseState"], row["resumable"]])
      .toEqual([other, "RELEASED", false]);
    expect(dispositionOf(row)).toEqual({
      resumable: false, strongestReason: other, terminalTarget: "RELEASED",
    });
    // Stated as a difference, not just as a value: the resumable path must be
    // unreachable by default rather than merely unselected here.
    expect(dispositionOf(row)).not.toEqual({
      resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
    });
  });

  it("lets the DURABLE lease and slot state win over a contradicting caller record", () => {
    const fixture = activated("contradiction");
    const claimed: ActivationLedgerRecord = {
      ...fixture.record,
      lease: { ...fixture.record.lease, state: "REVOKED", version: 99 },
      providerSlot: { ...fixture.record.providerSlot, state: "RELEASED" },
    };
    // The premise: the caller really is claiming something the store denies. A
    // REVOKED lease would make the kernel answer NO_OP and write nothing at all.
    expect([fixture.record.lease.state, fixture.record.providerSlot.state]).toEqual(
      ["ACTIVE", "ACTIVE"]);
    expect([claimed.lease.state, claimed.providerSlot.state]).toEqual(["REVOKED", "RELEASED"]);
    const written =
      recordAttemptRelease(fixture.store, fixture.bound, claimed, settledRequest());
    // No layer refuses: the claim is not rejected, it is never consulted. The
    // identity is unchanged, so the binding guard has nothing to answer.
    expect(written.ok && written.outcome).toBe("RELEASED");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["leaseState"], row["providerSlotState"]]).toEqual(["RELEASED", "ACTIVE"]);
    expect([leaseOf(row)["version"], row["providerSlotRef"]]).toEqual(
      [8, fixture.record.providerSlot.slotRef]);
  });

  it("reads the reason set through validated bytes, not the caller's own array", () => {
    const fixture = activated("hostile-reasons");
    // A plain array carrying an own `includes` that lies and an own iterator that
    // would smuggle an unvalidated member into the durable row. The kernel's
    // `stringList` reads own INDEX properties and then composes a fresh frozen
    // array, so neither override is ever consulted.
    const reasons: string[] = ["WORK_RELEASE_OR_PAUSE"];
    Object.defineProperty(reasons, "includes", { value: () => true });
    Object.defineProperty(reasons, Symbol.iterator, {
      value: function* smuggle(): Generator<string> { yield "NOT_A_DRAIN_REASON"; },
    });
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ disposition: {
        reasons, resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE",
        terminalTarget: "RELEASED",
      } }));
    expect(rowOf(outcome)["reasons"]).toEqual(["WORK_RELEASE_OR_PAUSE"]);
  });
});

describe("attempt release disposition — DRAINING is its own outcome", () => {
  /** Drives one unsettled variant and returns the row it wrote. */
  function drained(flag: string): Record<string, unknown> {
    const fixture = activated(`draining-${flag}`);
    const written = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ [flag]: false }));
    expect(written.ok && written.outcome, flag).toBe("DRAINING");
    expect(durableRowCount(fixture), flag).toBe(1);
    return rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
  }

  it("records DRAINING with resumable false for each unsettled boundary flag", () => {
    const flags = ["effectsTerminal", "resourcesTerminal", "safeBoundaryObserved"];
    const rows = flags.map((flag) => drained(flag));
    // A sweep that generated nothing passes every assertion below vacuously.
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect([row["outcome"], row["leaseState"], row["resumable"], row["releasePending"]])
        .toEqual(["DRAINING", "DRAINING", false, true]);
      expect(leaseOf(row)["state"]).toBe("DRAINING");
      expect(row["intentRefs"]).toEqual(["intent:release"]);
      expect(row["handoff"]).toBeNull();
      // THE NON-EQUIVALENT HALF. The reason set still composes a RESUMABLE
      // disposition — design 765 says WORK_RELEASE_OR_PAUSE is resumable — yet
      // THIS release is not, because the boundary was never observed. A daemon
      // that re-derived `resumable` from the disposition would print true here.
      expect(dispositionOf(row)["resumable"]).toBe(true);
      expect(row["resumable"]).toBe(false);
    }
  });

  it("differs from the released row FIELD BY FIELD, never merely 'not released'", () => {
    const fixture = activated("released-for-diff");
    recordAttemptRelease(fixture.store, fixture.bound, fixture.record, settledRequest());
    const released = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    const draining = drained("safeBoundaryObserved");
    const differing = Object.keys(released)
      .filter((key) => JSON.stringify(released[key]) !== JSON.stringify(draining[key]));
    expect(differing.sort()).toEqual([
      "handoff", "intentRefs", "lease", "leaseState", "outcome", "releasePending", "resumable",
    ]);
    // And every OTHER field is genuinely identical, so the two rows describe the
    // same attempt rather than two unrelated releases that happen to disagree.
    expect([draining["attemptAggregateId"], draining["reason"], draining["attemptState"]])
      .toEqual([released["attemptAggregateId"], released["reason"], released["attemptState"]]);
  });
});

describe("attempt release disposition — replay and cardinality", () => {
  it("answers the kernel's NO_OP on replay and leaves EXACTLY ONE durable row", () => {
    const fixture = activated("replay");
    const first = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(first.ok && first.outcome).toBe("RELEASED");
    expect(durableRowCount(fixture)).toBe(1);
    // A DIFFERENT disposition, so a second row would be observable rather than an
    // idempotent repeat. The recorded lease is already RELEASED, so `releaseWork`
    // answers NO_OP and the daemon writes nothing.
    const replay = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ reason: "WORK_CANCEL" }));
    expect(replay.ok && replay.outcome).toBe("NO_OP");
    expect(durableRowCount(fixture)).toBe(1);
    // The FIRST release still stands, unchanged, and is still the durable answer.
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["reason"], row["outcome"], row["leaseState"]])
      .toEqual(["WORK_RELEASE_OR_PAUSE", "RELEASED", "RELEASED"]);
    expect(rowOf(replay)).toEqual(row);
  });

  it("keeps ABSENT and AMBIGUOUS distinct, because they demand opposite repairs", () => {
    const fixture = activated("cardinality");
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId)).code)
      .toBe("ATTEMPT_RELEASE_RECORD_ABSENT");
    expect(recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest()).ok).toBe(true);
    plantReleaseEvent(fixture, encoder.encode(JSON.stringify({ duplicate: true })), 1);
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_AMBIGUOUS", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
  });

  it("refuses stored bytes that no longer re-encode, under a third distinct code", () => {
    const fixture = activated("drift");
    // Canonical encoding sorts keys, so a row whose keys are stored out of order
    // decodes cleanly and then fails the re-encode byte compare — unreadable in
    // the only sense that matters, and not the same repair as absent or two.
    plantReleaseEvent(fixture, encoder.encode('{"b":1,"a":2}'), 0);
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_DRIFT", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
  });

  it("refuses a SECOND transition over a DRAINING row rather than appending one", () => {
    const fixture = activated("draining-then-settled");
    // First release: the boundary was never observed, so the row records DRAINING
    // and the durable lease reaches DRAINING rather than a terminal state.
    const first = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ safeBoundaryObserved: false }));
    expect(first.ok && first.outcome).toBe("DRAINING");
    // DRAINING is NOT terminal, so `releaseWork` composes a real RELEASED
    // transition on the replay — and the aggregate, written at expectedVersion 0,
    // has nowhere to put it. Refused, not silently dropped and not a second row.
    const second = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(refusalOf(second)).toEqual({
      code: "ATTEMPT_RELEASE_COMMIT_UNAVAILABLE", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expect(durableRowCount(fixture)).toBe(1);
    expect(rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))["outcome"])
      .toBe("DRAINING");
  });

  it("refuses to fence against a stored lease the scheduler's parser will not accept", () => {
    const fixture = activated("lease-drift");
    // Canonically encoded and carrying a declared outcome, so the byte compare
    // and the outcome guard both pass and ONLY the lease parse can refuse. A
    // daemon that fell back to the activation lease here would fence against a
    // state the release had already left, and write a second truth.
    plantReleaseEvent(
      fixture, encoder.encode('{"lease":{"leaseId":"lease-1"},"outcome":"RELEASED"}'), 0);
    expect(readAttemptRelease(fixture.store, fixture.bound.aggregateId).ok).toBe(true);
    const outcome = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_DRIFT", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expect(durableRowCount(fixture)).toBe(1);
  });

  it("refuses an UNREADABLE store separately from an absent row", () => {
    const fixture = activated("unreadable");
    fixture.store.close();
    // Absent and unreadable demand opposite repairs: one says write the release,
    // the other says the durable history cannot be consulted at all.
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_UNREADABLE", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expect(refusalOf(recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest())).code)
      .toBe("ATTEMPT_RELEASE_ACTIVATION_UNREADABLE");
  });

  it("carries the kernel's EXHAUSTED-COUNTER refusal instead of releasing over it", () => {
    // `fenceAuthority` refuses a lease at MAX_AUTHORITY_COUNT as MALFORMED: a
    // successor above the ceiling would never parse again, leaving the lease
    // unrevocable. Planted through the PRODUCTION codec, so the bytes are the
    // canonical ones the reader demands rather than a hand-sorted guess.
    const CEILING = Number.MAX_SAFE_INTEGER - 1_000_000;
    const plant = (fixture: Fixture, version: number): void => {
      const encoded = encodeFoundationPayload({
        lease: {
          authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
          leaseId: "lease-1", leaseToken: "token-1", monotonicObservation: 500,
          ownerSessionRef: SESSION_ID, serverWallDeadline: 1_000, state: "RELEASED", version,
        },
        outcome: "RELEASED",
      });
      if (!encoded.ok) throw new Error("the production codec refused the planted row");
      plantReleaseEvent(fixture, encoded.bytes, 0);
    };
    // CONTROL first, the SAME planted shape one counter below the ceiling: it
    // fences cleanly and answers NO_OP, so the refusal below is the counter and
    // not merely "a planted row is rejected".
    const control = activated("counter-control");
    plant(control, CEILING - 1);
    const fenced =
      recordAttemptRelease(control.store, control.bound, control.record, settledRequest());
    expect(fenced.ok && fenced.outcome).toBe("NO_OP");

    const fixture = activated("counter-exhausted");
    plant(fixture, CEILING);
    expect(refusalOf(recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest()))).toEqual({
      code: "AUTHORITY_MALFORMED_INPUT", refusedBy: SCHEDULER_LEASE_DRAIN,
    });
    expect(durableRowCount(fixture)).toBe(1);
  });

  it("refuses a row whose recorded outcome is outside the frozen vocabulary", () => {
    const fixture = activated("outcome-drift");
    // Canonically encoded, so the byte compare passes and ONLY the outcome guard
    // can refuse it. A reader that trusted the stored string would hand a caller
    // an outcome no kernel ever answered.
    plantReleaseEvent(fixture, encoder.encode('{"outcome":"SUCCEEDED"}'), 0);
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_DRIFT", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
  });
});

/** Writes a row this module did not compose, so the reader's cardinality and
 *  byte-identity guards are reached by evidence rather than by a stub. */
function plantReleaseEvent(fixture: Fixture, payload: Uint8Array, expectedVersion: number): void {
  const committed = fixture.store.commitExpectedVersionDecision({
    commandKind: ATTEMPT_RELEASE_COMMAND_KIND, committedResultBytes: payload,
    correlationId: `corr-plant-${expectedVersion}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `planted-${expectedVersion}`, eventType: ATTEMPT_RELEASE_EVENT_TYPE, payload,
    }],
    expectedVersion,
    key: {
      commandId: `cmd-plant-${expectedVersion}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    },
    requestBytes: payload, targetAggregateId: fixture.bound.target,
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`planting refused: ${committed.decision.effectDisposition}`);
  }
}
