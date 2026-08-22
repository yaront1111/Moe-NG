import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  DISTRIBUTION_COMPONENT_KINDS,
} from "../../../packages/contracts/src/distribution/distribution-contract.js";
import type {
  DistributionRefusalReason,
} from "../../../packages/contracts/src/distribution/distribution-contract.js";
import {
  MAX_JSON_BODY_BYTES,
  MAX_JSON_STRING_UTF8_BYTES,
} from "../../../packages/contracts/src/input-limits.js";
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
import { DISTRIBUTION_INVENTORY } from "../../../tools/packaging/distribution-inventory.js";
import { startDistribution } from "../../../tools/packaging/distribution-startup.js";
import type { StartupDistributionExpectation } from "../../../packages/contracts/src/distribution/distribution-verifier.js";
import {
  RELEASE_COMPONENTS,
  buildReleaseSubject,
} from "../../../scripts/release/release-subject.mjs";

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

/**
 * The ONE canonical production inventory, imported rather than rebuilt. This file used to
 * carry a second hand-built list — and a `providerAssets()` DIRECTORY WALK for the two
 * provider components — while scripts/release/release-subject.mjs carried a different one.
 * Two lists meant two answers to "what ships"; the release script omitted the JetBrains
 * adapter entirely and enumerated eleven claude assets where the walk found twenty-two.
 *
 * The walk is gone on purpose, not incidentally: its filter excluded `*.test.ts` but not
 * `*-test-fixtures.ts`, so it swept claude-launcher-test-fixtures.ts and
 * claude-launcher-authority-test-fixtures.ts into a SHIPPED distribution — exactly the
 * fixture-as-shipped-artifact the IDE_ADAPTER test below is written to prevent. A walk
 * also makes the distribution digest depend on whatever happens to be on disk at build
 * time, which is the one thing a canonical inventory exists to stop.
 *
 * This array is the SUBJECT of the assertions below, never their source. Every expectation
 * about it — the count, the ids, the kinds, the exact asset paths — is hand-written
 * literal text. An expectation derived from the import would compare the array with itself
 * and survive every future omission.
 */
const INVENTORY = DISTRIBUTION_INVENTORY;

/**
 * The exact shipped asset set, hand-transcribed from the shipped tree.
 *
 * IDE_ADAPTER IS SHIPPED. The premise of its former absence — that `adapters/` does not
 * exist — stopped being true: task-9fd52b41f3ea4aad8c0c07bbe6fd3025 landed
 * adapters/jetbrains and adapters/ide-contract, and
 * task-9fff3d4258ca4bd8b6e167761ee94fdf added the host that composes them. Its assets are
 * real shipped source read through the same `read(path)` helper as every other component,
 * so its digests come from the production builder rather than from a fixture. Both the
 * `.ts` modules AND their `.js` bridges are enumerated: the bridges are what let these
 * modules resolve each other under plain Node, so a component shipped without them would
 * not load at all.
 *
 * The labelled contract FIXTURE at the bottom of this file is a different thing and stays:
 * it exercises the packaging path for an IDE_ADAPTER component that is not this one.
 */
