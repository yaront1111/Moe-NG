import { describe, expect, it } from "vitest";

import {
  DELIVERY_PROFILE_FAMILY_DEFINITIONS,
  DELIVERY_PROFILE_FAMILY_IDS,
  DELIVERY_PROFILE_RECIPE_KINDS,
  computeDeliveryProfileRecipeDigest,
  createDeliveryProfileQualification,
  createDeliveryProfileRevision,
  decodeDeliveryProfileQualificationBytes,
  decodeDeliveryProfileRevisionBytes,
  type DeliveryProfileFamilyId,
  type DeliveryProfileBuilderIdentity,
  type DeliveryProfileIndependentVerifierReceipt,
  type DeliveryProfileQualification,
  type DeliveryProfileQualificationAuthorityPort,
  type DeliveryProfileQualificationEvidenceBinding,
  type DeliveryProfileOperatorApprovalBinding,
  type DeliveryProfileProviderProfileRef,
  type DeliveryProfileRevision,
} from "./delivery-profile-codec.js";
import { resolveQualifiedDeliveryProfile } from "./delivery-profile-qualification.js";

const hex = (digit: string): string => digit.repeat(64);
const notQualified = {
  code: "DELIVERY_PROFILE_NOT_QUALIFIED",
  layer: "DELIVERY_PROFILE_QUALIFICATION",
  ok: false,
};

function recipeFor(toolRef: string, kind: (typeof DELIVERY_PROFILE_RECIPE_KINDS)[number]) {
  const argv = ["verify", kind.toLowerCase()];
  return {
    argv, executionMode: "DIRECT_ARGV" as const,
    recipeDigest: computeDeliveryProfileRecipeDigest(toolRef, argv),
    recipeRef: `recipe-${kind.toLowerCase()}`, toolRef,
  };
}

function definitionFor(familyId: DeliveryProfileFamilyId) {
  const definition = DELIVERY_PROFILE_FAMILY_DEFINITIONS.find(
    (candidate) => candidate.profileFamilyId === familyId,
  );
  if (definition === undefined) throw new Error(`missing family definition ${familyId}`);
  return definition;
}

