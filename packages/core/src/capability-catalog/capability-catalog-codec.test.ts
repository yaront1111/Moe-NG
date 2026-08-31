import { expect, it } from "vitest";

const hex = (digit: string): string => digit.repeat(64);
const modulePath = "./capability-catalog-codec.js";
const ALL_ROLES = [
  "ANALYTICS", "ARCHITECTURE", "BACKEND", "FRONTEND", "OPERATIONS", "PLATFORM",
  "PRODUCT", "QA", "RELEASE", "REQUIREMENTS", "RESEARCH", "REVIEW", "SECURITY", "UX",
];
const VERIFIER_ROLES = [
  "ARCHITECTURE", "OPERATIONS", "PRODUCT", "QA", "REQUIREMENTS", "SECURITY", "UX",
];

interface CodecModule {
  readonly CAPABILITY_CATALOG_AUTHORITY_KINDS: readonly string[];
  readonly CAPABILITY_CATALOG_CRITERION_CATEGORIES: readonly string[];
  readonly CAPABILITY_CATALOG_DELIVERY_PROFILE_FAMILY_IDS: readonly string[];
  readonly CAPABILITY_CATALOG_DIGEST_DOMAIN: string;
  readonly CAPABILITY_CATALOG_LIMITS: Readonly<{ maxBytes: number }>;
  readonly CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES: readonly string[];
  readonly CAPABILITY_CATALOG_RESOURCE_KINDS: readonly string[];
  readonly CAPABILITY_CATALOG_ROLES: readonly string[];
  readonly CAPABILITY_CATALOG_VERSION: string;
  readonly createCapabilityCatalogRevision: (value: unknown) => any;
  readonly decodeCapabilityCatalogRevisionBytes: (value: unknown) => any;
  readonly encodeCapabilityCatalogRevision: (value: unknown) => any;
}

async function loadCodec(): Promise<CodecModule> {
  return await import(modulePath) as CodecModule;
}

function entry(
  capabilityId = "capability-web-build",
  authorityKind: "BUILDER" | "VERIFIER" = "BUILDER",
): Record<string, unknown> {
  return {
    authorityKind,
    capabilityId,
    criterionCategories: [
      "DEPLOYMENT", "FUNCTIONAL", "NON_FUNCTIONAL", "SECURITY_PRIVACY",
      "TECHNOLOGY", "UX_ACCESSIBILITY",
    ],
    deliveryProfileFamilyId: "Next.js/TypeScript",
    deliveryProfileRevisionDigest: hex("a"),
    deliveryProfileRevisionId: "profile-next-typescript-r1",
    executionIsolationProfileRevisionDigest: hex("b"),
    executionIsolationProfileRevisionId: "execution-profile-default-r1",
    readScopes: ["packages/core/src"],
    requiredImageDigests: [`sha256:${hex("c")}`],
    requiredToolDigests: [hex("d")],
    resourceScopes: [
      { kind: "EVIDENCE_CLASS", ref: "unit-reports" },
      { kind: "NETWORK_PLANE", ref: "managed-internal" },
    ],
    roles: authorityKind === "BUILDER" ? [...ALL_ROLES] : [...VERIFIER_ROLES],
    verificationRecipeRevisions: [
      { recipeRevisionDigest: hex("e"), recipeRevisionId: "verify-unit-r1" },
    ],
    verifierCapabilityIds: authorityKind === "BUILDER" ? ["capability-web-verify"] : [],
    writeScopes: authorityKind === "BUILDER" ? ["packages/core/generated"] : [],
  };
}

function entries(): Record<string, unknown>[] {
  return [entry(), entry("capability-web-verify", "VERIFIER")];
}

function withBuilder(patch: Record<string, unknown>): Record<string, unknown>[] {
  return [{ ...entry(), ...patch }, entry("capability-web-verify", "VERIFIER")];
}

function withVerifier(patch: Record<string, unknown>): Record<string, unknown>[] {
  return [entry(), { ...entry("capability-web-verify", "VERIFIER"), ...patch }];
}

function draft(): Record<string, unknown> {
  return {
    catalogId: "catalog-default",
    entries: entries(),
    lineage: null,
    revisionId: "catalog-revision-1",
    sourceCommitSha256: hex("1"),
  };
}

