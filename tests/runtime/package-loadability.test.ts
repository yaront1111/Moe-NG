import { spawn } from "node:child_process";
import { glob, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

interface WorkspacePackage {
  readonly directory: string;
  readonly name: string;
  readonly runtimeEntry: string | null;
}

interface AllowedPackageFailure {
  readonly addedOn: "2026-08-09";
  readonly expectedCode: "ERR_MODULE_NOT_FOUND";
  readonly expectedPathFragment: string;
  readonly ownerTaskId: string;
  readonly reason: string;
}

interface PackageProbeObservation {
  readonly packageName: string;
  readonly result: RuntimeProbeResult;
}

type RuntimeProbeResult =
  | {
    readonly exportNames: readonly string[];
    readonly marker: string;
    readonly outcome: "IMPORTED";
    readonly undefinedExports: readonly string[];
  }
  | {
    readonly code: string;
    readonly marker: string;
    readonly outcome: "IMPORT_FAILED";
    readonly specifier: string;
  }
  | { readonly outcome: "PROCESS_FAILED"; readonly reason: string }
  | { readonly outcome: "TIMED_OUT"; readonly timeoutMs: number };

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeProbeMarker = "MOE_RUNTIME_PROBE_V1";
const runtimeProbeSource = `
import { pathToFileURL } from "node:url";
const marker = ${JSON.stringify(runtimeProbeMarker)};
const delayMs = Number.parseInt(process.argv[2] ?? "0", 10);
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
try {
  const namespace = await import(pathToFileURL(process.argv[1]).href);
  const exportNames = Object.keys(namespace);
  const undefinedExports = exportNames.filter((name) => namespace[name] === undefined);
  console.log(JSON.stringify({ exportNames, marker, outcome: "IMPORTED", undefinedExports }));
} catch (error) {
  const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
  const specifier = typeof error?.url === "string" ? error.url : process.argv[1];
  console.log(JSON.stringify({ code, marker, outcome: "IMPORT_FAILED", specifier }));
}
`;

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

async function readWorkspacePatterns(_root: string): Promise<readonly string[]> {
  const contents = await readFile(resolve(_root, "pnpm-workspace.yaml"), "utf8");
  const lines = contents.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^packages:\s*$/u.test(line));
  if (start < 0) throw new Error("pnpm-workspace.yaml has no packages section");
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    const match = /^\s*-\s+['"]?([^'"]+?)['"]?\s*$/u.exec(line);
    if (match?.[1] !== undefined) patterns.push(match[1]);
  }
  if (patterns.length === 0) throw new Error("pnpm-workspace.yaml has no package globs");
  return patterns;
}

async function expandWorkspacePattern(
  root: string,
  pattern: string,
): Promise<readonly string[]> {
  const directories: string[] = [];
  for await (const match of glob(pattern, { cwd: root })) {
    if ((await stat(resolve(root, match))).isDirectory()) directories.push(normalizePath(match));
  }
  return directories.sort();
}

async function workspacePackageDirectoriesOnDisk(
  root: string,
): Promise<readonly string[]> {
  const patterns = await readWorkspacePatterns(root);
  const directories = new Set<string>();
  for (const pattern of patterns) {
    for await (const manifest of glob(`${pattern}/package.json`, { cwd: root })) {
      directories.add(normalizePath(dirname(manifest)));
    }
  }
  return [...directories].sort();
}

async function discoverWorkspacePackages(
  root: string,
): Promise<readonly WorkspacePackage[]> {
  const patterns = await readWorkspacePatterns(root);
  const directories = new Set<string>();
  for (const pattern of patterns) {
    for (const directory of await expandWorkspacePattern(root, pattern)) directories.add(directory);
  }
  const packages = await Promise.all([...directories].sort().map(
    (directory) => readWorkspacePackage(root, directory),
  ));
  return packages.filter((item): item is WorkspacePackage => item !== null);
}

