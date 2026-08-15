/**
 * The @moe/core project-configuration codec: create, encode, decode.
 *
 * Everything asserted here is decided by the PRODUCTION surface. The one place
 * this file computes a hash of its own (the domain-separation test) reads the
 * canonical settings body back out of production's own encoded bytes rather
 * than re-canonicalizing anything, so it cannot agree with a broken
 * canonicalizer by construction.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PROJECT_CONFIGURATION_INPUT_INVALID,
  PROJECT_CONFIGURATION_LIMIT_KEYS,
  PROJECT_CONFIGURATION_SCHEMA_VERSION,
  PROJECT_CONFIGURATION_VERSION_UNSUPPORTED,
} from "@moe/contracts";
import type { ProjectConfigurationManifest } from "@moe/contracts";

import {
  PROJECT_CONFIGURATION_SETTINGS_DIGEST_DOMAIN,
  createProjectConfigurationManifest,
  decodeProjectConfigurationManifestBytes,
  encodeProjectConfigurationManifest,
} from "./project-configuration-manifest.js";
import type {
  ProjectConfigurationCodecRefusal,
  ProjectConfigurationManifestCreateResult,
  ProjectConfigurationManifestDecodeResult,
  ProjectConfigurationManifestEncodeResult,
} from "./project-configuration-manifest.js";

const hex = (character: string): string => character.repeat(64);

const PROJECT_ID = "project-alpha";
const OPT_IN_DIGEST = hex("1");
const SOURCE_SHA = hex("2");

/** Dense and POSITIONAL: entry `i` must already carry vocabulary key `i`. */
const limitEntries = (): { key: string; value: number }[] =>
  PROJECT_CONFIGURATION_LIMIT_KEYS.map((key, index) => ({ key, value: index + 1 }));

/**
 * Every gate is the opt-in mode so the opt-in digest is a real hex64 rather than
 * the coupled `null`, which gives EVERY policy leaf an isolated valid mutation:
 * flipping one gate to manual leaves the other two opt-in, so the digest stays
 * required and the record stays valid.
 */
const baseSettings = (): Record<string, unknown> => ({
  isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
  limits: limitEntries(),
  network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
  orchestrationSource: { objectFormat: "sha256", sourceSha: SOURCE_SHA },
  policy: {
    acceptanceGate: "POLICY_AUTO_APPROVAL_OPT_IN",
    autoApprovalOptInDigest: OPT_IN_DIGEST,
    evaluatorVersion: "policy-evaluator-v1",
    expansionGate: "POLICY_AUTO_APPROVAL_OPT_IN",
    planningGate: "POLICY_AUTO_APPROVAL_OPT_IN",
    policyRevisionId: "policy-revision-7",
    revision: 3,
  },
  schemaVersions: {
    commandSchemaVersion: "moe-command/1",
    errorSchemaVersion: "moe-error/1",
    querySchemaVersion: "moe-query/1",
  },
  selection: {
    modelRef: "model-1", profileRef: "profile-1", providerRef: "provider-1",
    reasoningEffortRef: "effort-1", runtimeRef: "runtime-1", snapshotRef: "snapshot-1",
    structuredOutputSchemaRef: "schema-1",
  },
});

/** The same logical settings with every object key inserted in reverse order. */
const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(record).reverse()) reversed[key] = reverseKeys(record[key]);
  return reversed;
};

function createdOrThrow(settings: unknown = baseSettings()): ProjectConfigurationManifest {
  const result: ProjectConfigurationManifestCreateResult =
    createProjectConfigurationManifest(PROJECT_ID, settings);
  if (!result.ok) throw new Error(`fixture creation refused with ${result.code}`);
  return result.manifest;
}

function encodedOrThrow(manifest: unknown): Uint8Array {
  const result: ProjectConfigurationManifestEncodeResult =
    encodeProjectConfigurationManifest(manifest);
  if (!result.ok) throw new Error(`fixture encoding refused with ${result.code}`);
  return result.bytes;
}

