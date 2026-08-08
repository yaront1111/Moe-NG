import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { NextAllowedCommand, RuntimeCommandKind, RuntimeTruthClass } from "@moe/contracts";

/**
 * Development-only approval fixtures.
 *
 * Nothing here is evidence and nothing here carries authority. `ApprovalDecisionRecord`
 * is a STRUCTURAL mirror of `packages/core/src/policy/approval-contract.ts`: the control
 * room may not depend on `@moe/core`, and the lifecycles it needs are already ratified in
 * `@moe/contracts`, so they are imported rather than redeclared.
 *
 * The refusal vocabulary these fixtures are refused against lives in `approval-gating.ts`,
 * which owns every reason a control can carry.
 */
export const APPROVAL_FIXTURE_KIND = "DEVELOPMENT_ONLY/NOT_CONFIRMATORY" as const;

export type ApprovalLifecycle = (typeof RUNTIME_LIFECYCLES)["APPROVAL"][number];
export type ApprovalDecision = (typeof RUNTIME_LIFECYCLES)["APPROVAL_DECISION"][number];
export type ApprovalValidity = (typeof RUNTIME_LIFECYCLES)["APPROVAL_VALIDITY"][number];
export type CutoverState = (typeof RUNTIME_LIFECYCLES)["CUTOVER"][number];

export const APPROVAL_ACTOR_KINDS = Object.freeze(["HUMAN", "SYSTEM_POLICY"] as const);
export type ApprovalActorKind = (typeof APPROVAL_ACTOR_KINDS)[number];

/** Design 706-711 risk classes; R2/R3 are human-only and R3 is step-up authenticated. */
export const APPROVAL_RISK_TIERS = Object.freeze(["R0", "R1", "R2", "R3"] as const);
export type ApprovalRiskTier = (typeof APPROVAL_RISK_TIERS)[number];

/** Structural mirror of core's design-265 carry-forward codes, used for delta display. */
export const CARRY_FORWARD_REASON_CODES = Object.freeze([
  "CARRY_FORWARD_CANONICALIZATION_UNKNOWN",
  "CARRY_FORWARD_DEPENDENCY_MISSING",
  "CARRY_FORWARD_ENVIRONMENT_CHANGED",
  "CARRY_FORWARD_HASH_MISMATCH",
  "CARRY_FORWARD_POLICY_SLICE_CHANGED",
  "CARRY_FORWARD_PREDECESSOR_RESULT_CHANGED",
] as const);
export type CarryForwardReasonCode = (typeof CARRY_FORWARD_REASON_CODES)[number];

export interface ApprovalDependencyChanges {
  readonly additions: readonly string[];
  readonly challenges: readonly string[];
  readonly removals: readonly string[];
}

export interface ApprovalDecisionRecord {
  readonly actor: string;
  readonly actorKind: ApprovalActorKind;
  readonly applicablePolicyRef: string;
  readonly approvalRef: string;
  readonly approvedNodeScope: readonly string[];
  readonly budgetRef: string;
  readonly criteriaRef: string;
  readonly decision: ApprovalDecision | null;
  readonly decisionReason: string | null;
  readonly dependencyChanges: ApprovalDependencyChanges;
  readonly exactRevisionHash: string;
  readonly lifecycle: ApprovalLifecycle;
  readonly planQualityAssessmentRef: string;
  readonly policyDecisionRef: string | null;
  readonly riskTier: ApprovalRiskTier;
  readonly stepUpAuthRef: string | null;
  readonly truthClass: RuntimeTruthClass;
  readonly validity: ApprovalValidity;
}

/**
 * Design 1007's typed decision union. `SOFT_POLICY_WAIVER` is carried so the union stays
 * honest; the spec gives it no surface, so nothing renders it.
 */
export const APPROVAL_DECISION_KINDS = Object.freeze([
  "PLAN", "EXPANSION", "ACCEPTANCE", "REVOCATION_CONFIRMATION", "RECONCILIATION",
  "ESCALATION", "CUTOVER_QUIESCE", "CUTOVER_ACTIVATE", "SOFT_POLICY_WAIVER",
] as const);
export type ApprovalDecisionKind = (typeof APPROVAL_DECISION_KINDS)[number];

