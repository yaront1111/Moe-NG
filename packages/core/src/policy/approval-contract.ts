/**
 * Approval decision records, lifecycle commands, and selective-invalidation inputs
 * (design sections 7.2, 8 line 360, 11.6, 12.1).
 *
 * `APPROVAL`, `APPROVAL_DECISION`, and `APPROVAL_VALIDITY` are closed lifecycles owned by
 * `@moe/contracts` and are imported, never redeclared. Every hash and ref below is a SUPPLIED
 * opaque identity; core validates shape and never computes one.
 */
import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { RuntimeError, RuntimeTruthClass } from "@moe/contracts";

import type { PolicyRiskTier } from "./policy-contract.js";

export type ApprovalLifecycle = (typeof RUNTIME_LIFECYCLES)["APPROVAL"][number];
export type ApprovalDecision = (typeof RUNTIME_LIFECYCLES)["APPROVAL_DECISION"][number];
export type ApprovalValidity = (typeof RUNTIME_LIFECYCLES)["APPROVAL_VALIDITY"][number];

export const APPROVAL_ACTOR_KINDS = Object.freeze(["HUMAN", "SYSTEM_POLICY"] as const);
export type ApprovalActorKind = (typeof APPROVAL_ACTOR_KINDS)[number];

/** Design 265 carry-forward invalidation conditions, one code per named condition. */
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

/**
 * Design 7.2 + 360. `decision` is non-null if and only if `lifecycle` is `DECIDED`, and is
 * immutable once set. A `SYSTEM_POLICY` record is a real decision (design 701), never the
 * absence of one, but its truth class is `DAEMON_VERIFIED` and its tier can only be R0/R1.
 */
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
  readonly riskTier: PolicyRiskTier;
  readonly stepUpAuthRef: string | null;
  readonly truthClass: RuntimeTruthClass;
  readonly validity: ApprovalValidity;
}

export const APPROVAL_COMMAND_KINDS = Object.freeze([
  "approval.decide", "approval.withdraw",
] as const);
export type ApprovalCommandKind = (typeof APPROVAL_COMMAND_KINDS)[number];

export interface ApprovalDecideCommand {
  readonly decision: ApprovalDecision;
  readonly decisionReason: string | null;
  readonly kind: "approval.decide";
  readonly stepUpAuthRef: string | null;
}

export interface ApprovalWithdrawCommand {
  readonly kind: "approval.withdraw";
}

export type ApprovalCommand = ApprovalDecideCommand | ApprovalWithdrawCommand;

/** Supplied by the scheduler: design 265 makes the graph diff the daemon's job, not core's. */
export interface ApprovalImpactSet {
  readonly canonicalizerVersion: string;
  readonly changedNodeRefs: readonly string[];
  readonly changedRevisionHashes: readonly string[];
}

/** Design 263/269: a successor approval marks its predecessor SUPERSEDED, never relabelled. */
export interface ApprovalSuccessorLink {
  readonly predecessorApprovalRef: string;
  readonly successorApprovalRef: string;
}

export interface ApprovalInvalidationInput {
  readonly approvals: readonly ApprovalDecisionRecord[];
  readonly impactSet: ApprovalImpactSet;
  readonly successorLinks: readonly ApprovalSuccessorLink[];
  readonly supportedCanonicalizerVersions: readonly string[];
}

export interface CarryForwardInput {
  readonly canonicalizerVersion: string;
  readonly dependenciesPresent: boolean;
  readonly environmentClosureUnchanged: boolean;
  readonly policySliceUnchanged: boolean;
  readonly predecessorResultUnchanged: boolean;
  readonly sourceHash: string;
  readonly targetHash: string;
}

export interface CarryForwardVerdict {
  readonly reasonCodes: readonly CarryForwardReasonCode[];
  readonly valid: boolean;
}

export interface ApprovalAcceptedResult<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ApprovalRejectedResult {
  readonly error: RuntimeError;
  readonly ok: false;
}

export type ApprovalResult<T> = ApprovalAcceptedResult<T> | ApprovalRejectedResult;
