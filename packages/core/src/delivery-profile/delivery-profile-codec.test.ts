import { describe, expect, it } from "vitest";

import {
  DELIVERY_PROFILE_FAMILY_DEFINITIONS,
  DELIVERY_PROFILE_FAMILY_IDS,
  DELIVERY_PROFILE_QUALIFICATION_VERSION,
  DELIVERY_PROFILE_RECIPE_KINDS,
  DELIVERY_PROFILE_VERSION,
  computeDeliveryProfileRecipeDigest,
  createDeliveryProfileQualification,
  createDeliveryProfileRevision,
  decodeDeliveryProfileQualificationBytes,
  decodeDeliveryProfileRevisionBytes,
  encodeDeliveryProfileQualification,
  encodeDeliveryProfileRevision,
  type DeliveryProfileQualification,
  type DeliveryProfileBuilderIdentity,
  type DeliveryProfileQualificationAuthorityPort,
  type DeliveryProfileQualificationEvidenceBinding,
  type DeliveryProfileIndependentVerifierReceipt,
  type DeliveryProfileOperatorApprovalBinding,
  type DeliveryProfileProviderProfileRef,
} from "./delivery-profile-codec.js";
import { resolveQualifiedDeliveryProfile } from "./delivery-profile-qualification.js";

const hex = (digit: string): string => digit.repeat(64);
const NEXT = DELIVERY_PROFILE_FAMILY_DEFINITIONS[0]!;

const recipe = (kind: (typeof DELIVERY_PROFILE_RECIPE_KINDS)[number]) => {
  const argv = ["--profile", kind.toLowerCase()];
  const toolRef = NEXT.toolRefRoster[0]!;
  return {
    argv, executionMode: "DIRECT_ARGV" as const,
    recipeDigest: computeDeliveryProfileRecipeDigest(toolRef, argv),
    recipeRef: `recipe-${kind.toLowerCase()}`, toolRef,
  };
};

function profileDraft(): Record<string, unknown> {
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
      imageRef, imageDigest: `sha256:${hex("c")}`,
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
      kind.toLowerCase(), recipe(kind),
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
      artifactDigest: hex("1"), artifactRef,
    })),
    toolRefs: NEXT.toolRefRoster.map((artifactRef) => ({
      artifactDigest: hex("2"), artifactRef,
    })),
    writeScopes: ["project:generated", "project:migrations"],
  };
}

