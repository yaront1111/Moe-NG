import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, test } from "vitest";

import {
  DISTRIBUTION_COMPONENT_KINDS,
} from "../../../packages/contracts/src/distribution/distribution-contract.js";
import type {
  DistributionComponentKind,
  DistributionRefusalReason,
} from "../../../packages/contracts/src/distribution/distribution-contract.js";
import { createCompatGate } from "../../../packages/control-room-client/src/index.js";
import {
  GENERATED_CONTRACT_PINS,
} from "../../../packages/control-room-client/src/generated/generated-client.js";
import {
  SKILL_MANIFEST_VERSION,
  validateSkillManifestBytes,
} from "../../../packages/skills/src/index.js";
import {
  buildDistributionContainer,
  publicKeyHex,
} from "../../../tools/packaging/distribution-build.js";
import type { DistributionBuildInput } from "../../../tools/packaging/distribution-build.js";
import { startDistribution } from "../../../tools/packaging/distribution-startup.js";
import type { StartupDistributionExpectation } from "../../../packages/contracts/src/distribution/distribution-verifier.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * The LIVE pins, read from the generated client rather than transcribed. A literal here
 * would still let every test below pass while packaging a distribution the control room
 * refuses to run; the `createCompatGate` block at the bottom is what proves these are the
 * values that authority actually accepts.
 */
const PINS = Object.freeze({
  commandEnvelopeVersion: GENERATED_CONTRACT_PINS.commandEnvelopeVersion,
  errorRegistryVersion: GENERATED_CONTRACT_PINS.errorRegistryVersion,
  queryEnvelopeVersion: GENERATED_CONTRACT_PINS.queryEnvelopeVersion,
});
const BUILD_TOOLS = Object.freeze({ node: "24.16.0", pnpm: "11.0.8" });
const SCHEMA_HASH = GENERATED_CONTRACT_PINS.contractDigest;
const SOURCE_SHA = "7".repeat(64);
const KEY_ID = "release-key-1";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

function read(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(join(REPO_ROOT, relative)));
}

