import {
  DELIVERY_PROFILE_FAMILY_DEFINITIONS,
  DELIVERY_PROFILE_RECIPE_KINDS,
  computeDeliveryProfileRecipeDigest,
  createDeliveryProfileQualification,
  createDeliveryProfileRevision,
} from "../delivery-profile/delivery-profile-codec.js";
import type {
  DeliveryProfileQualificationAuthorityPort,
  DeliveryProfileQualificationStatusBinding,
} from "../delivery-profile/delivery-profile-contract.js";
import {
  EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS,
  createExecutionIsolationProfileRevision,
} from "../execution-profile/execution-isolation-profile-codec.js";
import { createVerificationRecipeRevision } from
  "../execution-profile/verification-recipe-codec.js";

export const hex = (digit: string): string => digit.repeat(64);
export const ALL_ROLES = Object.freeze([
  "ANALYTICS", "ARCHITECTURE", "BACKEND", "FRONTEND", "OPERATIONS", "PLATFORM",
  "PRODUCT", "QA", "RELEASE", "REQUIREMENTS", "RESEARCH", "REVIEW", "SECURITY", "UX",
]);
export const VERIFIER_ROLES = Object.freeze([
  "ARCHITECTURE", "OPERATIONS", "PRODUCT", "QA", "REQUIREMENTS", "SECURITY", "UX",
]);
export const ALL_CATEGORIES = Object.freeze([
  "DEPLOYMENT", "FUNCTIONAL", "NON_FUNCTIONAL", "SECURITY_PRIVACY",
  "TECHNOLOGY", "UX_ACCESSIBILITY",
]);
const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const NEXT = DELIVERY_PROFILE_FAMILY_DEFINITIONS[0]!;
const unwrap = <T extends { readonly ok: boolean }>(result: T): Exclude<T, { ok: false }> => {
  if (!result.ok) {
    const refusal = result as unknown as Readonly<{ code: string; layer: string }>;
    throw new Error(`${refusal.code}@${refusal.layer}`);
  }
  return result as Exclude<T, { ok: false }>;
};

export function deliveryProfileDraft(): Record<string, unknown> {
  return {
    allowedCapabilityIds: [
      "delivery.activate", "delivery.backup", "delivery.browser", "delivery.build",
      "delivery.health", "delivery.migrate", "delivery.restore", "delivery.rollback",
      "delivery.test",
    ],
    composeTopology: {
      networkMode: "MANAGED_INTERNAL",
      services: NEXT.services.map((service) => ({
        dependsOnServiceIds: [...service.dependsOnServiceIds],
        healthRecipeRef: "recipe-health",
        imageRef: service.imageRef,
        secretIds: ["database-password"],
        serviceId: service.serviceId,
      })),
    },
    familyDefinitionDigest: NEXT.definitionDigest,
    imageRefs: NEXT.imageRefRoster.map((imageRef) => ({
      imageDigest: `sha256:${hex("c")}`, imageRef,
    })),
    policyRefs: {
      budget: { artifactDigest: hex("1"), artifactRef: "policy-budget", policyKind: "BUDGET" },
      operations: {
        artifactDigest: hex("2"), artifactRef: "policy-operations", policyKind: "OPERATIONS",
      },
      resource: {
        artifactDigest: hex("3"), artifactRef: "policy-resource", policyKind: "RESOURCE",
      },
      security: {
        artifactDigest: hex("4"), artifactRef: "policy-security", policyKind: "SECURITY",
      },
    },
    profileFamilyId: "Next.js/TypeScript",
    profileId: "profile-next-typescript",
    qualificationBenchmarkCorpus: {
      artifactDigest: hex("5"), artifactRef: "benchmark-next-typescript-v1",
    },
    readScopes: ["project:source"],
    recipes: Object.fromEntries(DELIVERY_PROFILE_RECIPE_KINDS.map((kind) => [
      kind.toLowerCase(), (() => {
        const argv = ["--profile", kind.toLowerCase()];
        const toolRef = NEXT.toolRefRoster[0]!;
        return {
          argv,
          executionMode: "DIRECT_ARGV",
          recipeDigest: computeDeliveryProfileRecipeDigest(toolRef, argv),
          recipeRef: `recipe-${kind.toLowerCase()}`,
          toolRef,
        };
      })(),
    ])),
    requiredModelProviderCapabilities: [
      "CODE_GENERATION", "STRUCTURED_OUTPUT", "TOOL_CALLING", "VISION",
    ],
    resourceClasses: ["BROWSER", "BUILD_CPU", "CONTAINER", "DATABASE", "PERSISTENT_STORAGE"],
    revisionId: "profile-next-typescript-r1",
    secretSchema: [{
      consumerServiceIds: ["web"],
      purpose: "Database credential injected only into the web service.",
      required: true,
      secretId: "database-password",
    }],
    stackGrammar: {
      components: NEXT.components.map((component, index) => ({
        ...component, artifactDigest: hex(String(index + 1)), version: `${index + 1}.2.3`,
      })),
      dependencyEdges: NEXT.dependencyEdges.map((edge) => ({ ...edge })),
    },
    supportedBackendFacts: {
      databaseEngine: "PostgreSQL", healthProtocol: "HTTP", migrationMode: "TRANSACTIONAL",
      stateModel: "PERSISTENT",
    },
    supportedHostFacts: {
      architecture: "x86_64", browserEngine: "Chromium",
      composeImplementation: "Docker Compose", containerEngine: "Docker",
      operatingSystem: "Linux",
    },
    templateRefs: NEXT.templateRefRoster.map((artifactRef) => ({
      artifactDigest: hex("9"), artifactRef,
    })),
    toolRefs: NEXT.toolRefRoster.map((artifactRef) => ({
      artifactDigest: hex("d"), artifactRef,
    })),
    writeScopes: ["project:generated", "project:migrations"],
  };
}

