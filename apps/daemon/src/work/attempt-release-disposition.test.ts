import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DRAIN_REASONS, DRAIN_TERMINAL_TARGETS } from "@moe/runner";
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
  ATTEMPT_RELEASE_RECORD_VERSION, DAEMON_ATTEMPT_RELEASE, deriveAttemptReleaseAggregateId,
  readAttemptRelease, recordAttemptRelease,
} from "./attempt-release-disposition.js";
import type { AttemptReleaseOutcome, AttemptReleaseRequest } from "./attempt-release-disposition.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";

/**
 * The attempt-level release disposition, over a REAL SqliteEventStore and a REAL
 * activation committed by the production ingress.
 *
 * NOTHING HERE HAND-FORGES AN ACTIVATION. `parseActivationGrant` demands a hex64
 * grantId derived from the whole successor intent, so the only coherent
 * activation is the one `runEffectActivateCommand` commits — which is also what
 * makes the durable lease and provider-slot facts below genuinely durable rather
 * than a fixture this suite wrote and then read back.
 *
 * Every refusal case asserts THREE things, not one: the exact code, the exact
 * layer, and that NO durable row exists afterwards. A handler that wrote a row
 * and then refused sails through a return-value assertion.
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

/** Design 348's own shape: WORK_RELEASE_OR_PAUSE is rank 20, target RELEASED. */
const RELEASE_DISPOSITION = Object.freeze({
  reasons: Object.freeze(["WORK_RELEASE_OR_PAUSE"]),
  strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
});

const releaseRequest = (
  overrides: Partial<AttemptReleaseRequest> = {},
): AttemptReleaseRequest => ({
  disposition: RELEASE_DISPOSITION, reason: "WORK_RELEASE_OR_PAUSE", ...overrides,
});

