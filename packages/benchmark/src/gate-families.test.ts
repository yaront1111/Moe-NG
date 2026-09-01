import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMPOSITE_SCRIPTS,
  EXCLUDED_SCRIPTS,
  GATE_FAMILIES,
} from "./gate-families.js";

const EXPECTED_FAMILY_IDS = Object.freeze([
  "repository",
  "property",
  "fault",
  "security",
  "migration",
  "integration",
  "e2e",
  "packaging",
  "benchmark",
  "independent-review",
] as const);

function findRepoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const marker = join(current, "pnpm-workspace.yaml");
    if (existsSync(marker) && statSync(marker).isFile()) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("repo root not found: no pnpm-workspace.yaml above this file");
    }
    current = parent;
  }
}

function readRootScripts(repoRoot: string): readonly string[] {
  const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    throw new Error("root package.json has no scripts object");
  }
  const scripts = parsed.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error("root package.json has no scripts object");
  }
  if (Object.values(scripts).some((value) => typeof value !== "string")) {
    throw new Error("root package.json has a non-string script");
  }
  return Object.keys(scripts);
}

function classifiedScripts(): ReadonlySet<string> {
  const scripts = new Set(GATE_FAMILIES.flatMap(({ commands }) => commands));
  for (const composite of COMPOSITE_SCRIPTS) scripts.add(composite.script);
  for (const excluded of EXCLUDED_SCRIPTS) scripts.add(excluded.script);
  return scripts;
}

