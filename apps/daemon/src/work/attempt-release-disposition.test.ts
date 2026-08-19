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
import { encodeActivationLedgerRecord } from "../activation/activation-ledger-codec.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE, deriveActivationAggregateId,
} from "../activation/activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject, trackHarnessRoot,
} from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RELEASE_CODES, ATTEMPT_RELEASE_COMMAND_KIND, ATTEMPT_RELEASE_EVENT_TYPE,
  ATTEMPT_RELEASE_RECORD_VERSION, DAEMON_ATTEMPT_RELEASE, SCHEDULER_LEASE_DRAIN,
  SCHEDULER_PROVIDER_SLOT_RELEASE, deriveAttemptReleaseAggregateId, readAttemptRelease,
  recordAttemptRelease,
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
  const root = trackHarnessRoot(mkdtempSync(join(tmpdir(), `moe-release-${label}-`)));
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

/** The DECISIONS landed on the release aggregate, paged out of the store. A row
 *  count alone cannot see a decision committed with no event, and "zero release
 *  rows AND zero decisions" is what an all-or-none refusal has to mean. */
function releaseDecisionCount(fixture: Fixture): number {
  const target = deriveAttemptReleaseAggregateId(fixture.bound.aggregateId);
  let counted = 0;
  for (let cursor = 0n; ; ) {
    const page = fixture.store.readCommandDecisionsAfter(cursor, 100);
    counted += page.items.filter((item) => item.targetAggregateId === target).length;
    if (!page.hasMore || page.nextCursor === null) return counted;
    cursor = page.nextCursor;
  }
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

  it("adds NO daemon code for the slot layer, which carries the SCHEDULER's own", () => {
    // The roster stayed at seven. `releaseProviderSlot` refuses in the
    // scheduler's words, and `AttemptReleaseRefused.code` is already
    // `AttemptReleaseCode | AuthorityErrorCode`, so a daemon member for the slot
    // arms would be a dead entry that no path raises and that still reads as
    // coverage. Both scheduler codes are asserted ABSENT from the daemon list.
    expect(ATTEMPT_RELEASE_CODES.length).toBe(7);
    for (const carried of ["AUTHORITY_MALFORMED_INPUT", "AUTHORITY_STALE_LEASE"]) {
      expect([...ATTEMPT_RELEASE_CODES]).not.toContain(carried);
    }
  });

  it("names all THREE refusing layers, disjoint from the sibling dispatch layer", () => {
    expect(DAEMON_ATTEMPT_RELEASE).toBe("DAEMON_ATTEMPT_RELEASE");
    expect(SCHEDULER_LEASE_DRAIN).toBe("SCHEDULER_LEASE_DRAIN");
    expect(SCHEDULER_PROVIDER_SLOT_RELEASE).toBe("SCHEDULER_PROVIDER_SLOT_RELEASE");
    // Pairwise distinct, by hand. Two kernels refuse this path out of ONE
    // two-member code vocabulary, so the layer is the only thing that can tell a
    // slot that will not release from a lease that could not be fenced — and
    // DoD 3's "never restamped as a lease-drain refusal" rests on it.
    const layers = [
      DAEMON_ATTEMPT_RELEASE, SCHEDULER_LEASE_DRAIN, SCHEDULER_PROVIDER_SLOT_RELEASE,
    ];
    expect(new Set(layers).size).toBe(3);
    expect(SCHEDULER_PROVIDER_SLOT_RELEASE).not.toBe(SCHEDULER_LEASE_DRAIN);
    expect(SCHEDULER_PROVIDER_SLOT_RELEASE).not.toBe(DAEMON_ATTEMPT_RELEASE);
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
      // All three states are the SAFE-BOUNDARY TRANSACTION OUTCOME now, never the
      // activation slice: the slot ref is the one the kernel's successor names.
      attemptState: "RELEASED", leaseRef: fixture.record.lease.leaseId,
      providerSlotRef: fixture.record.providerSlot.slotRef,
      providerSlotState: "RELEASED", reason: "WORK_RELEASE_OR_PAUSE",
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

  it("records attempt, lease AND provider slot RELEASED in the ONE decision", () => {
    const fixture = activated("three-states");
    // THE DEFECT THIS CASE CORRECTS. The row used to copy the ACTIVATION SLICE
    // into two of these three fields, so a settled release durably claimed a
    // RUNNING attempt holding an ACTIVE provider slot. Stated as a premise
    // because it is also what stops the assertion below passing by echo: if
    // either slice ever equalled "RELEASED" this case would prove nothing.
    expect([fixture.record.attempt.state, fixture.record.providerSlot.state])
      .toEqual(["RUNNING", "ACTIVE"]);
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    // ONE decision, and every state below is read out of its canonical durable
    // bytes through the module's own reader. Nothing here consults `written`.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect({
      attemptState: row["attemptState"], leaseState: row["leaseState"],
      providerSlotState: row["providerSlotState"],
    }).toEqual({
      attemptState: "RELEASED", leaseState: "RELEASED", providerSlotState: "RELEASED",
    });
    // Stated as a DIFFERENCE as well as a value: a body that reverted to the
    // activation slice would satisfy neither half.
    expect(row["attemptState"]).not.toBe(fixture.record.attempt.state);
    expect(row["providerSlotState"]).not.toBe(fixture.record.providerSlot.state);
    // The released row still names the SAME slot and attempt the activation
    // bound, so the transition happened to this attempt and not beside it.
    expect([row["providerSlotRef"], row["attemptRef"]]).toEqual([
      fixture.record.providerSlot.slotRef, fixture.record.attempt.attemptId,
    ]);
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
      providerSlot: {
        ...fixture.record.providerSlot, slotRef: "slot-forged", state: "RESERVED",
      },
    };
    // The premise: the caller really is claiming something the store denies. A
    // REVOKED lease would make the kernel answer NO_OP and write nothing at all,
    // and a RESERVED slot is one the slot kernel REFUSES to release — so if the
    // caller's copy reached either the command or the row, this case could not
    // end in a released row naming the durable slot.
    expect([fixture.record.lease.state, fixture.record.providerSlot.state]).toEqual(
      ["ACTIVE", "ACTIVE"]);
    expect([claimed.lease.state, claimed.providerSlot.state]).toEqual(["REVOKED", "RESERVED"]);
    expect(claimed.providerSlot.slotRef).not.toBe(fixture.record.providerSlot.slotRef);
    const written =
      recordAttemptRelease(fixture.store, fixture.bound, claimed, settledRequest());
    // No layer refuses: the claim is not rejected, it is never consulted. The
    // identity is unchanged, so the binding guard has nothing to answer.
    expect(written.ok && written.outcome).toBe("RELEASED");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    // RELEASED because the DURABLE slot was ACTIVE and the kernel transitioned
    // it — not because the caller claimed RELEASED. The caller's copy reached
    // neither the command nor the row: the identical value is a coincidence the
    // slot-refusal cases below break apart.
    expect([row["leaseState"], row["providerSlotState"]]).toEqual(["RELEASED", "RELEASED"]);
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
      // DRAINING NEVER UPGRADES THE ATTEMPT OR THE SLOT. The attempt records the
      // kernel's own DRAINING outcome, and the provider slot is RETAINED exactly
      // as the activation left it — a slot transition is never attempted on an
      // unsettled boundary, so a DRAINING row cannot claim safe release.
      expect(row["attemptState"]).toBe("DRAINING");
      expect(row["providerSlotState"]).not.toBe("RELEASED");
      expect(row["providerSlotState"]).toBe("ACTIVE");
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
      // `attemptState` and `providerSlotState` belong in this list and did not
      // before: while they copied the activation slice the two rows agreed on
      // them, which is exactly the bug — a DRAINING and a RELEASED row cannot
      // honestly describe the same attempt and slot state.
      "attemptState", "handoff", "intentRefs", "lease", "leaseState", "outcome",
      "providerSlotState", "releasePending", "resumable",
    ]);
    expect([released["attemptState"], released["providerSlotState"]])
      .toEqual(["RELEASED", "RELEASED"]);
    expect([draining["attemptState"], draining["providerSlotState"]])
      .toEqual(["DRAINING", "ACTIVE"]);
    // And every OTHER field is genuinely identical, so the two rows describe the
    // same attempt rather than two unrelated releases that happen to disagree.
    expect([draining["attemptAggregateId"], draining["reason"], draining["attemptRef"],
      draining["providerSlotRef"]]).toEqual([released["attemptAggregateId"],
      released["reason"], released["attemptRef"], released["providerSlotRef"]]);
  });
});