/** Spec §8.10, verbatim. Kinds the spec does not name deliberately have no entry. */
export const IDLE_CONSEQUENCES = Object.freeze({
  ACCEPTANCE: "work waits in WORK_REVIEW; branch stays unmerged.",
  ESCALATION: "node stays parked in PLANNING.",
  EXPANSION: "children stay unscheduled.",
  PLAN: "node waits in PLAN_REVIEW; its lease may lapse to SUSPECT.",
  RECONCILIATION: "the record stays quarantined and unschedulable.",
  REVOCATION_CONFIRMATION: "the lease stays SUSPECT; no takeover occurs.",
});
export type SpecIdleConsequenceKind = keyof typeof IDLE_CONSEQUENCES;

/** The spec's line, or null. A kind without a spec line never gets an invented one. */
export function idleConsequence(kind: ApprovalDecisionKind): string | null {
  return Object.hasOwn(IDLE_CONSEQUENCES, kind)
    ? IDLE_CONSEQUENCES[kind as SpecIdleConsequenceKind]
    : null;
}

const hash64 = (seed: string): string => seed.repeat(64 / seed.length);

export const FIXTURE_REVISION_HASH = hash64("a3f9c2d4");
export const FIXTURE_SUPERSEDING_HASH = hash64("b71e5f06");

const BASE_RECORD: ApprovalDecisionRecord = Object.freeze({
  actor: "human/operator-1",
  actorKind: "HUMAN",
  applicablePolicyRef: "policy/rev-q-3",
  approvalRef: "approval-fx-plan",
  approvedNodeScope: Object.freeze(["node/api-endpnt"]),
  budgetRef: "budget/envelope-19",
  criteriaRef: "criteria/api-endpnt",
  decision: null,
  decisionReason: null,
  dependencyChanges: Object.freeze({
    additions: Object.freeze([]),
    challenges: Object.freeze([]),
    removals: Object.freeze([]),
  }),
  exactRevisionHash: FIXTURE_REVISION_HASH,
  lifecycle: "PENDING",
  planQualityAssessmentRef: "assessment/api-endpnt",
  policyDecisionRef: null,
  riskTier: "R2",
  stepUpAuthRef: null,
  truthClass: "DAEMON_VERIFIED",
  validity: "CURRENT",
});

/**
 * Design 701/710: a policy-decided record is a real decision, but its truth class is
 * `DAEMON_VERIFIED` and its tier can only be R0 or R1. A fixture that claims otherwise is
 * refused here rather than rendered, so no surface can show automation wearing human truth.
 */
function validated(record: ApprovalDecisionRecord): ApprovalDecisionRecord {
  if (record.actorKind === "SYSTEM_POLICY") {
    if (record.truthClass === "HUMAN_APPROVED") {
      throw new Error("SYSTEM_POLICY approval may not claim HUMAN_APPROVED truth (design 701)");
    }
    if (record.riskTier !== "R0" && record.riskTier !== "R1") {
      throw new Error(`SYSTEM_POLICY approval may not carry tier ${record.riskTier} (design 710)`);
    }
  }
  return Object.freeze(record);
}

export function approvalRecord(
  overrides: Partial<ApprovalDecisionRecord> = {},
): ApprovalDecisionRecord {
  return validated({ ...BASE_RECORD, ...overrides });
}

export function withRecord(
  record: ApprovalDecisionRecord,
  overrides: Partial<ApprovalDecisionRecord>,
): ApprovalDecisionRecord {
  return validated({ ...record, ...overrides });
}

type RecordSeed = readonly [ApprovalDecisionKind, ApprovalRiskTier, Partial<ApprovalDecisionRecord>];

const POLICY_DECIDED: Partial<ApprovalDecisionRecord> = {
  actor: "policy:q-3",
  actorKind: "SYSTEM_POLICY",
  decision: "APPROVE",
  lifecycle: "DECIDED",
  policyDecisionRef: "rule/auto-r1-isolated-writes",
  truthClass: "DAEMON_VERIFIED",
};

