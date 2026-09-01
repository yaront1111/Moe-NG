/**
 * Immutable planner-to-Scheduler allocation content. A digest proves byte integrity only: this
 * record remains inert until a daemon-owned durable reader proves the revision is current and
 * authenticates both allocationDecisionRef and every conversion.authorityRef. Version 1 binds
 * the complete Product envelope to one admission; it supplies no retry or incremental-allocation
 * authority and carries no approval/policy witness.
 */
import type { ProductContractV2BudgetKind } from "@moe/core";
import type {
  AdmissionPurpose,
  NodeAdmissionAmount,
  NodeAdmissionGatePolicy,
  NodeAdmissionMeter,
} from "@moe/scheduler";

export const PLANNER_ADMISSION_PROFILE_VERSION =
  "moe-planner-admission-profile-revision/1" as const;
export const PLANNER_ADMISSION_PROFILE_DIGEST_DOMAIN =
  "moe-planner-admission-profile-revision-digest/1" as const;

export const PLANNER_ADMISSION_PROFILE_CODES = Object.freeze([
  "PLANNER_ADMISSION_PROFILE_MALFORMED",
  "PLANNER_ADMISSION_PROFILE_VERSION_UNSUPPORTED",
  "PLANNER_ADMISSION_PROFILE_LIMIT_EXCEEDED",
  "PLANNER_ADMISSION_PROFILE_BYTES_INVALID",
  "PLANNER_ADMISSION_PROFILE_DUPLICATE_KEY",
  "PLANNER_ADMISSION_PROFILE_NONCANONICAL",
  "PLANNER_ADMISSION_PROFILE_DIGEST_MISMATCH",
  "PLANNER_ADMISSION_PROFILE_BINDING_MISMATCH",
  "PLANNER_ADMISSION_PROFILE_BUDGET_KIND_UNSUPPORTED",
  "PLANNER_ADMISSION_PROFILE_PROVIDER_METER_FORBIDDEN",
  "PLANNER_ADMISSION_PROFILE_MAPPING_ABSENT",
  "PLANNER_ADMISSION_PROFILE_MAPPING_AMBIGUOUS",
  "PLANNER_ADMISSION_PROFILE_MAPPING_NONINTEGRAL",
  "PLANNER_ADMISSION_PROFILE_MAPPING_OVERFLOW",
  "PLANNER_ADMISSION_PROFILE_ALLOCATION_INCOMPLETE",
  "PLANNER_ADMISSION_PROFILE_ALLOCATION_TOTAL_MISMATCH",
  "PLANNER_ADMISSION_PROFILE_GATE_POLICY_INVALID",
] as const);

export const PLANNER_ADMISSION_PROFILE_LIMITS = Object.freeze({
  maxAllocations: 64,
  maxBytes: 65_536,
  maxIdBytes: 512,
  maxPurposeQuantities: 5,
});

export type PlannerAdmissionProfileCode =
  (typeof PLANNER_ADMISSION_PROFILE_CODES)[number];
export type PlannerAdmissionProfileLayer =
  | "PLANNER_ADMISSION_PROFILE_ADMISSION"
  | "PLANNER_ADMISSION_PROFILE_ALLOCATION"
  | "PLANNER_ADMISSION_PROFILE_BINDING"
  | "PLANNER_ADMISSION_PROFILE_CANONICALIZATION"
  | "PLANNER_ADMISSION_PROFILE_CODEC"
  | "PLANNER_ADMISSION_PROFILE_DIGEST"
  | "PLANNER_ADMISSION_PROFILE_LIMITS"
  | "PLANNER_ADMISSION_PROFILE_MAPPING"
  | "PLANNER_ADMISSION_PROFILE_VERSION";
export type PlannerAdmissionProfileAuthorityKind = "BUILDER" | "VERIFIER";
export type PlannerAdmissionProfileAllocationSemantics =
  "SINGLE_ADMISSION_FULL_ENVELOPE";

export interface PlannerAdmissionProfileSourceBudget {
  readonly budgetId: string;
  readonly kind: ProductContractV2BudgetKind;
  readonly limit: number;
  readonly unit: string;
}

