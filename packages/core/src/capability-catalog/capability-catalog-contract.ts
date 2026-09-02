import { MAX_JSON_BODY_BYTES } from "@moe/contracts";

import {
  DELIVERY_PROFILE_FAMILY_IDS,
  type DeliveryProfileFamilyId,
} from "../delivery-profile/delivery-profile-contract.js";

export const CAPABILITY_CATALOG_VERSION = "moe-capability-catalog-revision/2" as const;
export const CAPABILITY_CATALOG_DIGEST_DOMAIN =
  "moe-capability-catalog-revision-digest/2" as const;

export const CAPABILITY_CATALOG_DELIVERY_PROFILE_FAMILY_IDS =
  DELIVERY_PROFILE_FAMILY_IDS;
export const CAPABILITY_CATALOG_CRITERION_CATEGORIES = Object.freeze([
  "DEPLOYMENT",
  "FUNCTIONAL",
  "NON_FUNCTIONAL",
  "SECURITY_PRIVACY",
  "TECHNOLOGY",
  "UX_ACCESSIBILITY",
] as const);
export const CAPABILITY_CATALOG_ROLES = Object.freeze([
  "PRODUCT",
  "REQUIREMENTS",
  "RESEARCH",
  "UX",
  "ARCHITECTURE",
  "FRONTEND",
  "BACKEND",
  "PLATFORM",
  "SECURITY",
  "QA",
  "REVIEW",
  "RELEASE",
  "ANALYTICS",
  "OPERATIONS",
] as const);
export const CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES = Object.freeze([
  "PRODUCT", "REQUIREMENTS", "UX", "ARCHITECTURE", "SECURITY", "QA", "OPERATIONS",
] as const);
export const CAPABILITY_CATALOG_AUTHORITY_KINDS = Object.freeze([
  "BUILDER", "VERIFIER",
] as const);
export const CAPABILITY_CATALOG_RESOURCE_KINDS = Object.freeze([
  "EVIDENCE_CLASS", "NETWORK_PLANE", "RESOURCE_CLASS", "SECRET_SCHEMA",
] as const);

export const CAPABILITY_CATALOG_CODES = Object.freeze([
  "CAPABILITY_CATALOG_MALFORMED",
  "CAPABILITY_CATALOG_VACUOUS",
  "CAPABILITY_CATALOG_VERSION_UNSUPPORTED",
  "CAPABILITY_CATALOG_REFERENCE_INVALID",
  "CAPABILITY_CATALOG_SCOPE_INVALID",
  "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
  "CAPABILITY_CATALOG_BYTES_INVALID",
  "CAPABILITY_CATALOG_DUPLICATE_KEY",
  "CAPABILITY_CATALOG_NONCANONICAL",
  "CAPABILITY_CATALOG_DIGEST_MISMATCH",
  "CAPABILITY_CATALOG_ENTRY_ABSENT",
  "CAPABILITY_CATALOG_BINDING_MISMATCH",
  "CAPABILITY_CATALOG_ROLE_COVERAGE_INCOMPLETE",
  "CAPABILITY_CATALOG_VERIFIER_BINDING_INVALID",
  "CAPABILITY_CATALOG_RESOURCE_SCOPE_INVALID",
] as const);

export const CAPABILITY_CATALOG_LAYERS = Object.freeze([
  "CAPABILITY_CATALOG_ADMISSION",
  "CAPABILITY_CATALOG_VERSION",
  "CAPABILITY_CATALOG_REFERENCES",
  "CAPABILITY_CATALOG_SCOPES",
  "CAPABILITY_CATALOG_LIMITS",
  "CAPABILITY_CATALOG_CODEC",
  "CAPABILITY_CATALOG_CANONICALIZATION",
  "CAPABILITY_CATALOG_DIGEST",
  "CAPABILITY_CATALOG_RESOLUTION",
  "CAPABILITY_CATALOG_AUTHORITY",
  "CAPABILITY_CATALOG_RESOURCES",
] as const);