async function created(value: unknown = draft()): Promise<any> {
  const result = (await loadCodec()).createCapabilityCatalogRevision(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

it("publishes the exact closed role, authority, resource, category, and family rosters", async () => {
  const codec = await loadCodec();
  expect(codec.CAPABILITY_CATALOG_VERSION).toBe("moe-capability-catalog-revision/2");
  expect(codec.CAPABILITY_CATALOG_DIGEST_DOMAIN)
    .toBe("moe-capability-catalog-revision-digest/2");
  expect(codec.CAPABILITY_CATALOG_ROLES).toEqual([
    "PRODUCT", "REQUIREMENTS", "RESEARCH", "UX", "ARCHITECTURE", "FRONTEND",
    "BACKEND", "PLATFORM", "SECURITY", "QA", "REVIEW", "RELEASE", "ANALYTICS",
    "OPERATIONS",
  ]);
  expect(codec.CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES).toEqual([
    "PRODUCT", "REQUIREMENTS", "UX", "ARCHITECTURE", "SECURITY", "QA", "OPERATIONS",
  ]);
  expect(codec.CAPABILITY_CATALOG_AUTHORITY_KINDS).toEqual(["BUILDER", "VERIFIER"]);
  expect(codec.CAPABILITY_CATALOG_RESOURCE_KINDS).toEqual([
    "EVIDENCE_CLASS", "NETWORK_PLANE", "RESOURCE_CLASS", "SECRET_SCHEMA",
  ]);
  expect(codec.CAPABILITY_CATALOG_CRITERION_CATEGORIES).toHaveLength(6);
  expect(codec.CAPABILITY_CATALOG_DELIVERY_PROFILE_FAMILY_IDS).toHaveLength(5);
});

it("creates a deeply immutable canonical revision with typed authority and resources", async () => {
  const codec = await loadCodec();
  const revision = await created();
  expect(revision.revisionDigest)
    .toBe("c45bc40ac1b086e99e00cf71f204b55291a2a70c7913aae5401bfc9106523056");
  expect(Object.isFrozen(revision)).toBe(true);
  expect(Object.isFrozen(revision.entries[0].roles)).toBe(true);
  expect(Object.isFrozen(revision.entries[0].resourceScopes[0])).toBe(true);
  const encoded = codec.encodeCapabilityCatalogRevision(revision);
  expect(encoded.ok).toBe(true);
  if (!encoded.ok) return;
  expect(new TextDecoder().decode(encoded.bytes)).toBe(JSON.stringify({
    catalogId: "catalog-default",
    entries: entries(),
    lineage: null,
    revisionDigest: revision.revisionDigest,
    revisionId: "catalog-revision-1",
    sourceCommitSha256: hex("1"),
    version: "moe-capability-catalog-revision/2",
  }));
  expect(codec.decodeCapabilityCatalogRevisionBytes(encoded.bytes)).toEqual({
    ok: true, revision,
  });
});

it("requires coverage of every closed role and every required verifier role", async () => {
  const codec = await loadCodec();
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), entries: withBuilder({ roles: ALL_ROLES.filter((role) => role !== "ANALYTICS") }),
  })).toEqual({
    code: "CAPABILITY_CATALOG_ROLE_COVERAGE_INCOMPLETE",
    layer: "CAPABILITY_CATALOG_AUTHORITY",
    ok: false,
  });
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), entries: withVerifier({
      roles: VERIFIER_ROLES.filter((role) => role !== "OPERATIONS"),
    }),
  })).toEqual({
    code: "CAPABILITY_CATALOG_ROLE_COVERAGE_INCOMPLETE",
    layer: "CAPABILITY_CATALOG_AUTHORITY",
    ok: false,
  });
});

it("requires exact independent verifier capability bindings", async () => {
  const codec = await loadCodec();
  for (const invalidEntries of [
    withBuilder({ verifierCapabilityIds: [] }),
    withBuilder({ verifierCapabilityIds: ["capability-absent"] }),
    withVerifier({ verifierCapabilityIds: ["capability-web-verify"] }),
  ]) {
    expect(codec.createCapabilityCatalogRevision({ ...draft(), entries: invalidEntries })).toEqual({
      code: "CAPABILITY_CATALOG_VERIFIER_BINDING_INVALID",
      layer: "CAPABILITY_CATALOG_AUTHORITY",
      ok: false,
    });
  }
});