function refusalOf(outcome: AttemptReleaseOutcome): { code: string; refusedBy: string } {
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

describe("attempt release disposition — frozen vocabulary", () => {
  it("publishes a closed code list with no duplicate member", () => {
    expect(ATTEMPT_RELEASE_CODES.length).toBeGreaterThan(0);
    expect(new Set(ATTEMPT_RELEASE_CODES).size).toBe(ATTEMPT_RELEASE_CODES.length);
    expect([...ATTEMPT_RELEASE_CODES].sort()).toEqual([
      "ATTEMPT_RELEASE_ACTIVATION_UNREADABLE", "ATTEMPT_RELEASE_BINDING_MISMATCH",
      "ATTEMPT_RELEASE_COMMIT_UNAVAILABLE", "ATTEMPT_RELEASE_DISPOSITION_DOWNGRADED",
      "ATTEMPT_RELEASE_DISPOSITION_MALFORMED", "ATTEMPT_RELEASE_REASON_NOT_UNIONED",
      "ATTEMPT_RELEASE_REASON_UNKNOWN", "ATTEMPT_RELEASE_RECORD_AMBIGUOUS",
      "ATTEMPT_RELEASE_RECORD_ABSENT", "ATTEMPT_RELEASE_RECORD_DRIFT",
      "ATTEMPT_RELEASE_RECORD_UNREADABLE", "ATTEMPT_RELEASE_TARGET_MISMATCH",
    ].sort());
  });

  it("names its own layer, disjoint from the sibling dispatch layer", () => {
    expect(DAEMON_ATTEMPT_RELEASE).toBe("DAEMON_ATTEMPT_RELEASE");
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

describe("attempt release disposition — refusals write nothing", () => {
  it("refuses a disposition whose SHAPE the runner's parser rejects", () => {
    const fixture = activated("malformed");
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      releaseRequest({ disposition: { reasons: [], strongestReason: "WORK_RELEASE_OR_PAUSE" } }));
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_DISPOSITION_MALFORMED", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expectNoDurableRow(fixture);
  });

  it("refuses a DOWNGRADED disposition whose strongest reason is not its highest", () => {
    const fixture = activated("downgraded");
    // URGENT_REVOKE is rank 70 and sits in the set, so WORK_RELEASE_OR_PAUSE
    // (rank 20) cannot honestly be the strongest. The target below is the one
    // the CLAIMED strongest reason maps to, so only the rank half is wrong.
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      releaseRequest({ disposition: {
        reasons: ["URGENT_REVOKE", "WORK_RELEASE_OR_PAUSE"],
        strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
      } }));
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_DISPOSITION_DOWNGRADED", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expectNoDurableRow(fixture);
  });

  it("refuses a RETARGETED disposition under its own distinct code", () => {
    const fixture = activated("retargeted");
    // The reason set is coherent — WORK_RELEASE_OR_PAUSE really is its own
    // strongest — and ONLY the terminal target is wrong. A single code shared
    // with the case above would leave a reviewer unable to tell a retargeted
    // safe boundary from a downgraded reason set; they demand opposite repairs.
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      releaseRequest({ disposition: {
        reasons: ["WORK_RELEASE_OR_PAUSE"], strongestReason: "WORK_RELEASE_OR_PAUSE",
        terminalTarget: "SUCCEEDED",
      } }));
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_TARGET_MISMATCH", refusedBy: DAEMON_ATTEMPT_RELEASE,
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
      fixture.store, fixture.bound, fixture.record, releaseRequest({ reason: unknown }));
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_REASON_UNKNOWN", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expectNoDurableRow(fixture);
  });

  it("refuses a declared reason the disposition never unioned", () => {
    const fixture = activated("not-unioned");
    // A recognised reason that is absent from the disposition's own set: the
    // union step of design 348 was skipped, so the recorded `reason` and the
    // recorded `strongestReason` would describe two different releases.
    expect([...DRAIN_REASONS]).toContain("SUBMISSION_FINALIZE");
    expect([...RELEASE_DISPOSITION.reasons]).not.toContain("SUBMISSION_FINALIZE");
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      releaseRequest({ reason: "SUBMISSION_FINALIZE" }));
    expect(refusalOf(outcome)).toEqual({
      code: "ATTEMPT_RELEASE_REASON_NOT_UNIONED", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    expectNoDurableRow(fixture);
  });

  it("keeps the two coherence codes reachable through the runner's own predicate", () => {
    // A positive control for the discriminator itself: the retargeted case above
    // is only distinguishable because SOME declared target makes the disposition
    // monotonic. If the terminal-target vocabulary ever shrank to one member the
    // discriminator would silently collapse into one code.
    expect(DRAIN_TERMINAL_TARGETS.length).toBeGreaterThan(1);
    expect([...DRAIN_TERMINAL_TARGETS]).toContain("RELEASED");
  });

  it("refuses when the durable activation it must read is not there", () => {
    const fixture = activated("no-activation");
    const orphan: FoundationAttemptBound = Object.freeze({
      ...fixture.bound, aggregateId: `${ACTIVATION_AGGREGATE}-absent`,
      target: deriveAttemptReleaseAggregateId(`${ACTIVATION_AGGREGATE}-absent`),
    });
    const outcome =
      recordAttemptRelease(fixture.store, orphan, fixture.record, releaseRequest());
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
      recordAttemptRelease(fixture.store, fixture.bound, forged, releaseRequest());
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

describe("attempt release disposition — durable release facts", () => {
  it("records an unchanged strongest WORK_RELEASE_OR_PAUSE and reads every field back", () => {
    const fixture = activated("happy");
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, releaseRequest());
    expect(written.ok).toBe(true);
    // EVERY assertion below is against the READER's answer, never `written`.
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect(RELEASE_FIELDS.filter((field) => !(field in row))).toEqual([]);
    expect({
      attemptState: row["attemptState"], leaseRef: row["leaseRef"],
      leaseState: row["leaseState"], providerSlotRef: row["providerSlotRef"],
      providerSlotState: row["providerSlotState"], reason: row["reason"],
    }).toEqual({
      attemptState: fixture.record.attempt.state, leaseRef: fixture.record.lease.leaseId,
      leaseState: fixture.record.lease.state,
      providerSlotRef: fixture.record.providerSlot.slotRef,
      providerSlotState: fixture.record.providerSlot.state, reason: "WORK_RELEASE_OR_PAUSE",
    });
    expect(dispositionOf(row)).toEqual({
      resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
    });
    expect([row["recordVersion"], row["truthClass"], row["attemptAggregateId"]]).toEqual(
      [ATTEMPT_RELEASE_RECORD_VERSION, "DAEMON_VERIFIED", ACTIVATION_AGGREGATE]);
  });

  it("records a NON-RESUMABLE release under a different drain reason", () => {
    const fixture = activated("non-resumable");
    const other = "WORK_CANCEL";
    // The two reasons really are different members of the same frozen list, so
    // this case cannot pass by accidentally re-driving the resumable one.
    expect(other).not.toBe("WORK_RELEASE_OR_PAUSE");
    expect([...DRAIN_REASONS]).toContain(other);
    const written = recordAttemptRelease(fixture.store, fixture.bound, fixture.record, {
      disposition: {
        reasons: [other], strongestReason: other, terminalTarget: "CANCELLED",
      },
      reason: other,
    });
    expect(written.ok).toBe(true);
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect(row["reason"]).toBe(other);
    expect(dispositionOf(row)).toEqual({
      resumable: false, strongestReason: other, terminalTarget: "CANCELLED",
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
      lease: { ...fixture.record.lease, state: "RELEASED" },
      providerSlot: { ...fixture.record.providerSlot, state: "RELEASED" },
    };
    // The premise: the caller really is claiming something the store denies.
    expect([fixture.record.lease.state, fixture.record.providerSlot.state]).toEqual(
      ["ACTIVE", "ACTIVE"]);
    expect([claimed.lease.state, claimed.providerSlot.state]).toEqual(["RELEASED", "RELEASED"]);
    const written =
      recordAttemptRelease(fixture.store, fixture.bound, claimed, releaseRequest());
    // No layer refuses: the claim is not rejected, it is never consulted. The
    // identity is unchanged, so the binding guard has nothing to answer.
    expect(written.ok).toBe(true);
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["leaseState"], row["providerSlotState"]]).toEqual(["ACTIVE", "ACTIVE"]);
    expect([row["leaseRef"], row["providerSlotRef"]]).toEqual(
      [fixture.record.lease.leaseId, fixture.record.providerSlot.slotRef]);
  });

  it("keeps ABSENT and AMBIGUOUS distinct, because they demand opposite repairs", () => {
    const fixture = activated("cardinality");
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId)).code)
      .toBe("ATTEMPT_RELEASE_RECORD_ABSENT");
    expect(recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, releaseRequest()).ok).toBe(true);
    plantReleaseEvent(fixture, encoder.encode(JSON.stringify({ duplicate: true })), 1);
    expect(refusalOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId))).toEqual({
      code: "ATTEMPT_RELEASE_RECORD_AMBIGUOUS", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
  });

  it("cannot append a SECOND release to an attempt that already released", () => {
    const fixture = activated("second-release");
    expect(recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, releaseRequest()).ok).toBe(true);
    // A different disposition, so a second row would be observable rather than
    // an idempotent repeat of the first. The aggregate is written at
    // expectedVersion 0, so there is nowhere for it to land.
    const second = recordAttemptRelease(fixture.store, fixture.bound, fixture.record, {
      disposition: {
        reasons: ["WORK_CANCEL"], strongestReason: "WORK_CANCEL", terminalTarget: "CANCELLED",
      },
      reason: "WORK_CANCEL",
    });
    expect(refusalOf(second)).toEqual({
      code: "ATTEMPT_RELEASE_COMMIT_UNAVAILABLE", refusedBy: DAEMON_ATTEMPT_RELEASE,
    });
    // The FIRST release still stands and is still readable — the second attempt
    // neither overwrote it nor made the aggregate ambiguous.
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect(row["reason"]).toBe("WORK_RELEASE_OR_PAUSE");
  });

  it("reads the reason set through the frozen vocabulary, not the caller's array", () => {
    const fixture = activated("hostile-reasons");
    // A plain array carrying an own `includes` that lies and an own iterator
    // that would smuggle an unvalidated member into the durable row. Neither is
    // a key `parseDrainDisposition` inspects, so only re-reading the set through
    // DRAIN_REASONS and a borrowed builtin keeps the forgery out.
    const reasons: string[] = ["WORK_RELEASE_OR_PAUSE"];
    Object.defineProperty(reasons, "includes", { value: () => true });
    Object.defineProperty(reasons, Symbol.iterator, {
      value: function* smuggle(): Generator<string> { yield "NOT_A_DRAIN_REASON"; },
    });
    const outcome = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      releaseRequest({ disposition: {
        reasons, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
      } }));
    const row = rowOf(outcome);
    expect(row["reasons"]).toEqual(["WORK_RELEASE_OR_PAUSE"]);
    // The lying `includes` must not be what admitted the union check either: a
    // reason genuinely absent from the array is still refused.
    const other = activated("hostile-reasons-union");
    const refused = recordAttemptRelease(other.store, other.bound, other.record, {
      disposition: {
        reasons, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
      },
      reason: "SUBMISSION_FINALIZE",
    });
    expect(refusalOf(refused).code).toBe("ATTEMPT_RELEASE_REASON_NOT_UNIONED");
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
