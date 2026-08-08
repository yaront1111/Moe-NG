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

type ExportKind = "array" | "function" | "number" | "record";
/** Hand-transcribed: 17 pre-existing graph values + 19 approved claim-composition values. */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["ABSOLUTE_MAX_GRAPH_HARD_EDGES", "number"], ["ABSOLUTE_MAX_GRAPH_NODES", "number"],
  ["ABSOLUTE_MAX_GRAPH_TOTAL_EDGES", "number"], ["ADMISSION_PURPOSES", "array"],
  ["ADMISSION_PURPOSE_RESERVE_CONTRACT", "record"], ["BUDGET_RESERVATION_ISSUE_CODES", "array"],
  ["DEFAULT_GRAPH_POLICY", "record"], ["DEFAULT_MAX_HARD_EDGES", "number"],
  ["DEFAULT_MAX_NODES", "number"], ["DEFAULT_MAX_TOTAL_EDGES", "number"],
  ["GraphAnalysisError", "function"], ["MAX_GRAPH_KEY_CODE_UNITS", "number"],
  ["MIN_GATED_DESCENDANTS_FOR_REVIEW", "number"], ["PROTECTED_ADMISSION_PURPOSES", "array"],
  ["RESERVATION_STATES", "array"], ["SLOT_STATES", "array"],
  ["activateReservation", "function"], ["adapterConfirm", "function"],
  ["adapterFail", "function"], ["analyzeGraphStructure", "function"],
  ["analyzeHardEdgeCounterfactuals", "function"], ["cancelReservation", "function"],
  ["createTraversalCounter", "function"], ["deriveReservationId", "function"],
  ["fenceAuthority", "function"], ["grantSuccessorCapacity", "function"],
  ["parseClock", "function"], ["parseLeaseRecord", "function"], ["parseProof", "function"],
  ["partitionFrontier", "function"], ["previewGraphSnapshot", "function"],
  ["reserveAll", "function"], ["reserveForAdmission", "function"],
  ["reserveProviderSlot", "function"], ["resolveGraphPolicy", "function"],
  ["validateGraphSnapshot", "function"],
];
const surface: Readonly<Record<string, unknown>> = scheduler;

it("generates one expectation per published root export", () => {
  expect(EXPECTED_EXPORTS.length).toBe(36);
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

it("publishes the admission purpose vocabularies and their contract mapping", () => {
  const contract: Readonly<Record<AdmissionPurpose, BudgetReservePurpose | null>> =
    scheduler.ADMISSION_PURPOSE_RESERVE_CONTRACT;
  expect(contract.EXECUTION).toBeNull();
  expect(contract.INDEPENDENT_REVIEW).toBe("REVIEW");
  expect([...scheduler.PROTECTED_ADMISSION_PURPOSES]).not.toContain("EXECUTION");
  expect(scheduler.BUDGET_RESERVATION_ISSUE_CODES)
    .toContain("BUDGET_RESERVATION_NEVER_STARTED_PROOF_MISSING");
});