function providerAssets(provider: string): readonly string[] {
  const dir = posix.join("packages/runner/src/providers", provider);
  return readdirSync(join(REPO_ROOT, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => posix.join(dir, name));
}

/**
 * The hand-reviewed inventory of components that actually exist in this tree.
 *
 * IDE_ADAPTER is deliberately ABSENT: `adapters/` does not exist and the real JetBrains
 * consumer is task-9fd52b41f3ea4aad8c0c07bbe6fd3025. It is exercised below only as an
 * explicitly labelled contract fixture, never as a shipped artifact.
 */
const INVENTORY: ReadonlyArray<{
  readonly assets: readonly string[];
  readonly componentId: string;
  readonly componentKind: DistributionComponentKind;
}> = [
  { assets: ["apps/daemon/src/index.ts"], componentId: "daemon", componentKind: "DAEMON" },
  {
    assets: ["apps/control-room/index.html"],
    componentId: "control-room",
    componentKind: "CONTROL_ROOM",
  },
  { assets: ["packages/mcp/src/index.ts"], componentId: "mcp-bridge", componentKind: "MCP_BRIDGE" },
  {
    assets: providerAssets("claude"),
    componentId: "provider-claude",
    componentKind: "PROVIDER_ADAPTER",
  },
  {
    assets: providerAssets("codex"),
    componentId: "provider-codex",
    componentKind: "PROVIDER_ADAPTER",
  },
];

/** Every durable instruction template this repo ships. Exactly three, hand-transcribed. */
const TEMPLATE_PATHS = ["AGENTS.md", "CLAUDE.md", ".codex/agent-instructions.md"] as const;

/**
 * Shipped built-in skill BUNDLES, in the product's own SkillManifest schema. Currently
 * none: `.moe/skills/` is this project's workspace state under a different schema
 * (`moeGeneratedSha`/`skills[]`), and per the 2026-08-07 roadmap amendment runtime,
 * user and project skills stay external inputs. Adding a real built-in must turn the
 * count assertion below red until it is deliberately registered here.
 */
const SHIPPED_BUILT_IN_SKILLS: readonly Uint8Array[] = [];

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function skillManifestBytes(skillId: string, version: string): Uint8Array {
  const body = {
    files: [{ byteLength: 3, path: "SKILL.md", sha256: sha256(new TextEncoder().encode("abc")) }],
    manifestVersion: SKILL_MANIFEST_VERSION,
    origin: "authored",
    skillId,
    version,
  };
  return new TextEncoder().encode(JSON.stringify(body));
}

function buildInput(overrides: Partial<DistributionBuildInput> = {}): DistributionBuildInput {
  const entry = INVENTORY[0]!;
  return {
    apiCompatibilityRange: { ...PINS },
    assets: entry.assets.map((path) => ({ bytes: read(path), path })),
    buildToolVersions: { ...BUILD_TOOLS },
    builtInSkillManifestBytes: SHIPPED_BUILT_IN_SKILLS,
    componentId: entry.componentId,
    componentKind: entry.componentKind,
    contractSchemaHash: SCHEMA_HASH,
    instructionTemplates: TEMPLATE_PATHS.map((path) => ({
      bytes: read(path),
      templateId: path,
      version: "1",
    })),
    signingKeyId: KEY_ID,
    source: { objectFormat: "sha256", sourceSha: SOURCE_SHA },
    ...overrides,
  };
}

function buildOk(overrides: Partial<DistributionBuildInput> = {}): {
  readonly containerBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
} {
  const result = buildDistributionContainer(buildInput(overrides), privateKey);
  if (!result.ok) throw new Error(`build refused: ${result.reason}`);
  return { containerBytes: result.containerBytes, manifestBytes: result.manifestBytes };
}

function inventoryInput(index: number): DistributionBuildInput {
  const entry = INVENTORY[index]!;
  return buildInput({
    assets: entry.assets.map((path) => ({ bytes: read(path), path })),
    componentId: entry.componentId,
    componentKind: entry.componentKind,
  });
}

function expectation(
  overrides: Partial<StartupDistributionExpectation> = {},
): StartupDistributionExpectation {
  return {
    apiCompatibilityRange: { ...PINS },
    buildToolVersions: { ...BUILD_TOOLS },
    builtInSkills: [],
    componentKinds: Object.fromEntries(
      INVENTORY.map((entry) => [entry.componentId, entry.componentKind]),
    ),
    contractSchemaHash: SCHEMA_HASH,
    instructionTemplates: TEMPLATE_PATHS.map((path) => ({
      digest: sha256(read(path)),
      templateId: path,
      version: "1",
    })),
    source: { objectFormat: "sha256", sourceSha: SOURCE_SHA },
    trustedKeyIds: [KEY_ID],
    ...overrides,
  };
}

const trustedKeys = (): Readonly<Record<string, string>> => ({ [KEY_ID]: publicKeyHex(publicKey) });

function allContainers(): readonly Uint8Array[] {
  return INVENTORY.map((_entry, index) => {
    const result = buildDistributionContainer(inventoryInput(index), privateKey);
    if (!result.ok) throw new Error(`inventory build refused: ${result.reason}`);
    return result.containerBytes;
  });
}

function expectRefusal(result: { readonly ok: boolean }, reason: DistributionRefusalReason): void {
  expect(result).toMatchObject({ code: "DISTRIBUTION_MISMATCH", ok: false, reason });
}

describe("hand-reviewed distribution inventory", () => {
  test("the inventory is exactly the five components that exist on disk", () => {
    expect(INVENTORY.length).toBe(5);
    expect(INVENTORY.map((entry) => entry.componentId)).toEqual([
      "daemon", "control-room", "mcp-bridge", "provider-claude", "provider-codex",
    ]);
    expect(INVENTORY.map((entry) => entry.componentKind)).toEqual([
      "DAEMON", "CONTROL_ROOM", "MCP_BRIDGE", "PROVIDER_ADAPTER", "PROVIDER_ADAPTER",
    ]);
    for (const entry of INVENTORY) {
      expect(entry.assets.length, `${entry.componentId} must enumerate assets`)
        .toBeGreaterThan(0);
    }
  });

  test("no shipped component claims the IDE_ADAPTER kind", () => {
    expect(DISTRIBUTION_COMPONENT_KINDS).toContain("IDE_ADAPTER");
    expect(INVENTORY.some((entry) => entry.componentKind === "IDE_ADAPTER")).toBe(false);
  });

  test("the durable instruction template set is exactly three files", () => {
    expect(TEMPLATE_PATHS.length).toBe(3);
    for (const path of TEMPLATE_PATHS) {
      expect(read(path).byteLength, `${path} must be readable`).toBeGreaterThan(0);
    }
  });

  test("the shipped built-in skill bundle count is exactly zero", () => {
    expect(SHIPPED_BUILT_IN_SKILLS.length).toBe(0);
  });
});

describe("deterministic packaging", () => {
  test("two builds from one source tree are byte-identical", () => {
    const first = buildOk();
    const second = buildOk();
    expect(second.manifestBytes).toEqual(first.manifestBytes);
    expect(second.containerBytes).toEqual(first.containerBytes);
  });

  test("every inventory component rebuilds byte-identically", () => {
    const rebuilt = allContainers();
    expect(rebuilt.length).toBe(5);
    expect(allContainers()).toEqual(rebuilt);
  });

  test("asset enumeration order does not change the bytes", () => {
    const entry = INVENTORY[3]!;
    const forward = entry.assets.map((path) => ({ bytes: read(path), path }));
    const baseline = buildOk({
      assets: forward,
      componentId: entry.componentId,
      componentKind: entry.componentKind,
    });
    const reversed = buildOk({
      assets: [...forward].reverse(),
      componentId: entry.componentId,
      componentKind: entry.componentKind,
    });
    expect(forward.length).toBeGreaterThan(1);
    expect(reversed.containerBytes).toEqual(baseline.containerBytes);
  });

  test("a dot-slash path root spelling normalizes to the same bytes", () => {
    const baseline = buildOk();
    const dotted = buildOk({
      assets: INVENTORY[0]!.assets.map((path) => ({ bytes: read(path), path: `./${path}` })),
    });
    expect(dotted.containerBytes).toEqual(baseline.containerBytes);
  });

  test("build input keys are exact: an undeclared skill payload is refused", () => {
    const hostile = { ...buildInput(), runtimeSkills: [skillManifestBytes("rogue", "1.0.0")] };
    expectRefusal(
      buildDistributionContainer(hostile, privateKey),
      "BUILD_INPUT_INVALID",
    );
  });

  test("built-in skill identities come from the production skill validator", () => {
    const bytes = skillManifestBytes("moe-planning", "1.0.0");
    const validated = validateSkillManifestBytes(bytes);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const result = buildDistributionContainer(
      buildInput({ builtInSkillManifestBytes: [bytes] }),
      privateKey,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.builtInSkills).toEqual([
      { digest: validated.identityDigest, skillId: "moe-planning", version: "1.0.0" },
    ]);
  });

  test("an external skill substituting a shipped ID is refused, never merged", () => {
    expectRefusal(
      buildDistributionContainer(
        buildInput({
          builtInSkillManifestBytes: [
            skillManifestBytes("moe-planning", "1.0.0"),
            skillManifestBytes("moe-planning", "6.6.6"),
          ],
        }),
        privateKey,
      ),
      "SKILL_IDENTITY_DUPLICATE",
    );
  });

  test("malformed skill manifest bytes are refused by the validator, not embedded", () => {
    expectRefusal(
      buildDistributionContainer(
        buildInput({ builtInSkillManifestBytes: [new TextEncoder().encode("{")] }),
        privateKey,
      ),
      "SKILL_IDENTITY_INVALID",
    );
  });
});

describe("production startup admission", () => {
  test("the full trusted set launches every component exactly once", () => {
    const launched: string[] = [];
    const result = startDistribution(
      { containers: allContainers(), expectation: expectation(), trustedPublicKeys: trustedKeys() },
      (componentId) => launched.push(componentId),
    );
    expect(result.ok).toBe(true);
    expect(launched.sort()).toEqual([
      "control-room", "daemon", "mcp-bridge", "provider-claude", "provider-codex",
    ]);
  });

  const tampers: ReadonlyArray<{
    readonly label: string;
    readonly reason: DistributionRefusalReason;
    readonly run: (launch: (id: string) => void) => { readonly ok: boolean };
  }> = [
    {
      label: "signature bytes flipped",
      reason: "SIGNATURE_INVALID",
      run: (launch) => {
        const containers = [...allContainers()];
        const text = new TextDecoder().decode(containers[0]!);
        const parsed = JSON.parse(text) as { signature: string };
        const flipped = parsed.signature[0] === "0" ? "1" : "0";
        containers[0] = new TextEncoder().encode(
          text.replace(`"${parsed.signature}"`, `"${flipped}${parsed.signature.slice(1)}"`),
        );
        return startDistribution(
          { containers, expectation: expectation(), trustedPublicKeys: trustedKeys() },
          launch,
        );
      },
    },
    {
      label: "signing key not in the trusted map",
      reason: "SIGNING_KEY_UNTRUSTED",
      run: (launch) => startDistribution(
        { containers: allContainers(), expectation: expectation(), trustedPublicKeys: {} },
        launch,
      ),
    },
    {
      label: "a different key signed the manifest",
      reason: "SIGNATURE_INVALID",
      run: (launch) => startDistribution(
        {
          containers: allContainers(),
          expectation: expectation(),
          trustedPublicKeys: {
            [KEY_ID]: publicKeyHex(generateKeyPairSync("ed25519").publicKey),
          },
        },
        launch,
      ),
    },
    {
      label: "source sha is stale",
      reason: "SOURCE_SHA_MISMATCH",
      run: (launch) => startDistribution(
        {
          containers: allContainers(),
          expectation: expectation({ source: { objectFormat: "sha256", sourceSha: "0".repeat(64) } }),
          trustedPublicKeys: trustedKeys(),
        },
        launch,
      ),
    },
    {
      label: "contract schema hash drifted",
      reason: "SCHEMA_HASH_MISMATCH",
      run: (launch) => startDistribution(
        {
          containers: allContainers(),
          expectation: expectation({ contractSchemaHash: "0".repeat(64) }),
          trustedPublicKeys: trustedKeys(),
        },
        launch,
      ),
    },
    {
      label: "api compatibility range drifted",
      reason: "API_RANGE_MISMATCH",
      run: (launch) => startDistribution(
        {
          containers: allContainers(),
          expectation: expectation({
            apiCompatibilityRange: { ...PINS, errorRegistryVersion: "9.9.9" },
          }),
          trustedPublicKeys: trustedKeys(),
        },
        launch,
      ),
    },
    {
      label: "build tool version drifted",
      reason: "BUILD_TOOL_MISMATCH",
      run: (launch) => startDistribution(
        {
          containers: allContainers(),
          expectation: expectation({ buildToolVersions: { node: "23.0.0", pnpm: "11.0.8" } }),
          trustedPublicKeys: trustedKeys(),
        },
        launch,
      ),
    },
    {
      label: "an embedded asset byte changed",
      reason: "ASSET_DIGEST_MISMATCH",
      run: (launch) => {
        const containers = [...allContainers()];
        const parsed = JSON.parse(new TextDecoder().decode(containers[0]!)) as {
          assets: Record<string, string>;
        };
        const key = Object.keys(parsed.assets).sort()[0]!;
        parsed.assets[key] = Buffer.from("tampered").toString("base64");
        containers[0] = new TextEncoder().encode(JSON.stringify(parsed));
        return startDistribution(
          { containers, expectation: expectation(), trustedPublicKeys: trustedKeys() },
          launch,
        );
      },
    },
    {
      label: "a component is missing from the set",
      reason: "COMPONENT_SET_INCOMPLETE",
      run: (launch) => startDistribution(
        {
          containers: allContainers().slice(1),
          expectation: expectation(),
          trustedPublicKeys: trustedKeys(),
        },
        launch,
      ),
    },
    {
      label: "a component is duplicated",
      reason: "COMPONENT_DUPLICATE",
      run: (launch) => {
        const containers = allContainers();
        return startDistribution(
          {
            containers: [...containers, containers[0]!],
            expectation: expectation(),
            trustedPublicKeys: trustedKeys(),
          },
          launch,
        );
      },
    },
    {
      label: "an instruction template drifted",
      reason: "INSTRUCTION_TEMPLATE_DRIFT",
      run: (launch) => startDistribution(
        {
          containers: allContainers(),
          expectation: expectation({
            instructionTemplates: TEMPLATE_PATHS.map((path) => ({
              digest: "0".repeat(64),
              templateId: path,
              version: "1",
            })),
          }),
          trustedPublicKeys: trustedKeys(),
        },
        launch,
      ),
    },
    {
      label: "a built-in skill is expected but not shipped",
      reason: "BUILT_IN_SKILL_DRIFT",
      run: (launch) => startDistribution(
        {
          containers: allContainers(),
          expectation: expectation({
            builtInSkills: [{ digest: "0".repeat(64), skillId: "ghost", version: "1.0.0" }],
          }),
          trustedPublicKeys: trustedKeys(),
        },
        launch,
      ),
    },
    {
      label: "the container is truncated",
      reason: "CONTAINER_BYTES_INVALID",
      run: (launch) => {
        const containers = [...allContainers()];
        containers[0] = containers[0]!.slice(0, 40);
        return startDistribution(
          { containers, expectation: expectation(), trustedPublicKeys: trustedKeys() },
          launch,
        );
      },
    },
  ];

  test("the tamper table was actually generated", () => {
    expect(tampers.length).toBe(13);
    expect(new Set(tampers.map((entry) => entry.label)).size).toBe(13);
  });

  for (const entry of tampers) {
    test(`refuses when ${entry.label}, and launches nothing`, () => {
      const launched: string[] = [];
      const result = entry.run((componentId) => launched.push(componentId));
      expectRefusal(result, entry.reason);
      expect(result).toMatchObject({ refusedBy: "DISTRIBUTION_STARTUP" });
      expect(launched).toEqual([]);
    });
  }

  test("a signature lifted from another component does not admit this one", () => {
    // The signature covers componentId, so a valid signature over a DIFFERENT manifest
    // must not carry. Without this the set gate would accept any reshuffling of a
    // genuinely signed release.
    const containers = [...allContainers()];
    const donor = JSON.parse(new TextDecoder().decode(containers[1]!)) as { signature: string };
    const victim = JSON.parse(new TextDecoder().decode(containers[0]!)) as { signature: string };
    expect(donor.signature).not.toBe(victim.signature);
    victim.signature = donor.signature;
    containers[0] = new TextEncoder().encode(JSON.stringify(victim));
    const launched: string[] = [];
    const result = startDistribution(
      { containers, expectation: expectation(), trustedPublicKeys: trustedKeys() },
      (componentId) => launched.push(componentId),
    );
    expectRefusal(result, "SIGNATURE_INVALID");
    expect(launched).toEqual([]);
  });

  test("an asset path that shadows Object.prototype still packages and admits", () => {
    // `payload["__proto__"] = x` on an object literal creates NO own property, so a naive
    // packager emits a container missing a declared asset that can never be admitted.
    const built = buildDistributionContainer(
      buildInput({
        assets: [
          { bytes: new TextEncoder().encode("a"), path: "__proto__" },
          { bytes: new TextEncoder().encode("b"), path: "src/real.ts" },
        ],
        componentId: "proto-edge-fixture",
        componentKind: "DAEMON",
      }),
      privateKey,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const carried = JSON.parse(new TextDecoder().decode(built.containerBytes)) as {
      assets: Record<string, string>;
    };
    expect(Object.keys(carried.assets).sort()).toEqual(["__proto__", "src/real.ts"]);
    const launched: string[] = [];
    const result = startDistribution(
      {
        containers: [built.containerBytes],
        expectation: expectation({ componentKinds: { "proto-edge-fixture": "DAEMON" } }),
        trustedPublicKeys: trustedKeys(),
      },
      (componentId) => launched.push(componentId),
    );
    expect(result.ok).toBe(true);
    expect(launched).toEqual(["proto-edge-fixture"]);
  });

  test("admission grants identifiers only, never a capability", () => {
    const result = startDistribution(
      { containers: allContainers(), expectation: expectation(), trustedPublicKeys: trustedKeys() },
      () => undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result).sort()).toEqual(["launched", "ok"]);
    expect(result.launched.every((id) => typeof id === "string")).toBe(true);
    expect(Object.values(result).some((value) => typeof value === "function")).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("a throwing launch port fails closed with a stable startup reason", () => {
    const result = startDistribution(
      { containers: allContainers(), expectation: expectation(), trustedPublicKeys: trustedKeys() },
      () => {
        throw new Error("component refused to start");
      },
    );
    expectRefusal(result, "LAUNCH_PORT_FAILED");
  });
});

describe("IDE_ADAPTER packaging contract", () => {
  test("packages and admits as a labelled fixture, with no JetBrains artifact claimed", () => {
    const FIXTURE_BYTES = new TextEncoder().encode("// contract fixture, not a shipped adapter\n");
    const built = buildDistributionContainer(
      buildInput({
        assets: [{ bytes: FIXTURE_BYTES, path: "fixture/ide-adapter-contract-fixture.ts" }],
        componentId: "ide-adapter-contract-fixture",
        componentKind: "IDE_ADAPTER",
      }),
      privateKey,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const launched: string[] = [];
    const result = startDistribution(
      {
        containers: [built.containerBytes],
        expectation: expectation({
          componentKinds: { "ide-adapter-contract-fixture": "IDE_ADAPTER" },
        }),
        trustedPublicKeys: trustedKeys(),
      },
      (componentId) => launched.push(componentId),
    );
    expect(result.ok).toBe(true);
    expect(launched).toEqual(["ide-adapter-contract-fixture"]);
  });
});

describe("composition with the landed control-room compatibility authority", () => {
  const reportFor = (manifest: {
    readonly apiCompatibilityRange: unknown;
    readonly buildToolVersions: unknown;
    readonly contractSchemaHash: unknown;
  }): unknown => ({
    apiCompatibilityRange: manifest.apiCompatibilityRange,
    buildToolVersions: manifest.buildToolVersions,
    contractSchemaHash: manifest.contractSchemaHash,
  });

  const built = (overrides: Partial<DistributionBuildInput> = {}) => {
    const result = buildDistributionContainer(buildInput(overrides), privateKey);
    if (!result.ok) throw new Error(`build refused: ${result.reason}`);
    return result.manifest;
  };

  test("a packaged manifest carries the live pins, not transcribed literals", () => {
    // If PINS or SCHEMA_HASH were hand-written constants that had drifted, this gate —
    // the control room's own authority, which we do not reimplement — would refuse.
    const manifest = built();
    expect(manifest.contractSchemaHash).toBe(GENERATED_CONTRACT_PINS.contractDigest);
    expect(createCompatGate(reportFor(manifest))).toMatchObject({ ok: true });
  });

  test("a packaged manifest with a drifted pin is refused by that same authority", () => {
    const manifest = built({
      apiCompatibilityRange: { ...PINS, commandEnvelopeVersion: "moe-runtime-command/9" },
    });
    const gate = createCompatGate(reportFor(manifest));
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    // truthClass OBSERVED is that layer's own marker: the control room compared the pins,
    // so this refusal is attributable to it rather than to the distribution gate.
    expect(gate.error).toMatchObject({ code: "DISTRIBUTION_MISMATCH", truthClass: "OBSERVED" });
  });

  test("a drifted schema hash is refused by that same authority", () => {
    const gate = createCompatGate(reportFor(built({ contractSchemaHash: "0".repeat(64) })));
    expect(gate).toMatchObject({ ok: false });
  });
});

describe("raw Node loadability", () => {
  // Vitest resolves a NodeNext `.js` specifier back to `.ts`, so a green suite above does
  // not prove these modules load outside it. Only a real Node process does.
  const modules = [
    "tools/packaging/distribution-build.ts",
    "tools/packaging/distribution-startup.ts",
  ] as const;

  test("both tooling modules import under plain Node with real bindings", () => {
    expect(modules.length).toBe(2);
    for (const relative of modules) {
      const script =
        `const m = await import(${JSON.stringify(`./${relative}`)});` +
        "const named = Object.keys(m).filter((k) => m[k] !== undefined);" +
        "if (named.length === 0) throw new Error('no defined bindings');" +
        "console.log(named.sort().join(','));";
      const out = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", script],
        { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out.trim().length, `${relative} must export defined bindings`).toBeGreaterThan(0);
    }
  });
});
