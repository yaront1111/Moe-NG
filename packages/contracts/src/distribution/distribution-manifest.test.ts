import { describe, expect, test } from "vitest";

import {
  DISTRIBUTION_COMPONENT_KINDS,
  DISTRIBUTION_CONTAINER_VERSION,
  DISTRIBUTION_MANIFEST_VERSION,
  DISTRIBUTION_REFUSAL_LAYERS,
  DISTRIBUTION_REFUSAL_REASONS,
  DISTRIBUTION_SIGNATURE_ALGORITHM,
  canonicalContainerBytes,
  canonicalUnsignedManifestBytes,
} from "./distribution-contract.js";
import type {
  DistributionManifest,
  DistributionRefusalReason,
} from "./distribution-contract.js";
import {
  decodeDistributionContainerBytes,
  parseDistributionContainer,
  parseDistributionManifest,
} from "./distribution-parser.js";
import { verifyDistributionSet } from "./distribution-verifier.js";
import type {
  ObservedDistributionComponent,
  StartupDistributionExpectation,
} from "./distribution-verifier.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const AGGREGATE = "d".repeat(64);
const SIGNATURE = "e".repeat(128);
const SOURCE_SHA = "f".repeat(64);

const PINS = Object.freeze({
  commandEnvelopeVersion: "1.4.0",
  errorRegistryVersion: "2.0.1",
  queryEnvelopeVersion: "1.1.0",
});

type Json = Record<string, unknown>;

function manifestInput(overrides: Json = {}): Json {
  return {
    apiCompatibilityRange: { ...PINS },
    aggregateDigest: AGGREGATE,
    assets: [
      { path: "src/index.ts", sha256: HEX_A, byteLength: 12 },
      { path: "src/util.ts", sha256: HEX_B, byteLength: 34 },
    ],
    buildToolVersions: { node: "24.16.0", pnpm: "11.0.8" },
    builtInSkills: [{ skillId: "moe-planning", version: "1.0.0", digest: HEX_C }],
    componentId: "daemon",
    componentKind: "DAEMON",
    contractSchemaHash: HEX_A,
    instructionTemplates: [{ templateId: "AGENTS.md", version: "1", digest: HEX_B }],
    manifestVersion: DISTRIBUTION_MANIFEST_VERSION,
    signatureAlgorithm: DISTRIBUTION_SIGNATURE_ALGORITHM,
    signingKeyId: "release-key-1",
    source: { objectFormat: "sha256", sourceSha: SOURCE_SHA },
    ...overrides,
  };
}

function parsedManifest(overrides: Json = {}): DistributionManifest {
  const result = parseDistributionManifest(manifestInput(overrides), "DISTRIBUTION_PACKAGER");
  if (!result.ok) throw new Error(`fixture manifest refused: ${result.reason}`);
  return result.manifest;
}

function containerInput(overrides: Json = {}): Json {
  return {
    assets: { "src/index.ts": "aGVsbG8=", "src/util.ts": "d29ybGQ=" },
    containerVersion: DISTRIBUTION_CONTAINER_VERSION,
    manifest: manifestInput(),
    signature: SIGNATURE,
    ...overrides,
  };
}

/** Asserts the full refusal triple. A test that checks only `ok:false` is vacuous. */
function expectRefusal(
  result: { readonly ok: boolean },
  reason: DistributionRefusalReason,
  refusedBy: string,
): void {
  expect(result).toMatchObject({
    code: "DISTRIBUTION_MISMATCH",
    ok: false,
    reason,
    refusedBy,
  });
  expect(DISTRIBUTION_REFUSAL_REASONS).toContain(reason);
}

describe("distribution vocabulary is closed and frozen", () => {
  test("component kinds are exactly the five shipped kinds", () => {
    expect([...DISTRIBUTION_COMPONENT_KINDS]).toEqual([
      "CONTROL_ROOM", "DAEMON", "IDE_ADAPTER", "MCP_BRIDGE", "PROVIDER_ADAPTER",
    ]);
    expect(Object.isFrozen(DISTRIBUTION_COMPONENT_KINDS)).toBe(true);
  });

  test("refusal layers name the packager and the startup gate only", () => {
    expect([...DISTRIBUTION_REFUSAL_LAYERS]).toEqual([
      "DISTRIBUTION_PACKAGER", "DISTRIBUTION_STARTUP",
    ]);
  });

  test("refusal reasons are unique, non-empty and frozen", () => {
    expect(DISTRIBUTION_REFUSAL_REASONS.length).toBeGreaterThan(0);
    expect(new Set(DISTRIBUTION_REFUSAL_REASONS).size).toBe(DISTRIBUTION_REFUSAL_REASONS.length);
    expect(Object.isFrozen(DISTRIBUTION_REFUSAL_REASONS)).toBe(true);
  });
});

