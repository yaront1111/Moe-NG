import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_RECOVERY_SLOT_MANIFEST_BYTES,
  decodeRecoverySlotManifest,
  encodeRecoverySlotManifestV2,
} from "./recovery-slot-manifest.js";

const HEX_1 = "1".repeat(64);
const HEX_2 = "2".repeat(64);
const HEX_3 = "3".repeat(64);
const HEX_4 = "4".repeat(64);
const HEX_5 = "5".repeat(64);
const V1_KEYS = Object.freeze([
  "generationDigest",
  "incarnationRef",
  "keyEpochRef",
  "payloadDigests",
  "slotManifestVersion",
]);
const V2_KEYS = Object.freeze([
  "databaseDigest",
  "generationDigest",
  "incarnationRef",
  "keyEpochRef",
  "payloadDigests",
  "slotManifestVersion",
]);
const FIXTURE_PATH = new URL(
  "../../../tests/fixtures/store/recovery-slot-manifest-v1.json",
  import.meta.url,
);
const FIXTURE_SHA256 = "56e2189cd32aabddddc0a2bccab54a0f0bef847fcabc7ad0d08d2a1771b25892";

function fixtureBytes(): Uint8Array {
  return readFileSync(FIXTURE_PATH);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REFUSAL = Object.freeze({
  code: "RECOVERY_SLOT_MANIFEST_INVALID",
  layer: "RECOVERY_SLOT_MANIFEST",
  ok: false,
  outcome: "REFUSED",
});

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function v2Input(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    databaseDigest: HEX_5,
    generationDigest: HEX_1,
    incarnationRef: HEX_2,
    keyEpochRef: HEX_3,
    payloadDigests: {
      "z-last.json": HEX_4,
      "artifacts/state.json": HEX_1,
    },
    ...overrides,
  };
}

function v2Stored(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    databaseDigest: HEX_5,
    generationDigest: HEX_1,
    incarnationRef: HEX_2,
    keyEpochRef: HEX_3,
    payloadDigests: { "artifacts/state.json": HEX_4 },
    slotManifestVersion: "moe-recovery-slot/2",
    ...overrides,
  };
}

function expectRefusal(result: unknown): void {
  expect(result).toEqual(REFUSAL);
  expect(Object.isFrozen(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("TOP_SECRET");
}

describe("recovery slot manifest historical compatibility", () => {
  it("decodes the exact pre-2364d4e v1 fixture and never rewrites it", () => {
    const before = fixtureBytes();
    const stored = JSON.parse(decoder.decode(before)) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(V1_KEYS);
    expect(stored).not.toHaveProperty("databaseDigest");
    expect(sha256(before)).toBe(FIXTURE_SHA256);

    const decoded = decodeRecoverySlotManifest(before);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected the historical fixture to decode");
    expect(decoded.kind).toBe("LEGACY_V1");
    expect(decoded.manifest).toEqual({
      generationDigest: HEX_1,
      incarnationRef: HEX_2,
      keyEpochRef: HEX_3,
      payloadDigests: { "artifacts/state.json": HEX_4 },
      slotManifestVersion: "moe-recovery-slot/1",
    });
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.manifest)).toBe(true);
    expect(Object.isFrozen(decoded.manifest.payloadDigests)).toBe(true);

    const encoded = encodeRecoverySlotManifestV2({
      databaseDigest: HEX_5,
      generationDigest: HEX_1,
      incarnationRef: HEX_2,
      keyEpochRef: HEX_3,
      payloadDigests: { "artifacts/state.json": HEX_4 },
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error("expected valid v2 input to encode");
    const emitted = JSON.parse(decoder.decode(encoded.bytes)) as Record<string, unknown>;
    expect(Object.keys(emitted)).toEqual(V2_KEYS);
    expect(emitted["slotManifestVersion"]).toBe("moe-recovery-slot/2");

    const after = fixtureBytes();
    expect(sha256(after)).toBe(FIXTURE_SHA256);
    expect(Object.keys(JSON.parse(decoder.decode(after)) as object)).toEqual(V1_KEYS);
  });

  it("preserves the artifact insertion order emitted by the historical /1 writer", () => {
    const legacy = {
      generationDigest: HEX_1,
      incarnationRef: HEX_2,
      keyEpochRef: HEX_3,
      payloadDigests: { "z-last.json": HEX_4, "artifacts/state.json": HEX_1 },
      slotManifestVersion: "moe-recovery-slot/1",
    };
    const decoded = decodeRecoverySlotManifest(bytes(legacy));
    expect(decoded.ok && decoded.kind).toBe("LEGACY_V1");
    if (!decoded.ok) throw new Error("expected historical insertion order to decode");
    expect(Object.keys(decoded.manifest.payloadDigests)).toEqual([
      "z-last.json",
      "artifacts/state.json",
    ]);

    // /2 has one canonical writer order and must not inherit the legacy rule.
    expectRefusal(
      decodeRecoverySlotManifest(
        bytes(v2Stored({ payloadDigests: legacy.payloadDigests })),
      ),
    );
  });
});

/** The pre-move location of the v1 vector, kept as a positive control for the matcher. */
const PRE_MOVE_SOURCE_PATH = "fixtures/recovery-slot-manifest-v1.json";
const RECOVERY_JSON = /(^|\/)[^/]*recovery[^/]*\.json$/iu;

/**
 * Packaging sweeps enumerate every file under a package's `src`, so a test-only
 * compatibility vector kept there ships. Walk the real store source tree instead of
 * trusting the move; relative paths are joined with `/` so the set is identical on
 * Windows, macOS and Linux.
 */
function storeSourceInventory(): { readonly files: string[]; readonly recoveryJson: string[] } {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const files: string[] = [];
  const recoveryJson: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relative);
        continue;
      }
      files.push(relative);
      if (RECOVERY_JSON.test(relative)) recoveryJson.push(relative);
    }
  };
  walk(root, "");
  return { files, recoveryJson };
}

