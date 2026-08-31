import {
  EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS,
  createCapabilityCatalogRevision,
  createExecutionIsolationProfileRevision,
  createVerificationRecipeRevision,
  resolveCapabilityCatalogEntry,
} from "@moe/core";

import {
  compilerDeliveryProfile,
  compilerQualification,
  compilerQualificationAuthority,
  fixtureDigest,
} from "./compiler-profile-test-fixtures.js";

const CATEGORIES = Object.freeze([
  "DEPLOYMENT", "FUNCTIONAL", "NON_FUNCTIONAL", "SECURITY_PRIVACY",
  "TECHNOLOGY", "UX_ACCESSIBILITY",
] as const);
const ALL_ROLES = Object.freeze([
  "ANALYTICS", "ARCHITECTURE", "BACKEND", "FRONTEND", "OPERATIONS", "PLATFORM",
  "PRODUCT", "QA", "RELEASE", "REQUIREMENTS", "RESEARCH", "REVIEW", "SECURITY", "UX",
] as const);
const VERIFIER_ROLES = Object.freeze([
  "ARCHITECTURE", "OPERATIONS", "PRODUCT", "QA", "REQUIREMENTS", "SECURITY", "UX",
] as const);

function execution(profile: ReturnType<typeof compilerDeliveryProfile>,
  purpose: "BUILD_AGENT" | "FRESH_VERIFIER") {
  const fresh = purpose === "FRESH_VERIFIER";
  const result = createExecutionIsolationProfileRevision({
    commandMode: "DIRECT_ARGV",
    credentialBroker: fresh ? null : {
      brokerRef: "broker:provider-session", maximumCredentialTtlMs: 60_000,
    },
    deliveryProfileRevisionDigest: profile.revisionDigest,
    executionPlane: "DISPOSABLE_DOCKER_LINUX",
    forbiddenHostInputs: [...EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS],
    image: {
      imageDigest: profile.imageRefs[0]!.imageDigest,
      imageRef: "image:node24",
    },
    limits: {
      cpuMilliCores: 2_000, memoryBytes: 1_073_741_824,
      outputBytes: 10_485_760, pids: 128, wallTimeMs: 300_000,
    },
    mounts: fresh ? [
      { access: "READ_ONLY", kind: "SOURCE_SNAPSHOT", maxBytes: 10_485_760 },
      { access: "WRITE_ONLY", kind: "EVIDENCE", maxBytes: 10_485_760 },
    ] : [
      { access: "READ_ONLY", kind: "SOURCE_SNAPSHOT", maxBytes: 10_485_760 },
      { access: "READ_WRITE", kind: "RUN_SCRATCH", maxBytes: 10_485_760 },
      { access: "READ_WRITE", kind: "OUTPUT", maxBytes: 10_485_760 },
      { access: "READ_WRITE", kind: "EVIDENCE", maxBytes: 10_485_760 },
    ],
    network: {
      accessMode: "NONE",
      endpointPolicies: [{
        endpointPolicyDigest: fixtureDigest(`endpoint-${purpose}`),
        endpointPolicyRef: `network-policy:${purpose.toLowerCase()}`,
        plane: "QUALIFICATION_BUILD", purpose,
      }],
      plane: "QUALIFICATION_BUILD",
    },
    profileId: fresh ? "execution-verifier" : "execution-builder",
    purpose,
    revisionId: fresh ? "execution-verifier-r1" : "execution-builder-r1",
    sourceSnapshotDigest: fixtureDigest("source-snapshot"),
    tools: [{ toolDigest: profile.toolRefs[0]!.artifactDigest, toolRef: "tool:node" }],
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function recipe(executionProfile: ReturnType<typeof execution>,
  profile: ReturnType<typeof compilerDeliveryProfile>, label: "builder" | "verifier") {
  const result = createVerificationRecipeRevision({
    argv: ["--run", `test:${label}`],
    environmentNameAllowlist: ["CI", "MOE_EVIDENCE_DIR"],
    evidenceParser: {
      parserRef: "evidence-parser:vitest-json", revisionDigest: fixtureDigest("parser"),
    },
    executionProfileRevisionDigest: executionProfile.revisionDigest,
    expectedExitCode: 0,
    expectedOutputs: [{
      mount: "EVIDENCE", relativePath: `reports/${label}.json`,
      sha256: fixtureDigest(`report-${label}`),
    }],
    expectedRefusal: null,
    image: executionProfile.image,
    networkPolicy: {
      accessMode: "NONE", plane: "QUALIFICATION_BUILD",
      policyRef: `network-policy:${executionProfile.purpose.toLowerCase()}`,
      revisionDigest: executionProfile.network.endpointPolicies[0]!.endpointPolicyDigest,
    },
    recipeId: `verify-${label}`,
    resourceCaps: {
      cpuMilliCores: 2_000, memoryBytes: 1_073_741_824,
      outputBytes: 10_485_760, pids: 128, timeoutMs: 300_000,
    },
    revisionId: `verify-${label}-r1`,
    sourceSnapshotDigest: executionProfile.sourceSnapshotDigest,
    tool: { toolDigest: profile.toolRefs[0]!.artifactDigest, toolRef: "tool:node" },
    workingDirectory: "packages/core",
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function entry(profile: ReturnType<typeof compilerDeliveryProfile>,
  executionProfile: ReturnType<typeof execution>, verification: ReturnType<typeof recipe>,
  authorityKind: "BUILDER" | "VERIFIER") {
  const capabilityId = authorityKind === "BUILDER"
    ? "capability-web-build" : "capability-web-verify";
  return {
    authorityKind, capabilityId, criterionCategories: [...CATEGORIES],
    deliveryProfileFamilyId: profile.profileFamilyId,
    deliveryProfileRevisionDigest: profile.revisionDigest,
    deliveryProfileRevisionId: profile.revisionId,
    executionIsolationProfileRevisionDigest: executionProfile.revisionDigest,
    executionIsolationProfileRevisionId: executionProfile.revisionId,
    readScopes: ["packages/core/src"],
    requiredImageDigests: [verification.image.imageDigest],
    requiredToolDigests: [verification.tool.toolDigest],
    resourceScopes: [
      { kind: "EVIDENCE_CLASS", ref: "EVIDENCE" },
      { kind: "NETWORK_PLANE", ref: executionProfile.network.plane },
      { kind: "RESOURCE_CLASS", ref: profile.resourceClasses[0]! },
      { kind: "SECRET_SCHEMA", ref: profile.secretSchema[0]!.secretId },
    ],
    roles: authorityKind === "BUILDER" ? [...ALL_ROLES] : [...VERIFIER_ROLES],
    verificationRecipeRevisions: [{
      recipeRevisionDigest: verification.revisionDigest,
      recipeRevisionId: verification.revisionId,
    }],
    verifierCapabilityIds: authorityKind === "BUILDER" ? ["capability-web-verify"] : [],
    writeScopes: authorityKind === "BUILDER" ? ["packages/core/generated"] : [],
  };
}

export function compilerResolutionMintInput() {
  const profile = compilerDeliveryProfile(); const qualification = compilerQualification(profile);
  const builderExecution = execution(profile, "BUILD_AGENT");
  const verifierExecution = execution(profile, "FRESH_VERIFIER");
  const builderRecipe = recipe(builderExecution, profile, "builder");
  const verifierRecipe = recipe(verifierExecution, profile, "verifier");
  const builder = entry(profile, builderExecution, builderRecipe, "BUILDER");
  const verifier = entry(profile, verifierExecution, verifierRecipe, "VERIFIER");
  const catalog = createCapabilityCatalogRevision({
    catalogId: "catalog-v2", entries: [builder, verifier], lineage: null,
    revisionId: "catalog-r1", sourceCommitSha256: fixtureDigest("source-commit"),
  });
  if (!catalog.ok) throw new Error(`${catalog.code}@${catalog.layer}`);
  return Object.freeze({
    catalog: catalog.revision,
    materials: Object.freeze({
      deliveryProfileQualification: qualification, deliveryProfileRevision: profile,
      entryMaterials: [
        { capabilityId: builder.capabilityId,
          executionIsolationProfileRevision: builderExecution,
          verificationRecipeRevisions: [builderRecipe] },
        { capabilityId: verifier.capabilityId,
          executionIsolationProfileRevision: verifierExecution,
          verificationRecipeRevisions: [verifierRecipe] },
      ],
    }),
    qualificationAuthority: compilerQualificationAuthority(),
    request: Object.freeze({
      atEpochMs: 1_500, capabilityId: builder.capabilityId,
      requiredCriterionCategories: [...CATEGORIES],
    }),
  });
}

/** Test-tier compatibility helper; production compilation accepts only opaque minted tokens. */
export function resolvedCompilerWitness() {
  const value = compilerResolutionMintInput();
  const resolved = resolveCapabilityCatalogEntry(
    value.catalog, value.request, value.materials, value.qualificationAuthority,
  );
  if (!resolved.ok) throw new Error(`${resolved.code}@${resolved.layer}`);
  return Object.freeze({
    catalogRevision: value.catalog,
    qualificationStatus: resolved.witness.deliveryProfileQualificationStatus,
    witness: resolved.witness,
  });
}
