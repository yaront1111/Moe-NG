import type {
  DELIVERY_PROFILE_QUALIFICATION_VERSION,
  DeliveryProfileBenchmarkVerdict,
  DeliveryProfileFamilyId,
  DeliveryProfileModelProviderCapability,
  DeliveryProfileOperatorDecision,
  DeliveryProfileQualificationValidity,
  DeliveryProfileRefusal,
} from "./delivery-profile-contract.js";

export interface DeliveryProfileIndependentVerifierReceipt {
  readonly observedAtEpochMs: number;
  readonly outcome: "PASS";
  readonly profileRevisionDigest: string;
  readonly receiptDigest: string;
  readonly receiptRef: string;
  readonly recipeDigest: string;
  readonly recipeRef: string;
  readonly verifierAuthorityRef: string;
  readonly verifierCapabilityId: string;
  readonly verifierRef: string;
}

export interface DeliveryProfileBuilderIdentity {
  readonly authorityRef: string;
  readonly capabilityId: string;
  readonly principalRef: string;
}

export interface DeliveryProfileBenchmarkManifestRef {
  readonly benchmarkCorpusDigest: string;
  readonly benchmarkCorpusRef: string;
  readonly manifestDigest: string;
  readonly manifestRef: string;
}

export interface DeliveryProfileObservedDigests {
  readonly browserDigest: string;
  readonly composeDigest: string;
  readonly dockerDigest: string;
  readonly gitDigest: string;
  readonly imageDigests: readonly string[];
  readonly nodeDigest: string;
  readonly pnpmDigest: string;
}

export interface DeliveryProfileProviderProfileRef {
  readonly profileDigest: string;
  readonly profileRef: string;
  readonly profileRevisionId: string;
}

export interface DeliveryProfileQualificationInvalidation {
  readonly invalidatedAtEpochMs: number;
  readonly invalidatedByAuthorityRef: string;
  readonly invalidationDigest: string;
  readonly invalidationReason: string;
  readonly invalidationRef: string;
  readonly supersedingQualificationId: string | null;
}

export interface DeliveryProfileQualificationDraft {
  readonly benchmarkManifest: DeliveryProfileBenchmarkManifestRef;
  readonly benchmarkVerdict: DeliveryProfileBenchmarkVerdict;
  readonly builderIdentity: DeliveryProfileBuilderIdentity;
  readonly expiresAtEpochMs: number;
  readonly independentVerifierReceipts:
    readonly DeliveryProfileIndependentVerifierReceipt[];
  readonly invalidation: DeliveryProfileQualificationInvalidation | null;
  readonly moeSourceCommit: string;
  readonly observedDigests: DeliveryProfileObservedDigests;
  readonly operatorApprovalRef: string | null;
  readonly operatorDecision: DeliveryProfileOperatorDecision;
  readonly profileFamilyId: DeliveryProfileFamilyId;
  readonly profileId: string;
  readonly profileRevisionDigest: string;
  readonly profileRevisionId: string;
  readonly providerProfileRefs: readonly DeliveryProfileProviderProfileRef[];
  readonly qualificationId: string;
  readonly qualifiedAtEpochMs: number;
  readonly validity: DeliveryProfileQualificationValidity;
}

export interface DeliveryProfileQualification extends DeliveryProfileQualificationDraft {
  readonly qualificationDigest: string;
  readonly version: typeof DELIVERY_PROFILE_QUALIFICATION_VERSION;
}

export interface DeliveryProfileOperatorApprovalBinding {
  readonly operatorApprovalRef: string;
  readonly profileFamilyId: DeliveryProfileFamilyId;
  readonly profileId: string;
  readonly profileRevisionDigest: string;
  readonly profileRevisionId: string;
  readonly qualificationDigest: string;
  readonly qualificationId: string;
}

export interface DeliveryProfileQualificationEvidenceBinding {
  readonly benchmarkManifest: DeliveryProfileBenchmarkManifestRef;
  readonly benchmarkVerdict: DeliveryProfileBenchmarkVerdict;
  readonly builderIdentity: DeliveryProfileBuilderIdentity;
  readonly moeSourceCommit: string;
  readonly observedDigests: DeliveryProfileObservedDigests;
  readonly profileFamilyId: DeliveryProfileFamilyId;
  readonly profileId: string;
  readonly profileRevisionDigest: string;
  readonly profileRevisionId: string;
  readonly providerProfileRefs: readonly DeliveryProfileProviderProfileRef[];
  readonly qualificationDigest: string;
  readonly qualificationId: string;
  readonly requiredModelProviderCapabilities:
    readonly DeliveryProfileModelProviderCapability[];
}

export interface DeliveryProfileQualificationStatusBinding {
  readonly qualificationDigest: string;
  readonly qualificationId: string;
}

/** Current durable head for one exact qualification; REVOKED is never authorizing. */
export interface DeliveryProfileDurableQualificationStatus {
  readonly qualificationDigest: string;
  readonly qualificationId: string;
  readonly status: "CURRENT" | "REVOKED";
  readonly statusDigest: string;
  readonly statusRef: string;
}

/** Trusted adapter boundary. Every method verifies durable records, never string shape alone. */
export interface DeliveryProfileQualificationAuthorityPort {
  readonly readDurableQualificationStatus: (
    binding: DeliveryProfileQualificationStatusBinding,
  ) => DeliveryProfileDurableQualificationStatus | undefined;
  readonly verifyDurableOperatorApproval: (
    binding: DeliveryProfileOperatorApprovalBinding,
  ) => boolean;
  readonly verifyDurableBuilderIdentity: (
    builder: DeliveryProfileBuilderIdentity,
    binding: DeliveryProfileQualificationEvidenceBinding,
  ) => boolean;
  readonly verifyDurableProviderProfile: (
    profile: DeliveryProfileProviderProfileRef,
    binding: DeliveryProfileQualificationEvidenceBinding,
  ) => boolean;
  readonly verifyDurableVerifierReceipt: (
    receipt: DeliveryProfileIndependentVerifierReceipt,
    binding: DeliveryProfileQualificationEvidenceBinding,
  ) => boolean;
}

export type DeliveryProfileQualificationDraftAdmission =
  | Readonly<{ draft: DeliveryProfileQualificationDraft; ok: true }>
  | DeliveryProfileRefusal;
export type DeliveryProfileQualificationAdmission =
  | Readonly<{ ok: true; qualification: DeliveryProfileQualification }>
  | DeliveryProfileRefusal;