export const CAPABILITY_CATALOG_LIMITS = Object.freeze({
  maxBytes: MAX_JSON_BODY_BYTES,
  maxEntries: 512,
  maxIdBytes: 512,
  maxRefsPerEntry: 128,
  maxResourceRefBytes: 512,
  maxScopeBytes: 1_024,
  maxScopesPerKind: 128,
  maxSnapshotDepth: 6,
  maxSnapshotNodes: 100_000,
});

export type CapabilityCatalogDeliveryProfileFamilyId = DeliveryProfileFamilyId;
export type CapabilityCatalogCriterionCategory =
  (typeof CAPABILITY_CATALOG_CRITERION_CATEGORIES)[number];
export type CapabilityCatalogRole = (typeof CAPABILITY_CATALOG_ROLES)[number];
export type CapabilityCatalogAuthorityKind =
  (typeof CAPABILITY_CATALOG_AUTHORITY_KINDS)[number];
export type CapabilityCatalogResourceKind =
  (typeof CAPABILITY_CATALOG_RESOURCE_KINDS)[number];
export type CapabilityCatalogCode = (typeof CAPABILITY_CATALOG_CODES)[number];
export type CapabilityCatalogLayer = (typeof CAPABILITY_CATALOG_LAYERS)[number];

export interface CapabilityCatalogLineage {
  readonly parentRevisionDigest: string;
  readonly parentRevisionId: string;
}

export interface CapabilityCatalogVerificationRecipeRevisionRef {
  readonly recipeRevisionDigest: string;
  readonly recipeRevisionId: string;
}

export interface CapabilityCatalogResourceScope {
  readonly kind: CapabilityCatalogResourceKind;
  readonly ref: string;
}

export interface CapabilityCatalogEntry {
  readonly authorityKind: CapabilityCatalogAuthorityKind;
  readonly capabilityId: string;
  readonly criterionCategories: readonly CapabilityCatalogCriterionCategory[];
  readonly deliveryProfileFamilyId: CapabilityCatalogDeliveryProfileFamilyId;
  readonly deliveryProfileRevisionDigest: string;
  readonly deliveryProfileRevisionId: string;
  readonly executionIsolationProfileRevisionDigest: string;
  readonly executionIsolationProfileRevisionId: string;
  readonly readScopes: readonly string[];
  readonly requiredImageDigests: readonly string[];
  readonly requiredToolDigests: readonly string[];
  readonly resourceScopes: readonly CapabilityCatalogResourceScope[];
  readonly roles: readonly CapabilityCatalogRole[];
  readonly verificationRecipeRevisions:
    readonly CapabilityCatalogVerificationRecipeRevisionRef[];
  readonly verifierCapabilityIds: readonly string[];
  readonly writeScopes: readonly string[];
}

export interface CapabilityCatalogRevisionDraft {
  readonly catalogId: string;
  readonly entries: readonly CapabilityCatalogEntry[];
  readonly lineage: CapabilityCatalogLineage | null;
  readonly revisionId: string;
  readonly sourceCommitSha256: string;
}

export interface CapabilityCatalogRevision extends CapabilityCatalogRevisionDraft {
  readonly revisionDigest: string;
  readonly version: typeof CAPABILITY_CATALOG_VERSION;
}

export interface CapabilityCatalogRefusal {
  readonly code: CapabilityCatalogCode;
  readonly layer: CapabilityCatalogLayer;
  readonly ok: false;
}

export type CapabilityCatalogRevisionDraftAdmission =
  | Readonly<{ draft: CapabilityCatalogRevisionDraft; ok: true }>
  | CapabilityCatalogRefusal;
export type CapabilityCatalogRevisionAdmission =
  | Readonly<{ ok: true; revision: CapabilityCatalogRevision }>
  | CapabilityCatalogRefusal;

export function capabilityCatalogRefusal(
  code: CapabilityCatalogCode,
  layer: CapabilityCatalogLayer,
): CapabilityCatalogRefusal {
  return Object.freeze({ code, layer, ok: false as const });
}
