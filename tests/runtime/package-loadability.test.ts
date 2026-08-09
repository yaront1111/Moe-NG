import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  type AllowedPackageFailure,
  discoverWorkspacePackages,
  expandWorkspacePattern,
  formatObservation,
  hasRuntimeEntry,
  mapWithConcurrency,
  observeWorkspacePackage,
  observationIssues,
  probeRuntimeEntry,
  readWorkspacePatterns,
  runtimeProbeMarker,
  workspacePackageDirectoriesOnDisk,
} from "./package-loadability-support.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const noRuntimeEntryReasons: Readonly<Record<string, string>> = Object.freeze({
  "@moe/control-room": "browser-only Vite application; no Node entry by design",
});
const allowedPackageFailures: Readonly<Record<string, AllowedPackageFailure>> = Object.freeze({});

it("discovers every workspace package manifest from pnpm-workspace.yaml", async () => {
  const discovered = await discoverWorkspacePackages(repositoryRoot);
  const directoriesOnDisk = await workspacePackageDirectoriesOnDisk(repositoryRoot);

  expect(discovered.length).toBeGreaterThan(0);
  expect(discovered.map(({ directory }) => directory)).toEqual(directoriesOnDisk);
  expect(new Set(discovered.map(({ name }) => name)).size).toBe(discovered.length);
});

it("tolerates a workspace glob whose base directory is absent", async () => {
  const patterns = await readWorkspacePatterns(repositoryRoot);

  expect(patterns).toContain("adapters/*");
  await expect(expandWorkspacePattern(repositoryRoot, "adapters/*")).resolves.toEqual([]);
});

it("classifies a declared missing entry with a stable actionable code", async () => {
  const root = await mkdtemp(join(tmpdir(), "moe-runtime-loadability-"));
  try {
    const goodDirectory = resolve(root, "packages/good");
    const missingDirectory = resolve(root, "packages/missing");
    await Promise.all([
      mkdir(resolve(goodDirectory, "src"), { recursive: true }),
      mkdir(missingDirectory, { recursive: true }),
    ]);
    await writeFile(resolve(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
    await Promise.all([
      writeFile(resolve(goodDirectory, "package.json"), JSON.stringify({
        exports: { ".": "./src/index.ts" }, name: "@fixture/good",
      }), "utf8"),
      writeFile(resolve(goodDirectory, "src/index.ts"), "export const ready = true;\n", "utf8"),
      writeFile(resolve(missingDirectory, "package.json"), JSON.stringify({
        exports: { ".": "./src/index.ts" }, name: "@fixture/missing",
      }), "utf8"),
    ]);

    const discovered = await discoverWorkspacePackages(root);
    expect(discovered).toHaveLength(2);
    const declaredEntries = discovered.filter(hasRuntimeEntry);
    const observations = await mapWithConcurrency(
      declaredEntries, 2, (item) => observeWorkspacePackage(root, item),
    );
    const missing = discovered.find(({ name }) => name === "@fixture/missing");
    const missingObservation = observations.find(({ packageName }) => packageName === "@fixture/missing");
    expect(missing).toMatchObject({
      entryState: "MISSING_ENTRY",
      name: "@fixture/missing",
      runtimeEntry: resolve(missingDirectory, "src/index.ts"),
    });
    expect(observations.find(({ packageName }) => packageName === "@fixture/good")?.result)
      .toMatchObject({ outcome: "IMPORTED", undefinedExports: [] });
    expect(missingObservation?.result).toEqual({
      code: "MISSING_ENTRY",
      outcome: "MISSING_ENTRY",
      specifier: resolve(missingDirectory, "src/index.ts"),
    });
    expect(missingObservation).toBeDefined();
    if (missingObservation !== undefined) {
      const report = formatObservation(missingObservation);
      expect(report).toContain("@fixture/missing: MISSING_ENTRY");
      expect(report).toContain(resolve(missingDirectory, "src/index.ts"));
      expect(observationIssues(missingObservation, {})).toEqual([report]);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("partitions every manifest into a probed or justified no-entry bucket", async () => {
  const discovered = await discoverWorkspacePackages(repositoryRoot);
  const withEntry = discovered.filter(hasRuntimeEntry);
  const withoutEntry = discovered.filter(({ entryState }) => entryState === "NO_RUNTIME_ENTRY");

  expect(withEntry.length + withoutEntry.length).toBe(discovered.length);
  expect(withoutEntry.map(({ name }) => name)).toEqual(Object.keys(noRuntimeEntryReasons));
  for (const item of withoutEntry) expect(noRuntimeEntryReasons[item.name]).toBeTruthy();
});

it("proves the real-Node probe with positive and negative controls", async () => {
  const packages = await discoverWorkspacePackages(repositoryRoot);
  const scheduler = packages.find(({ name }) => name === "@moe/scheduler");
  expect(scheduler?.runtimeEntry).toBeTruthy();
  const missingEntry = resolve(repositoryRoot, "tests/runtime/deliberately-unresolvable.ts");
  const results = await mapWithConcurrency(
    [scheduler?.runtimeEntry ?? "", missingEntry],
    2,
    (entry) => probeRuntimeEntry(repositoryRoot, entry),
  );

  expect(results[0]).toMatchObject({ marker: runtimeProbeMarker, outcome: "IMPORTED" });
  if (results[0]?.outcome === "IMPORTED") {
    expect(results[0].exportNames.length).toBeGreaterThan(0);
    expect(results[0].undefinedExports).toEqual([]);
  }
  expect(results[1]).toMatchObject({
    code: "ERR_MODULE_NOT_FOUND",
    marker: runtimeProbeMarker,
    outcome: "IMPORT_FAILED",
  });
  if (results[1]?.outcome === "IMPORT_FAILED") {
    expect(results[1].specifier).toContain("deliberately-unresolvable.ts");
  }
});

it("reports a child-process timeout as its own outcome", async () => {
  const packages = await discoverWorkspacePackages(repositoryRoot);
  const scheduler = packages.find(({ name }) => name === "@moe/scheduler");
  expect(scheduler?.runtimeEntry).toBeTruthy();

  await expect(
    probeRuntimeEntry(repositoryRoot, scheduler?.runtimeEntry ?? "", 10, 100),
  ).resolves.toEqual({ outcome: "TIMED_OUT", timeoutMs: 10 });
});

it("loads every Node-entry workspace package or pins its temporary bridge owner", async () => {
  const packages = await discoverWorkspacePackages(repositoryRoot);
  const runtimePackages = packages.filter(hasRuntimeEntry);
  expect(runtimePackages.length).toBeGreaterThan(0);
  const runtimePackageNames = runtimePackages.map(({ name }) => name);
  for (const [packageName, allowance] of Object.entries(allowedPackageFailures)) {
    expect(runtimePackageNames).toContain(packageName);
    expect(allowance.addedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(allowance.expectedCode).toBe("ERR_MODULE_NOT_FOUND");
    expect(allowance.ownerTaskId).toMatch(/^task-[a-f0-9]+$/u);
    expect(allowance.reason).toBeTruthy();
  }
  const observations = await mapWithConcurrency(
    runtimePackages, 4, (item) => observeWorkspacePackage(repositoryRoot, item),
  );
  const issues = observations.flatMap(
    (observation) => observationIssues(observation, allowedPackageFailures),
  );
  const report = observations.map(formatObservation).join("\n");

  expect(issues, `runtime package report:\n${report}`).toEqual([]);
});
