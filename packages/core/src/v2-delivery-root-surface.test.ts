import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES,
  CAPABILITY_CATALOG_ROLES,
  DELIVERY_PROFILE_FAMILY_DEFINITIONS,
  DELIVERY_PROFILE_FAMILY_IDS,
  EXECUTION_ISOLATION_FRESH_VERIFIER_MOUNT_SHAPE,
  EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES,
  EXECUTION_ISOLATION_PROFILE_DEFAULT_PLANE,
  VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES,
  admitVerificationRecipeForExecutionProfile,
  createCapabilityCatalogRevision,
  createDeliveryProfileQualification,
  createDeliveryProfileRevision,
  createExecutionIsolationProfileRevision,
  createVerificationRecipeRevision,
  decodeDeliveryProfileQualificationBytes,
  decodeCapabilityCatalogRevisionBytes,
  decodeDeliveryProfileRevisionBytes,
  decodeExecutionIsolationProfileRevisionBytes,
  decodeVerificationRecipeRevisionBytes,
  deliveryProfileFamilyDefinition,
  deriveCapabilityCatalogRevisionDigest,
  encodeDeliveryProfileQualification,
  encodeCapabilityCatalogRevision,
  encodeDeliveryProfileRevision,
  encodeExecutionIsolationProfileRevision,
  encodeVerificationRecipeRevision,
  resolveQualifiedDeliveryProfile,
  resolveCapabilityCatalogEntry,
  validateProductContractGate1V2,
} from "@moe/core";

describe("v2 delivery authority on the @moe/core root", () => {
  it("publishes the exact closed delivery-family roster", () => {
    expect(DELIVERY_PROFILE_FAMILY_IDS).toEqual([
      "Next.js/TypeScript", "React/FastAPI", "Go/HTMX", "Rust/Axum",
      "ASP.NET Core/Blazor",
    ]);
    expect(DELIVERY_PROFILE_FAMILY_DEFINITIONS.map((entry) => entry.profileFamilyId))
      .toEqual(DELIVERY_PROFILE_FAMILY_IDS);
    expect(DELIVERY_PROFILE_FAMILY_IDS.map(deliveryProfileFamilyDefinition))
      .toEqual(DELIVERY_PROFILE_FAMILY_DEFINITIONS);
  });

  it("publishes the exact isolation planes and credential-free verifier boundary", () => {
    expect(EXECUTION_ISOLATION_PROFILE_DEFAULT_PLANE).toBe("DISPOSABLE_DOCKER_LINUX");
    expect(EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES).toEqual([
      "CONTROL", "PROVIDER", "QUALIFICATION_BUILD", "RESEARCH", "PRODUCT_PREVIEW",
      "PRODUCT_PRODUCTION", "TRUSTED_GITHUB_PUBLISHER",
    ]);
    expect(EXECUTION_ISOLATION_FRESH_VERIFIER_MOUNT_SHAPE).toEqual([
      { access: "READ_ONLY", kind: "SOURCE_SNAPSHOT" },
      { access: "WRITE_ONLY", kind: "EVIDENCE" },
    ]);
    expect(VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES).toEqual([
      "CI", "MOE_EVIDENCE_DIR", "NO_COLOR",
    ]);
  });

  it("publishes every v2 capability role and independent verification authority", () => {
    expect(CAPABILITY_CATALOG_ROLES).toEqual([
      "PRODUCT", "REQUIREMENTS", "RESEARCH", "UX", "ARCHITECTURE", "FRONTEND", "BACKEND",
      "PLATFORM", "SECURITY", "QA", "REVIEW", "RELEASE", "ANALYTICS", "OPERATIONS",
    ]);
    expect(CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES).toEqual([
      "PRODUCT", "REQUIREMENTS", "UX", "ARCHITECTURE", "SECURITY", "QA", "OPERATIONS",
    ]);
  });

  it("publishes every codec and authority composition needed by v2 consumers", () => {
    expect([
      createDeliveryProfileRevision,
      encodeDeliveryProfileRevision,
      decodeDeliveryProfileRevisionBytes,
      createDeliveryProfileQualification,
      encodeDeliveryProfileQualification,
      decodeDeliveryProfileQualificationBytes,
      resolveQualifiedDeliveryProfile,
      createExecutionIsolationProfileRevision,
      encodeExecutionIsolationProfileRevision,
      decodeExecutionIsolationProfileRevisionBytes,
      createVerificationRecipeRevision,
      encodeVerificationRecipeRevision,
      decodeVerificationRecipeRevisionBytes,
      admitVerificationRecipeForExecutionProfile,
      validateProductContractGate1V2,
      createCapabilityCatalogRevision,
      deriveCapabilityCatalogRevisionDigest,
      encodeCapabilityCatalogRevision,
      decodeCapabilityCatalogRevisionBytes,
      resolveCapabilityCatalogEntry,
    ].map((value) => typeof value)).toEqual(Array(20).fill("function"));
  });
});
