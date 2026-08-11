/**
 * Package-ROOT reachability contract for the claim-composition surface.
 *
 * Every specifier here is the bare package root `@moe/scheduler`: the package
 * `exports` map is exclusive, so a deep subpath would not resolve for a real
 * consumer and testing one would prove nothing. The expected namespace below is
 * hand-transcribed, never derived from the namespace under test, so a removed
 * export AND an unreviewed addition both go red.
 */
import { expect, it } from "vitest";

import * as scheduler from "@moe/scheduler";
import type {
  AuthorityErrorCode, AuthorityIssue, AuthorityOutcome, AuthorityProof, AuthorityRejection,
  ClockObservation, Fenced, LeaseKind, LeaseRecord, LeaseState, RejectionSecurityRecord,
} from "@moe/scheduler";
import type {
  AcquisitionFailure, AcquisitionSet, AcquisitionState, DeclaredResource,
  ProviderSlotReservation, ReserveAllRequest, ReserveAllResult, ResourceRow, ResourceWaitRequest,
  SlotState,
} from "@moe/scheduler";
import type {
  AdmissionAmount, AdmissionGate, AdmissionHumanApproval, AdmissionPolicyAllowance,
  AdmissionPurpose, AdmissionRequest, BudgetAvailableView, BudgetReservationIssue,
  BudgetReservationIssueCode, BudgetReservationResult, ReservationActivateCommand,
  ReservationCancelCommand, ReservationLine, ReservationRecord, ReservationState,
} from "@moe/scheduler";
import type {
  BudgetAccountState, BudgetMeterBuckets, BudgetPolicyOutcome, BudgetReservePurpose,
} from "@moe/scheduler";
import type {
  FairnessBypassClaim, FairnessCapMigration, FairnessCapRevision, FairnessContractIssue,
  FairnessContractIssueCode, FairnessContractLayer, FairnessContractRefusal,
  FairnessContractResult, FairnessDispatchabilityFact, FairnessDispatchabilityState,
  FairnessOpportunityAttestation, FairnessPriorityClass, FairnessProvenBypasses, FairnessRing,
  FairnessRingQueueEntry, FairnessRingResource, FairnessWorkItem,
} from "@moe/scheduler";
import type {
  FairnessAgedStanding, FairnessResourceCapacity, FairnessRotationDisposition,
  FairnessRotationInputs, FairnessRotationOutcome, FairnessRotationSelection,
} from "@moe/scheduler";
import type {
  SupersessionBoundDispositionField, SupersessionBudgetFacts, SupersessionCarryRefusal,
  SupersessionDispositionFamily, SupersessionDispositionLayer, SupersessionDispositionResult,
  SupersessionDispositionSet, SupersessionFamilyDisposition,
  SupersessionNodeFacts, SupersessionRefusalCode, SupersessionResourceFacts,
} from "@moe/scheduler";
import type {
  DerivedExpansionEvidence, ExpansionAdmissionIssue, ExpansionAdmissionIssueCode,
  ExpansionAdmissionOrigin, ExpansionAdmissionRefusal, ExpansionAdmissionRequest,
  ExpansionAdmissionResult, ExpansionAdmissionUnwind, ExpansionBoundFacts, ExpansionBudgetFacts,
  ExpansionCapacityFact, ExpansionChildFacts, ExpansionEvidenceIssue, ExpansionEvidenceIssueCode,
  ExpansionEvidenceLayer, ExpansionEvidenceRefusal, ExpansionEvidenceResult, ExpansionFairnessFacts,
  ExpansionInputFact, ExpansionLineageFacts, ExpansionPreparation, ExpansionResourceFacts,
  ExpansionRestoredMeter,
} from "@moe/scheduler";

