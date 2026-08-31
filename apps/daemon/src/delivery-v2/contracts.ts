import type {
  CapabilityCatalogRevision,
  DeliveryProfileQualification,
  DeliveryProfileRevision,
  ExecutionIsolationProfileRevision,
  VerificationRecipeRevision,
} from "@moe/core";
import type { DurableStoreErrorCode } from "@moe/store";

export const DELIVERY_V2_PERSISTENCE_LAYER = "DAEMON_DELIVERY_V2_PERSISTENCE" as const;
export const DELIVERY_V2_READER_LAYER = "DAEMON_DELIVERY_V2_READER" as const;
export const DELIVERY_V2_AUTHORITY_LAYER = "DAEMON_DELIVERY_V2_AUTHORITY" as const;

export const DELIVERY_V2_CODES = Object.freeze([
  "DELIVERY_V2_INPUT_INVALID",
  "DELIVERY_V2_MATERIAL_INVALID",
  "DELIVERY_V2_MATERIAL_ABSENT",
  "DELIVERY_V2_MATERIAL_UNREADABLE",
  "DELIVERY_V2_MATERIAL_PROJECT_MISMATCH",
  "DELIVERY_V2_MATERIAL_REF_MISMATCH",
  "DELIVERY_V2_MATERIAL_DIGEST_MISMATCH",
  "DELIVERY_V2_AUTHORITY_ABSENT",
  "DELIVERY_V2_AUTHORITY_UNREADABLE",
  "DELIVERY_V2_AUTHORITY_PROJECT_MISMATCH",
  "DELIVERY_V2_AUTHORITY_BINDING_MISMATCH",
  "DELIVERY_V2_AUTHORITY_TRANSITION_INVALID",
  "STORAGE_DEGRADED",
] as const);
export type DeliveryV2Code = (typeof DELIVERY_V2_CODES)[number] | DurableStoreErrorCode;

export interface DeliveryV2Refusal {
  readonly code: DeliveryV2Code;
  readonly disposition?: undefined;
  readonly layer: typeof DELIVERY_V2_PERSISTENCE_LAYER
    | typeof DELIVERY_V2_READER_LAYER | typeof DELIVERY_V2_AUTHORITY_LAYER | "DURABLE_STORE";
  readonly ok: false;
}
export interface DeliveryV2AppendAccepted<T> {
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly value: T;
}
export type DeliveryV2AppendResult<T> = DeliveryV2AppendAccepted<T> | DeliveryV2Refusal;

export interface DeliveryV2AppendContext {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly principalId: string;
  readonly projectId: string;
}

export interface DeliveryV2QualificationStatusInput {
  readonly qualificationDigest: string;
  readonly qualificationId: string;
  readonly status: "CURRENT" | "REVOKED";
  readonly statusRef: string;
}

export interface DeliveryV2ProviderProfilePrincipalBinding {
  readonly principalId: string;
  readonly profileRef: string;
}
export interface DeliveryV2BuilderIdentityPrincipalBinding {
  readonly authorityRef: string;
  readonly capabilityId: string;
  readonly principalId: string;
}
export interface DeliveryV2VerifierReceiptPrincipalBinding {
  readonly authorityRef: string;
  readonly capabilityId: string;
  readonly principalId: string;
}
export interface DeliveryV2AuthorityPrincipalBindings {
  readonly builderIdentityPrincipals: readonly DeliveryV2BuilderIdentityPrincipalBinding[];
  readonly operatorApprovalPrincipalId: string;
  readonly providerProfilePrincipals: readonly DeliveryV2ProviderProfilePrincipalBinding[];
  readonly qualificationStatusPrincipalId: string;
  readonly verifierReceiptPrincipals: readonly DeliveryV2VerifierReceiptPrincipalBinding[];
}

export interface DeliveryV2MaterialPublisherPrincipalBindings {
  readonly capabilityCatalogPrincipalId: string;
  readonly deliveryProfilePrincipalId: string;
  readonly deliveryProfileQualificationPrincipalId: string;
  readonly executionIsolationProfilePrincipalId: string;
  readonly verificationRecipePrincipalId: string;
}

export interface DeliveryV2QualificationStatusFence {
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly qualificationDigest: string;
  readonly qualificationId: string;
  readonly statusDigest: string;
  readonly statusRef: string;
}

export interface CapabilityCatalogRevisionRef {
  readonly catalogId: string;
  readonly projectId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}
export interface DeliveryProfileRevisionRef {
  readonly profileId: string;
  readonly projectId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}
export interface DeliveryProfileQualificationRef {
  readonly projectId: string;
  readonly qualificationDigest: string;
  readonly qualificationId: string;
}
export interface ExecutionIsolationProfileRevisionRef {
  readonly profileId: string;
  readonly projectId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}
export interface VerificationRecipeRevisionRef {
  readonly projectId: string;
  readonly recipeId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}

export interface DeliveryV2ResolutionMaterialRefs {
  readonly catalog: Omit<CapabilityCatalogRevisionRef, "projectId">;
  readonly deliveryProfile: Omit<DeliveryProfileRevisionRef, "projectId">;
  readonly entries: readonly Readonly<{
    capabilityId: string;
    executionIsolationProfile: Omit<ExecutionIsolationProfileRevisionRef, "projectId">;
    verificationRecipes: readonly Omit<VerificationRecipeRevisionRef, "projectId">[];
  }>[];
  readonly projectId: string;
  readonly qualification: Omit<DeliveryProfileQualificationRef, "projectId">;
}
export interface DeliveryV2ResolutionMaterials {
  readonly deliveryProfileQualification: DeliveryProfileQualification;
  readonly deliveryProfileRevision: DeliveryProfileRevision;
  readonly entryMaterials: readonly Readonly<{
    capabilityId: string;
    executionIsolationProfileRevision: ExecutionIsolationProfileRevision;
    verificationRecipeRevisions: readonly VerificationRecipeRevision[];
  }>[];
}
export type DeliveryV2ResolutionMaterialsResult = Readonly<{
  catalogRevision: CapabilityCatalogRevision;
  materials: DeliveryV2ResolutionMaterials;
  ok: true;
}> | DeliveryV2Refusal;