describe("canonical unsigned manifest bytes", () => {
  test("key insertion order does not change the signed bytes", () => {
    const forward = parsedManifest();
    const reversed = parseDistributionManifest(
      Object.fromEntries(Object.entries(manifestInput()).reverse()),
      "DISTRIBUTION_PACKAGER",
    );
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    expect(canonicalUnsignedManifestBytes(reversed.manifest)).toEqual(
      canonicalUnsignedManifestBytes(forward),
    );
  });

  test("asset enumeration order does not change the signed bytes", () => {
    const swapped = parsedManifest({
      assets: [
        { path: "src/util.ts", sha256: HEX_B, byteLength: 34 },
        { path: "src/index.ts", sha256: HEX_A, byteLength: 12 },
      ],
    });
    expect(canonicalUnsignedManifestBytes(swapped)).toEqual(
      canonicalUnsignedManifestBytes(parsedManifest()),
    );
  });

  test("build tool key order does not change the signed bytes", () => {
    const swapped = parsedManifest({ buildToolVersions: { pnpm: "11.0.8", node: "24.16.0" } });
    expect(canonicalUnsignedManifestBytes(swapped)).toEqual(
      canonicalUnsignedManifestBytes(parsedManifest()),
    );
  });

  test("every provenance-bearing field is inside the signed bytes", () => {
    // A field-list sweep, not a key-shape check: an implementation that signs the right
    // KEYS but drops a VALUE stays green under a shape assertion.
    const mutations: ReadonlyArray<readonly [string, Json]> = [
      ["componentId", { componentId: "control-room" }],
      ["componentKind", { componentKind: "MCP_BRIDGE" }],
      ["contractSchemaHash", { contractSchemaHash: HEX_C }],
      ["aggregateDigest", { aggregateDigest: HEX_C }],
      ["signingKeyId", { signingKeyId: "release-key-2" }],
      ["source.sourceSha", { source: { objectFormat: "sha256", sourceSha: HEX_C } }],
      ["source.objectFormat", { source: { objectFormat: "sha1", sourceSha: "1".repeat(40) } }],
      ["apiCompatibilityRange", {
        apiCompatibilityRange: { ...PINS, commandEnvelopeVersion: "9.9.9" },
      }],
      ["buildToolVersions", { buildToolVersions: { node: "24.16.1", pnpm: "11.0.8" } }],
      ["assets.sha256", {
        assets: [
          { path: "src/index.ts", sha256: HEX_C, byteLength: 12 },
          { path: "src/util.ts", sha256: HEX_B, byteLength: 34 },
        ],
      }],
      ["assets.byteLength", {
        assets: [
          { path: "src/index.ts", sha256: HEX_A, byteLength: 13 },
          { path: "src/util.ts", sha256: HEX_B, byteLength: 34 },
        ],
      }],
      ["builtInSkills", {
        builtInSkills: [{ skillId: "moe-planning", version: "1.0.1", digest: HEX_C }],
      }],
      ["instructionTemplates", {
        instructionTemplates: [{ templateId: "CLAUDE.md", version: "1", digest: HEX_B }],
      }],
    ];
    expect(mutations.length).toBe(13);
    const baseline = canonicalUnsignedManifestBytes(parsedManifest());
    for (const [label, override] of mutations) {
      const mutated = canonicalUnsignedManifestBytes(parsedManifest(override));
      expect(mutated, `${label} must be covered by the signature`).not.toEqual(baseline);
    }
  });

  test("the signature is excluded from the bytes it signs", () => {
    const decoded = decodeDistributionContainerBytes(
      new TextEncoder().encode(JSON.stringify(containerInput())),
      "DISTRIBUTION_STARTUP",
    );
    const other = decodeDistributionContainerBytes(
      new TextEncoder().encode(JSON.stringify(containerInput({ signature: "0".repeat(128) }))),
      "DISTRIBUTION_STARTUP",
    );
    expect(decoded.ok && other.ok).toBe(true);
    if (!decoded.ok || !other.ok) return;
    expect(canonicalUnsignedManifestBytes(decoded.container.manifest)).toEqual(
      canonicalUnsignedManifestBytes(other.container.manifest),
    );
    expect(canonicalContainerBytes(decoded.container)).not.toEqual(
      canonicalContainerBytes(other.container),
    );
  });
});

