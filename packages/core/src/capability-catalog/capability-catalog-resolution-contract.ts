import type {
  DeliveryProfileDurableQualificationStatus,
  DeliveryProfileQualification,
  DeliveryProfileRevision,
} from "../delivery-profile/delivery-profile-contract.js";
import type { ExecutionIsolationProfileRevision } from
  "../execution-profile/execution-isolation-profile-contract.js";
import type { VerificationRecipeRevision } from
  "../execution-profile/verification-recipe-contract.js";
import type {
  CapabilityCatalogCriterionCategory,
  CapabilityCatalogEntry,
  CapabilityCatalogRefusal,
} from "./capability-catalog-contract.js";

export interface CapabilityCatalogResolutionRequest {
  readonly atEpochMs: number;
  readonly capabilityId: string;
  readonly requiredCriterionCategories:
    readonly CapabilityCatalogCriterionCategory[];
}

export interface CapabilityCatalogEntryResolutionMaterials {
  readonly capabilityId: string;
  readonly executionIsolationProfileRevision: ExecutionIsolationProfileRevision;
  readonly verificationRecipeRevisions: readonly VerificationRecipeRevision[];
}

export interface CapabilityCatalogResolutionMaterials {
  readonly deliveryProfileQualification: DeliveryProfileQualification;
  readonly deliveryProfileRevision: DeliveryProfileRevision;
  readonly entryMaterials: readonly CapabilityCatalogEntryResolutionMaterials[];
}

export interface CapabilityCatalogResolvedEntryBinding {
  readonly capability: CapabilityCatalogEntry;
  readonly executionIsolationProfileRevision: ExecutionIsolationProfileRevision;
  readonly verificationRecipeRevisions: readonly VerificationRecipeRevision[];
}

export interface CapabilityCatalogResolutionWitness {
  readonly atEpochMs: number;
  readonly builderBinding: CapabilityCatalogResolvedEntryBinding;
  readonly catalogId: string;
  readonly catalogRevisionDigest: string;
  readonly catalogRevisionId: string;
  readonly deliveryProfileQualification: DeliveryProfileQualification;
  readonly deliveryProfileQualificationStatus: DeliveryProfileDurableQualificationStatus;
  readonly deliveryProfileRevision: DeliveryProfileRevision;
  readonly requiredCriterionCategories:
    readonly CapabilityCatalogCriterionCategory[];
  readonly verifierBindings: readonly CapabilityCatalogResolvedEntryBinding[];
}

export type CapabilityCatalogResolutionResult =
  | Readonly<{ ok: true; witness: CapabilityCatalogResolutionWitness }>
  | CapabilityCatalogRefusal;