interface WorkspaceManifest {
  readonly name?: string;
  readonly path: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

function workspaceManifests(repoRoot: string): readonly WorkspaceManifest[] {
  const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const patterns = workspace.split("\n").flatMap((line) => {
    const match = /^\s*-\s+([^#\s]+)\s*(?:#.*)?$/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  const manifests: WorkspaceManifest[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) throw new Error(`unsupported workspace pattern: ${pattern}`);
    const areaPath = join(repoRoot, ...pattern.slice(0, -2).split("/"));
    if (!existsSync(areaPath)) continue;
    for (const entry of readdirSync(areaPath)) {
      const manifestPath = join(areaPath, entry, "package.json");
      if (!existsSync(manifestPath)) continue;
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        readonly name?: string;
        readonly scripts?: Readonly<Record<string, string>>;
      };
      manifests.push({ ...parsed, path: manifestPath });
    }
  }
  return manifests;
}

describe("repository gate-family roster", () => {
  it("freezes exactly the ten consumer gate families in order", () => {
    const actualIds = GATE_FAMILIES.map(({ id }) => id);
    expect(Object.isFrozen(GATE_FAMILIES)).toBe(true);
    expect(GATE_FAMILIES).toHaveLength(10);
    expect(actualIds).toEqual(EXPECTED_FAMILY_IDS);
    expect(new Set(actualIds)).toEqual(new Set(EXPECTED_FAMILY_IDS));
    expect(new Set(EXPECTED_FAMILY_IDS)).toEqual(new Set(actualIds));
  });

  it("freezes each executable family and its independent-review exception", () => {
    for (const family of GATE_FAMILIES) {
      expect(Object.isFrozen(family)).toBe(true);
      expect(Object.isFrozen(family.commands)).toBe(true);
      if (family.id === "independent-review") {
        expect(family).toMatchObject({
          command: null,
          commands: [],
          packageLeg: null,
          packageScript: null,
        });
        expect(family.reason.trim().length).toBeGreaterThan(0);
      } else {
        expect(family.commands.length > 0 || family.packageLeg !== null).toBe(true);
        expect(family.packageLeg === null).toBe(family.packageScript === null);
      }
    }
  });

  it("freezes explicit composite and non-gate script classifications", () => {
    expect(Object.isFrozen(COMPOSITE_SCRIPTS)).toBe(true);
    expect(COMPOSITE_SCRIPTS).toHaveLength(4);
    expect(COMPOSITE_SCRIPTS.map(({ script }) => script)).toEqual([
      "verify:foundation",
      "verify:store",
      "verify:release",
      "test:integration",
    ]);
    for (const composite of COMPOSITE_SCRIPTS) {
      expect(Object.isFrozen(composite)).toBe(true);
      expect(Object.isFrozen(composite.composes)).toBe(true);
      expect(composite.composes.length).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(EXCLUDED_SCRIPTS)).toBe(true);
    expect(EXCLUDED_SCRIPTS).toHaveLength(2);
    expect(EXCLUDED_SCRIPTS.map(({ script }) => script)).toEqual(["start", "seed"]);
    for (const excluded of EXCLUDED_SCRIPTS) {
      expect(Object.isFrozen(excluded)).toBe(true);
      expect(excluded.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("has no live manifest script missing from the roster", () => {
    const manifestScripts = new Set(readRootScripts(findRepoRoot()));
    const rosterScripts = classifiedScripts();
    const manifestMinusRoster = [...manifestScripts].filter((script) => !rosterScripts.has(script));

    expect(manifestMinusRoster.sort()).toEqual([]);
  });

  it("names no roster script missing from the live manifest", () => {
    const manifestScripts = new Set(readRootScripts(findRepoRoot()));
    const rosterScripts = classifiedScripts();
    const rosterMinusManifest = [...rosterScripts].filter((script) => !manifestScripts.has(script));

    expect(rosterMinusManifest.sort()).toEqual([]);
  });

  it("assigns every direct gate script to exactly one family", () => {
    const familyCommands = GATE_FAMILIES.flatMap(({ commands }) => commands);
    const counts = new Map<string, number>();
    for (const command of familyCommands) counts.set(command, (counts.get(command) ?? 0) + 1);
    const duplicateOwners = [...counts].filter(([, count]) => count !== 1);
    const compositeOnly = new Set(
      COMPOSITE_SCRIPTS.flatMap(({ script }) => counts.has(script) ? [] : [script]),
    );
    const excluded = new Set(EXCLUDED_SCRIPTS.map(({ script }) => script));
    const directGateScripts = readRootScripts(findRepoRoot()).filter(
      (script) => !compositeOnly.has(script) && !excluded.has(script),
    );

    expect(duplicateOwners).toEqual([]);
    expect(new Set(familyCommands)).toEqual(new Set(directGateScripts));
    expect(new Set(directGateScripts)).toEqual(new Set(familyCommands));
  });

  it("records only test:integration in both the family and composite roles", () => {
    const familyCommands = new Set(GATE_FAMILIES.flatMap(({ commands }) => commands));
    const compositeCommands = COMPOSITE_SCRIPTS.map(({ script }) => script);
    expect(compositeCommands.filter((script) => familyCommands.has(script))).toEqual([
      "test:integration",
    ]);
    const liveScripts = new Set(readRootScripts(findRepoRoot()));
    const missingComposedScripts = COMPOSITE_SCRIPTS.flatMap(({ composes }) => composes)
      .filter((script) => !liveScripts.has(script));
    expect(missingComposedScripts).toEqual([]);
  });

  it("keeps excluded scripts outside every gate and composite role", () => {
    const gateScripts = new Set(GATE_FAMILIES.flatMap(({ commands }) => commands));
    const compositeScripts = new Set(COMPOSITE_SCRIPTS.map(({ script }) => script));
    const overlaps = EXCLUDED_SCRIPTS.map(({ script }) => script)
      .filter((script) => gateScripts.has(script) || compositeScripts.has(script));
    expect(overlaps).toEqual([]);
  });

  it("resolves every non-root package leg to a live workspace package", () => {
    const repoRoot = findRepoRoot();
    const manifests = workspaceManifests(repoRoot);
    const packageLegs = GATE_FAMILIES.flatMap(({ packageLeg, packageScript }) =>
      packageLeg === null ? [] : [{ packageLeg, packageScript }]
    );

    expect(packageLegs).toEqual([{ packageLeg: "@moe/benchmark", packageScript: "test" }]);
    for (const { packageLeg, packageScript } of packageLegs) {
      const matches = manifests.filter(({ name }) => name === packageLeg);
      expect(matches.map(({ path }) => path)).toHaveLength(1);
      expect(packageScript).not.toBeNull();
      if (packageScript !== null) {
        expect(matches[0]?.scripts?.[packageScript]?.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