const RECORD_SEEDS: readonly RecordSeed[] = Object.freeze([
  ["PLAN", "R2", {}],
  ["EXPANSION", "R2", { approvedNodeScope: Object.freeze(["node/api-endpnt", "node/ui-panel"]) }],
  ["ACCEPTANCE", "R2", { criteriaRef: "criteria/api-endpnt-acceptance" }],
  ["REVOCATION_CONFIRMATION", "R3", { stepUpAuthRef: "stepup/webauthn-1" }],
  ["RECONCILIATION", "R2", {}],
  ["ESCALATION", "R3", { stepUpAuthRef: "stepup/webauthn-1" }],
  ["CUTOVER_QUIESCE", "R3", { stepUpAuthRef: "stepup/webauthn-1" }],
  ["CUTOVER_ACTIVATE", "R3", { stepUpAuthRef: "stepup/webauthn-1" }],
  ["SOFT_POLICY_WAIVER", "R1", POLICY_DECIDED],
]);

function buildRecords(): Readonly<Record<ApprovalDecisionKind, ApprovalDecisionRecord>> {
  const built: Partial<Record<ApprovalDecisionKind, ApprovalDecisionRecord>> = {};
  for (const [kind, riskTier, overrides] of RECORD_SEEDS) {
    built[kind] = approvalRecord({
      approvalRef: `approval-fx-${kind.toLowerCase()}`, riskTier, ...overrides,
    });
  }
  return Object.freeze(built as Record<ApprovalDecisionKind, ApprovalDecisionRecord>);
}

export const APPROVAL_FIXTURE_RECORDS = buildRecords();

/** The one policy-decided record the collapsed `cr.approvals.auto` group renders. */
export const AUTO_APPROVED_RECORD = approvalRecord({
  ...POLICY_DECIDED, approvalRef: "approval-fx-auto", riskTier: "R1",
});

export interface ApprovalAffordanceOverrides {
  readonly commandId?: string;
  readonly expectedVersion?: number;
  readonly graphRevisionHash?: string | undefined;
  readonly targetAggregateId?: string;
}

/** Declared directly; the gating test runs the daemon's real parser over these entries. */
export function approvalAffordance(
  commandKind: RuntimeCommandKind,
  overrides: ApprovalAffordanceOverrides = {},
): NextAllowedCommand {
  const pinned = Object.hasOwn(overrides, "graphRevisionHash")
    ? overrides.graphRevisionHash
    : FIXTURE_REVISION_HASH;
  const base = {
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId: overrides.commandId ?? `cmd-fx-${commandKind.replaceAll(".", "-")}`,
    commandKind,
    expectedVersion: overrides.expectedVersion ?? 4,
    inputSchemaVersion: "moe-runtime-command-input/1",
    targetAggregateId: overrides.targetAggregateId ?? "approval-fx-target",
  } as const;
  return Object.freeze(
    pinned === undefined ? base : { ...base, graphRevisionHash: pinned },
  ) as NextAllowedCommand;
}

/**
 * Design 1007's cutover consequence frame, field-for-field. The control-room spec contains
 * no cutover text at all, so every cutover surface built on this is PROVISIONAL and claims
 * no spec test IDs (§13-D1 ⟨TD⟩).
 */
export interface CutoverConsequence {
  readonly consequencePayload: string;
  readonly deadline: string;
  readonly disposition: string;
  readonly exactStoredHash: string;
  readonly fundingReservation: string;
  readonly planningFenceMembership: string;
  readonly releaseAction: string;
}

export const CUTOVER_PROVISIONAL_NOTE =
  "Provisional: derived from the system design, not from control-room spec text.";

export const CUTOVER_CONSEQUENCE_FIXTURE: CutoverConsequence = Object.freeze({
  consequencePayload: "3 nodes rebound; 1 attempt drained; 0 effects orphaned",
  deadline: "2026-08-07T09:12:00.000Z",
  disposition: "REBIND_TO_SUCCESSOR",
  exactStoredHash: FIXTURE_SUPERSEDING_HASH,
  fundingReservation: "$18 of $19 envelope held",
  planningFenceMembership: "fence/goal-j1 (ACTIVE)",
  releaseAction: "graph.release_preparation",
});
