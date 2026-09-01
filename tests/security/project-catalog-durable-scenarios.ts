/** Real-filesystem hostile and positive controls for the atomic project catalog. */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createNodeProjectCatalogFs,
  loadProjectCatalog,
  saveProjectCatalogAtomic,
} from "../../apps/daemon/src/projects/project-catalog.js";
import type {
  ProjectCatalog,
  ProjectCatalogFsPort,
} from "../../apps/daemon/src/projects/project-catalog.js";
import { probeRacing } from "./hostile-harness.js";

const CATALOG_TEMP_ID = "11111111-1111-4111-8111-111111111111";
const EMPTY_CATALOG: ProjectCatalog = Object.freeze({
  entries: Object.freeze([]),
  schemaVersion: "moe-project-catalog/1",
});

function catalogPorts(fs: ProjectCatalogFsPort) {
  return Object.freeze({ fs, mintUuid: () => CATALOG_TEMP_ID });
}

function recordProperties(value: unknown): Readonly<{ authority: unknown; truth: unknown }> {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return { authority: record["authority"], truth: record["truth"] };
}

export async function runProjectCatalogRefusal(
  phase: "AFTER" | "BEFORE",
  root: string,
): Promise<Readonly<{
  authority: unknown;
  durableComplete: boolean;
  durableRecords: number;
  refusal: unknown;
  truth: unknown;
}>> {
  const catalogPath = join(root, "projects.json");
  const base = createNodeProjectCatalogFs();
  if (phase === "BEFORE") {
    const fs: ProjectCatalogFsPort = Object.freeze({
      ...base,
      readText: async () => { throw new Error("catalog read denied"); },
    });
    const refusal = await loadProjectCatalog(catalogPath, fs);
    return {
      ...recordProperties(refusal),
      durableComplete: (await readdir(root)).length === 0,
      durableRecords: 0,
      refusal,
    };
  }
  const original = "prior-catalog-bytes\n";
  await writeFile(catalogPath, original, "utf8");
  const fs: ProjectCatalogFsPort = Object.freeze({
    ...base,
    rename: async () => { throw new Error("atomic replace denied"); },
  });
  const refusal = await saveProjectCatalogAtomic(catalogPath, EMPTY_CATALOG, catalogPorts(fs));
  const names = await readdir(root);
  return {
    ...recordProperties(refusal),
    durableComplete: await readFile(catalogPath, "utf8") === original
      && names.filter((name) => name.endsWith(".tmp")).length === 0,
    durableRecords: names.includes("projects.json") ? 1 : 0,
    refusal,
  };
}

export async function projectCatalogRace(root: string): Promise<Readonly<{
  admittedSides: number;
  durableComplete: boolean;
  durableRecords: number;
  sides: readonly unknown[];
}>> {
  const catalogPath = join(root, "projects.json");
  const original = "prior-catalog-race-bytes\n";
  await writeFile(catalogPath, original, "utf8");
  const base = createNodeProjectCatalogFs();
  const fs: ProjectCatalogFsPort = Object.freeze({
    ...base,
    openExclusiveWrite: async () => { throw new Error("hostile writer denied"); },
  });
  const raced = await probeRacing(
    { label: "project-catalog-race", timeoutMs: 2_000 },
    async () => await saveProjectCatalogAtomic(catalogPath, EMPTY_CATALOG, catalogPorts(fs)),
    async () => await saveProjectCatalogAtomic(catalogPath, EMPTY_CATALOG, catalogPorts(fs)),
  );
  const sides = [raced.left, raced.right].map((side) =>
    side.status === "fulfilled" ? side.value : side.reason);
  const names = await readdir(root);
  return Object.freeze({
    admittedSides: sides.filter((side) =>
      typeof side === "object" && side !== null && (side as { ok?: unknown }).ok === true).length,
    durableComplete: await readFile(catalogPath, "utf8") === original
      && names.filter((name) => name.endsWith(".tmp")).length === 0,
    durableRecords: names.includes("projects.json") ? 1 : 0,
    sides: Object.freeze(sides),
  });
}

export async function projectCatalogAcceptedControl(root: string): Promise<Readonly<{
  entries: number;
  ok: boolean;
  persisted: boolean;
}>> {
  const catalogPath = join(root, "projects.json");
  const ports = catalogPorts(createNodeProjectCatalogFs());
  const saved = await saveProjectCatalogAtomic(catalogPath, EMPTY_CATALOG, ports);
  if (!saved.ok) return Object.freeze({ entries: 0, ok: false, persisted: false });
  const loaded = await loadProjectCatalog(catalogPath, ports.fs);
  return Object.freeze({
    entries: loaded.ok ? loaded.catalog.entries.length : -1,
    ok: loaded.ok,
    persisted: (await readdir(root)).filter((name) => name === "projects.json").length === 1,
  });
}
