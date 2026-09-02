import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

import type {
  DeliveryProfileModelProviderCapability,
  DeliveryProfilePolicyRefs,
  DeliveryProfileResourceClass,
  DeliveryProfileSupportedBackendFacts,
  DeliveryProfileSupportedHostFacts,
} from "./delivery-profile-revision-contract.js";
import type {
  DeliveryProfileComposeTopology,
  DeliveryProfileImmutableArtifactRef,
  DeliveryProfileImmutableImageRef,
  DeliveryProfileRecipes,
  DeliveryProfileSecretSchemaEntry,
  DeliveryProfileStackGrammar,
} from "./delivery-profile-topology-contract.js";

export const DELIVERY_PROFILE_VERSION = "moe-delivery-profile-revision/2" as const;
export const DELIVERY_PROFILE_QUALIFICATION_VERSION =
  "moe-delivery-profile-qualification/3" as const;
export const DELIVERY_PROFILE_DIGEST_DOMAIN =
  "moe-delivery-profile-revision-digest/2" as const;
export const DELIVERY_PROFILE_QUALIFICATION_DIGEST_DOMAIN =
  "moe-delivery-profile-qualification-digest/3" as const;

/** Closed shipped-family roster. A family descriptor is not qualification authority. */
export const DELIVERY_PROFILE_FAMILY_IDS = Object.freeze([
  "Next.js/TypeScript",
  "React/FastAPI",
  "Go/HTMX",
  "Rust/Axum",
  "ASP.NET Core/Blazor",
] as const);

export const DELIVERY_PROFILE_RECIPE_KINDS = Object.freeze([
  "BUILD", "TEST", "BROWSER", "MIGRATION", "HEALTH", "BACKUP", "RESTORE",
  "ACTIVATION", "ROLLBACK",
] as const);

export const DELIVERY_PROFILE_STACK_ROLES = Object.freeze([
  "FRONTEND", "BACKEND", "LANGUAGE", "RUNTIME", "DATABASE", "MIGRATION", "PROXY", "WORKER",
] as const);

export const DELIVERY_PROFILE_OPERATOR_DECISIONS = Object.freeze([
  "APPROVED", "REJECTED",
] as const);

export const DELIVERY_PROFILE_BENCHMARK_VERDICTS = Object.freeze([
  "PASSED", "FAILED", "UNKNOWN",
] as const);

export const DELIVERY_PROFILE_QUALIFICATION_VALIDITIES = Object.freeze([
  "CURRENT", "INVALIDATED",
] as const);

export const DELIVERY_PROFILE_CODES = Object.freeze([
  "DELIVERY_PROFILE_MALFORMED",
  "DELIVERY_PROFILE_VERSION_UNSUPPORTED",
  "DELIVERY_PROFILE_FAMILY_UNSUPPORTED",
  "DELIVERY_PROFILE_FAMILY_GRAMMAR_MISMATCH",
  "DELIVERY_PROFILE_SHELL_EXECUTION_FORBIDDEN",
  "DELIVERY_PROFILE_REFERENCE_INVALID",
  "DELIVERY_PROFILE_LIMIT_EXCEEDED",
  "DELIVERY_PROFILE_BYTES_INVALID",
  "DELIVERY_PROFILE_DUPLICATE_KEY",
  "DELIVERY_PROFILE_NONCANONICAL",
  "DELIVERY_PROFILE_DIGEST_MISMATCH",
  "DELIVERY_PROFILE_RECIPE_DIGEST_MISMATCH",
  "DELIVERY_PROFILE_NOT_QUALIFIED",
] as const);

export const DELIVERY_PROFILE_LAYERS = Object.freeze([
  "DELIVERY_PROFILE_ADMISSION",
  "DELIVERY_PROFILE_VERSION",
  "DELIVERY_PROFILE_FAMILY",
  "DELIVERY_PROFILE_REFERENCES",
  "DELIVERY_PROFILE_LIMITS",
  "DELIVERY_PROFILE_CODEC",
  "DELIVERY_PROFILE_CANONICALIZATION",
  "DELIVERY_PROFILE_DIGEST",
  "DELIVERY_PROFILE_QUALIFICATION",
] as const);

export const DELIVERY_PROFILE_LIMITS = Object.freeze({
  maxArgBytes: 8_192,
  maxArgsPerRecipe: 128,
  maxBytes: MAX_JSON_BODY_BYTES,
  maxComponents: 64,
  maxEdges: 256,
  maxVerifierReceipts: 128,
  maxIdBytes: 512,
  maxRefsPerKind: 128,
  maxScopesPerKind: 128,
  maxSecrets: 128,
  maxServices: 64,
  maxSnapshotArrayLength: 256,
  maxSnapshotDepth: 12,
  maxSnapshotNodes: 100_000,
  maxStatementBytes: 16_384,
});

export type DeliveryProfileFamilyId = (typeof DELIVERY_PROFILE_FAMILY_IDS)[number];
export type DeliveryProfileRecipeKind = (typeof DELIVERY_PROFILE_RECIPE_KINDS)[number];
export type DeliveryProfileStackRole = (typeof DELIVERY_PROFILE_STACK_ROLES)[number];
export type DeliveryProfileOperatorDecision =
  (typeof DELIVERY_PROFILE_OPERATOR_DECISIONS)[number];