type ExportKind = "array" | "function" | "number" | "record";
/**
 * Hand-transcribed: 17 pre-existing graph values + 19 approved claim-composition
 * values + 11 fairness contract values + 6 supersession disposition values +
 * 12 fairness rotation and aging values + 7 expansion admission values.
 */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["ABSOLUTE_MAX_GRAPH_HARD_EDGES", "number"], ["ABSOLUTE_MAX_GRAPH_NODES", "number"],
  ["ABSOLUTE_MAX_GRAPH_TOTAL_EDGES", "number"], ["ADMISSION_PURPOSES", "array"],
  ["ADMISSION_PURPOSE_RESERVE_CONTRACT", "record"], ["BUDGET_RESERVATION_ISSUE_CODES", "array"],
  ["DEFAULT_GRAPH_POLICY", "record"], ["DEFAULT_MAX_HARD_EDGES", "number"],
  ["DEFAULT_MAX_NODES", "number"], ["DEFAULT_MAX_TOTAL_EDGES", "number"],
  ["EXPANSION_ADMISSION_ISSUE_CODES", "array"], ["EXPANSION_ADMISSION_ORIGINS", "array"],
  ["EXPANSION_EVIDENCE_ISSUE_CODES", "array"], ["EXPANSION_EVIDENCE_LAYERS", "array"],
  ["FAIRNESS_BYPASSES_PER_LEVEL", "number"],
  ["FAIRNESS_CONTRACT_ISSUE_CODES", "array"], ["FAIRNESS_CONTRACT_LAYERS", "array"],
  ["FAIRNESS_DIMENSION_CEILING", "number"],
  ["FAIRNESS_DISPATCHABILITY_STATES", "array"],
  ["FAIRNESS_FORCED_BYPASS_BOUND", "number"], ["FAIRNESS_PRIORITY_CLASSES", "array"],
  ["FAIRNESS_PRIORITY_LADDER", "array"], ["FAIRNESS_ROTATION_DISPOSITIONS", "array"],
  ["FAIRNESS_SERVICE_COST", "number"], ["FORBIDDEN_VERDICT_KEYS", "array"],
  ["GraphAnalysisError", "function"], ["MAX_GRAPH_KEY_CODE_UNITS", "number"],
  ["MIN_GATED_DESCENDANTS_FOR_REVIEW", "number"], ["PROTECTED_ADMISSION_PURPOSES", "array"],
  ["RESERVATION_STATES", "array"], ["SLOT_STATES", "array"],
  ["SUPERSESSION_BOUND_DISPOSITION_FIELDS", "array"],
  ["SUPERSESSION_DISPOSITION_FAMILIES", "array"],
  ["SUPERSESSION_DISPOSITION_LAYERS", "array"], ["SUPERSESSION_REFUSAL_CODES", "array"],
  ["activateReservation", "function"], ["adapterConfirm", "function"],
  ["adapterFail", "function"], ["admitExpansion", "function"], ["ageWorkItem", "function"],
  ["analyzeGraphStructure", "function"],
  ["analyzeHardEdgeCounterfactuals", "function"],
  ["buildSupersessionDispositions", "function"], ["bypassesToForced", "function"],
  ["cancelReservation", "function"],
  ["carryWaitProjection", "function"],
  ["createTraversalCounter", "function"], ["deriveExpansionEvidence", "function"],
  ["deriveReservationId", "function"],
  ["fenceAuthority", "function"], ["grantSuccessorCapacity", "function"],
  ["isFairnessIdentity", "function"],
  ["parseClock", "function"], ["parseLeaseRecord", "function"], ["parseProof", "function"],
  ["partitionFrontier", "function"], ["previewGraphSnapshot", "function"],
  ["reserveAll", "function"], ["reserveForAdmission", "function"],
  ["reserveProviderSlot", "function"], ["resolveGraphPolicy", "function"],
  ["resourceRotationOrder", "function"], ["rotateOnce", "function"],
  ["validateBypassClaim", "function"], ["validateCapRevision", "function"],
  ["validateGraphSnapshot", "function"], ["validateResourceCapacity", "function"],
  ["validateRing", "function"],
  ["validateRingResource", "function"], ["validateRotationRequest", "function"],
  ["validateWorkItem", "function"],
  ["validateWorkItemSet", "function"],
];
const surface: Readonly<Record<string, unknown>> = scheduler;

it("generates one expectation per published root export", () => {
  expect(EXPECTED_EXPORTS.length).toBe(72);
});

it("publishes exactly the reviewed root namespace, with no loss and no addition", () => {
  expect(Object.keys(scheduler).sort()).toEqual(EXPECTED_EXPORTS.map(([name]) => name));
});

it.each(EXPECTED_EXPORTS)("publishes %s on the package root as a %s", (name, kind) => {
  const value = surface[name];
  if (kind === "array") expect(Array.isArray(value)).toBe(true);
  else if (kind === "record") expect(typeof value === "object" && !Array.isArray(value)).toBe(true);
  else expect(typeof value).toBe(kind);
});

const DIGEST = "a".repeat(64);
const LOCAL: DeclaredResource =
  { resourceId: "res:local", capacityUnits: 1, external: false, fenceable: true };
const EXTERNAL: DeclaredResource =
  { resourceId: "res:remote", capacityUnits: 1, external: true, fenceable: true };
const RESERVE_REQUEST: ReserveAllRequest = {
  requestId: "req:1", declaredResources: [LOCAL, EXTERNAL],
  capacitySnapshot: { "res:local": 4, "res:remote": 4 }, epoch: 1,
  eligibilityEventSequenceRef: "seq:1", continuouslyEligibleSinceRef: "since:1",
  callerObservation: "obs:1",
};
const LEASE: LeaseRecord = {
  leaseId: "lease:1", kind: "ASSIGNMENT" satisfies LeaseKind, ownerSessionRef: "session:1",
  leaseToken: "token:1", epoch: 3, state: "ACTIVE" satisfies LeaseState, serverWallDeadline: 90,
  bootId: "boot:1", monotonicObservation: 12, authorityHashRef: DIGEST, version: 7,
};
const PROOF: AuthorityProof = {
  leaseToken: "token:1", epoch: 3, authorityHashRef: DIGEST, ownerSessionRef: "session:1",
  expectedVersion: 7,
};
const LEGAL_STATES: readonly LeaseState[] = ["ACTIVE"];

/** Names every arm of AuthorityOutcome without any deep import. */
function authorityCodes(outcome: AuthorityOutcome<unknown>): readonly AuthorityErrorCode[] {
  if (outcome.ok) return [];
  const rejection: AuthorityRejection = outcome;
  const record: RejectionSecurityRecord | null = rejection.securityRecord;
  expect(record === null || record.aggregateKind === "LEASE").toBe(true);
  return rejection.issues.map((issue: AuthorityIssue): AuthorityErrorCode => issue.code);
}
function reservedRows(outcome: AuthorityOutcome<ReserveAllResult>): readonly ResourceRow[] {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return [];
  const result: ReserveAllResult = outcome.value;
  if (result.outcome === "WAITING") {
    const waiting: ResourceWaitRequest = result.waitRequest;
    throw new Error(`unexpected wait for ${waiting.requestId}`);
  }
  return result.rows;
}
function acquisitionSet(outcome: AuthorityOutcome<AcquisitionSet>): AcquisitionSet {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(authorityCodes(outcome).join(","));
  return outcome.value;
}