const textOf = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("project configuration manifest creation and canonical bytes", () => {
  it("creates a manifest carrying the pinned schema version and a hex64 digest", () => {
    const manifest = createdOrThrow();
    expect(manifest.projectId).toBe(PROJECT_ID);
    expect(manifest.schemaVersion).toBe(PROJECT_CONFIGURATION_SCHEMA_VERSION);
    expect(manifest.settingsDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("encodes one manifest to byte-identical output on every call", () => {
    const manifest = createdOrThrow();
    expect(textOf(encodedOrThrow(manifest))).toBe(textOf(encodedOrThrow(manifest)));
  });

  it("produces the identical digest and bytes when object keys are inserted in reverse", () => {
    const forward = createdOrThrow(baseSettings());
    const reversed = createdOrThrow(reverseKeys(baseSettings()));
    expect(reversed.settingsDigest).toBe(forward.settingsDigest);
    expect(textOf(encodedOrThrow(reversed))).toBe(textOf(encodedOrThrow(forward)));
  });

  it("keeps the fixed limit table in its declared order instead of sorting it", () => {
    // CONTROL FIRST: the assertion below can only distinguish "declared" from
    // "sorted" if the two differ. If the vocabulary ever became alphabetical
    // this test would be vacuous, so that possibility is pinned as red.
    const declared = [...PROJECT_CONFIGURATION_LIMIT_KEYS];
    expect(declared).not.toEqual([...declared].sort());

    const text = textOf(encodedOrThrow(createdOrThrow()));
    const emitted = [...text.matchAll(/"key":"([A-Za-z]+)"/gu)].map((match) => match[1]);
    expect(emitted).toEqual(declared);
  });

  it("emits every object key in sorted order in the canonical bytes", () => {
    const text = textOf(encodedOrThrow(createdOrThrow()));
    expect(text.startsWith('{"projectId":"project-alpha","schemaVersion":')).toBe(true);
    expect(text.endsWith('"}')).toBe(true);
    expect(text.indexOf('"settings":')).toBeLessThan(text.indexOf('"settingsDigest":'));
    expect(text).toContain('{"key":"providerSlotsPerProject","value":1}');
  });
});

/**
 * The canonical settings body, sliced out of PRODUCTION's own manifest bytes.
 * Reconstructing it here instead would reimplement the canonicalizer and make
 * every assertion below agree with itself rather than with the codec.
 */
const settingsBodyOf = (bytes: Uint8Array): Buffer => {
  const text = textOf(bytes);
  const marker = '"settings":';
  const start = text.indexOf(marker) + marker.length;
  const end = text.lastIndexOf(',"settingsDigest":');
  expect(start).toBeGreaterThan(marker.length - 1);
  expect(end).toBeGreaterThan(start);
  return Buffer.from(text.slice(start, end), "utf8");
};

const taggedDigest = (tag: string, body: Buffer): string =>
  createHash("sha256").update(tag, "utf8").update(Buffer.from([0])).update(body).digest("hex");

describe("settings digest domain separation and exclusion", () => {
  it("derives the digest from the production domain tag over the canonical body", () => {
    const manifest = createdOrThrow();
    const body = settingsBodyOf(encodedOrThrow(manifest));
    expect(taggedDigest(PROJECT_CONFIGURATION_SETTINGS_DIGEST_DOMAIN, body))
      .toBe(manifest.settingsDigest);
  });

  it("yields a different digest for the same body under a different domain tag", () => {
    const manifest = createdOrThrow();
    const body = settingsBodyOf(encodedOrThrow(manifest));
    expect(taggedDigest("moe-project-configuration-other/1", body))
      .not.toBe(manifest.settingsDigest);
  });

  it("excludes settingsDigest from its own preimage yet refuses a forged one", () => {
    const manifest = createdOrThrow();
    const text = textOf(encodedOrThrow(manifest));
    const forge = (digest: string): Uint8Array =>
      bytesOf(text.replace(/"settingsDigest":"[0-9a-f]{64}"\}$/u, `"settingsDigest":"${digest}"}`));

    // POSITIVE CONTROL: the surgery itself produces decodable canonical bytes,
    // so the refusal below is the forged VALUE and not the forging method.
    const control: ProjectConfigurationManifestDecodeResult =
      decodeProjectConfigurationManifestBytes(forge(manifest.settingsDigest));
    expect(control.ok).toBe(true);

    // The recomputed digest is unchanged, because settingsDigest lives on the
    // manifest and is structurally absent from the settings that are hashed.
    expect(createdOrThrow().settingsDigest).toBe(manifest.settingsDigest);

    const forged: ProjectConfigurationManifestDecodeResult =
      decodeProjectConfigurationManifestBytes(forge(hex("9")));
    expect(forged.ok).toBe(false);
    if (forged.ok) throw new Error("expected a refusal");
    const refusal: ProjectConfigurationCodecRefusal = forged;
    expect([refusal.code, refusal.layer, refusal.upstream])
      .toEqual(["PROJECT_CONFIGURATION_DIGEST_MISMATCH", "PROJECT_CONFIGURATION_DIGEST", null]);
  });
});

const deeplyFrozen = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value)
    .every((key) => deeplyFrozen((value as Record<PropertyKey, unknown>)[key]));
};

