import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as contracts from "@moe/contracts";
import {
  PROJECT_CONFIGURATION_EGRESS_POLICIES,
  PROJECT_CONFIGURATION_EXPOSURE_POLICIES,
  PROJECT_CONFIGURATION_GATE_MODES,
  PROJECT_CONFIGURATION_HOST_CONTAINMENTS,
  PROJECT_CONFIGURATION_INPUT_INVALID,
  PROJECT_CONFIGURATION_LIMIT_KEYS,
  PROJECT_CONFIGURATION_REFUSAL_CODES,
  PROJECT_CONFIGURATION_REFUSAL_LAYERS,
  PROJECT_CONFIGURATION_SCHEMA_VERSION,
  PROJECT_CONFIGURATION_VERSION_UNSUPPORTED,
  PROJECT_CONFIGURATION_WORKSPACE_ISOLATIONS,
  parseProjectConfigurationManifest,
  parseProjectConfigurationSettings,
} from "@moe/contracts";
import type {
  ProjectConfigurationManifest,
  ProjectConfigurationSettings,
} from "@moe/contracts";

import {
  EXPECTED_EGRESS_POLICIES,
  EXPECTED_EXPOSURE_POLICIES,
  EXPECTED_GATE_MODES,
  EXPECTED_HOST_CONTAINMENTS,
  EXPECTED_LIMIT_KEYS,
  EXPECTED_LIMIT_KEY_COUNT,
  EXPECTED_REFUSAL_CODES,
  EXPECTED_REFUSAL_LAYERS,
  EXPECTED_SCHEMA_VERSION,
  EXPECTED_WORKSPACE_ISOLATIONS,
  HOSTILE_REFS,
  LEGITIMATE_REFS,
  validManifestInput,
  validSettingsInput,
} from "./project-configuration.test-fixtures.js";

function expectSettings(value: unknown): ProjectConfigurationSettings {
  const result = parseProjectConfigurationSettings(value);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.settings;
}

function expectManifest(value: unknown): ProjectConfigurationManifest {
  const result = parseProjectConfigurationManifest(value);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.manifest;
}

/** Every node of a value graph, so freezing and identity are checked at EVERY depth. */
function collectObjects(value: unknown, seen: object[] = []): object[] {
  if (value === null || typeof value !== "object") return seen;
  seen.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectObjects(child, seen);
  }
  return seen;
}