describe("manifest parsing fails closed with a stable reason and layer", () => {
  const cases: ReadonlyArray<readonly [DistributionRefusalReason, unknown]> = [
    ["MANIFEST_SCHEMA_INVALID", null],
    ["MANIFEST_SCHEMA_INVALID", "a string"],
    ["MANIFEST_SCHEMA_INVALID", []],
    ["MANIFEST_SCHEMA_INVALID", manifestInput({ extraKey: 1 })],
    ["MANIFEST_VERSION_UNSUPPORTED", manifestInput({ manifestVersion: "nope/9" })],
    ["MANIFEST_SCHEMA_INVALID", manifestInput({ componentKind: "JETBRAINS" })],
    ["MANIFEST_SCHEMA_INVALID", manifestInput({ componentId: "" })],
    ["SIGNATURE_ALGORITHM_UNSUPPORTED", manifestInput({ signatureAlgorithm: "rsa" })],
    ["SOURCE_PROVENANCE_INVALID", manifestInput({
      source: { objectFormat: "sha256", sourceSha: "1".repeat(40) },
    })],
    ["SOURCE_PROVENANCE_INVALID", manifestInput({
      source: { objectFormat: "md5", sourceSha: SOURCE_SHA },
    })],
    ["ASSET_PATH_INVALID", manifestInput({
      assets: [{ path: "../escape.ts", sha256: HEX_A, byteLength: 1 }],
    })],
    ["ASSET_PATH_INVALID", manifestInput({
      assets: [{ path: "src\\index.ts", sha256: HEX_A, byteLength: 1 }],
    })],
    ["ASSET_PATH_INVALID", manifestInput({
      assets: [{ path: "C:/index.ts", sha256: HEX_A, byteLength: 1 }],
    })],
    ["ASSET_PATH_INVALID", manifestInput({
      assets: [{ path: "/abs.ts", sha256: HEX_A, byteLength: 1 }],
    })],
    ["ASSET_PATH_INVALID", manifestInput({
      assets: [{ path: "src/cafe\u0301.ts", sha256: HEX_A, byteLength: 1 }],
    })],
    ["ASSET_PATH_DUPLICATE", manifestInput({
      assets: [
        { path: "src/a.ts", sha256: HEX_A, byteLength: 1 },
        { path: "src/a.ts", sha256: HEX_B, byteLength: 2 },
      ],
    })],
    ["ASSET_PATH_DUPLICATE", manifestInput({
      assets: [
        { path: "src/A.ts", sha256: HEX_A, byteLength: 1 },
        { path: "src/a.ts", sha256: HEX_B, byteLength: 2 },
      ],
    })],
    ["ASSET_DIGEST_INVALID", manifestInput({
      assets: [{ path: "src/a.ts", sha256: HEX_A.toUpperCase(), byteLength: 1 }],
    })],
    ["ASSET_SET_EMPTY", manifestInput({ assets: [] })],
    ["SKILL_IDENTITY_DUPLICATE", manifestInput({
      builtInSkills: [
        { skillId: "moe-planning", version: "1.0.0", digest: HEX_C },
        { skillId: "moe-planning", version: "2.0.0", digest: HEX_A },
      ],
    })],
    ["SKILL_IDENTITY_INVALID", manifestInput({
      builtInSkills: [{ skillId: "Moe Planning", version: "1.0.0", digest: HEX_C }],
    })],
    ["TEMPLATE_IDENTITY_DUPLICATE", manifestInput({
      instructionTemplates: [
        { templateId: "AGENTS.md", version: "1", digest: HEX_B },
        { templateId: "AGENTS.md", version: "2", digest: HEX_C },
      ],
    })],
    ["MANIFEST_SCHEMA_INVALID", manifestInput({ buildToolVersions: { node: 24 } })],
    ["MANIFEST_SCHEMA_INVALID", manifestInput({ aggregateDigest: "short" })],
  ];

  test("the refusal table was actually generated", () => {
    expect(cases.length).toBe(24);
  });

  for (const [index, entry] of cases.entries()) {
    const [reason, value] = entry;
    test(`case ${index} refuses with ${reason}`, () => {
      expectRefusal(
        parseDistributionManifest(value, "DISTRIBUTION_PACKAGER"),
        reason,
        "DISTRIBUTION_PACKAGER",
      );
    });
  }

  test("the refusing layer is the caller's layer, not a hardcoded one", () => {
    expectRefusal(
      parseDistributionManifest(null, "DISTRIBUTION_STARTUP"),
      "MANIFEST_SCHEMA_INVALID",
      "DISTRIBUTION_STARTUP",
    );
  });

  test("hostile records never reach the manifest shape", () => {
    const proxied = new Proxy(manifestInput(), {});
    expectRefusal(
      parseDistributionManifest(proxied, "DISTRIBUTION_PACKAGER"),
      "MANIFEST_SCHEMA_INVALID",
      "DISTRIBUTION_PACKAGER",
    );
    const prototyped = Object.assign(Object.create({ inherited: 1 }), manifestInput()) as Json;
    expectRefusal(
      parseDistributionManifest(prototyped, "DISTRIBUTION_PACKAGER"),
      "MANIFEST_SCHEMA_INVALID",
      "DISTRIBUTION_PACKAGER",
    );
  });

  test("an accepted manifest is deeply frozen and normalized", () => {
    const manifest = parsedManifest({
      assets: [
        { path: "src/util.ts", sha256: HEX_B, byteLength: 34 },
        { path: "src/index.ts", sha256: HEX_A, byteLength: 12 },
      ],
    });
    expect(manifest.assets.map((asset) => asset.path)).toEqual(["src/index.ts", "src/util.ts"]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.assets)).toBe(true);
    expect(Object.isFrozen(manifest.assets[0])).toBe(true);
    expect(Object.isFrozen(manifest.source)).toBe(true);
  });
});