function createdProfile(value: unknown = profileDraft()) {
  const result = createDeliveryProfileRevision(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function qualificationDraft(
  profile = createdProfile(),
  decision: "APPROVED" | "REJECTED" = "APPROVED",
): Record<string, unknown> {
  return {
    benchmarkManifest: {
      benchmarkCorpusDigest: profile.qualificationBenchmarkCorpus.artifactDigest,
      benchmarkCorpusRef: profile.qualificationBenchmarkCorpus.artifactRef,
      manifestDigest: hex("6"), manifestRef: "benchmark-manifest-next-r1",
    },
    benchmarkVerdict: "PASSED",
    builderIdentity: {
      authorityRef: "authority-builder-1",
      capabilityId: "capability-web-build",
      principalRef: "builder-1",
    },
    independentVerifierReceipts: DELIVERY_PROFILE_RECIPE_KINDS.map((kind, index) => ({
      observedAtEpochMs: 900 + index,
      outcome: "PASS",
      profileRevisionDigest: profile.revisionDigest,
      receiptDigest: hex(String((index % 9) + 1)),
      receiptRef: `receipt-${kind.toLowerCase()}`,
      recipeDigest: profile.recipes[kind.toLowerCase() as keyof typeof profile.recipes].recipeDigest,
      recipeRef: `recipe-${kind.toLowerCase()}`,
      verifierAuthorityRef: "authority-verifier-1",
      verifierCapabilityId: "capability-web-verify",
      verifierRef: "verifier-independent",
    })).sort((left, right) => left.receiptRef.localeCompare(right.receiptRef)),
    expiresAtEpochMs: 2_000,
    invalidation: null,
    moeSourceCommit: "0123456789abcdef0123456789abcdef01234567",
    observedDigests: {
      browserDigest: hex("7"), composeDigest: hex("8"), dockerDigest: hex("9"),
      gitDigest: hex("a"), imageDigests: profile.imageRefs.map((item) => item.imageDigest),
      nodeDigest: hex("b"), pnpmDigest: hex("c"),
    },
    operatorApprovalRef: decision === "APPROVED" ? "approval-profile-next-r1" : null,
    operatorDecision: decision,
    profileFamilyId: profile.profileFamilyId,
    profileId: profile.profileId,
    profileRevisionDigest: profile.revisionDigest,
    profileRevisionId: profile.revisionId,
    providerProfileRefs: [{
      profileDigest: hex("d"), profileRef: "provider-profile-1",
      profileRevisionId: "provider-profile-revision-1",
    }],
    qualificationId: "qualification-profile-next-r1",
    qualifiedAtEpochMs: 1_000,
    validity: "CURRENT",
  };
}

function createdQualification(value: unknown = qualificationDraft()) {
  const result = createDeliveryProfileQualification(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.qualification;
}

function authorityFor(
  qualification: DeliveryProfileQualification,
): DeliveryProfileQualificationAuthorityPort {
  const bindingMatches = (binding: DeliveryProfileQualificationEvidenceBinding) =>
    binding.qualificationDigest === qualification.qualificationDigest
    && binding.profileRevisionDigest === qualification.profileRevisionDigest;
  return Object.freeze({
    readDurableQualificationStatus: () => Object.freeze({
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
      status: "CURRENT" as const,
      statusDigest: hex("e"),
      statusRef: "qualification-status-current",
    }),
    verifyDurableOperatorApproval: (binding: DeliveryProfileOperatorApprovalBinding) =>
      binding.operatorApprovalRef === qualification.operatorApprovalRef
      && binding.profileRevisionDigest === qualification.profileRevisionDigest,
    verifyDurableBuilderIdentity: (
      builder: DeliveryProfileBuilderIdentity,
      binding: DeliveryProfileQualificationEvidenceBinding,
    ) => bindingMatches(binding)
      && builder.authorityRef === qualification.builderIdentity.authorityRef
      && builder.capabilityId === qualification.builderIdentity.capabilityId
      && builder.principalRef === qualification.builderIdentity.principalRef,
    verifyDurableProviderProfile: (
      profile: DeliveryProfileProviderProfileRef,
      binding: DeliveryProfileQualificationEvidenceBinding,
    ) => bindingMatches(binding) && qualification.providerProfileRefs.some(
      (candidate) => candidate.profileRef === profile.profileRef
        && candidate.profileDigest === profile.profileDigest,
    ),
    verifyDurableVerifierReceipt: (
      receipt: DeliveryProfileIndependentVerifierReceipt,
      binding: DeliveryProfileQualificationEvidenceBinding,
    ) => bindingMatches(binding) && qualification.independentVerifierReceipts.some(
      (candidate) => candidate.receiptRef === receipt.receiptRef
        && candidate.receiptDigest === receipt.receiptDigest,
    ),
  });
}

const notQualified = {
  code: "DELIVERY_PROFILE_NOT_QUALIFIED",
  layer: "DELIVERY_PROFILE_QUALIFICATION",
  ok: false,
};

describe("DeliveryProfileRevision", () => {
  it("publishes exactly the five shipped profile family identifiers", () => {
    expect(DELIVERY_PROFILE_FAMILY_IDS).toEqual([
      "Next.js/TypeScript",
      "React/FastAPI",
      "Go/HTMX",
      "Rust/Axum",
      "ASP.NET Core/Blazor",
    ]);
  });

  it("creates a deeply immutable digest-bound profile with every recipe kind", () => {
    const profile = createdProfile();
    expect(profile.version).toBe(DELIVERY_PROFILE_VERSION);
    expect(profile.revisionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.recipes.build.argv)).toBe(true);
    expect(Object.isFrozen(profile.composeTopology.services[0]?.secretIds)).toBe(true);
    expect(Object.keys(profile.recipes).sort()).toEqual(
      DELIVERY_PROFILE_RECIPE_KINDS.map((kind) => kind.toLowerCase()).sort(),
    );
  });

  it("canonically round-trips the profile bytes and detects digest mutation", () => {
    const profile = createdProfile();
    const encoded = encodeDeliveryProfileRevision(profile);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeDeliveryProfileRevisionBytes(encoded.bytes)).toEqual({ ok: true, revision: profile });

    const mutated = new TextEncoder().encode(
      new TextDecoder().decode(encoded.bytes).replace(profile.revisionDigest, hex("9")),
    );
    expect(decodeDeliveryProfileRevisionBytes(mutated)).toEqual({
      code: "DELIVERY_PROFILE_DIGEST_MISMATCH",
      layer: "DELIVERY_PROFILE_DIGEST",
      ok: false,
    });
  });

  it("rejects unshipped families rather than treating a descriptor as qualified", () => {
    expect(createDeliveryProfileRevision({
      ...profileDraft(), profileFamilyId: "Django/HTMX",
    })).toEqual({
      code: "DELIVERY_PROFILE_FAMILY_UNSUPPORTED",
      layer: "DELIVERY_PROFILE_FAMILY",
      ok: false,
    });
  });

  it("rejects ranges and cycles in the pinned stack grammar", () => {
    const ranged = structuredClone(profileDraft());
    ((ranged["stackGrammar"] as Record<string, unknown>)["components"] as Record<string, unknown>[])
      [0]!["version"] = "^24.0.0";
    expect(createDeliveryProfileRevision(ranged)).toEqual({
      code: "DELIVERY_PROFILE_MALFORMED",
      layer: "DELIVERY_PROFILE_ADMISSION",
      ok: false,
    });

    const cyclic = structuredClone(profileDraft());
    (cyclic["stackGrammar"] as Record<string, unknown>)["dependencyEdges"] = [{
      consumerComponentId: "node-runtime", providerComponentId: "web-framework",
    }, {
      consumerComponentId: "web-framework", providerComponentId: "node-runtime",
    }];
    expect(createDeliveryProfileRevision(cyclic)).toEqual({
      code: "DELIVERY_PROFILE_REFERENCE_INVALID",
      layer: "DELIVERY_PROFILE_REFERENCES",
      ok: false,
    });
  });

  it("requires argv recipes and rejects shell-command-shaped substitutions", () => {
    const command = structuredClone(profileDraft());
    const recipes = command["recipes"] as Record<string, Record<string, unknown>>;
    recipes["build"] = {
      command: "pnpm build && publish", recipeDigest: hex("a"),
      recipeRef: "recipe-build", toolRef: "tool-runner",
    };
    expect(createDeliveryProfileRevision(command)).toEqual({
      code: "DELIVERY_PROFILE_MALFORMED",
      layer: "DELIVERY_PROFILE_ADMISSION",
      ok: false,
    });
  });

  it("refuses dangling tool, image, health, service, and secret references", () => {
    const cases: Record<string, unknown>[] = [];
    const tool = structuredClone(profileDraft());
    const toolRecipe = (tool["recipes"] as Record<string, Record<string, unknown>>)["build"]!;
    toolRecipe["toolRef"] = "missing";
    toolRecipe["recipeDigest"] = computeDeliveryProfileRecipeDigest(
      "missing", toolRecipe["argv"] as string[],
    );
    cases.push(tool);
    const image = structuredClone(profileDraft());
    (((image["composeTopology"] as Record<string, unknown>)["services"] as Record<string, unknown>[])
      [0]!)["imageRef"] = "missing";
    cases.push(image);
    const health = structuredClone(profileDraft());
    (((health["composeTopology"] as Record<string, unknown>)["services"] as Record<string, unknown>[])
      [0]!)["healthRecipeRef"] = "missing";
    cases.push(health);
    const service = structuredClone(profileDraft());
    ((service["secretSchema"] as Record<string, unknown>[])[0]!)["consumerServiceIds"] = ["missing"];
    cases.push(service);
    const secret = structuredClone(profileDraft());
    ((((secret["composeTopology"] as Record<string, unknown>)["services"] as Record<string, unknown>[])
      [0]!)["secretIds"] as string[])[0] = "missing";
    cases.push(secret);

    for (const hostile of cases) {
      expect(createDeliveryProfileRevision(hostile)).toEqual({
        code: "DELIVERY_PROFILE_REFERENCE_INVALID",
        layer: "DELIVERY_PROFILE_REFERENCES",
        ok: false,
      });
    }
  });
});

describe("DeliveryProfileQualification", () => {
  it("canonically round-trips qualification evidence without synthesizing receipts", () => {
    const qualification = createdQualification();
    expect(qualification.version).toBe(DELIVERY_PROFILE_QUALIFICATION_VERSION);
    expect(qualification.qualificationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(qualification.independentVerifierReceipts)).toBe(true);
    const encoded = encodeDeliveryProfileQualification(qualification);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeDeliveryProfileQualificationBytes(encoded.bytes)).toEqual({
      ok: true, qualification,
    });
  });

  it("does not qualify a profile from its descriptor alone", () => {
    expect(resolveQualifiedDeliveryProfile(createdProfile(), null, 1_500, undefined))
      .toEqual(notQualified);
  });

  it("refuses absent, stale, incomplete, expired, and unapproved evidence at one exact fence", () => {
    const profile = createdProfile();
    const approved = createdQualification(qualificationDraft(profile));
    const stale = createdQualification({
      ...qualificationDraft(profile),
      profileRevisionDigest: hex("8"),
      independentVerifierReceipts: (qualificationDraft(profile)[
        "independentVerifierReceipts"
      ] as Record<string, unknown>[]).map(
        (item) => ({ ...item, profileRevisionDigest: hex("8") }),
      ),
    });
    const incompleteDraft = qualificationDraft(profile);
    incompleteDraft["independentVerifierReceipts"] =
      (incompleteDraft["independentVerifierReceipts"] as unknown[]).slice(1);
    const incomplete = createdQualification(incompleteDraft);
    const rejected = createdQualification(qualificationDraft(profile, "REJECTED"));

    expect(resolveQualifiedDeliveryProfile(profile, undefined, 1_500, authorityFor(approved)))
      .toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, stale, 1_500, authorityFor(stale)))
      .toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, incomplete, 1_500, authorityFor(incomplete)))
      .toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, approved, 2_000, authorityFor(approved)))
      .toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, rejected, 1_500, authorityFor(rejected)))
      .toEqual(notQualified);
  });

  it("resolves only exact, current, operator-approved, recipe-complete evidence", () => {
    const profile = createdProfile();
    const qualification = createdQualification(qualificationDraft(profile));
    expect(resolveQualifiedDeliveryProfile(
      profile, qualification, 1_500, authorityFor(qualification),
    )).toEqual({
      ok: true, profile, qualification, qualificationStatus: {
        qualificationDigest: qualification.qualificationDigest,
        qualificationId: qualification.qualificationId,
        status: "CURRENT", statusDigest: hex("e"), statusRef: "qualification-status-current",
      },
    });
  });

  it("rejects approved qualification bytes without an operator approval reference", () => {
    expect(createDeliveryProfileQualification({
      ...qualificationDraft(), operatorApprovalRef: null,
    })).toEqual({
      code: "DELIVERY_PROFILE_MALFORMED",
      layer: "DELIVERY_PROFILE_ADMISSION",
      ok: false,
    });
  });
});