describe("recovery fixture source inventory", () => {
  it("keeps the historical fixture outside the publishable store package root", () => {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const fixtureFromPackageRoot = relative(packageRoot, fileURLToPath(FIXTURE_PATH));
    expect(fixtureFromPackageRoot.startsWith(`..${sep}`)).toBe(true);
    expect(sha256(fixtureBytes())).toBe(FIXTURE_SHA256);
  });

  it("leaves no recovery fixture JSON under the store production src tree", () => {
    const { files, recoveryJson } = storeSourceInventory();
    // An empty result must not be reachable by walking the wrong tree, by walking
    // nothing, or by a matcher that lost the shape it was written to catch.
    expect(files).toContain("recovery-slot-manifest.test.ts");
    expect(files.length).toBeGreaterThan(1);
    expect(RECOVERY_JSON.test(PRE_MOVE_SOURCE_PATH)).toBe(true);
    expect(recoveryJson).toEqual([]);
  });
});

describe("recovery slot manifest v2 encoding", () => {
  it("emits only canonical v2 bytes with sorted frozen payload digests", () => {
    const encoded = encodeRecoverySlotManifestV2(v2Input());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error("expected valid v2 input to encode");
    expect(decoder.decode(encoded.bytes)).toBe(
      `{\"databaseDigest\":\"${HEX_5}\",\"generationDigest\":\"${HEX_1}\",` +
        `\"incarnationRef\":\"${HEX_2}\",\"keyEpochRef\":\"${HEX_3}\",` +
        `\"payloadDigests\":{\"artifacts/state.json\":\"${HEX_1}\",\"z-last.json\":\"${HEX_4}\"},` +
        `\"slotManifestVersion\":\"moe-recovery-slot/2\"}`,
    );
    expect(Object.keys(encoded.manifest)).toEqual(V2_KEYS);
    expect(Object.keys(encoded.manifest.payloadDigests)).toEqual([
      "artifacts/state.json",
      "z-last.json",
    ]);
    expect(Object.isFrozen(encoded)).toBe(true);
    expect(Object.isFrozen(encoded.manifest)).toBe(true);
    expect(Object.isFrozen(encoded.manifest.payloadDigests)).toBe(true);
  });

  it("refuses hostile and structurally invalid writer inputs with one fixed reason", () => {
    const accessor = Object.defineProperty({}, "databaseDigest", {
      enumerable: true,
      get: () => {
        throw new Error("TOP_SECRET");
      },
    });
    const customPrototype = Object.assign(Object.create({ inherited: true }) as object, v2Input());
    const hostile = new Proxy(v2Input(), {
      ownKeys: () => {
        throw new Error("TOP_SECRET");
      },
    });
    const hostileMap = new Proxy({ "artifacts/state.json": HEX_4 }, {
      ownKeys: () => {
        throw new Error("TOP_SECRET");
      },
    });
    const oversizedMap = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`artifacts/${index}.json`, HEX_4]),
    );
    expect(Object.keys(oversizedMap)).toHaveLength(1_000);
    const cases: readonly unknown[] = [
      null,
      [],
      accessor,
      customPrototype,
      hostile,
      v2Input({ databaseDigest: "" }),
      v2Input({ databaseDigest: "A".repeat(64) }),
      v2Input({ payloadDigests: hostileMap }),
      v2Input({ payloadDigests: oversizedMap }),
      { ...v2Input(), extra: true },
    ];
    expect(cases.length).toBe(10);
    for (const input of cases) expectRefusal(encodeRecoverySlotManifestV2(input));
  });
});