/**
 * A REAL production activation whose PROVIDER-SLOT FACT ALONE has drifted,
 * resealed through the production codec and committed as sequence 1 of a fresh
 * store's activation aggregate.
 *
 * The production activation path always leaves the slot ACTIVE and bound to the
 * attempt, so no honest fixture can reach the slot kernel's refusing guards at
 * all. Nothing here is invented to get there: the grant, the digest, the lease,
 * the attempt and both version arithmetics come from `runEffectActivateCommand`
 * and are carried verbatim, so the strict activation reader accepts the planted
 * event and `releaseWork` fences against a genuine lease. The CONTROL case below
 * drifts nothing and releases cleanly, which is what proves a refusal here is
 * the slot guard's answer and not the planting's.
 */
function plantedSlot(label: string, providerSlot: unknown): Fixture {
  const source = activated(`${label}-source`);
  const encoded = encodeActivationLedgerRecord({ ...source.record, providerSlot });
  if (!encoded.ok) throw new Error(`the production codec refused the drift: ${encoded.code}`);
  const root = trackHarnessRoot(mkdtempSync(join(tmpdir(), `moe-release-${label}-`)));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  const committed = store.commitExpectedVersionDecision({
    commandKind: EFFECT_ACTIVATE_COMMAND_KIND, committedResultBytes: encoded.bytes,
    correlationId: `corr-plant-${label}`, decidedAt: DECIDED_AT,
    // The event id IS the grant id, which is what the strict reader cross-checks.
    events: [{
      eventId: source.record.grant.grantId, eventType: ACTIVATION_LEDGER_EVENT_TYPE,
      payload: encoded.bytes,
    }],
    expectedVersion: 0,
    key: { commandId: `cmd-plant-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: encoded.bytes, targetAggregateId: ACTIVATION_AGGREGATE,
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`planting refused: ${committed.decision.effectDisposition}`);
  }
  const history = readFoundationActivationHistory(
    ACTIVATION_AGGREGATE, store.readEvents(ACTIVATION_AGGREGATE), PROJECT_ID);
  if (!history.ok) {
    throw new Error(`the planted activation is unreadable: ${history.result.status}`);
  }
  return { bound: source.bound, record: history.history.record, store };
}

/** The slot the production activation actually commits: ACTIVE and attempt-bound. */
const ACTIVATED_SLOT = Object.freeze({
  attemptRef: "attempt-1", dimension: "default", requestId: "req-1", slotRef: "slot-1",
  state: "ACTIVE",
});

function refusalWithMessage(
  outcome: AttemptReleaseOutcome,
): { code: string; message: string | null; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, received a recorded row");
  return { code: outcome.code, message: outcome.message, refusedBy: outcome.refusedBy };
}

describe("attempt release disposition — the slot transition is all-or-none", () => {
  it("releases the planted CONTROL, so a refusal below is the SLOT guard's", () => {
    const fixture = plantedSlot("slot-control", { ...ACTIVATED_SLOT });
    // The premise the whole planting rests on: an undrifted plant is byte-for-byte
    // the activation the production path commits.
    expect(fixture.record.providerSlot).toEqual(ACTIVATED_SLOT);
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["attemptState"], row["leaseState"], row["providerSlotState"]])
      .toEqual(["RELEASED", "RELEASED", "RELEASED"]);
  });

  it("derives the slot identity from the DURABLE slot, not from a constant", () => {
    // Drifting the slot ref alone still RELEASES, because the command follows the
    // durable slot. A daemon that named the slot any other way would refuse here
    // — and the recorded ref is the drifted one, read back out of durable bytes.
    const fixture = plantedSlot("slot-identity", { ...ACTIVATED_SLOT, slotRef: "slot-moved" });
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["providerSlotRef"], row["providerSlotState"]])
      .toEqual(["slot-moved", "RELEASED"]);
  });

  it("ACCEPTS an already-RELEASED slot, which is the kernel's NO_OP arm", () => {
    // The slot kernel is three-way like `releaseWork`: a settled slot REPLAYS as
    // an acceptance rather than an error. A daemon that tightened DoD 3's
    // refusal list into "only an ACTIVE slot may be released" would refuse a
    // perfectly honest replay and strand the release — so the accepting arm is
    // pinned as deliberately as the refusing ones.
    const fixture = plantedSlot("slot-settled", { ...ACTIVATED_SLOT, state: "RELEASED" });
    expect(fixture.record.providerSlot.state).toBe("RELEASED");
    const written = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(written.ok && written.outcome).toBe("RELEASED");
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["attemptState"], row["leaseState"], row["providerSlotState"]])
      .toEqual(["RELEASED", "RELEASED", "RELEASED"]);
  });

  /** Every refusing drift, with the SCHEDULER's own words. `refuse()` stamps
   *  AUTHORITY_STALE_LEASE on all four of its guards, so the code alone would be
   *  the same assertion written four times: the message is the discriminator. */
  const SLOT_REFUSALS = [
    {
      code: "AUTHORITY_MALFORMED_INPUT",
      message: "releaseProviderSlot received a malformed slot record or command",
      name: "a slot state outside the frozen vocabulary", slot: { state: "SUSPENDED" },
    },
    {
      code: "AUTHORITY_STALE_LEASE",
      message: "release names a different attempt than the provider slot binding",
      name: "a slot bound to a DIFFERENT attempt", slot: { attemptRef: "attempt-other" },
    },
    {
      code: "AUTHORITY_STALE_LEASE",
      message: "release names a different attempt than the provider slot binding",
      // `null` is a real parsed value on a never-activated slot, and the kernel
      // treats it as a binding, not a wildcard.
      name: "an UNBOUND slot, whose null attemptRef is not a wildcard",
      slot: { attemptRef: null },
    },
    {
      code: "AUTHORITY_STALE_LEASE",
      message: "a provider slot in state RESERVED cannot be released",
      name: "a slot still RESERVED", slot: { state: "RESERVED" },
    },
  ] as const;

  it.each(SLOT_REFUSALS)("refuses under the slot layer for $name", (arm) => {
    const fixture = plantedSlot(`slot-refuse-${arm.name.slice(0, 12)}`,
      { ...ACTIVATED_SLOT, ...arm.slot });
    const outcome = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    // THE LAYER IS THE DISCRIMINATOR. `releaseWork` returns the SAME two codes,
    // so a slot refusal restamped as a lease-drain refusal would be invisible in
    // the code alone — and it demands the opposite repair.
    expect(refusalWithMessage(outcome)).toEqual({
      code: arm.code, message: arm.message, refusedBy: SCHEDULER_PROVIDER_SLOT_RELEASE,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusedBy).not.toBe(SCHEDULER_LEASE_DRAIN);
    // ALL-OR-NONE. A handler that wrote the row and then refused is identical to
    // a clean refusal from the return value alone, so both are counted out of
    // the store — and a decision with no event would escape the row count.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([0, 0]);
    expectNoDurableRow(fixture);
  });

  it("drives every refusing drift and keeps their messages apart", () => {
    // A table that generated nothing passes `it.each` vacuously.
    expect(SLOT_REFUSALS.length).toBe(4);
    // Three DISTINCT messages over four arms: the two attempt-binding arms are
    // different inputs reaching one guard, and the other two guards are separate.
    expect(new Set(SLOT_REFUSALS.map((arm) => arm.message)).size).toBe(3);
    // The code cannot tell the state guard from the binding guard.
    expect(new Set(SLOT_REFUSALS.map((arm) => arm.code)).size).toBe(2);
  });
});

describe("attempt release disposition — replay and cardinality", () => {
  it("answers the kernel's NO_OP on replay and leaves EXACTLY ONE durable row", () => {
    const fixture = activated("replay");
    const first = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    expect(first.ok && first.outcome).toBe("RELEASED");
    // The RAW counts before the replay: events on the aggregate and decisions
    // targeting it. "The second call did not throw" is also what a double write
    // looks like, and a decision landed with no event escapes a row count.
    const before = [durableRowCount(fixture), releaseDecisionCount(fixture)];
    expect(before).toEqual([1, 1]);
    // A DIFFERENT disposition, so a second row would be observable rather than an
    // idempotent repeat. The recorded lease is already RELEASED, so `releaseWork`
    // answers NO_OP and the daemon writes nothing.
    const replay = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ reason: "WORK_CANCEL" }));
    expect(replay.ok && replay.outcome).toBe("NO_OP");
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual(before);
    // The FIRST release still stands, unchanged, and is still the durable answer.
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["reason"], row["outcome"], row["leaseState"]])
      .toEqual(["WORK_RELEASE_OR_PAUSE", "RELEASED", "RELEASED"]);
    // Including the three states this task composes: a replay that recomposed
    // them would answer the SECOND call's slot transition, not the first's.
    expect([row["attemptState"], row["providerSlotState"]]).toEqual(["RELEASED", "RELEASED"]);
    expect(rowOf(replay)).toEqual(row);
  });

  it("refuses a LATER DIVERGENT slot fact before it can write a second row", () => {
    // A durable slot that is still RESERVED, with a first release that never
    // reached it: an unsettled boundary drains the lease and leaves the slot
    // alone, so the row records the RESERVED fact honestly.
    const fixture = plantedSlot("divergent-slot", { ...ACTIVATED_SLOT, state: "RESERVED" });
    const first = recordAttemptRelease(fixture.store, fixture.bound, fixture.record,
      settledRequest({ safeBoundaryObserved: false }));
    expect(first.ok && first.outcome).toBe("DRAINING");
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
    expect(rowOf(first)["providerSlotState"]).toBe("RESERVED");

    // DRAINING is not terminal, so `releaseWork` composes a real RELEASED
    // transition on the second call — and the slot it would have to release is
    // one the slot kernel refuses. The refusal must land BEFORE the commit.
    const second = recordAttemptRelease(
      fixture.store, fixture.bound, fixture.record, settledRequest());
    // THIS CODE IS THE ORDERING PROOF. Committing first and releasing the slot
    // afterwards would answer ATTEMPT_RELEASE_COMMIT_UNAVAILABLE under the daemon
    // layer instead — the aggregate is written at expectedVersion 0, so the
    // second commit fails for its own unrelated reason and buries this one.
    expect(refusalWithMessage(second)).toEqual({
      code: "AUTHORITY_STALE_LEASE",
      message: "a provider slot in state RESERVED cannot be released",
      refusedBy: SCHEDULER_PROVIDER_SLOT_RELEASE,
    });
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
    // The FIRST row survives untouched: no partial authority outlived the refusal.
    const row = rowOf(readAttemptRelease(fixture.store, fixture.bound.aggregateId));
    expect([row["outcome"], row["attemptState"], row["providerSlotState"]])
      .toEqual(["DRAINING", "DRAINING", "RESERVED"]);
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
    // Conflicting bytes refuse BEFORE a second write, decisions included.
    expect([durableRowCount(fixture), releaseDecisionCount(fixture)]).toEqual([1, 1]);
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