describe("codec result immutability and caller detachment", () => {
  it("freezes the created manifest all the way down", () => {
    expect(deeplyFrozen(createdOrThrow())).toBe(true);
  });

  it("detaches the created manifest from the caller's input at every depth", () => {
    const input = baseSettings();
    const manifest = createdOrThrow(input);
    (input["policy"] as Record<string, unknown>)["revision"] = 9_999;
    (input["limits"] as { value: number }[])[0]!.value = 9_999;
    expect(manifest.settings.policy.revision).toBe(3);
    expect(manifest.settings.limits[0]?.value).toBe(1);
  });

  it("hands out encoded bytes the caller cannot use to corrupt a later encode", () => {
    const manifest = createdOrThrow();
    const first = encodedOrThrow(manifest);
    const pristine = textOf(first);
    first[0] = 0x20;
    expect(textOf(encodedOrThrow(manifest))).toBe(pristine);
  });

  it("freezes the decoded manifest all the way down", () => {
    const manifest = createdOrThrow();
    const decoded: ProjectConfigurationManifestDecodeResult =
      decodeProjectConfigurationManifestBytes(encodedOrThrow(manifest));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected a decoded manifest");
    expect(deeplyFrozen(decoded.manifest)).toBe(true);
    expect(decoded.manifest.settingsDigest).toBe(manifest.settingsDigest);
  });
});

const DEEP_JSON_BYTES = bytesOf(`${"[".repeat(70)}1${"]".repeat(70)}`);

/** Hostile inputs, one per entry point, that must all REFUSE rather than throw. */
const HOSTILE_CASES: readonly (readonly [string, () => unknown])[] = [
  ["decode/not-bytes", () => decodeProjectConfigurationManifestBytes("{}")],
  ["decode/null", () => decodeProjectConfigurationManifestBytes(null)],
  ["decode/proxy-bytes", () => decodeProjectConfigurationManifestBytes(new Proxy(bytesOf("{}"), {}))],
  ["decode/empty", () => decodeProjectConfigurationManifestBytes(bytesOf(""))],
  ["decode/syntax", () => decodeProjectConfigurationManifestBytes(bytesOf("not json"))],
  ["decode/depth", () => decodeProjectConfigurationManifestBytes(DEEP_JSON_BYTES)],
  ["decode/array-root", () => decodeProjectConfigurationManifestBytes(bytesOf("[]"))],
  ["encode/undefined", () => encodeProjectConfigurationManifest(undefined)],
  ["encode/proxy", () => encodeProjectConfigurationManifest(new Proxy({}, {}))],
  ["create/null-settings", () => createProjectConfigurationManifest(PROJECT_ID, null)],
  ["create/bad-project-id", () => createProjectConfigurationManifest("../x", baseSettings())],
];