function normalizePath(path: string): string {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

async function readWorkspacePackage(
  root: string,
  directory: string,
): Promise<WorkspacePackage | null> {
  const manifestPath = resolve(root, directory, "package.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    const manifest = record(parsed);
    if (manifest === null || typeof manifest.name !== "string") {
      throw new Error(`${normalizePath(relative(root, manifestPath))} has no package name`);
    }
    const rawEntry = record(manifest.exports)?.["."];
    const entry = typeof rawEntry === "string" && [".ts", ".js", ".mts", ".mjs"].includes(extname(rawEntry))
      ? resolve(root, directory, rawEntry)
      : null;
    if (entry !== null && !(await stat(entry)).isFile()) {
      throw new Error(`${manifest.name} declares missing runtime entry ${rawEntry}`);
    }
    return Object.freeze({ directory, name: manifest.name, runtimeEntry: entry });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function probeRuntimeEntry(
  entry: string,
  timeoutMs = 10_000,
  delayMs = 0,
): Promise<RuntimeProbeResult> {
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "--eval", runtimeProbeSource,
    entry, String(delayMs),
  ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: RuntimeProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ outcome: "TIMED_OUT", timeoutMs });
    }, timeoutMs);
    child.once("error", (error) => finish({ outcome: "PROCESS_FAILED", reason: String(error) }));
    child.once("close", (code) => finish(parseProbeOutput(stdout, stderr, code)));
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  width: number,
  mapper: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  if (!Number.isInteger(width) || width < 1) throw new Error("concurrency width must be positive");
  const slots: Array<{ readonly value: R } | undefined> = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) slots[index] = { value: await mapper(item) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return slots.map((slot) => {
    if (slot === undefined) throw new Error("concurrent probe did not produce a result");
    return slot.value;
  });
}

function parseProbeOutput(stdout: string, stderr: string, code: number | null): RuntimeProbeResult {
  if (code !== 0) {
    return { outcome: "PROCESS_FAILED", reason: `exit=${String(code)} stderr=${stderr.trim()}` };
  }
  for (const line of stdout.trim().split(/\r?\n/u)) {
    try {
      const value: unknown = JSON.parse(line);
      const result = record(value);
      if (result?.marker === runtimeProbeMarker) return value as RuntimeProbeResult;
    } catch {
      // Imported packages may write unrelated stdout; only the marker is authoritative.
    }
  }
  return { outcome: "PROCESS_FAILED", reason: "probe marker missing from child stdout" };
}

function observationIssues(observation: PackageProbeObservation): readonly string[] {
  const allowance = allowedPackageFailures[observation.packageName];
  const { result } = observation;
  if (result.outcome === "IMPORTED") {
    const issues: string[] = [];
    if (allowance !== undefined) issues.push(`${observation.packageName}: allowlist entry is stale`);
    if (result.exportNames.length === 0) issues.push(`${observation.packageName}: imported with zero exports`);
    if (result.undefinedExports.length > 0) {
      issues.push(`${observation.packageName}: undefined exports ${result.undefinedExports.join(",")}`);
    }
    return issues;
  }
  if (allowance === undefined) return [formatFailure(observation)];
  if (result.outcome !== "IMPORT_FAILED") return [formatFailure(observation)];
  if (result.code !== allowance.expectedCode) return [formatFailure(observation)];
  if (!result.specifier.replaceAll("\\", "/").includes(allowance.expectedPathFragment)) {
    return [formatFailure(observation)];
  }
  return [];
}

function formatFailure(observation: PackageProbeObservation): string {
  const { result } = observation;
  if (result.outcome === "IMPORTED") {
    return `${observation.packageName}: IMPORTED exports=${result.exportNames.length}`;
  }
  if (result.outcome === "IMPORT_FAILED") {
    return `${observation.packageName}: ${result.code} ${result.specifier}`;
  }
  if (result.outcome === "TIMED_OUT") {
    return `${observation.packageName}: TIMED_OUT after ${result.timeoutMs}ms`;
  }
  return `${observation.packageName}: PROCESS_FAILED ${result.reason}`;
}

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
  for (const item of withoutEntry) {
    expect(noRuntimeEntryReasons[item.name]).toBeTruthy();
  }
});

it("proves the real-Node probe with positive and negative controls", async () => {
  const packages = await discoverWorkspacePackages(repositoryRoot);
  const scheduler = packages.find(({ name }) => name === "@moe/scheduler");
  expect(scheduler?.runtimeEntry).toBeTruthy();
  const missingEntry = resolve(repositoryRoot, "tests/runtime/deliberately-unresolvable.ts");
  const results = await mapWithConcurrency(
    [scheduler?.runtimeEntry ?? "", missingEntry],
    2,
    (entry) => probeRuntimeEntry(entry),
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

  await expect(probeRuntimeEntry(scheduler?.runtimeEntry ?? "", 10, 100)).resolves.toEqual({
    outcome: "TIMED_OUT",
    timeoutMs: 10,
  });
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
    result: await probeRuntimeEntry(item.runtimeEntry),
  }));
  const issues = observations.flatMap(observationIssues);
  const report = observations.map(formatFailure).join("\n");

  expect(issues, `runtime package report:\n${report}`).toEqual([]);
});
