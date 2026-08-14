import { describe, expect, it } from "vitest";

import {
  parseProjectConfigurationManifest,
  parseProjectConfigurationSettings,
} from "@moe/contracts";
import type { ProjectConfigurationRefusal } from "@moe/contracts";

import {
  DIGEST_B,
  EXPECTED_LIMIT_KEYS,
  validManifestInput,
  validSettingsInput,
} from "./project-configuration.test-fixtures.js";

type Node = Record<string, unknown>;
type Path = readonly (string | number)[];

/** Refusals carry exactly {code, layer, ok} — never a partial snapshot of the input. */
function expectRefusal(value: unknown, code: string): ProjectConfigurationRefusal {
  const result = parseProjectConfigurationManifest(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  expect(result.code).toBe(code);
  expect(result.layer).toBe("PROJECT_CONFIGURATION_MANIFEST");
  expect(Object.keys(result).sort()).toEqual(["code", "layer", "ok"]);
  expect(Object.isFrozen(result)).toBe(true);
  return result;
}

/** Replace the node at `path` in a fresh manifest input; `[]` replaces the root. */
function mutated(path: Path, transform: (node: Node) => unknown): unknown {
  const root = validManifestInput();
  if (path.length === 0) return transform(root);
  let parent = root as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) {
    parent = parent[segment] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1] as string | number;
  parent[last] = transform(parent[last] as Node);
  return root;
}

const TARGETS: readonly (readonly [string, Path])[] = [
  ["manifest", []],
  ["settings", ["settings"]],
  ["policy", ["settings", "policy"]],
  ["selection", ["settings", "selection"]],
  ["limit entry", ["settings", "limits", 0]],
  ["network", ["settings", "network"]],
  ["isolation", ["settings", "isolation"]],
  ["schema versions", ["settings", "schemaVersions"]],
  ["orchestration source", ["settings", "orchestrationSource"]],
];

const STRUCTURES: readonly (readonly [string, (node: Node) => unknown])[] = [
  ["an accessor where a data property belongs", (node) => {
    const key = Object.keys(node)[0] as string;
    const held = node[key];
    delete node[key];
    Object.defineProperty(node, key, { configurable: true, enumerable: true, get: () => held });
    return node;
  }],
  ["a transparent proxy", (node) => new Proxy(node, {})],
  ["a revoked proxy", (node) => {
    const revocable = Proxy.revocable(node, {});
    revocable.revoke();
    return revocable.proxy;
  }],
  ["an own symbol key", (node) => {
    (node as Record<symbol, unknown>)[Symbol("smuggled")] = true;
    return node;
  }],
  ["an extra own key", (node) => ({ ...node, smuggledExtraKey: true })],
  ["a missing required key", (node) => {
    delete node[Object.keys(node)[0] as string];
    return node;
  }],
  ["a custom prototype", (node) => Object.assign(Object.create({ inherited: true }), node)],
];

const STRUCTURE_CASES = TARGETS.flatMap(([target, path]) =>
  STRUCTURES.map(([label, transform]) => [`${target} carrying ${label}`, path, transform] as const),
);

describe("hostile record shapes refuse at PROJECT_CONFIGURATION_MANIFEST", () => {
  it("generated every target x structure case", () => {
    expect(TARGETS).toHaveLength(9);
    expect(STRUCTURES).toHaveLength(7);
    expect(STRUCTURE_CASES).toHaveLength(63);
  });

  it.each(STRUCTURE_CASES)("refuses %s", (_label, path, transform) => {
    expectRefusal(mutated(path, transform), "PROJECT_CONFIGURATION_INPUT_INVALID");
  });
});

const LIMIT_TABLES: readonly (readonly [string, (limits: unknown[]) => unknown])[] = [
  ["a sparse table", (limits) => { delete limits[3]; return limits; }],
  ["a duplicated entry", (limits) => [...limits, limits[0]]],
  ["a misordered table", (limits) => {
    const swapped = [...limits];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    return swapped;
  }],
  ["a table one entry short", (limits) => limits.slice(0, -1)],
  ["a table one entry long", (limits) => [...limits, { key: EXPECTED_LIMIT_KEYS[0], value: 1 }]],
  ["an empty table", () => []],
  ["a table that is not an array", () => ({ length: 30 })],
  ["a proxied table", (limits) => new Proxy(limits, {})],
];

const LIMIT_VALUES: readonly (readonly [string, unknown])[] = [
  ["a fractional value", 1.5],
  ["a negative value", -1],
  ["negative zero", -0],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ["a numeric string", "1"],
  ["a boxed number", new Number(1)],
];

describe("the ordered limit table is dense, exact and positionally bound", () => {
  it("generated every limit-table and limit-value case", () => {
    expect(LIMIT_TABLES).toHaveLength(8);
    expect(LIMIT_VALUES).toHaveLength(8);
  });

  it.each(LIMIT_TABLES)("refuses %s", (_label, transform) => {
    expectRefusal(
      mutated(["settings", "limits"], (node) => transform(node as unknown as unknown[])),
      "PROJECT_CONFIGURATION_INPUT_INVALID",
    );
  });

  it.each(LIMIT_VALUES)("refuses %s", (_label, value) => {
    expectRefusal(
      mutated(["settings", "limits", 0], (node) => ({ ...node, value })),
      "PROJECT_CONFIGURATION_INPUT_INVALID",
    );
  });

  it("refuses an entry whose key is the wrong member of the closed vocabulary", () => {
    expectRefusal(
      mutated(["settings", "limits", 0], (node) => ({ ...node, key: EXPECTED_LIMIT_KEYS[1] })),
      "PROJECT_CONFIGURATION_INPUT_INVALID",
    );
  });
});