describe("codec refusals over hostile bytes", () => {
  it("generated the hostile case table it sweeps", () => {
    expect(HOSTILE_CASES.length).toBe(11);
  });

  it.each(HOSTILE_CASES)("refuses %s without throwing", (_label, run) => {
    const result = run() as { readonly ok: boolean };
    expect(result.ok).toBe(false);
  });

  it("pins BYTES_INVALID at the codec layer for undecodable bytes", () => {
    for (const bytes of [bytesOf("not json"), bytesOf(""), DEEP_JSON_BYTES]) {
      const result = decodeProjectConfigurationManifestBytes(bytes);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect([result.code, result.layer, result.upstream])
        .toEqual(["PROJECT_CONFIGURATION_BYTES_INVALID", "PROJECT_CONFIGURATION_CODEC", null]);
    }
  });

  it("pins DUPLICATE_KEY, which JSON.parse would have silently swallowed", () => {
    const text = textOf(encodedOrThrow(createdOrThrow()));
    const duplicated = text.replace('{"projectId":', '{"projectId":"project-shadow","projectId":');

    // CONTROL: the forged bytes are otherwise well-formed JSON, and JSON.parse
    // accepts them while keeping only the LAST duplicate. That is exactly the
    // provenance decodeBoundedJsonBytes preserves and JSON.parse destroys, so
    // this pins COMPOSITION rather than merely "decoding failed".
    expect((JSON.parse(duplicated) as { projectId: string }).projectId).toBe(PROJECT_ID);

    const result = decodeProjectConfigurationManifestBytes(bytesOf(duplicated));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect([result.code, result.layer, result.upstream])
      .toEqual(["PROJECT_CONFIGURATION_DUPLICATE_KEY", "PROJECT_CONFIGURATION_CODEC", null]);
  });

  it("pins NONCANONICAL for reordered keys, added whitespace and a respelled number", () => {
    const text = textOf(encodedOrThrow(createdOrThrow()));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const reordered = JSON.stringify({
      settingsDigest: parsed["settingsDigest"], settings: parsed["settings"],
      schemaVersion: parsed["schemaVersion"], projectId: parsed["projectId"],
    });
    const spaced = text.replace('{"projectId"', '{ "projectId"');
    const respelled = text.replace(
      '{"key":"providerSlotsPerProject","value":1}',
      '{"key":"providerSlotsPerProject","value":1.0}',
    );
    // Each spelling must actually differ from the canonical bytes, or the case
    // would be asserting the canonical form against itself.
    expect([reordered, spaced, respelled].filter((variant) => variant !== text).length).toBe(3);

    for (const variant of [reordered, spaced, respelled]) {
      const result = decodeProjectConfigurationManifestBytes(bytesOf(variant));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect([result.code, result.layer, result.upstream]).toEqual([
        "PROJECT_CONFIGURATION_NONCANONICAL", "PROJECT_CONFIGURATION_CANONICALIZATION", null,
      ]);
    }
  });

  it("pins DIGEST_MISMATCH when encoding a manifest whose digest was swapped", () => {
    const manifest = createdOrThrow();
    const result = encodeProjectConfigurationManifest({ ...manifest, settingsDigest: hex("7") });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect([result.code, result.layer, result.upstream])
      .toEqual(["PROJECT_CONFIGURATION_DIGEST_MISMATCH", "PROJECT_CONFIGURATION_DIGEST", null]);
  });
});

describe("upstream contract refusals forwarded verbatim", () => {
  it("forwards VERSION_UNSUPPORTED rather than re-coding it as a codec code", () => {
    const text = textOf(encodedOrThrow(createdOrThrow()));
    const bumped = text.replace(
      `"schemaVersion":"${PROJECT_CONFIGURATION_SCHEMA_VERSION}"`,
      '"schemaVersion":"moe-project-configuration/2"',
    );
    expect(bumped).not.toBe(text);
    const result = decodeProjectConfigurationManifestBytes(bytesOf(bumped));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect([result.code, result.layer]).toEqual([
      "PROJECT_CONFIGURATION_VERSION_UNSUPPORTED", "PROJECT_CONFIGURATION_MANIFEST",
    ]);
    expect(result.upstream).toBe(PROJECT_CONFIGURATION_VERSION_UNSUPPORTED);
  });

  it("forwards INPUT_INVALID for an extra manifest key found in the bytes", () => {
    const text = textOf(encodedOrThrow(createdOrThrow()));
    const extra = text.replace('{"projectId":', '{"extra":1,"projectId":');
    const result = decodeProjectConfigurationManifestBytes(bytesOf(extra));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect([result.code, result.layer]).toEqual([
      "PROJECT_CONFIGURATION_INPUT_INVALID", "PROJECT_CONFIGURATION_MANIFEST",
    ]);
    expect(result.upstream).toBe(PROJECT_CONFIGURATION_INPUT_INVALID);
  });

  it.each([
    ["accessor", (): unknown => {
      const record: Record<string, unknown> = { ...baseSettings() };
      Object.defineProperty(record, "policy", { get: () => ({}), enumerable: true });
      return record;
    }],
    ["symbol-key", (): unknown => ({ ...baseSettings(), [Symbol("hidden")]: 1 })],
    ["proxy", (): unknown => new Proxy(baseSettings(), {})],
    ["sparse-limits", (): unknown => {
      const record = baseSettings();
      const limits = record["limits"] as unknown[];
      delete limits[0];
      return record;
    }],
    ["extra-key", (): unknown => ({ ...baseSettings(), extra: 1 })],
  ])("forwards INPUT_INVALID verbatim for a %s settings payload", (_label, build) => {
    const result = createProjectConfigurationManifest(PROJECT_ID, build());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect([result.code, result.layer]).toEqual([
      "PROJECT_CONFIGURATION_INPUT_INVALID", "PROJECT_CONFIGURATION_MANIFEST",
    ]);
    expect(result.upstream).toBe(PROJECT_CONFIGURATION_INPUT_INVALID);
  });
});

