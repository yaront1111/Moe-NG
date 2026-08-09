import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  type AllowedPackageFailure,
  discoverWorkspacePackages,
  expandWorkspacePattern,
  formatObservation,
  mapWithConcurrency,
  observationIssues,
  probeRuntimeEntry,
  readWorkspacePatterns,
  runtimeProbeMarker,
  type WorkspacePackage,
  workspacePackageDirectoriesOnDisk,
} from "./package-loadability-support.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const noRuntimeEntryReasons: Readonly<Record<string, string>> = Object.freeze({
  "@moe/control-room": "browser-only Vite application; no Node entry by design",
});
const allowedPackageFailures: Readonly<Record<string, AllowedPackageFailure>> = Object.freeze({
  "@moe/control-room-client": {
    addedOn: "2026-08-09",
    expectedCode: "ERR_MODULE_NOT_FOUND",
    expectedPathFragment: "/packages/control-room-client/src/",
    ownerTaskId: "task-17b03331e4ee488a994635144cae4a53",
    reason: "package-wide runtime bridges are pending",
  },
  "@moe/mcp": {
    addedOn: "2026-08-09",
    expectedCode: "ERR_MODULE_NOT_FOUND",
    expectedPathFragment: "/packages/mcp/src/",
    ownerTaskId: "task-17b03331e4ee488a994635144cae4a53",
    reason: "package-wide runtime bridges are pending",
  },
  "@moe/skills": {
    addedOn: "2026-08-09",
    expectedCode: "ERR_MODULE_NOT_FOUND",
    expectedPathFragment: "/packages/skills/src/",
    ownerTaskId: "task-17b03331e4ee488a994635144cae4a53",
    reason: "package-wide runtime bridges are pending",
  },
});

it("discovers every workspace package manifest from pnpm-workspace.yaml", async () => {
  const discovered = await discoverWorkspacePackages(repositoryRoot);
  const directoriesOnDisk = await workspacePackageDirectoriesOnDisk(repositoryRoot);

  expect(discovered.length).toBeGreaterThan(0);
  expect(discovered.map(({ directory }) => directory)).toEqual(directoriesOnDisk);
});

it("tolerates a workspace glob whose base directory is absent", async () => {
  const patterns = await readWorkspacePatterns(repositoryRoot);

  expect(patterns).toContain("adapters/*");
  await expect(expandWorkspacePattern(repositoryRoot, "adapters/*")).resolves.toEqual([]);
});

it("partitions every manifest into a probed or justified no-entry bucket", async () => {
  const discovered = await discoverWorkspacePackages(repositoryRoot);
  const withEntry = discovered.filter(({ runtimeEntry }) => runtimeEntry !== null);
  const withoutEntry = discovered.filter(({ runtimeEntry }) => runtimeEntry === null);

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
  const runtimePackages = packages.filter(
    (item): item is WorkspacePackage & { readonly runtimeEntry: string } => item.runtimeEntry !== null,
  );
  expect(runtimePackages.length).toBeGreaterThan(0);
  const runtimePackageNames = runtimePackages.map(({ name }) => name);
  for (const [packageName, allowance] of Object.entries(allowedPackageFailures)) {
    expect(runtimePackageNames).toContain(packageName);
    expect(allowance.addedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(allowance.expectedCode).toBe("ERR_MODULE_NOT_FOUND");
    expect(allowance.ownerTaskId).toMatch(/^task-[a-f0-9]+$/u);
    expect(allowance.reason).toBeTruthy();
  }
  const observations = await mapWithConcurrency(runtimePackages, 4, async (item) => ({
    packageName: item.name,
    result: await probeRuntimeEntry(repositoryRoot, item.runtimeEntry),
  }));
  const issues = observations.flatMap(
    (observation) => observationIssues(observation, allowedPackageFailures),
  );
  const report = observations.map(formatObservation).join("\n");

  expect(issues, `runtime package report:\n${report}`).toEqual([]);
});
