import { spawn } from "node:child_process";
import { glob, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";

interface WorkspacePackageBase { readonly directory: string; readonly name: string }

export type WorkspacePackage =
  | WorkspacePackageBase & { readonly entryState: "NO_RUNTIME_ENTRY"; readonly runtimeEntry: null }
  | WorkspacePackageBase & { readonly entryState: "PRESENT"; readonly runtimeEntry: string }
  | WorkspacePackageBase & { readonly entryState: "MISSING_ENTRY"; readonly runtimeEntry: string };

export type RuntimeWorkspacePackage = Exclude<WorkspacePackage, {
  readonly entryState: "NO_RUNTIME_ENTRY";
}>;

export interface AllowedPackageFailure {
  readonly addedOn: "2026-08-09";
  readonly expectedCode: "ERR_MODULE_NOT_FOUND";
  readonly expectedPathFragment: string;
  readonly ownerTaskId: string;
  readonly reason: string;
}

export type RuntimeProbeResult =
  | {
    readonly exportNames: readonly string[]; readonly marker: string;
    readonly outcome: "IMPORTED"; readonly undefinedExports: readonly string[];
  }
  | {
    readonly code: string; readonly marker: string;
    readonly outcome: "IMPORT_FAILED"; readonly specifier: string;
  }
  | { readonly code: "MISSING_ENTRY"; readonly outcome: "MISSING_ENTRY"; readonly specifier: string }
  | { readonly outcome: "PROCESS_FAILED"; readonly reason: string }
  | { readonly outcome: "TIMED_OUT"; readonly timeoutMs: number };

export interface PackageProbeObservation {
  readonly packageName: string; readonly result: RuntimeProbeResult;
}

export const runtimeProbeMarker = "MOE_RUNTIME_PROBE_V1";
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

export async function readWorkspacePatterns(root: string): Promise<readonly string[]> {
  const contents = await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8");
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

export async function expandWorkspacePattern(
  root: string,
  pattern: string,
): Promise<readonly string[]> {
  const directories: string[] = [];
  for await (const match of glob(pattern, { cwd: root })) {
    if ((await stat(resolve(root, match))).isDirectory()) directories.push(normalizePath(match));
  }
  return directories.sort();
}

export async function workspacePackageDirectoriesOnDisk(
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

export async function discoverWorkspacePackages(
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
  let contents: string;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  const manifest = record(parsed);
  if (manifest === null || typeof manifest.name !== "string") {
    throw new Error(`${normalizePath(relative(root, manifestPath))} has no package name`);
  }
  const rawEntry = record(manifest.exports)?.["."];
  const entry = typeof rawEntry === "string" && [".ts", ".js", ".mts", ".mjs"].includes(extname(rawEntry))
    ? resolve(root, directory, rawEntry)
    : null;
  if (entry === null) {
    return Object.freeze({ directory, entryState: "NO_RUNTIME_ENTRY", name: manifest.name, runtimeEntry: null });
  }
  const entryState = await isFile(entry) ? "PRESENT" : "MISSING_ENTRY";
  return Object.freeze({ directory, entryState, name: manifest.name, runtimeEntry: entry });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function hasRuntimeEntry(item: WorkspacePackage): item is RuntimeWorkspacePackage {
  return item.entryState !== "NO_RUNTIME_ENTRY";
}

export async function observeWorkspacePackage(
  root: string,
  item: RuntimeWorkspacePackage,
): Promise<PackageProbeObservation> {
  const result: RuntimeProbeResult = item.entryState === "MISSING_ENTRY"
    ? { code: "MISSING_ENTRY", outcome: "MISSING_ENTRY", specifier: item.runtimeEntry }
    : await probeRuntimeEntry(root, item.runtimeEntry);
  return { packageName: item.name, result };
}

export async function probeRuntimeEntry(
  root: string,
  entry: string,
  timeoutMs = 10_000,
  delayMs = 0,
): Promise<RuntimeProbeResult> {
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "--eval", runtimeProbeSource,
    entry, String(delayMs),
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

export async function mapWithConcurrency<T, R>(
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
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const result = decodeProbeResult(JSON.parse(line));
      if (result !== null) return result;
    } catch {
      // Imported packages may write unrelated stdout; only the marker is authoritative.
    }
  }
  return { outcome: "PROCESS_FAILED", reason: "probe marker missing from child stdout" };
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function decodeProbeResult(value: unknown): RuntimeProbeResult | null {
  const result = record(value);
  if (result?.marker !== runtimeProbeMarker) return null;
  if (result.outcome === "IMPORTED") {
    const exportNames = stringArray(result.exportNames);
    const undefinedExports = stringArray(result.undefinedExports);
    return exportNames !== null && undefinedExports !== null
      ? { exportNames, marker: runtimeProbeMarker, outcome: "IMPORTED", undefinedExports }
      : null;
  }
  return result.outcome === "IMPORT_FAILED"
    && typeof result.code === "string" && typeof result.specifier === "string"
    ? { code: result.code, marker: runtimeProbeMarker, outcome: "IMPORT_FAILED", specifier: result.specifier }
    : null;
}

export function observationIssues(
  observation: PackageProbeObservation,
  allowedFailures: Readonly<Record<string, AllowedPackageFailure>>,
): readonly string[] {
  const allowance = allowedFailures[observation.packageName];
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
  if (allowance === undefined || result.outcome !== "IMPORT_FAILED") return [formatObservation(observation)];
  if (result.code !== allowance.expectedCode) return [formatObservation(observation)];
  return result.specifier.replaceAll("\\", "/").includes(allowance.expectedPathFragment)
    ? []
    : [formatObservation(observation)];
}

export function formatObservation(observation: PackageProbeObservation): string {
  const { result } = observation;
  if (result.outcome === "IMPORTED") {
    return `${observation.packageName}: IMPORTED exports=${result.exportNames.length}`;
  }
  if (result.outcome === "IMPORT_FAILED") {
    return `${observation.packageName}: ${result.code} ${result.specifier}`;
  }
  if (result.outcome === "MISSING_ENTRY") {
    return `${observation.packageName}: ${result.code} ${result.specifier}`;
  }
  if (result.outcome === "TIMED_OUT") {
    return `${observation.packageName}: TIMED_OUT after ${result.timeoutMs}ms`;
  }
  return `${observation.packageName}: PROCESS_FAILED ${result.reason}`;
}