it("reserves and confirms an acquisition set through the root exports", () => {
  const rows = reservedRows(scheduler.reserveAll(RESERVE_REQUEST));
  const states: readonly AcquisitionState[] = rows.map((row) => row.state);
  expect(rows.map((row) => row.resourceId)).toEqual(["res:local", "res:remote"]);
  expect(states).toEqual(["ACTIVE", "PENDING_ACQUIRE"]);
  const confirmed = acquisitionSet(scheduler.adapterConfirm(rows, "res:remote", 1));
  expect(confirmed.allActive).toBe(true);
  const slot: AuthorityOutcome<ProviderSlotReservation> =
    scheduler.reserveProviderSlot(confirmed.rows, "slot:1", "req:1");
  expect(slot.ok).toBe(true);
  const state: SlotState = slot.ok ? slot.value.state : "RELEASED";
  expect(state).toBe("RESERVED");
  expect(scheduler.SLOT_STATES).toContain(state);
});

it("quarantines an unknown adapter failure and clears it with a proof", () => {
  const rows = reservedRows(scheduler.reserveAll(RESERVE_REQUEST));
  const disposition: AcquisitionFailure = "UNKNOWN";
  const held = acquisitionSet(scheduler.adapterFail(rows, "res:remote", 1, disposition));
  expect(held.held).toBe(true);
  expect(held.rows.some((row) => row.state === "QUARANTINED")).toBe(true);
  const cleared = acquisitionSet(scheduler.grantSuccessorCapacity(held.rows, "proof:1"));
  expect(cleared.rows.every((row) => row.state === "RELEASED")).toBe(true);
});

it("reports AUTHORITY_MALFORMED_INPUT from the root reserveAll on hostile input", () => {
  expect(authorityCodes(scheduler.reserveAll(null))).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
});

it("fences a current proof and names both Fenced arms from the root", () => {
  const fenced: Fenced = scheduler.fenceAuthority(LEASE, PROOF, "surface", LEGAL_STATES);
  expect(fenced.ok).toBe(true);
  if (!fenced.ok) throw new Error("expected a fenced authority");
  const lease: LeaseRecord = fenced.lease;
  const proof: AuthorityProof = fenced.proof;
  expect([lease.leaseId, proof.leaseToken]).toEqual(["lease:1", "token:1"]);
});