describe("container decoding", () => {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  test("round-trips to byte-identical container bytes", () => {
    const decoded = decodeDistributionContainerBytes(
      encode(containerInput()),
      "DISTRIBUTION_STARTUP",
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const rebuilt = decodeDistributionContainerBytes(
      canonicalContainerBytes(decoded.container),
      "DISTRIBUTION_STARTUP",
    );
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(canonicalContainerBytes(rebuilt.container)).toEqual(
      canonicalContainerBytes(decoded.container),
    );
  });

  const cases: ReadonlyArray<readonly [DistributionRefusalReason, Uint8Array]> = [
    ["CONTAINER_BYTES_INVALID", new TextEncoder().encode("{not json")],
    ["CONTAINER_BYTES_INVALID", new Uint8Array([0xff, 0xfe, 0xfd])],
    ["CONTAINER_SCHEMA_INVALID", encode([1, 2, 3])],
    ["CONTAINER_SCHEMA_INVALID", encode(containerInput({ extra: true }))],
    ["CONTAINER_VERSION_UNSUPPORTED", encode(containerInput({ containerVersion: "old/0" }))],
    ["SIGNATURE_INVALID", encode(containerInput({ signature: "abc" }))],
    ["SIGNATURE_INVALID", encode(containerInput({ signature: SIGNATURE.toUpperCase() }))],
    ["ASSET_SET_MISMATCH", encode(containerInput({ assets: { "src/index.ts": "aGVsbG8=" } }))],
    ["ASSET_SET_MISMATCH", encode(containerInput({
      assets: { "src/index.ts": "aGVsbG8=", "src/util.ts": "d29ybGQ=", "src/extra.ts": "eA==" },
    }))],
    ["CONTAINER_SCHEMA_INVALID", encode(containerInput({
      assets: { "src/index.ts": "not base64!!", "src/util.ts": "d29ybGQ=" },
    }))],
    ["MANIFEST_SCHEMA_INVALID", encode(containerInput({ manifest: { nope: true } }))],
  ];

  test("the container refusal table was actually generated", () => {
    expect(cases.length).toBe(11);
  });

  for (const [index, entry] of cases.entries()) {
    const [reason, bytes] = entry;
    test(`container case ${index} refuses with ${reason}`, () => {
      expectRefusal(
        decodeDistributionContainerBytes(bytes, "DISTRIBUTION_STARTUP"),
        reason,
        "DISTRIBUTION_STARTUP",
      );
    });
  }

  test("parseDistributionContainer rejects a truncated container", () => {
    expectRefusal(
      parseDistributionContainer({ containerVersion: DISTRIBUTION_CONTAINER_VERSION },
        "DISTRIBUTION_STARTUP"),
      "CONTAINER_SCHEMA_INVALID",
      "DISTRIBUTION_STARTUP",
    );
  });
});

describe("startup set admission", () => {
  const COMPONENTS = Object.freeze({
    "control-room": "CONTROL_ROOM",
    daemon: "DAEMON",
  } as const);

  function expectation(overrides: Partial<StartupDistributionExpectation> = {}):
  StartupDistributionExpectation {
    return {
      apiCompatibilityRange: { ...PINS },
      buildToolVersions: { node: "24.16.0", pnpm: "11.0.8" },
      builtInSkills: [{ skillId: "moe-planning", version: "1.0.0", digest: HEX_C }],
      componentKinds: { ...COMPONENTS },
      contractSchemaHash: HEX_A,
      instructionTemplates: [{ templateId: "AGENTS.md", version: "1", digest: HEX_B }],
      source: { objectFormat: "sha256", sourceSha: SOURCE_SHA },
      trustedKeyIds: ["release-key-1"],
      ...overrides,
    };
  }

  function observed(overrides: Json = {}): ObservedDistributionComponent {
    const manifest = parsedManifest(overrides);
    return {
      container: {
        assets: { "src/index.ts": "aGVsbG8=", "src/util.ts": "d29ybGQ=" },
        containerVersion: DISTRIBUTION_CONTAINER_VERSION,
        manifest,
        signature: SIGNATURE,
      },
      recomputedAggregateDigest: manifest.aggregateDigest,
      recomputedAssetDigests: Object.fromEntries(
        manifest.assets.map((asset) => [asset.path, asset.sha256]),
      ),
    };
  }

  const bothComponents = (): readonly ObservedDistributionComponent[] => [
    observed(),
    observed({ componentId: "control-room", componentKind: "CONTROL_ROOM" }),
  ];

  const accept = (): boolean => true;

  test("a complete, trusted, matching set is admitted and grants no launch affordance", () => {
    const result = verifyDistributionSet(bothComponents(), expectation(), accept);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.componentIds]).toEqual(["control-room", "daemon"]);
    expect(result.sourceSha).toBe(SOURCE_SHA);
    expect(Object.values(result).some((value) => typeof value === "function")).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("the signature port is asked for every component, over the unsigned bytes", () => {
    const seen: string[] = [];
    verifyDistributionSet(bothComponents(), expectation(), (input) => {
      seen.push(input.keyId);
      expect(input.signature).toBe(SIGNATURE);
      expect(input.message.byteLength).toBeGreaterThan(0);
      return true;
    });
    expect(seen).toEqual(["release-key-1", "release-key-1"]);
  });

  const refusals: ReadonlyArray<readonly [DistributionRefusalReason, () => unknown]> = [
    ["EXPECTATION_INVALID", () => verifyDistributionSet(bothComponents(), null, accept)],
    ["EXPECTATION_INVALID", () =>
      verifyDistributionSet(bothComponents(), expectation({ trustedKeyIds: [] }), accept)],
    ["EXPECTATION_INVALID", () =>
      verifyDistributionSet(bothComponents(), expectation({ componentKinds: {} }), accept)],
    ["COMPONENT_SET_INCOMPLETE", () => verifyDistributionSet([], expectation(), accept)],
    ["COMPONENT_SET_INCOMPLETE", () =>
      verifyDistributionSet([observed()], expectation(), accept)],
    ["COMPONENT_SET_UNEXPECTED", () => verifyDistributionSet(
      [...bothComponents(), observed({ componentId: "mcp-bridge", componentKind: "MCP_BRIDGE" })],
      expectation(), accept,
    )],
    ["COMPONENT_DUPLICATE", () =>
      verifyDistributionSet([...bothComponents(), observed()], expectation(), accept)],
    ["COMPONENT_KIND_MISMATCH", () => verifyDistributionSet(
      [observed(), observed({ componentId: "control-room", componentKind: "IDE_ADAPTER" })],
      expectation(), accept,
    )],
    ["SIGNING_KEY_UNTRUSTED", () => verifyDistributionSet(
      bothComponents(), expectation({ trustedKeyIds: ["other-key"] }), accept,
    )],
    ["SIGNATURE_INVALID", () => verifyDistributionSet(bothComponents(), expectation(), () => false)],
    ["SIGNATURE_PORT_FAILED", () => verifyDistributionSet(bothComponents(), expectation(), () => {
      throw new Error("hsm offline");
    })],
    ["SOURCE_SHA_MISMATCH", () => verifyDistributionSet(
      bothComponents(), expectation({ source: { objectFormat: "sha256", sourceSha: HEX_C } }),
      accept,
    )],
    ["SCHEMA_HASH_MISMATCH", () => verifyDistributionSet(
      bothComponents(), expectation({ contractSchemaHash: HEX_C }), accept,
    )],
    ["API_RANGE_MISMATCH", () => verifyDistributionSet(
      bothComponents(),
      expectation({ apiCompatibilityRange: { ...PINS, queryEnvelopeVersion: "9.9.9" } }),
      accept,
    )],
    ["BUILD_TOOL_MISMATCH", () => verifyDistributionSet(
      bothComponents(), expectation({ buildToolVersions: { node: "24.16.1", pnpm: "11.0.8" } }),
      accept,
    )],
    ["BUILT_IN_SKILL_DRIFT", () => verifyDistributionSet(
      bothComponents(),
      expectation({ builtInSkills: [{ skillId: "moe-planning", version: "9.9.9", digest: HEX_C }] }),
      accept,
    )],
    ["INSTRUCTION_TEMPLATE_DRIFT", () => verifyDistributionSet(
      bothComponents(),
      expectation({ instructionTemplates: [{ templateId: "CLAUDE.md", version: "1", digest: HEX_B }] }),
      accept,
    )],
    ["ASSET_DIGEST_MISMATCH", () => verifyDistributionSet(
      [
        { ...observed(), recomputedAssetDigests: { "src/index.ts": HEX_C, "src/util.ts": HEX_B } },
        observed({ componentId: "control-room", componentKind: "CONTROL_ROOM" }),
      ],
      expectation(), accept,
    )],
    ["ASSET_SET_MISMATCH", () => verifyDistributionSet(
      [
        { ...observed(), recomputedAssetDigests: { "src/index.ts": HEX_A } },
        observed({ componentId: "control-room", componentKind: "CONTROL_ROOM" }),
      ],
      expectation(), accept,
    )],
    ["AGGREGATE_DIGEST_MISMATCH", () => verifyDistributionSet(
      [
        { ...observed(), recomputedAggregateDigest: HEX_C },
        observed({ componentId: "control-room", componentKind: "CONTROL_ROOM" }),
      ],
      expectation(), accept,
    )],
  ];

  test("the startup refusal table was actually generated", () => {
    expect(refusals.length).toBe(20);
  });

  for (const [index, entry] of refusals.entries()) {
    const [reason, run] = entry;
    test(`startup case ${index} refuses with ${reason}`, () => {
      expectRefusal(run() as { readonly ok: boolean }, reason, "DISTRIBUTION_STARTUP");
    });
  }

  test("a space in one identity field cannot alias into a neighbouring field", () => {
    // {templateId:"welcome", version:"v2 1"} and {templateId:"welcome v2", version:"1"} are
    // different identities sharing one digest. A delimiter-joined encoding serializes both to
    // the same string, blinding INSTRUCTION_TEMPLATE_DRIFT to a signed-but-relabeled template.
    const spaced = {
      instructionTemplates: [{ templateId: "welcome", version: "v2 1", digest: HEX_B }],
    };
    const drifted = [
      observed(spaced),
      observed({ ...spaced, componentId: "control-room", componentKind: "CONTROL_ROOM" }),
    ];
    expectRefusal(
      verifyDistributionSet(drifted, expectation({
        instructionTemplates: [{ templateId: "welcome v2", version: "1", digest: HEX_B }],
      }), accept),
      "INSTRUCTION_TEMPLATE_DRIFT",
      "DISTRIBUTION_STARTUP",
    );
  });

  test("a mutually consistent but entirely stale set is still refused", () => {
    // Every component agrees on the same wrong source. Agreement among the observed set is
    // not evidence: only the trusted expectation decides.
    const stale = [
      observed({ source: { objectFormat: "sha256", sourceSha: HEX_C } }),
      observed({
        componentId: "control-room",
        componentKind: "CONTROL_ROOM",
        source: { objectFormat: "sha256", sourceSha: HEX_C },
      }),
    ];
    expectRefusal(
      verifyDistributionSet(stale, expectation(), accept),
      "SOURCE_SHA_MISMATCH",
      "DISTRIBUTION_STARTUP",
    );
  });

  test("an untrusted key is refused before the signature port is ever consulted", () => {
    let called = false;
    const result = verifyDistributionSet(
      bothComponents(),
      expectation({ trustedKeyIds: ["other-key"] }),
      () => {
        called = true;
        return true;
      },
    );
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});