export function createDeliveryProfile(value: unknown = deliveryProfileDraft()) {
  return unwrap(createDeliveryProfileRevision(value)).revision;
}

export function createQualification(
  profile = createDeliveryProfile(),
  patch: Record<string, unknown> = {},
  verifierCapabilityIds: readonly string[] = ["capability-web-verify"],
) {
  return unwrap(createDeliveryProfileQualification({
    benchmarkManifest: {
      benchmarkCorpusDigest: profile.qualificationBenchmarkCorpus.artifactDigest,
      benchmarkCorpusRef: profile.qualificationBenchmarkCorpus.artifactRef,
      manifestDigest: hex("7"),
      manifestRef: "benchmark-manifest:next-typescript-v1",
    },
    benchmarkVerdict: "PASSED",
    builderIdentity: {
      authorityRef: "authority-builder-1",
      capabilityId: "capability-web-build",
      principalRef: "principal-builder-1",
    },
    expiresAtEpochMs: 2_000,
    independentVerifierReceipts: DELIVERY_PROFILE_RECIPE_KINDS.map((kind, index) => {
      const verifierCapabilityId = verifierCapabilityIds[index % verifierCapabilityIds.length]!;
      return {
      observedAtEpochMs: 900 + index,
      outcome: "PASS",
      profileRevisionDigest: profile.revisionDigest,
      receiptDigest: hex(String(index + 1)),
      receiptRef: `receipt-${kind.toLowerCase()}`,
      recipeDigest: profile.recipes[kind.toLowerCase() as keyof typeof profile.recipes].recipeDigest,
      recipeRef: `recipe-${kind.toLowerCase()}`,
      verifierAuthorityRef: `authority:${verifierCapabilityId}`,
      verifierCapabilityId,
      verifierRef: `principal:${verifierCapabilityId}`,
    };
    }).sort((left, right) => compareCodeUnits(left.receiptRef, right.receiptRef)),
    invalidation: null,
    moeSourceCommit: "1".repeat(40),
    observedDigests: {
      browserDigest: hex("1"), composeDigest: hex("2"), dockerDigest: hex("3"),
      gitDigest: hex("4"),
      imageDigests: profile.imageRefs.map((image) => image.imageDigest).sort(),
      nodeDigest: hex("5"), pnpmDigest: hex("6"),
    },
    operatorApprovalRef: "approval-profile-next-r1",
    operatorDecision: "APPROVED",
    profileFamilyId: profile.profileFamilyId,
    profileId: profile.profileId,
    profileRevisionDigest: profile.revisionDigest,
    profileRevisionId: profile.revisionId,
    providerProfileRefs: [{
      profileDigest: hex("8"),
      profileRef: "provider-profile:codex",
      profileRevisionId: "provider-profile-codex-r1",
    }],
    qualificationId: "qualification-profile-next-r1",
    qualifiedAtEpochMs: 1_000,
    validity: "CURRENT",
    ...patch,
  })).qualification;
}