const EXPECTED_ASSETS: Readonly<Record<string, readonly string[]>> = {
  "control-room": ["apps/control-room/index.html"],
  daemon: ["apps/daemon/src/index.ts"],
  "ide-adapter-jetbrains": [
    "adapters/ide-contract/src/index.js",
    "adapters/ide-contract/src/index.ts",
    "adapters/jetbrains/src/host/jetbrains-host-port-detail.js",
    "adapters/jetbrains/src/host/jetbrains-host-port-detail.ts",
    "adapters/jetbrains/src/host/jetbrains-host-ports.js",
    "adapters/jetbrains/src/host/jetbrains-host-ports.ts",
    "adapters/jetbrains/src/host/jetbrains-host.js",
    "adapters/jetbrains/src/host/jetbrains-host.ts",
    "adapters/jetbrains/src/index.js",
    "adapters/jetbrains/src/index.ts",
    "adapters/jetbrains/src/jetbrains-distribution-gate.js",
    "adapters/jetbrains/src/jetbrains-distribution-gate.ts",
  ],
  "mcp-bridge": ["packages/mcp/src/index.ts"],
  "provider-claude": [
    "packages/runner/src/providers/claude/claude-cancel-reconcile.ts",
    "packages/runner/src/providers/claude/claude-capabilities.ts",
    "packages/runner/src/providers/claude/claude-observation.ts",
    "packages/runner/src/providers/claude/claude-probe.ts",
    "packages/runner/src/providers/claude/claude-render.ts",
    "packages/runner/src/providers/claude/claude-runtime-pin-closure.ts",
    "packages/runner/src/providers/claude/claude-runtime-pin-copy.ts",
    "packages/runner/src/providers/claude/claude-runtime-pin-fs.ts",
    "packages/runner/src/providers/claude/claude-runtime-pin.ts",
    "packages/runner/src/providers/claude/claude-stream-anomalies.ts",
    "packages/runner/src/providers/claude/claude-stream.ts",
  ],
  "provider-codex": [
    "packages/runner/src/providers/codex/codex-cancel-reconcile.ts",
    "packages/runner/src/providers/codex/codex-capabilities.ts",
    "packages/runner/src/providers/codex/codex-observation.ts",
    "packages/runner/src/providers/codex/codex-probe.ts",
    "packages/runner/src/providers/codex/codex-render-skills.ts",
    "packages/runner/src/providers/codex/codex-render.ts",
    "packages/runner/src/providers/codex/codex-stream-anomalies.ts",
    "packages/runner/src/providers/codex/codex-stream.ts",
  ],
};

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
  test("the inventory is exactly the six components that exist on disk", () => {
    expect(INVENTORY.length).toBe(6);
    expect(INVENTORY.map((entry) => entry.componentId)).toEqual([
      "daemon", "control-room", "mcp-bridge", "provider-claude", "provider-codex",
      "ide-adapter-jetbrains",
    ]);
    expect(INVENTORY.map((entry) => entry.componentKind)).toEqual([
      "DAEMON", "CONTROL_ROOM", "MCP_BRIDGE", "PROVIDER_ADAPTER", "PROVIDER_ADAPTER",
      "IDE_ADAPTER",
    ]);
    for (const entry of INVENTORY) {
      expect(entry.assets.length, `${entry.componentId} must enumerate assets`)
        .toBeGreaterThan(0);
    }
  });

  test("no component id is declared twice in the canonical inventory", () => {
    // A duplicate id would build two containers under one name; the startup gate refuses
    // that with COMPONENT_DUPLICATE (asserted below), but the inventory should never
    // reach it in the first place.
    const ids = INVENTORY.map((entry) => entry.componentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(6);
  });

  test("every shipped component carries exactly its hand-transcribed asset set", () => {
    // The pin that makes asset drift loud. `EXPECTED_ASSETS` is literal text; the
    // canonical inventory is the subject. A path added, dropped or renamed there
    // silently redefines the distribution digest unless this reddens.
    expect(Object.keys(EXPECTED_ASSETS).sort()).toEqual([
      "control-room", "daemon", "ide-adapter-jetbrains", "mcp-bridge", "provider-claude",
      "provider-codex",
    ]);
    for (const entry of INVENTORY) {
      expect(entry.assets, `${entry.componentId} asset set`)
        .toEqual(EXPECTED_ASSETS[entry.componentId]);
    }
    // Proves the loop above actually ran over all six rather than over nothing.
    expect(INVENTORY.length).toBe(6);
  });

  test("the canonical inventory and its entries are frozen against mutation", () => {
    expect(Object.isFrozen(INVENTORY)).toBe(true);
    for (const entry of INVENTORY) {
      expect(Object.isFrozen(entry), `${entry.componentId} entry`).toBe(true);
      expect(Object.isFrozen(entry.assets), `${entry.componentId} assets`).toBe(true);
    }
    expect(INVENTORY.length).toBe(6);
  });

  test("exactly one shipped component claims IDE_ADAPTER, built from real files", () => {
    expect(DISTRIBUTION_COMPONENT_KINDS).toContain("IDE_ADAPTER");
    const shipped = INVENTORY.filter((entry) => entry.componentKind === "IDE_ADAPTER");
    expect(shipped.length).toBe(1);
    expect(shipped[0]!.componentId).toBe("ide-adapter-jetbrains");
    // It is NOT the labelled contract fixture exercised at the bottom of this file.
    expect(shipped[0]!.componentId).not.toBe("ide-adapter-contract-fixture");

    // Every asset must be a real file with real bytes. `read` throws on a missing
    // path, so a placeholder that was never written cannot pass by being empty
    // either — this is the guard against a fixture creeping back in as a shipped
    // artifact, which task rail 2 forbids.
    expect(shipped[0]!.assets.length).toBe(12);
    for (const path of shipped[0]!.assets) {
      expect(read(path).byteLength, `${path} must be real shipped bytes`).toBeGreaterThan(0);
    }
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
    expect(rebuilt.length).toBe(6);
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

  test("an asset path spelling another pair's digest framing is refused, not aggregated", () => {
    // aggregateDigestHex frames each sorted (path, digest) pair as path LF digest LF. The
    // honest two-asset set {a, b} and the single asset "a\n<digest of a>\nb" frame to the
    // same bytes, so without a charset rule the two manifests would share one aggregate
    // digest and a signature over one would vouch for the other.
    const bytesA = new TextEncoder().encode("alpha");
    const bytesB = new TextEncoder().encode("beta");
    const honest = buildDistributionContainer(
      buildInput({
        assets: [{ bytes: bytesA, path: "a" }, { bytes: bytesB, path: "b" }],
        componentId: "framing-fixture",
        componentKind: "DAEMON",
      }),
      privateKey,
    );
    expect(honest.ok).toBe(true);
    if (!honest.ok) return;
    expect(honest.manifest.assets.map((asset) => asset.path)).toEqual(["a", "b"]);
    const colliding = buildDistributionContainer(
      buildInput({
        assets: [{ bytes: bytesB, path: `a\n${sha256(bytesA)}\nb` }],
        componentId: "framing-fixture",
        componentKind: "DAEMON",
      }),
      privateKey,
    );
    expectRefusal(colliding, "ASSET_PATH_INVALID");
    expect(colliding).toMatchObject({ refusedBy: "DISTRIBUTION_PACKAGER" });
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

describe("the packager inherits the startup decoder's bounds", () => {
  // The startup gate decodes a container through the bounded JSON decoder, which refuses
  // any string over MAX_JSON_STRING_UTF8_BYTES and any body over MAX_JSON_BODY_BYTES. An
  // asset is carried as base64, four chars per three raw bytes, so the largest asset a
  // container can ever carry is floor(limit / 4) * 3 raw bytes. The two literals below
  // are hand-derived from the 262,144-char limit rather than computed from it, so a
  // silent change to either limit reddens this block instead of re-deriving around it.
  const LARGEST_ADMISSIBLE_ASSET_BYTES = 196_608;
  const SMALLEST_OVERSIZE_ASSET_BYTES = 196_609;

  const filled = (byteLength: number, fill: number): Uint8Array =>
    new Uint8Array(byteLength).fill(fill);

  function boundedBuild(assets: readonly { bytes: Uint8Array; path: string }[]) {
    return buildDistributionContainer(
      buildInput({ assets, componentId: "bounds-fixture", componentKind: "DAEMON" }),
      privateKey,
    );
  }

  function admit(containerBytes: Uint8Array): { readonly ok: boolean } {
    return startDistribution(
      {
        containers: [containerBytes],
        expectation: expectation({ componentKinds: { "bounds-fixture": "DAEMON" } }),
        trustedPublicKeys: trustedKeys(),
      },
      () => undefined,
    );
  }

  test("the literals are the decoder's own limits, not a transcription that drifted", () => {
    expect(MAX_JSON_STRING_UTF8_BYTES).toBe(262_144);
    expect(MAX_JSON_BODY_BYTES).toBe(1_048_576);
    expect(Math.floor(MAX_JSON_STRING_UTF8_BYTES / 4) * 3).toBe(LARGEST_ADMISSIBLE_ASSET_BYTES);
    expect(LARGEST_ADMISSIBLE_ASSET_BYTES + 1).toBe(SMALLEST_OVERSIZE_ASSET_BYTES);
  });

  test("a 196,608-byte asset encodes to exactly the string limit, builds and admits", () => {
    // Positive control at the ceiling. Without it the refusal below would also pass
    // against a packager that had degenerated into refusing every large asset.
    const built = boundedBuild([
      { bytes: filled(LARGEST_ADMISSIBLE_ASSET_BYTES, 0x41), path: "src/large.bin" },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const carried = JSON.parse(new TextDecoder().decode(built.containerBytes)) as {
      assets: Record<string, string>;
    };
    expect(carried.assets["src/large.bin"]!.length).toBe(MAX_JSON_STRING_UTF8_BYTES);
    expect(built.manifest.assets[0]!.byteLength).toBe(LARGEST_ADMISSIBLE_ASSET_BYTES);
    expect(admit(built.containerBytes)).toMatchObject({ ok: true });
  });

  test("a 196,609-byte asset is refused by the packager, never handed to startup", () => {
    // One byte past the ceiling encodes to 262,148 chars, which the startup decoder
    // refuses as CONTAINER_BYTES_INVALID. That refusal must surface at build time under
    // the packager's own layer: an oversize asset that packages and signs cleanly is a
    // release that can never be admitted, discovered only when it fails to start.
    const result = boundedBuild([
      { bytes: filled(SMALLEST_OVERSIZE_ASSET_BYTES, 0x41), path: "src/large.bin" },
    ]);
    expectRefusal(result, "CONTAINER_BYTES_INVALID");
    expect(result).toMatchObject({ refusedBy: "DISTRIBUTION_PACKAGER" });
    expect("containerBytes" in result).toBe(false);
  });

  test("assets that each fit but together exceed the body limit are refused by the packager", () => {
    // Per-asset bound alone is not enough: five ceiling-sized assets are 1,310,720 chars
    // of base64, past MAX_JSON_BODY_BYTES, while every individual string is admissible.
    const within = [0, 1, 2].map((at) => ({
      bytes: filled(LARGEST_ADMISSIBLE_ASSET_BYTES, 0x41 + at), path: `src/part-${at}.bin`,
    }));
    const fitting = boundedBuild(within);
    expect(fitting.ok).toBe(true);
    if (!fitting.ok) return;
    expect(fitting.containerBytes.byteLength).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES);
    expect(admit(fitting.containerBytes)).toMatchObject({ ok: true });

    const overflowing = [0, 1, 2, 3, 4].map((at) => ({
      bytes: filled(LARGEST_ADMISSIBLE_ASSET_BYTES, 0x41 + at), path: `src/part-${at}.bin`,
    }));
    expect(overflowing.length * MAX_JSON_STRING_UTF8_BYTES).toBeGreaterThan(MAX_JSON_BODY_BYTES);
    const result = boundedBuild(overflowing);
    expectRefusal(result, "CONTAINER_BYTES_INVALID");
    expect(result).toMatchObject({ refusedBy: "DISTRIBUTION_PACKAGER" });
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
      "control-room", "daemon", "ide-adapter-jetbrains", "mcp-bridge", "provider-claude",
      "provider-codex",
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

  test("a port that throws mid-set reports the components already launched", () => {
    // The launch port has no stop affordance, so a throw on a later component cannot
    // un-launch its predecessors; the refusal must report the true launch count rather
    // than implying it is zero.
    const sideEffects: string[] = [];
    const result = startDistribution(
      { containers: allContainers(), expectation: expectation(), trustedPublicKeys: trustedKeys() },
      (componentId) => {
        if (sideEffects.length === 1) throw new Error("second component refused to start");
        sideEffects.push(componentId);
      },
    );
    expectRefusal(result, "LAUNCH_PORT_FAILED");
    if (result.ok || !("launched" in result)) {
      throw new Error("refusal must report the launched components");
    }
    expect(sideEffects.length).toBe(1);
    expect(result.launched).toEqual(sideEffects);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.launched)).toBe(true);
  });
});

describe("the shipped JetBrains adapter fails closed at the startup layer", () => {
  const JETBRAINS_INDEX = 5;

  test("the canonical inventory places the JetBrains adapter where these drills expect it", () => {
    expect(INVENTORY[JETBRAINS_INDEX]!.componentId).toBe("ide-adapter-jetbrains");
  });

  test("omitting the JetBrains adapter is refused as COMPONENT_SET_INCOMPLETE", () => {
    const without = allContainers().filter((_container, index) => index !== JETBRAINS_INDEX);
    expect(without.length).toBe(5);
    const launched: string[] = [];
    const result = startDistribution(
      { containers: without, expectation: expectation(), trustedPublicKeys: trustedKeys() },
      (componentId) => launched.push(componentId),
    );
    expectRefusal(result, "COMPONENT_SET_INCOMPLETE");
    expect(result).toMatchObject({ refusedBy: "DISTRIBUTION_STARTUP" });
    expect(launched).toEqual([]);
  });

  test("shipping the JetBrains adapter twice is refused as COMPONENT_DUPLICATE", () => {
    const containers = allContainers();
    const launched: string[] = [];
    const result = startDistribution(
      {
        containers: [...containers, containers[JETBRAINS_INDEX]!],
        expectation: expectation(),
        trustedPublicKeys: trustedKeys(),
      },
      (componentId) => launched.push(componentId),
    );
    expectRefusal(result, "COMPONENT_DUPLICATE");
    expect(result).toMatchObject({ refusedBy: "DISTRIBUTION_STARTUP" });
    expect(launched).toEqual([]);
  });

  test("a drifted JetBrains asset byte is refused as ASSET_DIGEST_MISMATCH", () => {
    const containers = [...allContainers()];
    const parsed = JSON.parse(new TextDecoder().decode(containers[JETBRAINS_INDEX]!)) as {
      assets: Record<string, string>;
    };
    const keys = Object.keys(parsed.assets).sort();
    expect(keys.length).toBe(12);
    parsed.assets[keys[0]!] = Buffer.from("drifted").toString("base64");
    containers[JETBRAINS_INDEX] = new TextEncoder().encode(JSON.stringify(parsed));
    const launched: string[] = [];
    const result = startDistribution(
      { containers, expectation: expectation(), trustedPublicKeys: trustedKeys() },
      (componentId) => launched.push(componentId),
    );
    expectRefusal(result, "ASSET_DIGEST_MISMATCH");
    expect(result).toMatchObject({ refusedBy: "DISTRIBUTION_STARTUP" });
    expect(launched).toEqual([]);
  });
});

describe("the release subject consumes the one canonical inventory", () => {
  const RELEASE_KEY = generateKeyPairSync("ed25519").privateKey;
  const SHIPPED_IDS = [
    "control-room", "daemon", "ide-adapter-jetbrains", "mcp-bridge", "provider-claude",
    "provider-codex",
  ];

  type DraftComponent = {
    assets: string[];
    componentId: string;
    componentKind: string;
  };

  /** A structural deep copy, which is exactly what the release guard byte-compares. */
  const clone = (): DraftComponent[] =>
    JSON.parse(JSON.stringify(RELEASE_COMPONENTS)) as DraftComponent[];

  const subject = (components?: unknown): Record<string, unknown> => {
    const base = {
      privateKey: RELEASE_KEY,
      signingKeyId: KEY_ID,
      source: { objectFormat: "sha256", sourceSha: SOURCE_SHA },
      sourceRoot: REPO_ROOT,
    };
    return buildReleaseSubject(
      components === undefined ? base : { ...base, components },
    ) as Record<string, unknown>;
  };

  /**
   * The release layer's own stable refusal, distinct from the distribution layer's
   * DISTRIBUTION_MISMATCH asserted by `expectRefusal`. Pinning `refusedBy` is what
   * records WHICH layer answered: if the distribution gate started refusing these
   * first, the reason would still be a refusal but the layer would change.
   */
  const expectReleaseRefusal = (result: Record<string, unknown>, reason: string): void => {
    expect(result).toMatchObject({
      code: "RELEASE_SUPPLY_CHAIN_REFUSED",
      ok: false,
      reason,
      refusedBy: "RELEASE_SUPPLY_CHAIN",
    });
  };

  test("the release inventory IS the canonical inventory, not a copy of it", () => {
    expect(RELEASE_COMPONENTS).toBe(DISTRIBUTION_INVENTORY);
  });

  test("the accepted subject binds all six components to one source sha and contract", () => {
    const result = subject();
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.componentCount).toBe(6);

    const containers = result.containers as ReadonlyArray<{
      readonly componentId: string;
      readonly containerDigest: string;
      readonly manifestBytes: Uint8Array;
      readonly manifestDigest: string;
    }>;
    expect(containers.length).toBe(6);
    expect(containers.map((entry) => entry.componentId).sort()).toEqual(SHIPPED_IDS);
    // Six distinct components must produce six distinct manifests and containers; a
    // collision would mean one component's bytes were bound twice under two names.
    expect(new Set(containers.map((entry) => entry.manifestDigest)).size).toBe(6);
    expect(new Set(containers.map((entry) => entry.containerDigest)).size).toBe(6);

    const manifests = containers.map((entry) => JSON.parse(
      new TextDecoder().decode(entry.manifestBytes),
    ) as {
      apiCompatibilityRange: unknown;
      buildToolVersions: unknown;
      contractSchemaHash: string;
      source: unknown;
    });
    expect(manifests.length).toBe(6);
    for (const manifest of manifests) {
      expect(manifest.source).toEqual({ objectFormat: "sha256", sourceSha: SOURCE_SHA });
      expect(manifest.contractSchemaHash).toBe(SCHEMA_HASH);
      expect(manifest.apiCompatibilityRange).toEqual({ ...PINS });
      expect(manifest.buildToolVersions).toEqual({ ...BUILD_TOOLS });
    }

    const receipt = result.receipt as {
      readonly admittedComponentIds: readonly string[];
      readonly compatibleComponentIds: readonly string[];
    };
    expect([...receipt.admittedComponentIds].sort()).toEqual(SHIPPED_IDS);
    expect([...receipt.compatibleComponentIds].sort()).toEqual(SHIPPED_IDS);
  });

  test("an exact structural copy of the canonical inventory is accepted", () => {
    // The positive control. Without it every refusal below would still pass against a
    // guard that had degenerated into refusing all caller-supplied inventories.
    const copy = clone();
    expect(copy).not.toBe(RELEASE_COMPONENTS);
    expect(copy.length).toBe(6);
    const result = subject(copy);
    expect(result.ok).toBe(true);
    expect(result.componentCount).toBe(6);
  });

  test("a caller-supplied inventory omitting the JetBrains adapter is refused", () => {
    const omitted = clone().filter((entry) => entry.componentId !== "ide-adapter-jetbrains");
    expect(omitted.length).toBe(5);
    expectReleaseRefusal(subject(omitted), "RELEASE_INPUT_INVALID");
  });

  test("a caller-supplied inventory duplicating a component is refused", () => {
    const duplicated = clone();
    duplicated.push(JSON.parse(JSON.stringify(duplicated[5])) as DraftComponent);
    expect(duplicated.length).toBe(7);
    expect(duplicated[6]!.componentId).toBe("ide-adapter-jetbrains");
    expectReleaseRefusal(subject(duplicated), "RELEASE_INPUT_INVALID");
  });

  test("a caller-supplied inventory with a drifted asset set is refused", () => {
    const drifted = clone();
    const jetbrains = drifted.find((entry) => entry.componentId === "ide-adapter-jetbrains");
    expect(jetbrains?.assets.length).toBe(12);
    jetbrains!.assets = jetbrains!.assets.slice(0, 11);
    // Same six components, same ids, same kinds — one asset short.
    expect(drifted.length).toBe(6);
    expectReleaseRefusal(subject(drifted), "RELEASE_INPUT_INVALID");
  });

  test("a caller-supplied inventory that is merely REORDERED is refused", () => {
    // The drill a length check or a set comparison would survive: same six entries,
    // same assets, different order. Order is part of the subject.
    const reordered = clone().reverse();
    expect(reordered.length).toBe(6);
    expect(reordered.map((entry) => entry.componentId).sort()).toEqual(SHIPPED_IDS);
    expect(reordered[0]!.componentId).not.toBe(RELEASE_COMPONENTS[0]!.componentId);
    expectReleaseRefusal(subject(reordered), "RELEASE_INPUT_INVALID");
  });
});

describe("IDE_ADAPTER packaging contract", () => {
  test("packages and admits a labelled fixture distinct from the shipped adapter", () => {
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
    "tools/packaging/distribution-inventory.ts",
    "tools/packaging/distribution-startup.ts",
  ] as const;

  test("every tooling module imports under plain Node with real bindings", () => {
    expect(modules.length).toBe(3);
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