describe("recovery slot manifest strict decoding", () => {
  it("dispatches valid v1 and v2 once and recursively freezes copied results", () => {
    const legacy = decodeRecoverySlotManifest(fixtureBytes());
    const encoded = encodeRecoverySlotManifestV2(v2Input());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error("expected valid v2 input to encode");
    const current = decodeRecoverySlotManifest(encoded.bytes);
    expect(legacy.ok && legacy.kind).toBe("LEGACY_V1");
    expect(current.ok && current.kind).toBe("DIGEST_BOUND_V2");
    if (!current.ok || current.kind !== "DIGEST_BOUND_V2") {
      throw new Error("expected valid v2 bytes to decode");
    }
    expect(current.manifest.databaseDigest).toBe(HEX_5);
    for (const value of [legacy, current, current.manifest, current.manifest.payloadDigests]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("strictly refuses version/schema confusion and every invalid v2 database digest", () => {
    const legacy = JSON.parse(decoder.decode(fixtureBytes())) as Record<string, unknown>;
    const invalidDigests: readonly unknown[] = [undefined, "", "g".repeat(64), "A".repeat(64), "a".repeat(63), "a".repeat(65)];
    const cases: unknown[] = [
      { ...legacy, slotManifestVersion: "moe-recovery-slot/99" },
      { databaseDigest: HEX_5, ...legacy },
      { ...legacy, extra: true },
      { ...legacy, generationDigest: undefined },
      { ...legacy, incarnationRef: "" },
      { ...legacy, keyEpochRef: legacy["incarnationRef"] },
      { ...legacy, payloadDigests: { "artifacts/state.json": "A".repeat(64) } },
      { ...v2Stored(), slotManifestVersion: "moe-recovery-slot/1" },
    ];
    for (const databaseDigest of invalidDigests) {
      const candidate = v2Stored({ databaseDigest });
      if (databaseDigest === undefined) delete candidate["databaseDigest"];
      cases.push(candidate);
    }
    expect(cases.length).toBe(14);
    for (const value of cases) expectRefusal(decodeRecoverySlotManifest(bytes(value)));
  });

  it("refuses malformed identifiers, payload maps, paths, and digests", () => {
    const invalidFields: readonly [string, unknown][] = [
      ["generationDigest", ""],
      ["incarnationRef", "bad\u0000ref"],
      ["keyEpochRef", "\ud800"],
      ["generationDigest", "x".repeat(513)],
      ["keyEpochRef", HEX_2],
    ];
    const invalidPaths = ["", "/absolute", "C:/absolute", "a\\b", "../escape", "a/../escape", "a//b", "./a"];
    const cases: unknown[] = invalidFields.map(([field, value]) => v2Stored({ [field]: value }));
    for (const path of invalidPaths) cases.push(v2Stored({ payloadDigests: { [path]: HEX_4 } }));
    cases.push(v2Stored({ payloadDigests: { "artifacts/state.json": "A".repeat(64) } }));
    cases.push(v2Stored({ payloadDigests: { "artifacts/state.json": "4".repeat(63) } }));
    cases.push(v2Stored({ payloadDigests: [] }));
    const legacy = JSON.parse(decoder.decode(fixtureBytes())) as Record<string, unknown>;
    cases.push({ ...legacy, payloadDigests: {} });
    expect(cases.length).toBe(17);
    for (const value of cases) expectRefusal(decodeRecoverySlotManifest(bytes(value)));
  });

  it("refuses noncanonical, malformed, proxied, detached, shared, and oversized bytes", () => {
    const canonical = decoder.decode(bytes(v2Stored()));
    const duplicate = canonical.replace(`\"databaseDigest\":\"${HEX_5}\"`, `\"databaseDigest\":\"${HEX_5}\",\"databaseDigest\":\"${HEX_5}\"`);
    const reordered = JSON.stringify({ slotManifestVersion: "moe-recovery-slot/2", ...v2Stored() });
    const proxied = new Proxy(bytes(v2Stored()), {});
    const detachedBuffer = new ArrayBuffer(8);
    const detached = new Uint8Array(detachedBuffer);
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
    const cases: readonly unknown[] = [
      null,
      proxied,
      detached,
      new Uint8Array(new SharedArrayBuffer(8)),
      new Uint8Array(MAX_RECOVERY_SLOT_MANIFEST_BYTES + 1),
      new Uint8Array([0xc3, 0x28]),
      encoder.encode("{"),
      encoder.encode(` ${canonical}`),
      encoder.encode(reordered),
      encoder.encode(duplicate),
      encoder.encode(JSON.stringify(null)),
      encoder.encode(JSON.stringify([])),
      encoder.encode(JSON.stringify({ TOP_SECRET: "do-not-leak" })),
    ];
    expect(cases.length).toBe(13);
    for (const value of cases) expectRefusal(decodeRecoverySlotManifest(value));
  });
});