const FIELD_CASES: readonly (readonly [string, Path, unknown])[] = [
  ["a source sha of the wrong length", ["settings", "orchestrationSource", "sourceSha"], "c".repeat(63)],
  ["an uppercase source sha", ["settings", "orchestrationSource", "sourceSha"], "C".repeat(64)],
  ["a sha1-length sha under sha256", ["settings", "orchestrationSource", "sourceSha"], "c".repeat(40)],
  ["an unsupported object format", ["settings", "orchestrationSource", "objectFormat"], "sha512"],
  ["a settings digest that is not hex64", ["settingsDigest"], "not-a-digest"],
  ["a project id carrying a path", ["projectId"], "../proj"],
  ["a negative policy revision", ["settings", "policy", "revision"], -1],
  ["a fractional policy revision", ["settings", "policy", "revision"], 2.5],
  ["a gate mode outside the closed vocabulary", ["settings", "policy", "planningGate"], "AUTO"],
  ["an egress policy outside the closed vocabulary", ["settings", "network", "providerEgress"], "OPEN"],
  ["an exposure policy outside the closed vocabulary", ["settings", "network", "daemonExposure"], "ANY"],
  ["a workspace isolation outside the closed vocabulary", ["settings", "isolation", "workspace"], "NONE"],
  ["a host containment outside the closed vocabulary", ["settings", "isolation", "hostContainment"], "FULL"],
  ["an empty command schema version", ["settings", "schemaVersions", "commandSchemaVersion"], ""],
];

describe("field values fail closed one by one", () => {
  it("generated every field case", () => {
    expect(FIELD_CASES).toHaveLength(14);
  });

  it.each(FIELD_CASES)("refuses %s", (_label, path, value) => {
    expectRefusal(mutated(path, () => value), "PROJECT_CONFIGURATION_INPUT_INVALID");
  });
});

describe("the auto-approval opt-in digest is bound to the gate modes", () => {
  it("refuses an opt-in gate with no opt-in digest", () => {
    expectRefusal(
      mutated(["settings", "policy"], (node) =>
        ({ ...node, autoApprovalOptInDigest: null, planningGate: "POLICY_AUTO_APPROVAL_OPT_IN" })),
      "PROJECT_CONFIGURATION_INPUT_INVALID",
    );
  });

  it("refuses fully manual gates carrying an opt-in digest", () => {
    expectRefusal(
      mutated(["settings", "policy"], (node) => ({ ...node, autoApprovalOptInDigest: DIGEST_B })),
      "PROJECT_CONFIGURATION_INPUT_INVALID",
    );
  });

  it("accepts an opt-in gate that carries its digest", () => {
    const input = mutated(["settings", "policy"], (node) =>
      ({ ...node, autoApprovalOptInDigest: DIGEST_B, expansionGate: "POLICY_AUTO_APPROVAL_OPT_IN" }));
    const result = parseProjectConfigurationManifest(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.settings.policy.autoApprovalOptInDigest).toBe(DIGEST_B);
  });
});

describe("the refusal order is pinned, not incidental", () => {
  it("reports VERSION_UNSUPPORTED for a well-formed record whose version is wrong", () => {
    expectRefusal(
      mutated([], (node) => ({ ...node, schemaVersion: "moe-project-configuration/2" })),
      "PROJECT_CONFIGURATION_VERSION_UNSUPPORTED",
    );
  });

  it("checks the version BEFORE the fields: a bad version wins over a bad field", () => {
    expectRefusal(
      mutated([], (node) =>
        ({ ...node, schemaVersion: "moe-project-configuration/2", settings: 42 })),
      "PROJECT_CONFIGURATION_VERSION_UNSUPPORTED",
    );
  });

  it("checks the structure BEFORE the version: an extra key wins over a bad version", () => {
    expectRefusal(
      mutated([], (node) =>
        ({ ...node, schemaVersion: "moe-project-configuration/2", smuggledExtraKey: true })),
      "PROJECT_CONFIGURATION_INPUT_INVALID",
    );
  });

  it("refuses a non-record and a missing version outright", () => {
    for (const value of [null, undefined, 42, "x", [], () => undefined]) {
      expectRefusal(value, "PROJECT_CONFIGURATION_INPUT_INVALID");
    }
  });
});

describe("the settings parser refuses independently of the manifest", () => {
  it("has no schemaVersion of its own and refuses one", () => {
    const input = { ...validSettingsInput(), schemaVersion: "moe-project-configuration/1" };
    const result = parseProjectConfigurationSettings(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROJECT_CONFIGURATION_INPUT_INVALID");
    expect(result.layer).toBe("PROJECT_CONFIGURATION_MANIFEST");
  });

  it("refuses a settings record carrying a settingsDigest", () => {
    const result = parseProjectConfigurationSettings({
      ...validSettingsInput(), settingsDigest: DIGEST_B,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROJECT_CONFIGURATION_INPUT_INVALID");
  });
});