export type DeliveryProfileBenchmarkVerdict =
  (typeof DELIVERY_PROFILE_BENCHMARK_VERDICTS)[number];
export type DeliveryProfileQualificationValidity =
  (typeof DELIVERY_PROFILE_QUALIFICATION_VALIDITIES)[number];
export type DeliveryProfileCode = (typeof DELIVERY_PROFILE_CODES)[number];
export type DeliveryProfileLayer = (typeof DELIVERY_PROFILE_LAYERS)[number];

export interface DeliveryProfileRevisionDraft {
  readonly allowedCapabilityIds: readonly string[];
  readonly composeTopology: DeliveryProfileComposeTopology;
  readonly familyDefinitionDigest: string;
  readonly imageRefs: readonly DeliveryProfileImmutableImageRef[];
  readonly policyRefs: DeliveryProfilePolicyRefs;
  readonly profileFamilyId: DeliveryProfileFamilyId;
  readonly profileId: string;
  readonly qualificationBenchmarkCorpus: DeliveryProfileImmutableArtifactRef;
  readonly readScopes: readonly string[];
  readonly recipes: DeliveryProfileRecipes;
  readonly requiredModelProviderCapabilities:
    readonly DeliveryProfileModelProviderCapability[];
  readonly resourceClasses: readonly DeliveryProfileResourceClass[];
  readonly revisionId: string;
  readonly secretSchema: readonly DeliveryProfileSecretSchemaEntry[];
  readonly stackGrammar: DeliveryProfileStackGrammar;
  readonly supportedBackendFacts: DeliveryProfileSupportedBackendFacts;
  readonly supportedHostFacts: DeliveryProfileSupportedHostFacts;
  readonly templateRefs: readonly DeliveryProfileImmutableArtifactRef[];
  readonly toolRefs: readonly DeliveryProfileImmutableArtifactRef[];
  readonly writeScopes: readonly string[];
}

export interface DeliveryProfileRevision extends DeliveryProfileRevisionDraft {
  readonly revisionDigest: string;
  readonly version: typeof DELIVERY_PROFILE_VERSION;
}

export interface DeliveryProfileRefusal {
  readonly code: DeliveryProfileCode;
  readonly layer: DeliveryProfileLayer;
  readonly ok: false;
}

export type DeliveryProfileRevisionDraftAdmission =
  | Readonly<{ draft: DeliveryProfileRevisionDraft; ok: true }>
  | DeliveryProfileRefusal;
export type DeliveryProfileRevisionAdmission =
  | Readonly<{ ok: true; revision: DeliveryProfileRevision }>
  | DeliveryProfileRefusal;
export function deliveryProfileRefusal(
  code: DeliveryProfileCode,
  layer: DeliveryProfileLayer,
): DeliveryProfileRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}

export type {
  DeliveryProfileBenchmarkManifestRef,
  DeliveryProfileBuilderIdentity,
  DeliveryProfileDurableQualificationStatus,
  DeliveryProfileIndependentVerifierReceipt,
  DeliveryProfileObservedDigests,
  DeliveryProfileOperatorApprovalBinding,
  DeliveryProfileProviderProfileRef,
  DeliveryProfileQualification,
  DeliveryProfileQualificationAdmission,
  DeliveryProfileQualificationAuthorityPort,
  DeliveryProfileQualificationDraft,
  DeliveryProfileQualificationDraftAdmission,
  DeliveryProfileQualificationEvidenceBinding,
  DeliveryProfileQualificationInvalidation,
  DeliveryProfileQualificationStatusBinding,
} from "./delivery-profile-qualification-contract.js";

export {
  DELIVERY_PROFILE_MODEL_PROVIDER_CAPABILITIES,
  DELIVERY_PROFILE_POLICY_KINDS,
  DELIVERY_PROFILE_RESOURCE_CLASSES,
} from "./delivery-profile-revision-contract.js";
export type {
  DeliveryProfileComposeService,
  DeliveryProfileComposeTopology,
  DeliveryProfileFamilyComponentDefinition,
  DeliveryProfileFamilyDefinition,
  DeliveryProfileFamilyServiceDefinition,
  DeliveryProfileImmutableArtifactRef,
  DeliveryProfileImmutableImageRef,
  DeliveryProfileRecipeRef,
  DeliveryProfileRecipes,
  DeliveryProfileSecretSchemaEntry,
  DeliveryProfileStackComponent,
  DeliveryProfileStackEdge,
  DeliveryProfileStackGrammar,
} from "./delivery-profile-topology-contract.js";
export type {
  DeliveryProfileModelProviderCapability,
  DeliveryProfilePolicyKind,
  DeliveryProfilePolicyRefs,
  DeliveryProfileResourceClass,
  DeliveryProfileSupportedBackendFacts,
  DeliveryProfileSupportedHostFacts,
  DeliveryProfileTypedPolicyRef,
} from "./delivery-profile-revision-contract.js";