it("forbids verifier repository writes", async () => {
  const codec = await loadCodec();
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), entries: withVerifier({ writeScopes: ["packages/core/generated"] }),
  })).toEqual({
    code: "CAPABILITY_CATALOG_SCOPE_INVALID",
    layer: "CAPABILITY_CATALOG_SCOPES",
    ok: false,
  });
});

it("requires every builder's bound verifier set to cover independent authority roles", async () => {
  const codec = await loadCodec();
  const builder = {
    ...entry(), verifierCapabilityIds: ["capability-web-verify"],
  };
  const boundReviewOnly = {
    ...entry("capability-web-verify", "VERIFIER"), roles: ["REVIEW"],
  };
  const unboundPolicyVerifier = {
    ...entry("capability-z-policy-verify", "VERIFIER"), roles: [...VERIFIER_ROLES],
  };
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), entries: [builder, boundReviewOnly, unboundPolicyVerifier],
  })).toEqual({
    code: "CAPABILITY_CATALOG_ROLE_COVERAGE_INCOMPLETE",
    layer: "CAPABILITY_CATALOG_AUTHORITY",
    ok: false,
  });
});

it.each([
  "../secrets", "/etc/passwd", "C:/repo", "packages\\core", "packages/*",
  "packages//core", "./packages", "packages/core/",
])("rejects noncanonical repository path scope %s", async (path) => {
  const codec = await loadCodec();
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), entries: withBuilder({ readScopes: [path] }),
  })).toEqual({
    code: "CAPABILITY_CATALOG_SCOPE_INVALID",
    layer: "CAPABILITY_CATALOG_SCOPES",
    ok: false,
  });
});

it("admits only exact sorted typed resource scopes", async () => {
  const codec = await loadCodec();
  for (const resourceScopes of [
    ["network:managed-internal"],
    [{ kind: "FILESYSTEM_PATH", ref: "packages-core" }],
    [{ kind: "NETWORK_PLANE", ref: "packages/core" }],
    [{ kind: "NETWORK_PLANE", ref: ".." }],
    [{ kind: "NETWORK_PLANE", ref: "C:" }],
    [{ kind: "NETWORK_PLANE", ref: "managed", extra: true }],
    [
      { kind: "NETWORK_PLANE", ref: "managed" },
      { kind: "EVIDENCE_CLASS", ref: "unit" },
    ],
  ]) {
    expect(codec.createCapabilityCatalogRevision({
      ...draft(), entries: withBuilder({ resourceScopes }),
    })).toEqual({
      code: "CAPABILITY_CATALOG_RESOURCE_SCOPE_INVALID",
      layer: "CAPABILITY_CATALOG_RESOURCES",
      ok: false,
    });
  }
});

it("rejects conflicting recipe identities across catalog entries", async () => {
  const codec = await loadCodec();
  for (const recipe of [
    { recipeRevisionDigest: hex("f"), recipeRevisionId: "verify-unit-r1" },
    { recipeRevisionDigest: hex("e"), recipeRevisionId: "verify-unit-r2" },
  ]) {
    expect(codec.createCapabilityCatalogRevision({
      ...draft(), entries: withVerifier({ verificationRecipeRevisions: [recipe] }),
    })).toEqual({
      code: "CAPABILITY_CATALOG_REFERENCE_INVALID",
      layer: "CAPABILITY_CATALOG_REFERENCES",
      ok: false,
    });
  }
});

it("requires OCI image digests and lowercase sha256 references", async () => {
  const codec = await loadCodec();
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), entries: withBuilder({ requiredImageDigests: [hex("c")] }),
  })).toEqual({
    code: "CAPABILITY_CATALOG_REFERENCE_INVALID",
    layer: "CAPABILITY_CATALOG_REFERENCES",
    ok: false,
  });
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), entries: withBuilder({ requiredToolDigests: [hex("D")] }),
  })).toEqual({
    code: "CAPABILITY_CATALOG_REFERENCE_INVALID",
    layer: "CAPABILITY_CATALOG_REFERENCES",
    ok: false,
  });
});

it("keeps exact entry, recipe, role, and verifier ordering canonical", async () => {
  const codec = await loadCodec();
  for (const invalidEntries of [
    [...entries()].reverse(),
    [entry(), entry()],
    withBuilder({ roles: [...ALL_ROLES].reverse() }),
    withBuilder({ verifierCapabilityIds: ["z-verifier", "a-verifier"] }),
    withBuilder({ verificationRecipeRevisions: [] }),
  ]) {
    expect(codec.createCapabilityCatalogRevision({ ...draft(), entries: invalidEntries }).ok)
      .toBe(false);
  }
});