function profileDraft(
  familyId: DeliveryProfileFamilyId = "Next.js/TypeScript",
): Record<string, unknown> {
  const definition = definitionFor(familyId);
  const secretConsumer = definition.services[0]!.serviceId;
  return {
    allowedCapabilityIds: [
      "delivery.activate", "delivery.backup", "delivery.browser", "delivery.build",
      "delivery.health", "delivery.migrate", "delivery.restore", "delivery.rollback",
      "delivery.test",
    ],
    composeTopology: {
      networkMode: "MANAGED_INTERNAL",
      services: definition.services.map((service, index) => ({
        dependsOnServiceIds: [...service.dependsOnServiceIds],
        healthRecipeRef: "recipe-health",
        imageRef: service.imageRef,
        secretIds: index === 0 ? ["database-password"] : [],
        serviceId: service.serviceId,
      })),
    },
    familyDefinitionDigest: definition.definitionDigest,
    imageRefs: definition.imageRefRoster.map((imageRef) => ({
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
    profileFamilyId: familyId,
    profileId: `profile-${DELIVERY_PROFILE_FAMILY_IDS.indexOf(familyId) + 1}`,
    qualificationBenchmarkCorpus: {
      artifactDigest: hex("5"),
      artifactRef: `benchmark-${familyId.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}`,
    },
    readScopes: ["project:source"],
    recipes: Object.fromEntries(DELIVERY_PROFILE_RECIPE_KINDS.map((kind) => [
      kind.toLowerCase(), recipeFor(definition.toolRefRoster[0]!, kind),
    ])),
    requiredModelProviderCapabilities: [
      "CODE_GENERATION", "STRUCTURED_OUTPUT", "TOOL_CALLING", "VISION",
    ],
    resourceClasses: ["BROWSER", "BUILD_CPU", "CONTAINER", "DATABASE", "PERSISTENT_STORAGE"],
    revisionId: `profile-${DELIVERY_PROFILE_FAMILY_IDS.indexOf(familyId) + 1}-r1`,
    secretSchema: [{
      consumerServiceIds: [secretConsumer],
      purpose: "Database credential injected into its exact authorized service.",
      required: true,
      secretId: "database-password",
    }],
    stackGrammar: {
      components: definition.components.map((component, index) => ({
        ...component,
        artifactDigest: hex(String((index % 9) + 1)),
        version: `${index + 1}.2.3`,
      })),
      dependencyEdges: definition.dependencyEdges.map((edge) => ({ ...edge })),
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
    templateRefs: definition.templateRefRoster.map((artifactRef) => ({
      artifactDigest: hex("e"), artifactRef,
    })),
    toolRefs: definition.toolRefRoster.map((artifactRef) => ({
      artifactDigest: hex("f"), artifactRef,
    })),
    writeScopes: ["project:generated", "project:migrations"],
  };
}

function reviewedProfileDraft(): Record<string, unknown> {
  return profileDraft();
}

function createdProfile(value: unknown = profileDraft()): DeliveryProfileRevision {
  const result = createDeliveryProfileRevision(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function qualificationDraft(
  profile: DeliveryProfileRevision,
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
    expiresAtEpochMs: 2_000,
    independentVerifierReceipts: Object.values(profile.recipes).map((recipe, index) => ({
      observedAtEpochMs: 900 + index,
      outcome: "PASS",
      profileRevisionDigest: profile.revisionDigest,
      receiptDigest: hex(String((index % 9) + 1)),
      receiptRef: `receipt-${recipe.recipeRef}`,
      recipeDigest: recipe.recipeDigest,
      recipeRef: recipe.recipeRef,
      verifierAuthorityRef: "authority-verifier-1",
      verifierCapabilityId: "capability-web-verify",
      verifierRef: "verifier-independent",
    })).sort((left, right) => left.receiptRef.localeCompare(right.receiptRef)),
    invalidation: null,
    moeSourceCommit: "0123456789abcdef0123456789abcdef01234567",
    observedDigests: {
      browserDigest: hex("7"), composeDigest: hex("8"), dockerDigest: hex("9"),
      gitDigest: hex("a"), imageDigests: profile.imageRefs.map((item) => item.imageDigest),
      nodeDigest: hex("b"), pnpmDigest: hex("c"),
    },
    operatorApprovalRef: decision === "APPROVED" ? "approval-profile-r1" : null,
    operatorDecision: decision,
    profileFamilyId: profile.profileFamilyId,
    profileId: profile.profileId,
    profileRevisionDigest: profile.revisionDigest,
    profileRevisionId: profile.revisionId,
    providerProfileRefs: [{
      profileDigest: hex("d"), profileRef: "provider-profile-1",
      profileRevisionId: "provider-profile-revision-1",
    }],
    qualificationId: "qualification-profile-r1",
    qualifiedAtEpochMs: 1_000,
    validity: "CURRENT",
  };
}

function reviewedQualificationDraft(profile: DeliveryProfileRevision): Record<string, unknown> {
  return qualificationDraft(profile);
}

function createdQualification(value: unknown): DeliveryProfileQualification {
  const result = createDeliveryProfileQualification(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.qualification;
}

function durableAuthorityFor(
  trusted: DeliveryProfileQualification,
): DeliveryProfileQualificationAuthorityPort {
  const approvalIdentity = [
    trusted.operatorApprovalRef,
    trusted.profileFamilyId,
    trusted.profileId,
    trusted.profileRevisionId,
    trusted.profileRevisionDigest,
    trusted.qualificationDigest,
    trusted.qualificationId,
  ].join("\0");
  const receipts = new Set(trusted.independentVerifierReceipts.map((receipt) => [
    receipt.receiptRef, receipt.receiptDigest, receipt.verifierRef,
    receipt.verifierAuthorityRef, receipt.verifierCapabilityId,
    receipt.profileRevisionDigest, receipt.recipeRef, receipt.recipeDigest,
    receipt.observedAtEpochMs, receipt.outcome,
  ].join("\0")));
  const providers = new Set(trusted.providerProfileRefs.map((profile) => [
    profile.profileRef, profile.profileRevisionId, profile.profileDigest,
  ].join("\0")));
  const bindingMatches = (binding: DeliveryProfileQualificationEvidenceBinding) =>
    binding.qualificationDigest === trusted.qualificationDigest
    && binding.qualificationId === trusted.qualificationId
    && binding.profileRevisionDigest === trusted.profileRevisionDigest
    && binding.moeSourceCommit === trusted.moeSourceCommit;
  return Object.freeze({
    readDurableQualificationStatus: () => Object.freeze({
      qualificationDigest: trusted.qualificationDigest,
      qualificationId: trusted.qualificationId,
      status: "CURRENT" as const,
      statusDigest: hex("e"),
      statusRef: "qualification-status-current",
    }),
    verifyDurableOperatorApproval: (binding: DeliveryProfileOperatorApprovalBinding) => [
      binding.operatorApprovalRef,
      binding.profileFamilyId,
      binding.profileId,
      binding.profileRevisionId,
      binding.profileRevisionDigest,
      binding.qualificationDigest,
      binding.qualificationId,
    ].join("\0") === approvalIdentity,
    verifyDurableBuilderIdentity: (
      builder: DeliveryProfileBuilderIdentity,
      binding: DeliveryProfileQualificationEvidenceBinding,
    ) => bindingMatches(binding)
      && builder.authorityRef === trusted.builderIdentity.authorityRef
      && builder.capabilityId === trusted.builderIdentity.capabilityId
      && builder.principalRef === trusted.builderIdentity.principalRef,
    verifyDurableProviderProfile: (
      profile: DeliveryProfileProviderProfileRef,
      binding: DeliveryProfileQualificationEvidenceBinding,
    ) => bindingMatches(binding) && providers.has([
      profile.profileRef, profile.profileRevisionId, profile.profileDigest,
    ].join("\0")),
    verifyDurableVerifierReceipt: (
      receipt: DeliveryProfileIndependentVerifierReceipt,
      binding: DeliveryProfileQualificationEvidenceBinding,
    ) => bindingMatches(binding) && receipts.has([
      receipt.receiptRef, receipt.receiptDigest, receipt.verifierRef,
      receipt.verifierAuthorityRef, receipt.verifierCapabilityId,
      receipt.profileRevisionDigest, receipt.recipeRef, receipt.recipeDigest,
      receipt.observedAtEpochMs, receipt.outcome,
    ].join("\0")),
  });
}

describe("delivery profile review hardening", () => {
  it("admits the exact supported facts, scopes, resources, corpus, provider, and typed policies", () => {
    expect(createDeliveryProfileRevision(reviewedProfileDraft()).ok).toBe(true);
  });

  it.each([
    "allowedCapabilityIds", "qualificationBenchmarkCorpus", "readScopes",
    "requiredModelProviderCapabilities", "resourceClasses", "supportedBackendFacts",
    "supportedHostFacts", "writeScopes",
  ])("requires the reviewed revision field %s", (field) => {
    const draft = reviewedProfileDraft(); delete draft[field];
    expect(createDeliveryProfileRevision(draft)).toEqual({
      code: "DELIVERY_PROFILE_MALFORMED", layer: "DELIVERY_PROFILE_ADMISSION", ok: false,
    });
  });

  it("refuses a policy ref whose kind tag does not match its typed slot", () => {
    const draft = reviewedProfileDraft();
    const policies = draft["policyRefs"] as Record<string, Record<string, unknown>>;
    policies["security"]!["policyKind"] = "BUDGET";
    expect(createDeliveryProfileRevision(draft)).toEqual({
      code: "DELIVERY_PROFILE_MALFORMED", layer: "DELIVERY_PROFILE_ADMISSION", ok: false,
    });
  });

  it("recomputes recipe identity instead of trusting a caller-minted digest", () => {
    const draft = profileDraft();
    const build = (draft["recipes"] as Record<string, Record<string, unknown>>)["build"]!;
    build["recipeDigest"] = hex("9");
    expect(createDeliveryProfileRevision(draft)).toEqual({
      code: "DELIVERY_PROFILE_RECIPE_DIGEST_MISMATCH",
      layer: "DELIVERY_PROFILE_DIGEST",
      ok: false,
    });
  });

  it.each(["dash", "ash", "fish"])("refuses the %s shell interpreter", (shell) => {
    const draft = profileDraft();
    const build = (draft["recipes"] as Record<string, Record<string, unknown>>)["build"]!;
    build["argv"] = [shell, "script-file"];
    expect(createDeliveryProfileRevision(draft)).toEqual({
      code: "DELIVERY_PROFILE_SHELL_EXECUTION_FORBIDDEN",
      layer: "DELIVERY_PROFILE_ADMISSION",
      ok: false,
    });
  });

  it("bounds hostile object snapshots before traversing unknown nested data", () => {
    const hostile = profileDraft();
    let nested: Record<string, unknown> = {};
    hostile["unknown"] = nested;
    for (let index = 0; index < 20; index += 1) {
      const child: Record<string, unknown> = {};
      nested["child"] = child;
      nested = child;
    }
    expect(createDeliveryProfileRevision(hostile)).toEqual({
      code: "DELIVERY_PROFILE_LIMIT_EXCEEDED",
      layer: "DELIVERY_PROFILE_LIMITS",
      ok: false,
    });
  });

  it("ships no fabricated built-in material or qualification claims", async () => {
    const modulePath = "./delivery-profile-builtins.js";
    const builtins: typeof import("./delivery-profile-builtins.js") | null =
      await import(modulePath).catch(() => null);
    expect(builtins?.BUILT_IN_DELIVERY_PROFILE_REVISIONS).toEqual([]);
    expect(builtins?.BUILT_IN_DELIVERY_PROFILE_QUALIFICATIONS).toEqual([]);
    expect(DELIVERY_PROFILE_FAMILY_DEFINITIONS.map((item) => item.profileFamilyId))
      .toEqual(DELIVERY_PROFILE_FAMILY_IDS);
  });

  it("admits all and only the five profiles that match their closed family definitions", () => {
    expect(DELIVERY_PROFILE_FAMILY_DEFINITIONS.map((item) => item.profileFamilyId))
      .toEqual(DELIVERY_PROFILE_FAMILY_IDS);
    expect(new Set(DELIVERY_PROFILE_FAMILY_DEFINITIONS.map(
      (item) => item.definitionDigest,
    )).size).toBe(5);
    for (const familyId of DELIVERY_PROFILE_FAMILY_IDS) {
      const result = createDeliveryProfileRevision(profileDraft(familyId));
      expect(result.ok, familyId).toBe(true);
    }

    const crossFamily = profileDraft("Next.js/TypeScript");
    crossFamily["profileFamilyId"] = "React/FastAPI";
    crossFamily["familyDefinitionDigest"] = definitionFor("React/FastAPI").definitionDigest;
    expect(createDeliveryProfileRevision(crossFamily)).toEqual({
      code: "DELIVERY_PROFILE_FAMILY_GRAMMAR_MISMATCH",
      layer: "DELIVERY_PROFILE_FAMILY",
      ok: false,
    });
  });

  it.each(["latest", "1.x", "*", "^1.2.3", "1.2.3 - 2.0.0", "symbolic", "01.2.3"])(
    "rejects the unpinned component version %s",
    (version) => {
      const draft = profileDraft();
      const components = (draft["stackGrammar"] as Record<string, unknown>)["components"] as
        Record<string, unknown>[];
      components[0]!["version"] = version;
      expect(createDeliveryProfileRevision(draft).ok).toBe(false);
    },
  );

  it("requires exact bidirectional secret authorization", () => {
    const draft = profileDraft("React/FastAPI");
    const services = (draft["composeTopology"] as Record<string, unknown>)["services"] as
      Record<string, unknown>[];
    services[1]!["secretIds"] = ["database-password"];
    expect(createDeliveryProfileRevision(draft)).toEqual({
      code: "DELIVERY_PROFILE_REFERENCE_INVALID",
      layer: "DELIVERY_PROFILE_REFERENCES",
      ok: false,
    });
  });

  it("rejects cyclic Compose service dependencies", () => {
    const draft = profileDraft("React/FastAPI");
    const services = (draft["composeTopology"] as Record<string, unknown>)["services"] as
      Record<string, unknown>[];
    services[0]!["dependsOnServiceIds"] = [services[1]!["serviceId"]];
    expect(createDeliveryProfileRevision(draft)).toEqual({
      code: "DELIVERY_PROFILE_REFERENCE_INVALID",
      layer: "DELIVERY_PROFILE_REFERENCES",
      ok: false,
    });
  });

  it("admits only direct argv recipes and forbids shell tools, interpreters, and escapes", () => {
    const cases = [
      (draft: Record<string, unknown>) => {
        const build = (draft["recipes"] as Record<string, Record<string, unknown>>)["build"]!;
        build["executionMode"] = "SHELL";
      },
      (draft: Record<string, unknown>) => {
        const build = (draft["recipes"] as Record<string, Record<string, unknown>>)["build"]!;
        build["toolRef"] = "tool-pwsh";
      },
      (draft: Record<string, unknown>) => {
        const build = (draft["recipes"] as Record<string, Record<string, unknown>>)["build"]!;
        build["argv"] = ["sh", "-c", "echo escaped"];
      },
      (draft: Record<string, unknown>) => {
        const build = (draft["recipes"] as Record<string, Record<string, unknown>>)["build"]!;
        build["argv"] = ["verify", "ok && whoami"];
      },
    ];
    for (const mutate of cases) {
      const draft = profileDraft(); mutate(draft);
      expect(createDeliveryProfileRevision(draft)).toEqual({
        code: "DELIVERY_PROFILE_SHELL_EXECUTION_FORBIDDEN",
        layer: "DELIVERY_PROFILE_ADMISSION",
        ok: false,
      });
    }
  });

  it("rejects negative-zero qualification and receipt timestamps", () => {
    const profile = createdProfile();
    for (const mutate of [
      (draft: Record<string, unknown>) => { draft["qualifiedAtEpochMs"] = -0; },
      (draft: Record<string, unknown>) => { draft["expiresAtEpochMs"] = -0; },
      (draft: Record<string, unknown>) => {
        (draft["independentVerifierReceipts"] as Record<string, unknown>[])[0]!["observedAtEpochMs"] = -0;
      },
    ]) {
      const draft = qualificationDraft(profile); mutate(draft);
      expect(createDeliveryProfileQualification(draft)).toEqual({
        code: "DELIVERY_PROFILE_MALFORMED",
        layer: "DELIVERY_PROFILE_ADMISSION",
        ok: false,
      });
    }
  });

  it("admits separate benchmark, validity, operator, provider, environment, and provenance facts", () => {
    const profile = createdProfile();
    expect(createDeliveryProfileQualification(reviewedQualificationDraft(profile)).ok).toBe(true);
  });

  it("admits exact builder identity and verifier authority-capability bindings", () => {
    const profile = createdProfile();
    const draft = qualificationDraft(profile);
    draft["builderIdentity"] = {
      authorityRef: "authority-builder-1",
      capabilityId: "capability-web-build",
      principalRef: "builder-1",
    };
    for (const receipt of draft["independentVerifierReceipts"] as Record<string, unknown>[]) {
      receipt["verifierAuthorityRef"] = "authority-verifier-1";
      receipt["verifierCapabilityId"] = "capability-web-verify";
    }
    expect(createDeliveryProfileQualification(draft)).toEqual(expect.objectContaining({ ok: true }));
  });

  it("rejects malformed source, observation, provider, and benchmark evidence", () => {
    const profile = createdProfile();
    const missingBuilder = qualificationDraft(profile); delete missingBuilder["builderIdentity"];
    const missingVerifierAuthority = qualificationDraft(profile);
    delete (missingVerifierAuthority["independentVerifierReceipts"] as
      Record<string, unknown>[])[0]!["verifierAuthorityRef"];
    const missingVerifierCapability = qualificationDraft(profile);
    delete (missingVerifierCapability["independentVerifierReceipts"] as
      Record<string, unknown>[])[0]!["verifierCapabilityId"];
    const cases = [
      missingBuilder, missingVerifierAuthority, missingVerifierCapability,
      { ...qualificationDraft(profile), moeSourceCommit: "HEAD" },
      {
        ...qualificationDraft(profile),
        observedDigests: {
          ...(qualificationDraft(profile)["observedDigests"] as Record<string, unknown>),
          gitDigest: "not-a-digest",
        },
      },
      {
        ...qualificationDraft(profile),
        providerProfileRefs: [{
          profileDigest: "not-a-digest", profileRef: "provider-profile-1",
          profileRevisionId: "provider-profile-revision-1",
        }],
      },
      {
        ...qualificationDraft(profile),
        benchmarkManifest: {
          ...(qualificationDraft(profile)["benchmarkManifest"] as Record<string, unknown>),
          unknown: true,
        },
      },
    ];
    for (const candidate of cases) {
      expect(createDeliveryProfileQualification(candidate)).toEqual({
        code: "DELIVERY_PROFILE_MALFORMED", layer: "DELIVERY_PROFILE_ADMISSION", ok: false,
      });
    }
  });

  it("bounds hostile qualification snapshots before unknown nested traversal", () => {
    const draft = qualificationDraft(createdProfile()); let nested: Record<string, unknown> = {};
    draft["unknown"] = nested;
    for (let index = 0; index < 20; index += 1) {
      const child: Record<string, unknown> = {}; nested["child"] = child; nested = child;
    }
    expect(createDeliveryProfileQualification(draft)).toEqual({
      code: "DELIVERY_PROFILE_LIMIT_EXCEEDED", layer: "DELIVERY_PROFILE_LIMITS", ok: false,
    });
  });

  it("requires durable approval and verifier authority instead of trusting minted strings", () => {
    const profile = createdProfile();
    const trusted = createdQualification(qualificationDraft(profile));
    const authority = durableAuthorityFor(trusted);
    expect(resolveQualifiedDeliveryProfile(profile, trusted, 1_500, undefined)).toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, trusted, 1_500, Object.freeze({
      ...authority, verifyDurableOperatorApproval: () => false,
    }))).toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, trusted, 1_500, Object.freeze({
      ...authority, verifyDurableBuilderIdentity: () => false,
    }))).toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, trusted, 1_500, Object.freeze({
      ...authority, verifyDurableProviderProfile: () => false,
    }))).toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, trusted, 1_500, Object.freeze({
      ...authority, verifyDurableVerifierReceipt: () => false,
    }))).toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, trusted, 1_500, Object.freeze({
      ...authority,
      verifyDurableOperatorApproval: () => { throw new Error("authority unavailable"); },
    }))).toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, trusted, 1_500, authority)).toEqual({
      ok: true, profile, qualification: trusted,
      qualificationStatus: {
        qualificationDigest: trusted.qualificationDigest,
        qualificationId: trusted.qualificationId,
        status: "CURRENT",
        statusDigest: hex("e"),
        statusRef: "qualification-status-current",
      },
    });

    const fabricatedApproval = createdQualification({
      ...qualificationDraft(profile), operatorApprovalRef: "approval-fabricated",
    });
    expect(resolveQualifiedDeliveryProfile(profile, fabricatedApproval, 1_500, authority))
      .toEqual(notQualified);
    const fabricatedReceiptDraft = qualificationDraft(profile);
    (fabricatedReceiptDraft["independentVerifierReceipts"] as Record<string, unknown>[])[0]!["receiptDigest"] =
      hex("9");
    const fabricatedReceipt = createdQualification(fabricatedReceiptDraft);
    expect(resolveQualifiedDeliveryProfile(profile, fabricatedReceipt, 1_500, authority))
      .toEqual(notQualified);
  });

  it("requires the durable current status head and rejects a replay after revocation", () => {
    const profile = createdProfile();
    const qualification = createdQualification(qualificationDraft(profile));
    const evidenceAuthority = durableAuthorityFor(qualification);
    const currentAuthority = Object.freeze({
      ...evidenceAuthority,
      readDurableQualificationStatus: () => Object.freeze({
        qualificationDigest: qualification.qualificationDigest,
        qualificationId: qualification.qualificationId,
        status: "CURRENT" as const,
        statusDigest: hex("e"),
        statusRef: "qualification-status-current",
      }),
    });
    expect(resolveQualifiedDeliveryProfile(
      profile, qualification, 1_500, currentAuthority,
    )).toEqual({ ok: true, profile, qualification, qualificationStatus: {
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
      status: "CURRENT", statusDigest: hex("e"), statusRef: "qualification-status-current",
    } });

    const revokedAuthority = Object.freeze({
      ...evidenceAuthority,
      readDurableQualificationStatus: () => Object.freeze({
        qualificationDigest: qualification.qualificationDigest,
        qualificationId: qualification.qualificationId,
        status: "REVOKED" as const,
        statusDigest: hex("f"),
        statusRef: "qualification-revocation-1",
      }),
    });
    expect(resolveQualifiedDeliveryProfile(
      profile, qualification, 1_500, revokedAuthority,
    )).toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, qualification, 1_500, Object.freeze({
      ...currentAuthority,
      readDurableQualificationStatus: () => Object.freeze({
        qualificationDigest: hex("f"),
        qualificationId: qualification.qualificationId,
        status: "CURRENT" as const,
        statusDigest: hex("e"),
        statusRef: "qualification-status-current",
      }),
    }))).toEqual(notQualified);
    expect(resolveQualifiedDeliveryProfile(profile, qualification, 1_500, Object.freeze({
      ...currentAuthority, readDurableQualificationStatus: () => undefined,
    }))).toEqual(notQualified);
  });

  it("rejects a verifier that is the builder under another receipt label", () => {
    const profile = createdProfile();
    const draft = qualificationDraft(profile);
    const receipt = (draft["independentVerifierReceipts"] as Record<string, unknown>[])[0]!;
    const builder = draft["builderIdentity"] as Record<string, unknown>;
    receipt["verifierRef"] = builder["principalRef"];
    receipt["verifierAuthorityRef"] = builder["authorityRef"];
    receipt["verifierCapabilityId"] = builder["capabilityId"];
    const qualification = createdQualification(draft);
    expect(resolveQualifiedDeliveryProfile(
      profile, qualification, 1_500, durableAuthorityFor(qualification),
    )).toEqual(notQualified);
  });

  it("collapses rejected, expired, stale, recipe-mismatched, and identity-mismatched records", () => {
    const profile = createdProfile();
    const cases: DeliveryProfileQualification[] = [];
    cases.push(createdQualification(qualificationDraft(profile, "REJECTED")));
    const staleDigest = qualificationDraft(profile);
    staleDigest["profileRevisionDigest"] = hex("8");
    for (const receipt of staleDigest["independentVerifierReceipts"] as Record<string, unknown>[]) {
      receipt["profileRevisionDigest"] = hex("8");
    }
    cases.push(createdQualification(staleDigest));
    for (const [field, value] of [
      ["profileFamilyId", "React/FastAPI"],
      ["profileId", "profile-other"],
      ["profileRevisionId", "profile-other-r1"],
    ] as const) cases.push(createdQualification({ ...qualificationDraft(profile), [field]: value }));
    const recipeMismatch = qualificationDraft(profile);
    (recipeMismatch["independentVerifierReceipts"] as Record<string, unknown>[])[0]!["recipeDigest"] = hex("7");
    cases.push(createdQualification(recipeMismatch));

    for (const candidate of cases) {
      expect(resolveQualifiedDeliveryProfile(
        profile, candidate, 1_500, durableAuthorityFor(candidate),
      )).toEqual(notQualified);
    }
    const approved = createdQualification(qualificationDraft(profile));
    expect(resolveQualifiedDeliveryProfile(
      profile, approved, 2_000, durableAuthorityFor(approved),
    )).toEqual(notQualified);
  });

  it("requires PASSED and CURRENT independently from operator approval", () => {
    const profile = createdProfile();
    const failed = createdQualification({
      ...qualificationDraft(profile), benchmarkVerdict: "FAILED",
    });
    const unknown = createdQualification({
      ...qualificationDraft(profile), benchmarkVerdict: "UNKNOWN",
    });
    const invalidated = createdQualification({
      ...qualificationDraft(profile),
      invalidation: {
        invalidatedAtEpochMs: 1_200, invalidatedByAuthorityRef: "authority-security",
        invalidationDigest: hex("e"), invalidationReason: "provider profile was revoked",
        invalidationRef: "invalidation-1", supersedingQualificationId: null,
      },
      validity: "INVALIDATED",
    });
    for (const candidate of [failed, unknown, invalidated]) {
      expect(resolveQualifiedDeliveryProfile(
        profile, candidate, 1_500, durableAuthorityFor(candidate),
      )).toEqual(notQualified);
    }
  });

  it("requires exact corpus, observed images, and durable provider profile bindings", () => {
    const profile = createdProfile();
    const trusted = createdQualification(qualificationDraft(profile));
    const authority = durableAuthorityFor(trusted);
    const wrongCorpus = createdQualification({
      ...qualificationDraft(profile),
      benchmarkManifest: {
        ...(qualificationDraft(profile)["benchmarkManifest"] as Record<string, unknown>),
        benchmarkCorpusDigest: hex("f"),
      },
    });
    const wrongImages = createdQualification({
      ...qualificationDraft(profile),
      observedDigests: {
        ...(qualificationDraft(profile)["observedDigests"] as Record<string, unknown>),
        imageDigests: [`sha256:${hex("f")}`],
      },
    });
    const fabricatedProvider = createdQualification({
      ...qualificationDraft(profile), providerProfileRefs: [{
        profileDigest: hex("f"), profileRef: "provider-fabricated",
        profileRevisionId: "provider-fabricated-r1",
      }],
    });
    for (const candidate of [wrongCorpus, wrongImages, fabricatedProvider]) {
      expect(resolveQualifiedDeliveryProfile(profile, candidate, 1_500, authority))
        .toEqual(notQualified);
    }
  });

  it("treats observed image digests as a unique set when image refs alias one image", () => {
    const profile = createdProfile(profileDraft("React/FastAPI"));
    expect(profile.imageRefs.length).toBeGreaterThan(1);
    expect(new Set(profile.imageRefs.map((item) => item.imageDigest)).size).toBe(1);
    const draft = qualificationDraft(profile);
    (draft["observedDigests"] as Record<string, unknown>)["imageDigests"] = [
      profile.imageRefs[0]!.imageDigest,
    ];
    const qualification = createdQualification(draft);
    expect(resolveQualifiedDeliveryProfile(
      profile, qualification, 1_500, durableAuthorityFor(qualification),
    )).toEqual({ ok: true, profile, qualification, qualificationStatus: {
      qualificationDigest: qualification.qualificationDigest,
      qualificationId: qualification.qualificationId,
      status: "CURRENT", statusDigest: hex("e"), statusRef: "qualification-status-current",
    } });
  });

  it("requires invalidation provenance exactly when validity is INVALIDATED", () => {
    const profile = createdProfile();
    expect(createDeliveryProfileQualification({
      ...qualificationDraft(profile), validity: "INVALIDATED",
    }).ok).toBe(false);
    expect(createDeliveryProfileQualification({
      ...qualificationDraft(profile),
      invalidation: {
        invalidatedAtEpochMs: 1_200, invalidatedByAuthorityRef: "authority-security",
        invalidationDigest: hex("e"), invalidationReason: "revoked",
        invalidationRef: "invalidation-1", supersedingQualificationId: null,
      },
    }).ok).toBe(false);
  });

  it("rejects duplicate-key and display-form bytes for both codecs", () => {
    expect(decodeDeliveryProfileRevisionBytes(new TextEncoder().encode(
      '{"profileId":"a","profileId":"b"}',
    ))).toEqual({ code: "DELIVERY_PROFILE_DUPLICATE_KEY", layer: "DELIVERY_PROFILE_CODEC", ok: false });
    expect(decodeDeliveryProfileQualificationBytes(new TextEncoder().encode(
      '{"qualificationId":"a","qualificationId":"b"}',
    ))).toEqual({ code: "DELIVERY_PROFILE_DUPLICATE_KEY", layer: "DELIVERY_PROFILE_CODEC", ok: false });

    const profile = createdProfile();
    expect(decodeDeliveryProfileRevisionBytes(
      new TextEncoder().encode(JSON.stringify(profile, null, 2)),
    )).toEqual({
      code: "DELIVERY_PROFILE_NONCANONICAL",
      layer: "DELIVERY_PROFILE_CANONICALIZATION",
      ok: false,
    });
    const qualification = createdQualification(qualificationDraft(profile));
    expect(decodeDeliveryProfileQualificationBytes(
      new TextEncoder().encode(JSON.stringify(qualification, null, 2)),
    )).toEqual({
      code: "DELIVERY_PROFILE_NONCANONICAL",
      layer: "DELIVERY_PROFILE_CANONICALIZATION",
      ok: false,
    });
  });
});