interface SettingsLeaf {
  readonly path: readonly (string | number)[];
  readonly valid: unknown;
  readonly validAlso?: { readonly path: readonly (string | number)[]; readonly value: unknown };
  readonly invalid: unknown;
}

function applyAt(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
  let cursor: Record<string | number, unknown> = root;
  for (const segment of path.slice(0, -1)) {
    cursor = cursor[segment] as Record<string | number, unknown>;
  }
  cursor[path[path.length - 1] as string | number] = value;
}

const withLeaf = (leaf: SettingsLeaf, value: unknown, also = false): Record<string, unknown> => {
  const clone = structuredClone(baseSettings());
  applyAt(clone, leaf.path, value);
  if (also && leaf.validAlso) applyAt(clone, leaf.validAlso.path, leaf.validAlso.value);
  return clone;
};

/**
 * HAND-ENUMERATED, deliberately not walked off the fixture or off the codec's
 * own preimage: a list derived from the subject agrees with the subject by
 * construction and would keep passing after a field silently left the hash.
 * 23 named leaves below plus the 30 positional limit values = 53.
 */
const NAMED_LEAVES: readonly SettingsLeaf[] = [
  { path: ["isolation", "hostContainment"], valid: "SANDBOX_ENFORCED", invalid: "NOT_A_MODE" },
  { path: ["isolation", "workspace"], valid: "SHARED_CHECKOUT", invalid: "NOT_A_WORKSPACE" },
  { path: ["network", "daemonExposure"], valid: "REVIEWED_AUTHENTICATED_NON_LOOPBACK", invalid: "PUBLIC" },
  { path: ["network", "providerEgress"], valid: "EGRESS_DENIED", invalid: "EGRESS_MAYBE" },
  {
    path: ["orchestrationSource", "objectFormat"], valid: "sha1", invalid: "sha512",
    // Coupled on purpose: the sha width is decided by the format, so the only
    // VALID spelling of this leaf carries the matching sourceSha with it.
    validAlso: { path: ["orchestrationSource", "sourceSha"], value: "3".repeat(40) },
  },
  { path: ["orchestrationSource", "sourceSha"], valid: hex("4"), invalid: `zz${"4".repeat(62)}` },
  { path: ["policy", "acceptanceGate"], valid: "MANUAL_HUMAN_APPROVAL", invalid: "AUTO" },
  { path: ["policy", "autoApprovalOptInDigest"], valid: hex("5"), invalid: "not-a-digest" },
  { path: ["policy", "evaluatorVersion"], valid: "policy-evaluator-v2", invalid: "" },
  { path: ["policy", "expansionGate"], valid: "MANUAL_HUMAN_APPROVAL", invalid: "AUTO" },
  { path: ["policy", "planningGate"], valid: "MANUAL_HUMAN_APPROVAL", invalid: "AUTO" },
  { path: ["policy", "policyRevisionId"], valid: "policy-revision-8", invalid: "../escape" },
  { path: ["policy", "revision"], valid: 4, invalid: -1 },
  { path: ["schemaVersions", "commandSchemaVersion"], valid: "moe-command/2", invalid: "" },
  { path: ["schemaVersions", "errorSchemaVersion"], valid: "moe-error/2", invalid: "" },
  { path: ["schemaVersions", "querySchemaVersion"], valid: "moe-query/2", invalid: "" },
  { path: ["selection", "modelRef"], valid: "model-2", invalid: "model/2" },
  { path: ["selection", "profileRef"], valid: "profile-2", invalid: "profile/2" },
  { path: ["selection", "providerRef"], valid: "provider-2", invalid: "provider/2" },
  { path: ["selection", "reasoningEffortRef"], valid: "effort-2", invalid: "effort/2" },
  { path: ["selection", "runtimeRef"], valid: "runtime-2", invalid: "runtime/2" },
  { path: ["selection", "snapshotRef"], valid: "snapshot-2", invalid: "snapshot/2" },
  { path: ["selection", "structuredOutputSchemaRef"], valid: "schema-2", invalid: "schema/2" },
];