it("rejects unknown command surfaces, hostile accessors, and malformed lineage", async () => {
  const codec = await loadCodec();
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), entries: withBuilder({ argv: ["sh", "-c", "true"] }),
  })).toEqual({
    code: "CAPABILITY_CATALOG_MALFORMED",
    layer: "CAPABILITY_CATALOG_ADMISSION",
    ok: false,
  });
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), lineage: { parentRevisionDigest: "bad", parentRevisionId: "prior" },
  })).toEqual({
    code: "CAPABILITY_CATALOG_REFERENCE_INVALID",
    layer: "CAPABILITY_CATALOG_REFERENCES",
    ok: false,
  });
  const accessor = draft();
  Object.defineProperty(accessor, "unexpected", {
    enumerable: true, get: () => { throw new Error("must not execute"); },
  });
  expect(codec.createCapabilityCatalogRevision(accessor)).toEqual({
    code: "CAPABILITY_CATALOG_MALFORMED",
    layer: "CAPABILITY_CATALOG_ADMISSION",
    ok: false,
  });
});

it("keeps vacuity, normalization, and bounded admission refusals exact", async () => {
  const codec = await loadCodec();
  for (const [value, layer] of [
    [{ ...draft(), entries: [] }, "CAPABILITY_CATALOG_ADMISSION"],
    [{ ...draft(), catalogId: "   " }, "CAPABILITY_CATALOG_ADMISSION"],
    [{ ...draft(), entries: withBuilder({ roles: [] }) }, "CAPABILITY_CATALOG_AUTHORITY"],
    [{ ...draft(), entries: withBuilder({ verificationRecipeRevisions: [] }) },
      "CAPABILITY_CATALOG_REFERENCES"],
  ] as const) {
    expect(codec.createCapabilityCatalogRevision(value)).toEqual({
      code: "CAPABILITY_CATALOG_VACUOUS", layer, ok: false,
    });
  }
  for (const catalogId of [" catalog-default", "e\u0301"]) {
    expect(codec.createCapabilityCatalogRevision({ ...draft(), catalogId })).toEqual({
      code: "CAPABILITY_CATALOG_MALFORMED",
      layer: "CAPABILITY_CATALOG_ADMISSION",
      ok: false,
    });
  }
  expect(codec.createCapabilityCatalogRevision({
    ...draft(), catalogId: "é".repeat(257),
  })).toEqual({
    code: "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
    layer: "CAPABILITY_CATALOG_LIMITS",
    ok: false,
  });
  expect(codec.decodeCapabilityCatalogRevisionBytes(
    new Uint8Array(codec.CAPABILITY_CATALOG_LIMITS.maxBytes + 1),
  )).toEqual({
    code: "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
    layer: "CAPABILITY_CATALOG_LIMITS",
    ok: false,
  });
});

it("refuses /1 upcast, duplicate keys, noncanonical bytes, and digest mutation distinctly", async () => {
  const codec = await loadCodec();
  const revision = await created();
  expect(codec.encodeCapabilityCatalogRevision({
    ...revision, version: "moe-capability-catalog-revision/1",
  })).toEqual({
    code: "CAPABILITY_CATALOG_VERSION_UNSUPPORTED",
    layer: "CAPABILITY_CATALOG_VERSION",
    ok: false,
  });
  expect(codec.decodeCapabilityCatalogRevisionBytes(
    new TextEncoder().encode('{"version":"x","version":"y"}'),
  )).toEqual({
    code: "CAPABILITY_CATALOG_DUPLICATE_KEY", layer: "CAPABILITY_CATALOG_CODEC", ok: false,
  });
  expect(codec.decodeCapabilityCatalogRevisionBytes(
    new TextEncoder().encode(JSON.stringify(revision, null, 2)),
  )).toEqual({
    code: "CAPABILITY_CATALOG_NONCANONICAL",
    layer: "CAPABILITY_CATALOG_CANONICALIZATION",
    ok: false,
  });
  expect(codec.encodeCapabilityCatalogRevision({
    ...revision, sourceCommitSha256: hex("2"),
  })).toEqual({
    code: "CAPABILITY_CATALOG_DIGEST_MISMATCH", layer: "CAPABILITY_CATALOG_DIGEST", ok: false,
  });
});