describe("project configuration vocabulary", () => {
  it("publishes the 30 design limit keys in design order", () => {
    expect([...PROJECT_CONFIGURATION_LIMIT_KEYS]).toEqual([...EXPECTED_LIMIT_KEYS]);
    expect(PROJECT_CONFIGURATION_LIMIT_KEYS).toHaveLength(EXPECTED_LIMIT_KEY_COUNT);
    expect(EXPECTED_LIMIT_KEYS).toHaveLength(EXPECTED_LIMIT_KEY_COUNT);
  });

  it.each([
    ["limit keys", PROJECT_CONFIGURATION_LIMIT_KEYS, EXPECTED_LIMIT_KEYS],
    ["gate modes", PROJECT_CONFIGURATION_GATE_MODES, EXPECTED_GATE_MODES],
    ["egress policies", PROJECT_CONFIGURATION_EGRESS_POLICIES, EXPECTED_EGRESS_POLICIES],
    ["exposure policies", PROJECT_CONFIGURATION_EXPOSURE_POLICIES, EXPECTED_EXPOSURE_POLICIES],
    ["workspace isolations", PROJECT_CONFIGURATION_WORKSPACE_ISOLATIONS,
      EXPECTED_WORKSPACE_ISOLATIONS],
    ["host containments", PROJECT_CONFIGURATION_HOST_CONTAINMENTS, EXPECTED_HOST_CONTAINMENTS],
    ["refusal codes", PROJECT_CONFIGURATION_REFUSAL_CODES, EXPECTED_REFUSAL_CODES],
    ["refusal layers", PROJECT_CONFIGURATION_REFUSAL_LAYERS, EXPECTED_REFUSAL_LAYERS],
  ])("%s equal the hand-written list, frozen and duplicate-free", (_label, actual, expected) => {
    expect([...actual]).toEqual([...expected]);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("pins the schema version literal", () => {
    expect(PROJECT_CONFIGURATION_SCHEMA_VERSION).toBe(EXPECTED_SCHEMA_VERSION);
  });
});

describe("every configuration symbol is reachable as a RUNTIME value from the root", () => {
  it.each([
    ["PROJECT_CONFIGURATION_LIMIT_KEYS", "object"],
    ["PROJECT_CONFIGURATION_GATE_MODES", "object"],
    ["PROJECT_CONFIGURATION_EGRESS_POLICIES", "object"],
    ["PROJECT_CONFIGURATION_EXPOSURE_POLICIES", "object"],
    ["PROJECT_CONFIGURATION_WORKSPACE_ISOLATIONS", "object"],
    ["PROJECT_CONFIGURATION_HOST_CONTAINMENTS", "object"],
    ["PROJECT_CONFIGURATION_REFUSAL_CODES", "object"],
    ["PROJECT_CONFIGURATION_REFUSAL_LAYERS", "object"],
    ["PROJECT_CONFIGURATION_INPUT_INVALID", "object"],
    ["PROJECT_CONFIGURATION_VERSION_UNSUPPORTED", "object"],
    ["PROJECT_CONFIGURATION_SCHEMA_VERSION", "string"],
    ["PROJECT_CONFIGURATION_MAX_REF_CHARS", "number"],
    ["PROJECT_CONFIGURATION_MAX_TEXT_CHARS", "number"],
    ["isBoundedText", "function"],
    ["isLogicalRef", "function"],
    ["parseProjectConfigurationSettings", "function"],
    ["parseProjectConfigurationManifest", "function"],
  ])("publishes %s as a %s", (name, kind) => {
    expect(typeof (contracts as Record<string, unknown>)[name]).toBe(kind);
  });

  it("negative control: a type-only name is erased and a typo resolves to nothing", () => {
    expect((contracts as Record<string, unknown>)["ProjectConfigurationSettings"])
      .toBeUndefined();
    expect((contracts as Record<string, unknown>)["PROJECT_CONFIGURATION_LIMIT_KEY"])
      .toBeUndefined();
  });

  it("both module-constant refusals are frozen and carry nothing observed", () => {
    for (const refusal of [
      PROJECT_CONFIGURATION_INPUT_INVALID, PROJECT_CONFIGURATION_VERSION_UNSUPPORTED,
    ]) {
      expect(Object.isFrozen(refusal)).toBe(true);
      expect(Object.keys(refusal).sort()).toEqual(["code", "layer", "ok"]);
      expect(refusal.ok).toBe(false);
      expect(refusal.layer).toBe("PROJECT_CONFIGURATION_MANIFEST");
    }
    expect(PROJECT_CONFIGURATION_INPUT_INVALID.code)
      .toBe("PROJECT_CONFIGURATION_INPUT_INVALID");
    expect(PROJECT_CONFIGURATION_VERSION_UNSUPPORTED.code)
      .toBe("PROJECT_CONFIGURATION_VERSION_UNSUPPORTED");
  });
});

describe("project configuration accepts a valid input without normalizing it", () => {
  it("returns a settings snapshot equal to the input value-for-value", () => {
    const input = validSettingsInput();
    const settings = expectSettings(input);
    expect(settings).toEqual(input);
  });

  it("returns a manifest snapshot equal to the input value-for-value", () => {
    const input = validManifestInput();
    expect(expectManifest(input)).toEqual(input);
  });

  it("keeps every accepted string identical — no trim, case fold or coercion", () => {
    const input = validManifestInput();
    const manifest = expectManifest(input);
    const source = input["settings"] as Record<string, Record<string, string>>;
    for (const [key, ref] of Object.entries(manifest.settings.selection)) {
      expect(ref).toBe(source["selection"]?.[key]);
    }
    expect(manifest.projectId).toBe(input["projectId"]);
    expect(manifest.settingsDigest).toBe(input["settingsDigest"]);
  });

  it("preserves the ordered limit table positionally, value 0 included", () => {
    const settings = expectSettings(validSettingsInput());
    expect(settings.limits.map((entry) => entry.key)).toEqual([...EXPECTED_LIMIT_KEYS]);
    expect(settings.limits.map((entry) => entry.value))
      .toEqual(EXPECTED_LIMIT_KEYS.map((_key, index) => index));
  });

  it("deep-freezes the snapshot at every depth", () => {
    const nodes = collectObjects(expectManifest(validManifestInput()));
    expect(nodes.length).toBeGreaterThan(EXPECTED_LIMIT_KEY_COUNT);
    for (const node of nodes) expect(Object.isFrozen(node)).toBe(true);
  });

  it("shares no object identity with the input at any depth", () => {
    const input = validManifestInput();
    const inputNodes = new Set(collectObjects(input));
    for (const node of collectObjects(expectManifest(input))) {
      expect(inputNodes.has(node)).toBe(false);
    }
  });

  it("leaves the caller's input unfrozen and its descriptors untouched", () => {
    const input = validManifestInput();
    const before = collectObjects(input);
    const descriptorsBefore = before.map((node) => Object.getOwnPropertyDescriptors(node));
    expectManifest(input);
    for (const [index, node] of before.entries()) {
      expect(Object.isFrozen(node)).toBe(false);
      expect(Object.getOwnPropertyDescriptors(node)).toEqual(descriptorsBefore[index]);
    }
  });
});

describe("logical refs never carry a filesystem or URI spelling", () => {
  it.each(HOSTILE_REFS)("refuses a %s ref", (_label, ref) => {
    const input = validSettingsInput();
    (input["selection"] as Record<string, unknown>)["modelRef"] = ref;
    const result = parseProjectConfigurationSettings(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROJECT_CONFIGURATION_INPUT_INVALID");
    expect(result.layer).toBe("PROJECT_CONFIGURATION_MANIFEST");
  });

  it("generated the whole hostile ref table", () => {
    expect(HOSTILE_REFS).toHaveLength(17);
  });

  it.each(LEGITIMATE_REFS)("accepts the legitimate ref %s", (ref) => {
    const input = validSettingsInput();
    (input["selection"] as Record<string, unknown>)["modelRef"] = ref;
    expect(expectSettings(input).selection.modelRef).toBe(ref);
  });

  it("generated the whole positive-control ref table", () => {
    expect(LEGITIMATE_REFS).toHaveLength(8);
  });
});

describe("the configuration sources stay browser-loadable", () => {
  it.each(["project-configuration-contract.ts", "project-configuration-parser.ts"])(
    "%s carries no node: specifier",
    async (name) => {
      const source = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/["']node:/);
    },
  );

  it("positive control: the same regex does match a genuine builtin import", async () => {
    const source = await readFile(
      new URL("../runtime/runtime-entrypoint-smoke-worker.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/["']node:/);
    expect(source).toContain('import { parentPort } from "node:worker_threads";');
  });
});