export interface PlannerAdmissionProfileConversion {
  readonly authorityRef: string;
  readonly denominator: number;
  readonly numerator: number;
  readonly targetMeter: NodeAdmissionMeter;
}

export interface PlannerAdmissionProfilePurposeQuantity {
  readonly purpose: AdmissionPurpose;
  readonly quantity: number;
}

export interface PlannerAdmissionProfileBudgetAllocation {
  readonly conversion: PlannerAdmissionProfileConversion;
  readonly purposeQuantities: readonly PlannerAdmissionProfilePurposeQuantity[];
  readonly sourceBudget: PlannerAdmissionProfileSourceBudget;
}

export interface PlannerAdmissionProfileContractBinding {
  readonly contractId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}

export interface PlannerAdmissionProfileRevisionDraft {
  readonly admissionGatePolicy: NodeAdmissionGatePolicy;
  readonly allocationDecisionRef: string;
  readonly allocationSemantics: PlannerAdmissionProfileAllocationSemantics;
  readonly authorRef: string;
  readonly authorityKind: PlannerAdmissionProfileAuthorityKind;
  readonly budgetAllocations: readonly PlannerAdmissionProfileBudgetAllocation[];
  readonly budgetBindingDigest: string;
  readonly contractBinding: PlannerAdmissionProfileContractBinding;
  readonly graphId: string;
  readonly graphSnapshotIdentity: string;
  readonly nodeIntentDigest: string;
  readonly nodeKey: string;
  readonly policyRevision: string;
  readonly profileId: string;
  readonly revisionId: string;
}

export interface PlannerAdmissionProfileRevision
  extends PlannerAdmissionProfileRevisionDraft {
  readonly revisionDigest: string;
  readonly version: typeof PLANNER_ADMISSION_PROFILE_VERSION;
}

export interface PlannerAdmissionProfileMappingExpectation {
  readonly authorityKind: PlannerAdmissionProfileAuthorityKind;
  readonly budgetBindingDigest: string;
  readonly budgetBindings: readonly PlannerAdmissionProfileSourceBudget[];
  readonly contractBinding: PlannerAdmissionProfileContractBinding;
  readonly graphId: string;
  readonly graphSnapshotIdentity: string;
  readonly nodeIntentDigest: string;
  readonly nodeKey: string;
  readonly policyRevision: string;
}

export interface PlannerAdmissionProfileBinding {
  readonly nodeKey: string;
  readonly profileId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
  readonly version: typeof PLANNER_ADMISSION_PROFILE_VERSION;
}

export interface PlannerAdmissionProfileAuthority {
  readonly admissionAmounts: readonly NodeAdmissionAmount[];
  readonly admissionGatePolicy: NodeAdmissionGatePolicy;
}

export interface PlannerAdmissionProfileAuthoritySuccess {
  readonly authority: PlannerAdmissionProfileAuthority;
  readonly ok: true;
  readonly profileBinding: PlannerAdmissionProfileBinding;
}

export interface PlannerAdmissionProfileRefusal {
  readonly code: PlannerAdmissionProfileCode;
  readonly layer: PlannerAdmissionProfileLayer;
  readonly ok: false;
}

export type PlannerAdmissionProfileCreateResult =
  | Readonly<{ readonly ok: true; readonly revision: PlannerAdmissionProfileRevision }>
  | PlannerAdmissionProfileRefusal;
export type PlannerAdmissionProfileEncodeResult =
  | Readonly<{ readonly bytes: Uint8Array; readonly ok: true }>
  | PlannerAdmissionProfileRefusal;
export type PlannerAdmissionProfileDecodeResult = PlannerAdmissionProfileCreateResult;
export type PlannerAdmissionProfileMappingResult =
  | PlannerAdmissionProfileAuthoritySuccess
  | PlannerAdmissionProfileRefusal;

export function plannerAdmissionProfileRefusal(
  code: PlannerAdmissionProfileCode,
  layer: PlannerAdmissionProfileLayer,
): PlannerAdmissionProfileRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}