/** The 30 positional limit slots, written out rather than counted from a length. */
const LIMIT_INDICES: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
];

const SETTINGS_LEAVES: readonly SettingsLeaf[] = [
  ...NAMED_LEAVES,
  ...LIMIT_INDICES.map((index) => ({
    path: ["limits", index, "value"] as const, valid: 9_001, invalid: -1,
  })),
];

const leafLabel = (leaf: SettingsLeaf): string => leaf.path.join(".");

describe("settings digest sensitivity sweep", () => {
  it("enumerates every settings leaf, with the count pinned by hand", () => {
    expect(NAMED_LEAVES.length).toBe(23);
    expect(LIMIT_INDICES.length).toBe(30);
    expect(SETTINGS_LEAVES.length).toBe(53);
    // The hand-written slot list must still cover the production vocabulary; a
    // vocabulary that grew would otherwise leave silently unswept slots.
    expect(LIMIT_INDICES.length).toBe(PROJECT_CONFIGURATION_LIMIT_KEYS.length);
    expect(new Set(SETTINGS_LEAVES.map(leafLabel)).size).toBe(53);
  });

  it.each(SETTINGS_LEAVES.map((leaf) => [leafLabel(leaf), leaf] as const))(
    "changes the settings digest when %s takes a different valid value",
    (_label, leaf) => {
      const baseline = createdOrThrow().settingsDigest;
      const mutated = createdOrThrow(withLeaf(leaf, leaf.valid, true));
      expect(mutated.settingsDigest).not.toBe(baseline);
    },
  );

  it.each(SETTINGS_LEAVES.map((leaf) => [leafLabel(leaf), leaf] as const))(
    "refuses %s with the contract's own code when the value is invalid",
    (_label, leaf) => {
      const result = createProjectConfigurationManifest(PROJECT_ID, withLeaf(leaf, leaf.invalid));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect([result.code, result.layer]).toEqual([
        "PROJECT_CONFIGURATION_INPUT_INVALID", "PROJECT_CONFIGURATION_MANIFEST",
      ]);
      expect(result.upstream).toBe(PROJECT_CONFIGURATION_INPUT_INVALID);
    },
  );
});

/**
 * A genuine Uint8Array subclass — so the bounded decoder's internal-slot brand
 * checks all pass — whose `Symbol.species` is armed. `%TypedArray%.slice`
 * consults species and would run this getter; a snapshot taken that way both
 * throws for this caller and, for a species returning a longer buffer, would
 * compare canonical bytes against something other than what was decoded.
 */
class SpeciesTrapBytes extends Uint8Array {
  static get [Symbol.species](): typeof Uint8Array {
    throw new Error("species trap");
  }
}

describe("caller-controlled byte views", () => {
  it("snapshots caller bytes without consulting Symbol.species", () => {
    const manifest = createdOrThrow();
    const canonical = encodedOrThrow(manifest);
    const trapped = new SpeciesTrapBytes(canonical.length);
    trapped.set(canonical);

    // CONTROL: the trap is really armed, so a green result below means the
    // species was not consulted rather than that the fixture was inert.
    expect(() => Uint8Array.prototype.slice.call(trapped)).toThrow("species trap");

    const decoded = decodeProjectConfigurationManifestBytes(trapped);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected a decoded manifest");
    expect(decoded.manifest.settingsDigest).toBe(manifest.settingsDigest);
  });
});