export function durableQualificationAuthority(
  result = true,
): DeliveryProfileQualificationAuthorityPort {
  return Object.freeze({
    readDurableQualificationStatus: (binding: DeliveryProfileQualificationStatusBinding) =>
      result ? Object.freeze({
      qualificationDigest: binding.qualificationDigest,
      qualificationId: binding.qualificationId,
      status: "CURRENT" as const,
      statusDigest: hex("a"),
      statusRef: `qualification-status:${binding.qualificationId}`,
    }) : undefined,
    verifyDurableOperatorApproval: () => result,
    verifyDurableBuilderIdentity: () => result,
    verifyDurableProviderProfile: () => result,
    verifyDurableVerifierReceipt: () => result,
  });
}

export function executionProfileDraft(
  deliveryProfileRevisionDigest: string,
  purpose: "BUILD_AGENT" | "FRESH_VERIFIER" = "FRESH_VERIFIER",
): Record<string, unknown> {
  const fresh = purpose === "FRESH_VERIFIER";
  return {
    commandMode: "DIRECT_ARGV",
    credentialBroker: fresh ? null : {
      brokerRef: "broker:provider-session", maximumCredentialTtlMs: 60_000,
    },
    deliveryProfileRevisionDigest,
    executionPlane: "DISPOSABLE_DOCKER_LINUX",
    forbiddenHostInputs: [...EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS],
    image: { imageDigest: `sha256:${hex("c")}`, imageRef: "image:node24" },
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
        endpointPolicyDigest: hex("8"),
        endpointPolicyRef: "network-policy:qualification",
        plane: "QUALIFICATION_BUILD",
        purpose,
      }],
      plane: "QUALIFICATION_BUILD",
    },
    profileId: fresh ? "execution-verifier" : "execution-builder",
    purpose,
    revisionId: fresh ? "execution-verifier-r1" : "execution-builder-r1",
    sourceSnapshotDigest: hex("6"),
    tools: [{ toolDigest: hex("d"), toolRef: "tool:node" }],
  };
}

export function createExecutionProfile(
  deliveryProfileRevisionDigest: string,
  patch: Record<string, unknown> = {},
  purpose: "BUILD_AGENT" | "FRESH_VERIFIER" = "FRESH_VERIFIER",
) {
  return unwrap(createExecutionIsolationProfileRevision({
    ...executionProfileDraft(deliveryProfileRevisionDigest, purpose), ...patch,
  })).revision;
}

export function verificationRecipeDraft(execution: {
  readonly revisionDigest: string;
  readonly sourceSnapshotDigest: string;
}): Record<string, unknown> {
  return {
    argv: ["--run", "test:unit"],
    environmentNameAllowlist: ["CI", "MOE_EVIDENCE_DIR"],
    evidenceParser: {
      parserRef: "evidence-parser:vitest-json", revisionDigest: hex("f"),
    },
    executionProfileRevisionDigest: execution.revisionDigest,
    expectedExitCode: 0,
    expectedOutputs: [{
      mount: "EVIDENCE", relativePath: "reports/unit.json", sha256: hex("7"),
    }],
    expectedRefusal: null,
    image: { imageDigest: `sha256:${hex("c")}`, imageRef: "image:node24" },
    networkPolicy: {
      accessMode: "NONE",
      plane: "QUALIFICATION_BUILD",
      policyRef: "network-policy:qualification",
      revisionDigest: hex("8"),
    },
    recipeId: "verify-unit",
    resourceCaps: {
      cpuMilliCores: 2_000,
      memoryBytes: 1_073_741_824,
      outputBytes: 10_485_760,
      pids: 128,
      timeoutMs: 300_000,
    },
    revisionId: "verify-unit-r1",
    sourceSnapshotDigest: execution.sourceSnapshotDigest,
    tool: { toolDigest: hex("d"), toolRef: "tool:node" },
    workingDirectory: "packages/core",
  };
}

export function createVerificationRecipe(
  execution: Parameters<typeof verificationRecipeDraft>[0],
  patch: Record<string, unknown> = {},
) {
  return unwrap(createVerificationRecipeRevision({
    ...verificationRecipeDraft(execution), ...patch,
  })).revision;
}
