import { createHash } from "node:crypto";
import {
  DELIVERY_PROFILE_FAMILY_DEFINITIONS,
  DELIVERY_PROFILE_RECIPE_KINDS,
  computeDeliveryProfileRecipeDigest,
  createDeliveryProfileQualification,
  createDeliveryProfileRevision,
  type DeliveryProfileQualificationAuthorityPort,
  type DeliveryProfileQualificationStatusBinding,
} from "@moe/core";

export const fixtureDigest = (label: string): string =>
  createHash("sha256").update(label).digest("hex");
const NEXT = DELIVERY_PROFILE_FAMILY_DEFINITIONS[0]!;

export function compilerDeliveryProfile() {
  const result = createDeliveryProfileRevision({
    allowedCapabilityIds: [
      "delivery.activate", "delivery.backup", "delivery.browser", "delivery.build",
      "delivery.health", "delivery.migrate", "delivery.restore", "delivery.rollback",
      "delivery.test",
    ],
    composeTopology: {
      networkMode: "MANAGED_INTERNAL",
      services: NEXT.services.map((service) => ({
        dependsOnServiceIds: [...service.dependsOnServiceIds],
        healthRecipeRef: "recipe-health", imageRef: service.imageRef,
        secretIds: ["database-password"], serviceId: service.serviceId,
      })),
    },
    familyDefinitionDigest: NEXT.definitionDigest,
    imageRefs: NEXT.imageRefRoster.map((imageRef) => ({
      imageDigest: `sha256:${fixtureDigest(imageRef)}`, imageRef,
    })),
    policyRefs: {
      budget: { artifactDigest: fixtureDigest("policy-budget"),
        artifactRef: "policy-budget", policyKind: "BUDGET" },
      operations: { artifactDigest: fixtureDigest("policy-operations"),
        artifactRef: "policy-operations", policyKind: "OPERATIONS" },
      resource: { artifactDigest: fixtureDigest("policy-resource"),
        artifactRef: "policy-resource", policyKind: "RESOURCE" },
      security: { artifactDigest: fixtureDigest("policy-security"),
        artifactRef: "policy-security", policyKind: "SECURITY" },
    },
    profileFamilyId: "Next.js/TypeScript",
    profileId: "profile-next-typescript",
    qualificationBenchmarkCorpus: {
      artifactDigest: fixtureDigest("benchmark-corpus"),
      artifactRef: "benchmark-next-typescript-v1",
    },
    readScopes: ["project:source"],
    recipes: Object.fromEntries(DELIVERY_PROFILE_RECIPE_KINDS.map((kind) => {
      const argv = ["--profile", kind.toLowerCase()]; const toolRef = NEXT.toolRefRoster[0]!;
      return [kind.toLowerCase(), {
        argv, executionMode: "DIRECT_ARGV",
        recipeDigest: computeDeliveryProfileRecipeDigest(toolRef, argv),
        recipeRef: `recipe-${kind.toLowerCase()}`, toolRef,
      }];
    })),
    requiredModelProviderCapabilities: [
      "CODE_GENERATION", "STRUCTURED_OUTPUT", "TOOL_CALLING", "VISION",
    ],
    resourceClasses: ["BROWSER", "BUILD_CPU", "CONTAINER", "DATABASE", "PERSISTENT_STORAGE"],
    revisionId: "profile-next-typescript-r1",
    secretSchema: [{
      consumerServiceIds: ["web"], purpose: "Database credential for web only.",
      required: true, secretId: "database-password",
    }],
    stackGrammar: {
      components: NEXT.components.map((component, index) => ({
        ...component, artifactDigest: fixtureDigest(`component-${index}`), version: `${index + 1}.0.0`,
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
      artifactDigest: fixtureDigest(`template:${artifactRef}`), artifactRef,
    })),
    toolRefs: NEXT.toolRefRoster.map((artifactRef) => ({
      artifactDigest: fixtureDigest(`tool:${artifactRef}`), artifactRef,
    })),
    writeScopes: ["project:generated", "project:migrations"],
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

export function compilerQualification(profile: ReturnType<typeof compilerDeliveryProfile>) {
  const result = createDeliveryProfileQualification({
    benchmarkManifest: {
      benchmarkCorpusDigest: profile.qualificationBenchmarkCorpus.artifactDigest,
      benchmarkCorpusRef: profile.qualificationBenchmarkCorpus.artifactRef,
      manifestDigest: fixtureDigest("benchmark-manifest"),
      manifestRef: "benchmark-manifest:next-typescript-v1",
    },
    benchmarkVerdict: "PASSED",
    builderIdentity: {
      authorityRef: "authority-builder", capabilityId: "capability-web-build",
      principalRef: "principal-builder",
    },
    expiresAtEpochMs: 2_000,
    independentVerifierReceipts: DELIVERY_PROFILE_RECIPE_KINDS.map((kind, index) => ({
      observedAtEpochMs: 900 + index, outcome: "PASS",
      profileRevisionDigest: profile.revisionDigest,
      receiptDigest: fixtureDigest(`receipt-${kind}`), receiptRef: `receipt-${kind.toLowerCase()}`,
      recipeDigest: profile.recipes[kind.toLowerCase() as keyof typeof profile.recipes].recipeDigest,
      recipeRef: `recipe-${kind.toLowerCase()}`,
      verifierAuthorityRef: "authority:capability-web-verify",
      verifierCapabilityId: "capability-web-verify",
      verifierRef: "principal:capability-web-verify",
    })).sort((left, right) => left.receiptRef < right.receiptRef ? -1 : 1),
    invalidation: null,
    moeSourceCommit: "1234567890abcdef1234567890abcdef12345678",
    observedDigests: {
      browserDigest: fixtureDigest("browser"), composeDigest: fixtureDigest("compose"),
      dockerDigest: fixtureDigest("docker"), gitDigest: fixtureDigest("git"),
      imageDigests: profile.imageRefs.map((image) => image.imageDigest).sort(),
      nodeDigest: fixtureDigest("node"), pnpmDigest: fixtureDigest("pnpm"),
    },
    operatorApprovalRef: "approval-profile-r1", operatorDecision: "APPROVED",
    profileFamilyId: profile.profileFamilyId, profileId: profile.profileId,
    profileRevisionDigest: profile.revisionDigest, profileRevisionId: profile.revisionId,
    providerProfileRefs: [{
      profileDigest: fixtureDigest("provider-profile"), profileRef: "provider-profile:codex",
      profileRevisionId: "provider-profile-codex-r1",
    }],
    qualificationId: "qualification-profile-next-r1", qualifiedAtEpochMs: 1_000,
    validity: "CURRENT",
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.qualification;
}

export function compilerQualificationStatus(qualification: DeliveryProfileQualificationStatusBinding) {
  return Object.freeze({
    qualificationDigest: qualification.qualificationDigest,
    qualificationId: qualification.qualificationId,
    status: "CURRENT" as const,
    statusDigest: fixtureDigest("qualification-status"),
    statusRef: `qualification-status:${qualification.qualificationId}`,
  });
}

export function compilerQualificationAuthority(): DeliveryProfileQualificationAuthorityPort {
  return Object.freeze({
    readDurableQualificationStatus: (binding: DeliveryProfileQualificationStatusBinding) =>
      compilerQualificationStatus(binding),
    verifyDurableBuilderIdentity: () => true,
    verifyDurableOperatorApproval: () => true,
    verifyDurableProviderProfile: () => true,
    verifyDurableVerifierReceipt: () => true,
  });
}