it("rejects a stale epoch with AUTHORITY_STALE_EPOCH and a redacted security record", () => {
  const stale: Fenced =
    scheduler.fenceAuthority(LEASE, { ...PROOF, epoch: 2 }, "surface", LEGAL_STATES);
  expect(stale.ok).toBe(false);
  if (stale.ok) throw new Error("expected a rejection");
  const rejection: AuthorityRejection = stale.rejection;
  expect(rejection.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_STALE_EPOCH"]);
  const record: RejectionSecurityRecord | null = rejection.securityRecord;
  expect(record?.code).toBe("AUTHORITY_STALE_EPOCH");
  expect(record).not.toHaveProperty("leaseToken");
});

it("parses lease, proof, and clock shapes from the root and refuses hostile input", () => {
  const parsedLease: LeaseRecord | null = scheduler.parseLeaseRecord(LEASE);
  const parsedProof: AuthorityProof | null = scheduler.parseProof(PROOF);
  const clock: ClockObservation | null =
    scheduler.parseClock({ serverWallSeconds: 10, bootId: "boot:1", monotonicObservation: 12 });
  expect([parsedLease?.state, parsedProof?.epoch, clock?.bootId]).toEqual(["ACTIVE", 3, "boot:1"]);
  expect([scheduler.parseLeaseRecord(null), scheduler.parseProof(null), scheduler.parseClock(null)])
    .toEqual([null, null, null]);
});

const METER: BudgetMeterBuckets =
  { meter: "usd", available: 100, reserved: 0, quarantined: 0, committed: 0 };
const VIEW: BudgetAvailableView = {
  accountId: "account:1", state: "OPEN" satisfies BudgetAccountState, version: 4, meters: [METER],
};
/** Hand-transcribed rather than mapped over ADMISSION_PURPOSES: a fixture derived from an
 * export under test collapses the whole file when that export goes missing, hiding the
 * per-name assertions that are supposed to report the loss. */
const PURPOSES: readonly AdmissionPurpose[] =
  ["EXECUTION", "VERIFICATION", "INDEPENDENT_REVIEW", "FINAL_ACCEPTANCE", "CONTINGENCY"];
const LINES: readonly AdmissionAmount[] =
  PURPOSES.map((purpose): ReservationLine => ({ purpose, meter: "usd", quantity: 2 }));
const ADMISSION: AdmissionRequest =
  { admissionRef: "admission:1", expectedVersion: 4, amounts: LINES };
const ALLOWANCE: AdmissionPolicyAllowance =
  { decisionRef: "decision:1", outcome: "ALLOW" satisfies BudgetPolicyOutcome };
const APPROVAL: AdmissionHumanApproval =
  { approvalRef: "approval:1", decision: "APPROVE", validity: "CURRENT" };
const GATE: AdmissionGate = { allowance: ALLOWANCE, approval: APPROVAL };

/** Names every arm of BudgetReservationResult without any deep import. */
function reservationOf(result: BudgetReservationResult): ReservationRecord {
  if (!result.ok) {
    const codes = result.issues.map((issue: BudgetReservationIssue) => issue.code);
    throw new Error(codes.join(","));
  }
  const view: BudgetAvailableView = result.view;
  expect(view.accountId).toBe("account:1");
  return result.reservation;
}
function issueCodes(result: BudgetReservationResult): readonly BudgetReservationIssueCode[] {
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  const held: ReservationRecord | null = result.reservation;
  expect(held === null || held.accountId === "account:1").toBe(true);
  return result.issues.map((issue: BudgetReservationIssue) => issue.code);
}

/** The refund is checked against the view the admission returned, not the one it consumed. */
function heldView(result: BudgetReservationResult): BudgetAvailableView {
  expect(result.ok).toBe(true);
  return result.view;
}

it("reserves, activates, and cancels an admission through the root exports", () => {
  const admitted = scheduler.reserveForAdmission(VIEW, ADMISSION, GATE);
  const reserved = reservationOf(admitted);
  const held = heldView(admitted);
  const state: ReservationState = reserved.state;
  expect(state).toBe("RESERVED");
  expect(reserved.reservationId).toBe(scheduler.deriveReservationId("account:1", "admission:1"));
  expect(scheduler.RESERVATION_STATES).toContain(state);
  const activate: ReservationActivateCommand = { expectedVersion: 0, attemptRef: "attempt:1" };
  expect(reservationOf(scheduler.activateReservation(held, reserved, activate)).state)
    .toBe("ACTIVATED");
  const cancel: ReservationCancelCommand =
    { expectedVersion: 0, neverStartedProofRef: "never:1" };
  expect(reservationOf(scheduler.cancelReservation(held, reserved, cancel)).state)
    .toBe("CANCELLED");
});

it("refuses a cancellation with no never-started proof by its own reason code", () => {
  const admitted = scheduler.reserveForAdmission(VIEW, ADMISSION, GATE);
  const cancel: ReservationCancelCommand = { expectedVersion: 0, neverStartedProofRef: null };
  expect(issueCodes(scheduler.cancelReservation(heldView(admitted), reservationOf(admitted), cancel)))
    .toEqual(["BUDGET_RESERVATION_NEVER_STARTED_PROOF_MISSING"]);
});

it("refuses a malformed admission view with BUDGET_RESERVATION_MALFORMED", () => {
  const hostile = null as unknown as BudgetAvailableView;
  expect(issueCodes(scheduler.reserveForAdmission(hostile, ADMISSION, GATE)))
    .toEqual(["BUDGET_RESERVATION_MALFORMED"]);
});

/**
 * Fairness contracts. A published TYPE is invisible to the count and namespace
 * guards above, which see runtime values only, so each one is proven by calling
 * through the bare specifier and annotating the returned value — an unpublished
 * type becomes a tsc error rather than a silently green test.
 */
const DISPATCHABILITY: FairnessDispatchabilityFact =
  { state: "DISPATCHABLE" satisfies FairnessDispatchabilityState, observationRef: "obs:wi-a" };
const FAIR_ITEM = {
  workItemId: "wi-a", dimensionId: "dim-1",
  priority: "P1" satisfies FairnessPriorityClass, resourceId: "res-a",
  dispatchability: DISPATCHABILITY,
};

/** Names both arms of the result union without any deep import. */
function fairnessCodes(
  result: FairnessContractResult<unknown>,
): readonly FairnessContractIssueCode[] {
  if (result.ok) return [];
  const refusal: FairnessContractRefusal = result;
  return refusal.issues.map(
    (issue: FairnessContractIssue): FairnessContractIssueCode => issue.code,
  );
}

it("validates every fairness family through the root exports", () => {
  const item = scheduler.validateWorkItem(FAIR_ITEM);
  if (!item.ok) throw new Error(fairnessCodes(item).join(","));
  const validated: FairnessWorkItem = item.value;
  expect([validated.workItemId, validated.dispatchability.observationRef])
    .toEqual(["wi-a", "obs:wi-a"]);
  expect(scheduler.validateWorkItemSet([FAIR_ITEM], "dim-1").ok).toBe(true);
  expect(scheduler.isFairnessIdentity("wi-a")).toBe(true);

  const ringResult = scheduler.validateRing({
    ringId: "ring-1", dimensionId: "dim-1",
    resources: [{ resourceId: "res-a", weight: 1 }],
    entries: [{ workItemId: "wi-a", resourceId: "res-a", deficitCounter: 0 }],
  });
  if (!ringResult.ok) throw new Error(fairnessCodes(ringResult).join(","));
  const ring: FairnessRing = ringResult.value;
  const resources: readonly FairnessRingResource[] = ring.resources;
  const entries: readonly FairnessRingQueueEntry[] = ring.entries;
  expect([resources.length, entries.length]).toEqual([1, 1]);
  expect(scheduler.validateRingResource(resources[0]).ok).toBe(true);

  const attestation: FairnessOpportunityAttestation =
    { opportunityRef: "opp-1", winnerWorkItemId: "wi-b", observationRef: "obs-1" };
  const claim: FairnessBypassClaim =
    { workItemId: "wi-a", claimedBypasses: 1, attestations: [attestation] };
  const proven = scheduler.validateBypassClaim(claim);
  if (!proven.ok) throw new Error(fairnessCodes(proven).join(","));
  const bypasses: FairnessProvenBypasses = proven.value;
  expect(bypasses.provenBypasses).toBe(1);

  const migration: FairnessCapMigration =
    { workItemId: "wi-a", boundAtMost: 2, currentBoundAtMost: 4 };
  const revised = scheduler.validateCapRevision({
    revisionRef: "rev-1", dimensionId: "dim-1", fromCapUnits: 4, toCapUnits: 8,
    drainedWorkItemIds: [], migrations: [migration],
  });
  if (!revised.ok) throw new Error(fairnessCodes(revised).join(","));
  const revision: FairnessCapRevision = revised.value;
  expect(revision.migrations.length).toBe(1);
});

/**
 * Rotation and aging are exercised through the bare specifier for the same
 * reason the families above are: the export-count guards see runtime values
 * only, so a type published nowhere would leave them green. Annotating each
 * returned value turns an unpublished type into a tsc error.
 */
it("rotates and ages through the root exports", () => {
  const ringInput = {
    ringId: "ring-1", dimensionId: "dim-1",
    resources: [{ resourceId: "res-a", weight: 2 }],
    entries: [{ workItemId: "wi-a", resourceId: "res-a", deficitCounter: 0 }],
  };
  const capacity: FairnessResourceCapacity =
    { resourceId: "res-a", capacityUnits: 4, inFlightUnits: 0 };
  const rotated = scheduler.rotateOnce({
    ring: ringInput, workItems: [FAIR_ITEM], capacities: [capacity],
    forcedHead: null, capRevision: null,
  });
  if (!rotated.ok) throw new Error(fairnessCodes(rotated).join(","));
  const outcome: FairnessRotationOutcome = rotated.value;
  const disposition: FairnessRotationDisposition = outcome.disposition;
  const selection: FairnessRotationSelection | null = outcome.selection;
  expect([disposition, selection?.workItemId]).toEqual(["SELECTED", "wi-a"]);
  expect(scheduler.FAIRNESS_ROTATION_DISPOSITIONS).toContain(disposition);

  const inputs = scheduler.validateRotationRequest({
    ring: ringInput, workItems: [FAIR_ITEM], capacities: [capacity],
    forcedHead: null, capRevision: null,
  });
  if (!inputs.ok) throw new Error(fairnessCodes(inputs).join(","));
  const validated: FairnessRotationInputs = inputs.value;
  expect(validated.totalInFlight).toBe(0);
  const order = scheduler.resourceRotationOrder(ringInput);
  expect(order.ok && order.value).toEqual(["res-a"]);
  expect(scheduler.validateResourceCapacity(capacity).ok).toBe(true);

  const aged = scheduler.ageWorkItem({
    workItem: FAIR_ITEM, capacity, capRevision: null, forcedHead: null,
    bypassClaim: {
      workItemId: "wi-a", claimedBypasses: 8,
      attestations: Array.from({ length: 8 }, (_, index) => ({
        opportunityRef: `opp-${index}`, winnerWorkItemId: "wi-b",
        observationRef: `obs-${index}`,
      })),
    },
  });
  if (!aged.ok) throw new Error(fairnessCodes(aged).join(","));
  const standing: FairnessAgedStanding = aged.value;
  // FAIR_ITEM is P1, so one quantum promotes it to P0 and forcing needs two.
  expect([standing.effectivePriority, standing.forced]).toEqual(["P0", false]);
  expect(scheduler.bypassesToForced("P1")).toBe(scheduler.FAIRNESS_BYPASSES_PER_LEVEL * 2);
  expect([scheduler.FAIRNESS_DIMENSION_CEILING, scheduler.FAIRNESS_SERVICE_COST])
    .toEqual([10_000, 1]);
  expect(scheduler.FAIRNESS_FORCED_BYPASS_BOUND).toBe(32);
  expect(scheduler.FAIRNESS_PRIORITY_LADDER).toEqual(["P0", "P1", "P2", "P3"]);
});

it("refuses hostile fairness input from the root and names the refusing layer", () => {
  const refused = scheduler.validateWorkItem(null);
  expect(fairnessCodes(refused)).toEqual(["FAIRNESS_CONTRACT_MALFORMED_INPUT"]);
  if (refused.ok) throw new Error("expected a refusal");
  const layers: readonly FairnessContractLayer[] = refused.issues.map((issue) => issue.layer);
  expect(layers).toEqual(["WORK_ITEM"]);
  expect(refused.disposition).toBe("REFUSED");
});

it("refuses an unprovable bypass claim from the root, not merely a malformed one", () => {
  const unproven =
    scheduler.validateBypassClaim({ workItemId: "wi-a", claimedBypasses: 3, attestations: [] });
  expect(fairnessCodes(unproven)).toEqual(["FAIRNESS_CONTRACT_BYPASS_EVIDENCE_MISSING"]);
});

it("publishes the fairness vocabularies as frozen closed sets", () => {
  expect([...scheduler.FAIRNESS_CONTRACT_LAYERS]).toContain("WORK_ITEM");
  expect([...scheduler.FAIRNESS_PRIORITY_CLASSES]).toContain("P1");
  expect([...scheduler.FAIRNESS_DISPATCHABILITY_STATES]).toContain("NOT_DISPATCHABLE");
  expect(scheduler.FAIRNESS_CONTRACT_ISSUE_CODES)
    .toContain("FAIRNESS_CONTRACT_ITEM_IN_MULTIPLE_QUEUES");
  for (const vocabulary of [
    scheduler.FAIRNESS_CONTRACT_ISSUE_CODES, scheduler.FAIRNESS_CONTRACT_LAYERS,
    scheduler.FAIRNESS_DISPATCHABILITY_STATES, scheduler.FAIRNESS_PRIORITY_CLASSES,
  ]) {
    expect(Object.isFrozen(vocabulary)).toBe(true);
  }
});

it("publishes the admission purpose vocabularies and their contract mapping", () => {
  const contract: Readonly<Record<AdmissionPurpose, BudgetReservePurpose | null>> =
    scheduler.ADMISSION_PURPOSE_RESERVE_CONTRACT;
  expect(contract.EXECUTION).toBeNull();
  expect(contract.INDEPENDENT_REVIEW).toBe("REVIEW");
  expect([...scheduler.PROTECTED_ADMISSION_PURPOSES]).not.toContain("EXECUTION");
  expect(scheduler.BUDGET_RESERVATION_ISSUE_CODES)
    .toContain("BUDGET_RESERVATION_NEVER_STARTED_PROOF_MISSING");
});

/**
 * Supersession dispositions. Same rule as the fairness block: a published TYPE
 * is invisible to the count and namespace guards, so every one is annotated on
 * a value that passes through the bare specifier — an unpublished type becomes
 * a tsc error rather than a silently green test.
 */
const BOUND_FIELD: SupersessionBoundDispositionField = "outcome";
const RESOURCE_FACTS: SupersessionResourceFacts =
  { drainDisposition: null, release: null, slotState: null, successorCapacity: null };
const BUDGET_FACTS: SupersessionBudgetFacts = {
  expectedVersion: 0, neverStartedProofRef: null, reservation: null, settlementState: null,
  successorAttemptRef: "attempt:1", view: null,
};
const ADD_NODE: SupersessionNodeFacts = {
  attemptLifecycle: "CREATED", budget: null, effectsTerminal: true, kind: "ADD",
  nodeKey: "node:add", resource: RESOURCE_FACTS,
};

/** Names both arms of the result union without any deep import. */
function supersessionRefusal(result: SupersessionDispositionResult): SupersessionCarryRefusal {
  if (result.ok) {
    const set: SupersessionDispositionSet = result;
    const first: SupersessionFamilyDisposition | undefined = set.dispositions[0];
    throw new Error(`expected a refusal, got ${set.dispositions.length} from ${String(first?.kind)}`);
  }
  return result;
}

it("refuses an incomplete supersession set from the root, naming code and layer", () => {
  const refused = supersessionRefusal(scheduler.buildSupersessionDispositions([ADD_NODE]));
  const code: SupersessionRefusalCode = refused.code;
  const layer: SupersessionDispositionLayer = refused.layer;
  expect([code, layer]).toEqual(["PLANNING_DISPOSITION_UNKNOWN", "SCHEDULER_SUPERSESSION_SET"]);
  expect(scheduler.SUPERSESSION_REFUSAL_CODES).toContain(code);
  expect(scheduler.SUPERSESSION_DISPOSITION_LAYERS).toContain(layer);
});

it("refuses a malformed wait projection through the root consumer edge", () => {
  const refused = supersessionRefusal(scheduler.carryWaitProjection(null, [ADD_NODE]));
  expect([refused.code, refused.layer])
    .toEqual(["INPUT_INVALID", "SCHEDULER_SUPERSESSION_SET"]);
});

it("publishes the supersession vocabularies as frozen closed sets", () => {
  const family: SupersessionDispositionFamily = "RESOURCE";
  expect([...scheduler.SUPERSESSION_DISPOSITION_FAMILIES]).toContain(family);
  expect([...scheduler.SUPERSESSION_BOUND_DISPOSITION_FIELDS]).toContain(BOUND_FIELD);
  expect(BUDGET_FACTS.successorAttemptRef).toBe("attempt:1");
  for (const vocabulary of [
    scheduler.SUPERSESSION_BOUND_DISPOSITION_FIELDS, scheduler.SUPERSESSION_DISPOSITION_FAMILIES,
    scheduler.SUPERSESSION_DISPOSITION_LAYERS, scheduler.SUPERSESSION_REFUSAL_CODES,
  ]) {
    expect(Object.isFrozen(vocabulary)).toBe(true);
  }
});

/**
 * Expansion admission. Same rule as the two blocks above, and it is the whole
 * reason a happy path is driven here rather than only in the cross-package
 * integration suite: `tests/` is collected by vitest but typechecked by NO gate,
 * so a type published nowhere would leave an annotation there silently green.
 * Every expansion type is therefore annotated HERE, on a value that came through
 * the bare specifier, where `pnpm --filter @moe/scheduler typecheck` can see it.
 *
 * The fixtures are rebuilt inline rather than imported from
 * ../admission/admission-fixtures.js on purpose: the package `exports` map is
 * exclusive, so a real consumer could not reach them either, and a surface test
 * that leaned on an unreachable helper would be proving the wrong reachability.
 */
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function healthyReceipt(): Record<string, unknown> {
  return {
    proposalId: "prop-1", revision: 3, goalVersion: 7, graphEpoch: 11,
    observedAtSequence: 100, horizonSequence: 90,
    parentScope: ["a", "b", "c", "d"],
    childScopes: [
      {
        childKey: "child-1", scope: ["a", "b"], oracleKind: "OBSERVED", completion: "CLOSED",
        inputs: [{ inputKey: "in-1", materialization: "MATERIALIZED", digest: DIGEST_A }],
      },
      {
        childKey: "child-2", scope: ["c"], oracleKind: "DERIVED", completion: "CLOSED",
        inputs: [{ inputKey: "in-2", materialization: "MATERIALIZED", digest: DIGEST_B }],
      },
    ],
    sourceDigests: [DIGEST_A, DIGEST_B],
  };
}

function contractFor(producerNodeKey: string, consumerNodeKey: string): Record<string, unknown> {
  return {
    producerNodeKey, consumerNodeKey, edgeKind: "ARTIFACT_CONSUMPTION",
    graphBindingDigest: "c".repeat(64),
    producer: {
      kind: "ARTIFACT_CONSUMPTION", artifactOrInterfaceRef: "artifact:shared", digest: DIGEST_B,
    },
    consumer: {
      kind: "PRECONDITION", criterionRef: `criterion:${consumerNodeKey}`, contractHash: DIGEST_A,
    },
    minimumQualifyingMilestone: "RESULT_SEALED",
    satisfactionPredicate: {
      predicateRef: "predicate:sealed", schemaId: "moe.predicate.sealed", schemaVersion: 1,
      parametersDigest: DIGEST_B,
    },
    stability: "REVOCABLE",
    satisfactionWitnesses: [{
      witnessRef: `witness:${producerNodeKey}`, witnessVersion: 1, witnessDigest: DIGEST_A,
      sourceOperationClass: "ARTIFACT_SEAL",
    }],
    consumptionHorizon: "RESULT_SEAL",
    necessity: {
      failedConsumerCriterionRef: `criterion:${consumerNodeKey}`, failureKind: "MISSING_ARTIFACT",
      truthClass: "DAEMON_VERIFIED",
    },
    alternativeRuling: { kind: "NOT_APPLICABLE", reason: "no compatible substitute" },
    alternateProducers: [], truthClass: "DAEMON_VERIFIED",
    invalidationFacts: [{
      sourceFactRef: `fact:${producerNodeKey}`, sourceFactVersion: 1, sourceFactDigest: DIGEST_A,
    }],
    recheckPredicateRef: "predicate:sealed",
  };
}

/** dev-node-a -> dev-node-b -> dev-node-c, completion dev-node-c. */
function graphPart(): Record<string, unknown> {
  const edges = [
    { edgeKey: "dev-edge-ab", producerNodeKey: "dev-node-a", consumerNodeKey: "dev-node-b", kind: "HARD" },
    { edgeKey: "dev-edge-bc", producerNodeKey: "dev-node-b", consumerNodeKey: "dev-node-c", kind: "HARD" },
  ];
  const snapshot = {
    nodes: ["dev-node-a", "dev-node-b", "dev-node-c"].map((nodeKey) => ({ nodeKey, executionBearing: true })),
    edges, completionNodeKey: "dev-node-c",
  };
  return {
    proposedSnapshot: snapshot, sequentialBaselineSnapshot: snapshot,
    contracts: edges.map((edge) => ({
      edgeKey: edge.edgeKey, edgeKind: "ARTIFACT_CONSUMPTION",
      contract: contractFor(edge.producerNodeKey, edge.consumerNodeKey),
      necessityWitness: { edgeKey: edge.edgeKey, truthClass: "DAEMON_VERIFIED" },
    })),
  };
}

function admissionRequest(): ExpansionAdmissionRequest {
  return {
    receipt: healthyReceipt(),
    lineage: { expansionDepth: 2, nodesAddedInExpansion: 2 },
    graph: graphPart(),
    rotation: {
      ring: {
        ringId: "ring.main", dimensionId: "dim.alpha",
        resources: [{ resourceId: "res.a", weight: 1 }, { resourceId: "res.b", weight: 1 }],
        entries: [
          { workItemId: "item.a", resourceId: "res.a", deficitCounter: 1 },
          { workItemId: "item.b", resourceId: "res.b", deficitCounter: 1 },
        ],
      },
      workItems: ["item.a", "item.b"].map((workItemId) => ({
        workItemId, dimensionId: "dim.alpha", priority: "P2",
        resourceId: workItemId === "item.a" ? "res.a" : "res.b",
        dispatchability: { state: "DISPATCHABLE", observationRef: `obs.${workItemId}` },
      })),
      capacities: [
        { resourceId: "res.a", capacityUnits: 4, inFlightUnits: 0 },
        { resourceId: "res.b", capacityUnits: 4, inFlightUnits: 0 },
      ],
      forcedHead: null, capRevision: null,
    },
    bypassClaim: null,
    budget: {
      view: {
        accountId: "acct.1", state: "OPEN", version: 4,
        meters: [{ meter: "tokens", available: 1000, reserved: 0, quarantined: 0, committed: 0 }],
      },
      admission: {
        admissionRef: "adm.1", expectedVersion: 4,
        amounts: [
          { purpose: "EXECUTION", meter: "tokens", quantity: 10 },
          { purpose: "VERIFICATION", meter: "tokens", quantity: 5 },
          { purpose: "INDEPENDENT_REVIEW", meter: "tokens", quantity: 5 },
          { purpose: "FINAL_ACCEPTANCE", meter: "tokens", quantity: 5 },
          { purpose: "CONTINGENCY", meter: "tokens", quantity: 5 },
        ],
      },
      gate: { allowance: { decisionRef: "dec.1", outcome: "ALLOW" }, approval: null },
    },
    resources: {
      requestId: "req.1",
      declaredResources: [{ resourceId: "res.a", capacityUnits: 1, external: false, fenceable: true }],
      capacitySnapshot: { "res.a": 4 }, epoch: 1,
      eligibilityEventSequenceRef: "seq.1", continuouslyEligibleSinceRef: "since.1",
      callerObservation: "obs.1",
    },
  };
}

it("derives expansion evidence through the root and names every derived type", () => {
  const result: ExpansionEvidenceResult = scheduler.deriveExpansionEvidence(healthyReceipt());
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  const evidence: DerivedExpansionEvidence = result.value;
  const children: readonly ExpansionChildFacts[] = evidence.childFacts;
  const inputs: readonly ExpansionInputFact[] = children[0]!.inputs;
  expect([evidence.proposalId, evidence.childWidth, evidence.childKeys.length]).toEqual(["prop-1", 2, 2]);
  expect([children.length, inputs[0]!.inputKey]).toEqual([2, "in-1"]);
});

it("refuses a caller-declared verdict from the root, naming code and layer", () => {
  const refused = scheduler.deriveExpansionEvidence({ ...healthyReceipt(), eligible: true });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("expected a refusal");
  const refusal: ExpansionEvidenceRefusal = refused;
  const issue: ExpansionEvidenceIssue = refusal.issues[0]!;
  const code: ExpansionEvidenceIssueCode = issue.code;
  const layer: ExpansionEvidenceLayer = issue.layer;
  expect([code, layer, refusal.disposition]).toEqual([
    "EXPANSION_CALLER_DECLARED_VERDICT", "EVIDENCE", "REFUSED",
  ]);
  expect(scheduler.EXPANSION_EVIDENCE_ISSUE_CODES).toContain(code);
  expect(scheduler.EXPANSION_EVIDENCE_LAYERS).toContain(layer);
});

it("admits one expansion through the root and names every prepared type", () => {
  const result: ExpansionAdmissionResult = scheduler.admitExpansion(admissionRequest());
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  const preparation: ExpansionPreparation = result.preparation;
  const bound: ExpansionBoundFacts = preparation.bound;
  const lineage: ExpansionLineageFacts = bound.lineage;
  const fairness: ExpansionFairnessFacts = bound.fairness;
  const capacities: readonly ExpansionCapacityFact[] = bound.capacitySnapshot;
  const budget: ExpansionBudgetFacts = bound.budgetReservation;
  const resources: ExpansionResourceFacts = bound.resourceReservation;
  expect(preparation.identity).toMatch(/^[0-9a-f]{64}$/u);
  // childWidth is DERIVED from the receipt; the caller supplied only the other two.
  expect(lineage).toEqual({ expansionDepth: 2, childWidth: 2, nodesAddedInExpansion: 2 });
  expect([fairness.disposition, fairness.capRevisionRef]).toEqual(["SELECTED", null]);
  expect(capacities.map((one) => one.resourceId)).toEqual(["res.a", "res.b"]);
  expect([budget.accountId, budget.admissionRef]).toEqual(["acct.1", "adm.1"]);
  expect(resources.resourceIds).toEqual(["res.a"]);
  // Reservation is not activation: no run, lease, effect or slot appears anywhere.
  expect(JSON.stringify(bound)).not.toMatch(/lease|dispatch|activat/iu);
});

it("refuses a malformed admission from the root and holds nothing back", () => {
  const result: ExpansionAdmissionResult = scheduler.admitExpansion(null);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ExpansionAdmissionRefusal = result;
  const issue: ExpansionAdmissionIssue = refusal.issues[0]!;
  const origin: ExpansionAdmissionOrigin = issue.origin;
  const unwind: ExpansionAdmissionUnwind = refusal.unwind;
  const restored: readonly ExpansionRestoredMeter[] | null = unwind.restoredMeters;
  const code: ExpansionAdmissionIssueCode = "EXPANSION_ADMISSION_REQUEST_MALFORMED";
  expect([issue.code, origin, refusal.disposition]).toEqual([code, "REQUEST", "REFUSED"]);
  // Nothing was reserved before the parse, so nothing can have been given back.
  expect([unwind.budgetReservationCancelled, restored]).toEqual([false, null]);
  expect(scheduler.EXPANSION_ADMISSION_ISSUE_CODES).toContain(code);
  expect(scheduler.EXPANSION_ADMISSION_ORIGINS).toContain(origin);
});

it("publishes the expansion vocabularies as frozen closed sets", () => {
  expect([...scheduler.FORBIDDEN_VERDICT_KEYS]).toContain("oracleEligible");
  for (const vocabulary of [
    scheduler.EXPANSION_ADMISSION_ISSUE_CODES, scheduler.EXPANSION_ADMISSION_ORIGINS,
    scheduler.EXPANSION_EVIDENCE_ISSUE_CODES, scheduler.EXPANSION_EVIDENCE_LAYERS,
    scheduler.FORBIDDEN_VERDICT_KEYS,
  ]) {
    expect(Object.isFrozen(vocabulary)).toBe(true);
  }
});
