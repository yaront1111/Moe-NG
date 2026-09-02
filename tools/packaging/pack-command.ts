import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { admitCargoPackTool, readCargoToolchainPins } from "./pack-cargo-tool.js";
import {
  leaseEntriesForTool, runWindowsLeasedProcess, WINDOWS_PROCESS_LEASE_SCHEMA,
} from "./pack-windows-process-lease.js";

import {
  PACK_STEP_FAILED, PACK_TOOL_SCHEMA, MAX_IDENTITY_ENTRIES,
  assertPackToolIdentity, captureNativePackTool, capturePackFileIdentity,
  capturePackTreeIdentity, freezePackTool, normalizedTreeSha256, pathInside, sameCanonicalPath,
  type PackFileIdentity, type PackToolLaunch, type PackTreeEntry, type PackTreeIdentity,
} from "./pack-tool-identity.js";
import { resolvePnpmHandoff } from "./pack-pnpm-handoff.js";
import { normalizedPnpmPackageTreeSha256 } from "./pack-pnpm-package-identity.js";
import { readToolchainPins } from "./toolchain-pins.js";

export {
  PACK_STEP_FAILED, assertPackToolIdentity, captureNativePackTool, capturePackFileIdentity,
} from "./pack-tool-identity.js";
export type {
  PackFileIdentity, PackToolLaunch, PackTreeEntry, PackTreeIdentity,
} from "./pack-tool-identity.js";

export const PACK_TOOLCHAIN_SCHEMA = "moe-windows-pack-toolchain/1" as const;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const PINS = readToolchainPins();
const PROTECTED_PROGRAM_FILES = "C:\\Program Files";
const PROTECTED_SYSTEM_ROOT = "C:\\Windows";

export interface WindowsPackToolchain {
  readonly node: PackToolLaunch;
  readonly pnpm: PackToolLaunch;
  readonly powershell: PackToolLaunch;
  readonly schemaVersion: typeof PACK_TOOLCHAIN_SCHEMA;
}

export type PackStepRunner = (
  tool: PackToolLaunch,
  args: readonly string[],
  cwd: string,
  log: (line: string) => void,
  environment?: NodeJS.ProcessEnv,
  broker?: PackToolLaunch,
) => void;

interface ToolResolutionDependencies {
  readonly architecture?: string;
  readonly expectedNativePnpmSha256?: string;
  readonly expectedNativePnpmTreeSha256?: string;
  readonly expectedNodeSha256?: string;
  readonly expectedPnpmPackageTreeSha256?: string;
  readonly nodeExecutable?: string;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform | string;
  readonly protectedProgramFilesRoot?: string;
  readonly protectedSystemRoot?: string;
  readonly powershellExecutable?: string;
  readonly powershell?: PackToolLaunch;
  readonly spawn?: typeof spawnSync;
}

export type ProtectedWindowsPackExecutable = "git" | "node" | "powershell" | "tar";

/** Fixed OS installation paths; alternate roots are a sealed unit-test seam only. */
export function resolveProtectedWindowsPackExecutable(
  kind: ProtectedWindowsPackExecutable,
  dependencies: Pick<ToolResolutionDependencies,
    "platform" | "protectedProgramFilesRoot" | "protectedSystemRoot"> = {},
): string {
  try {
    if ((dependencies.platform ?? process.platform) !== "win32") throw new Error();
    const programFiles = resolve(dependencies.protectedProgramFilesRoot ?? PROTECTED_PROGRAM_FILES);
    const systemRoot = resolve(dependencies.protectedSystemRoot ?? PROTECTED_SYSTEM_ROOT);
    const expected = kind === "git" ? join(programFiles, "Git", "cmd", "git.exe")
      : kind === "node" ? join(programFiles, "nodejs", "node.exe")
      : kind === "tar" ? join(systemRoot, "System32", "tar.exe")
      : join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const canonical = realpathSync(expected);
    if (!sameCanonicalPath(realpathSync(kind === "git" || kind === "node"
      ? programFiles : systemRoot), kind === "git" || kind === "node" ? programFiles : systemRoot)
      || !sameCanonicalPath(canonical, expected) || !lstatSync(canonical).isFile()) throw new Error();
    return canonical;
  } catch {
    throw new Error(`${PACK_STEP_FAILED}: protected ${kind} unavailable`);
  }
}

interface PackExecutionResult {
  readonly error?: unknown;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

function packageManifest(packageRoot: string): Readonly<Record<string, unknown>> {
  try {
    const manifestPath = join(packageRoot, "package.json");
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    throw new Error(`${PACK_STEP_FAILED}: pnpm identity unavailable`);
  }
}

function repositoryPnpmPin(repositoryRoot: string): string {
  const manifest = packageManifest(repositoryRoot);
  const engines = manifest["engines"];
  const packageManager = manifest["packageManager"];
  if (packageManager !== `pnpm@${PINS.pnpmVersion}`
    || typeof engines !== "object" || engines === null || Array.isArray(engines)
    || (engines as Record<string, unknown>)["pnpm"] !== PINS.pnpmVersion) {
    throw new Error(`${PACK_STEP_FAILED}: pnpm pin invalid`);
  }
  return PINS.pnpmVersion;
}

function pnpmEntry(packageRoot: string): string {
  const manifest = packageManifest(packageRoot);
  if (manifest["name"] !== "pnpm" || manifest["version"] !== PINS.pnpmVersion) {
    throw new Error(`${PACK_STEP_FAILED}: pnpm identity unavailable`);
  }
  const bin = manifest["bin"];
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) {
    throw new Error(`${PACK_STEP_FAILED}: pnpm identity unavailable`);
  }
  const mapped = (bin as Record<string, unknown>)["pnpm"];
  if (typeof mapped !== "string" || mapped.length === 0) {
    throw new Error(`${PACK_STEP_FAILED}: pnpm identity unavailable`);
  }
  const entry = resolve(packageRoot, mapped);
  if (!pathInside(packageRoot, entry) || !/\.(?:cjs|mjs|js)$/u.test(basename(entry))) {
    throw new Error(`${PACK_STEP_FAILED}: pnpm identity unavailable`);
  }
  return entry;
}

function findPnpmPackageRoot(entry: string): string {
  let candidate = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      if (sameCanonicalPath(realpathSync(pnpmEntry(candidate)), entry)) return realpathSync(candidate);
    } catch {
      // Continue to the next ancestor; only an exact pnpm manifest can stop discovery.
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`${PACK_STEP_FAILED}: pnpm identity unavailable`);
}
function pnpmActionDestination(
  handoff: ReturnType<typeof resolvePnpmHandoff>, environment: NodeJS.ProcessEnv,
): string {
  if (handoff.kind === "package" && handoff.witnesses.length !== 1) return "";
  const home = handoff.kind === "package" ? dirname(handoff.witnesses[0]!.path)
    : environment["PNPM_HOME"];
  if (typeof home !== "string" || !isAbsolute(home)) return "";
  try {
    const binDirectory = realpathSync(home);
    const installRoot = dirname(binDirectory);
    return basename(binDirectory) === ".bin" && basename(installRoot) === "node_modules" ? dirname(installRoot) : "";
  } catch { return ""; }
}

function execute(
  tool: PackToolLaunch, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv,
  spawn: typeof spawnSync, broker?: PackToolLaunch,
): PackExecutionResult {
  assertPackToolIdentity(tool);
  const result = broker === undefined ? spawn(tool.executable.path, [...tool.argsPrefix, ...args], {
      cwd, encoding: "utf8", env: environment, maxBuffer: 16 * 1024 * 1024,
      shell: false, stdio: "pipe", timeout: 20 * 60 * 1000, windowsHide: true,
    }) : runWindowsLeasedProcess(broker, Object.freeze({
      args: Object.freeze([...tool.argsPrefix, ...args]), cwd,
      executable: tool.executable.path,
      locks: leaseEntriesForTool(tool), schemaVersion: WINDOWS_PROCESS_LEASE_SCHEMA,
      timeoutMs: 20 * 60 * 1000,
    }), environment);
  assertPackToolIdentity(tool);
  return Object.freeze({
    ...(result.error === undefined ? {} : { error: result.error }),
    status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "",
  });
}

export function resolvePnpmPackTool(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  dependencies: Pick<ToolResolutionDependencies, "architecture" | "expectedNativePnpmSha256"
    | "expectedNativePnpmTreeSha256" | "expectedPnpmPackageTreeSha256" | "nodeExecutable"
    | "platform" | "powershell" | "spawn"> = {},
): PackToolLaunch {
  const pin = repositoryPnpmPin(repositoryRoot);
  const repository = realpathSync(repositoryRoot);
  const handoff = resolvePnpmHandoff(
    environment, repository, dependencies.platform ?? process.platform);
  let tool: PackToolLaunch;
  if (handoff.kind === "native") {
    const executable = capturePackFileIdentity(handoff.executable);
    if ((dependencies.architecture ?? process.arch) !== "x64"
      || executable.sha256 !== (dependencies.expectedNativePnpmSha256 ?? PINS.pnpmNativeSha256)) {
      throw new Error(`${PACK_STEP_FAILED}: pnpm provenance invalid`);
    }
    const tree = capturePackTreeIdentity(join(dirname(handoff.executable), "dist"));
    if (normalizedTreeSha256(tree)
      !== (dependencies.expectedNativePnpmTreeSha256 ?? PINS.pnpmNativeTreeSha256)) {
      throw new Error(`${PACK_STEP_FAILED}: pnpm provenance invalid`);
    }
    tool = freezePackTool({ argsPrefix: [], executable, kind: "pnpm", tree, witnesses: [] });
  } else {
    const packageRoot = handoff.kind === "entry"
      ? findPnpmPackageRoot(handoff.entry) : handoff.packageRoot;
    const witnesses = handoff.kind === "package" ? handoff.witnesses : [];
    const entry = realpathSync(pnpmEntry(packageRoot));
    const node = capturePackFileIdentity(dependencies.nodeExecutable ?? process.execPath);
    const tree = capturePackTreeIdentity(packageRoot);
    if (normalizedPnpmPackageTreeSha256(tree, {
      actionDestination: pnpmActionDestination(handoff, environment),
      pnpmVersion: pin,
    })
      !== (dependencies.expectedPnpmPackageTreeSha256 ?? PINS.pnpmPackageTreeSha256)) {
      throw new Error(`${PACK_STEP_FAILED}: pnpm provenance invalid`);
    }
    tool = freezePackTool({
      argsPrefix: [entry], executable: node, kind: "pnpm",
      tree, witnesses,
    });
  }
  const result = execute(tool, ["--version"], repository,
    Object.freeze({ ...environment }), dependencies.spawn ?? spawnSync, dependencies.powershell);
  if (result.error !== undefined || result.status !== 0 || result.stdout.trim() !== pin
    || result.stderr.trim() !== "") {
    throw new Error(`${PACK_STEP_FAILED}: pnpm version mismatch`);
  }
  return tool;
}

export function resolvePowerShellPackTool(
  _environment: NodeJS.ProcessEnv,
  dependencies: Pick<ToolResolutionDependencies, "platform" | "powershellExecutable"
    | "protectedProgramFilesRoot" | "protectedSystemRoot"> = {},
): PackToolLaunch {
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error(`${PACK_STEP_FAILED}: PowerShell unavailable`);
  }
  const executable = dependencies.powershellExecutable
    ?? resolveProtectedWindowsPackExecutable("powershell", dependencies);
  return captureNativePackTool("powershell", executable);
}

export function resolveCargoPackTool(
  repositoryRoot: string, explicitExecutable: string,
): PackToolLaunch {
  return admitCargoPackTool(repositoryRoot, explicitExecutable, readCargoToolchainPins());
}

export function resolveWindowsPackToolchain(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  dependencies: ToolResolutionDependencies = {},
): WindowsPackToolchain {
  const powershell = resolvePowerShellPackTool(environment, dependencies);
  const nodePath = dependencies.nodeExecutable ?? process.execPath;
  const node = captureNativePackTool("node", nodePath);
  if ((dependencies.architecture ?? process.arch) !== "x64"
    || (dependencies.nodeVersion ?? process.version) !== PINS.nodeVersion
    || node.executable.sha256 !== (dependencies.expectedNodeSha256 ?? PINS.nodeSha256)) {
    throw new Error(`${PACK_STEP_FAILED}: node provenance invalid`);
  }
  const pnpm = resolvePnpmPackTool(repositoryRoot, environment, {
    ...dependencies, nodeExecutable: nodePath, powershell,
  });
  return Object.freeze({ node, pnpm, powershell, schemaVersion: PACK_TOOLCHAIN_SCHEMA });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function decodeFile(value: unknown): PackFileIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>,
      ["dev", "ino", "mode", "nlink", "path", "sha256", "size"])) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  const file = value as Record<string, unknown>;
  if (typeof file["dev"] !== "string" || typeof file["ino"] !== "string"
    || typeof file["mode"] !== "string" || typeof file["nlink"] !== "string"
    || typeof file["path"] !== "string"
    || !isAbsolute(file["path"]) || typeof file["sha256"] !== "string"
    || !/^[0-9a-f]{64}$/u.test(file["sha256"])
    || !Number.isSafeInteger(file["size"]) || Number(file["size"]) <= 0) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  return Object.freeze(file as unknown as PackFileIdentity);
}

function decodeTree(value: unknown): PackTreeIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["entries", "root"])) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  const tree = value as Record<string, unknown>;
  if (typeof tree["root"] !== "string" || !isAbsolute(tree["root"])
    || !Array.isArray(tree["entries"]) || tree["entries"].length === 0
    || tree["entries"].length > MAX_IDENTITY_ENTRIES) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  const entries = tree["entries"].map((entry): PackTreeEntry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)
      || !exactKeys(entry as Record<string, unknown>,
        ["dev", "ino", "kind", "mode", "nlink", "path", "sha256", "size"])) {
      throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
    }
    const item = entry as Record<string, unknown>;
    if (typeof item["dev"] !== "string" || typeof item["ino"] !== "string"
      || typeof item["mode"] !== "string" || typeof item["nlink"] !== "string"
      || typeof item["path"] !== "string"
      || (item["kind"] !== "directory" && item["kind"] !== "file")
      || typeof item["sha256"] !== "string" || !Number.isSafeInteger(item["size"])) {
      throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
    }
    return Object.freeze(item as unknown as PackTreeEntry);
  });
  return Object.freeze({ entries: Object.freeze(entries), root: tree["root"] });
}

function decodeTool(value: unknown, expectedKind: PackToolLaunch["kind"]): PackToolLaunch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  const candidate = value as Record<string, unknown>;
  const keys = candidate["tree"] === undefined
    ? ["argsPrefix", "executable", "kind", "schemaVersion", "witnesses"]
    : ["argsPrefix", "executable", "kind", "schemaVersion", "tree", "witnesses"];
  if (!exactKeys(candidate, keys) || candidate["schemaVersion"] !== PACK_TOOL_SCHEMA
    || candidate["kind"] !== expectedKind || !Array.isArray(candidate["argsPrefix"])
    || candidate["argsPrefix"].some((arg) => typeof arg !== "string")
    || !Array.isArray(candidate["witnesses"]) || candidate["witnesses"].length > 8) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  return freezePackTool({
    argsPrefix: candidate["argsPrefix"] as string[], executable: decodeFile(candidate["executable"]),
    kind: expectedKind,
    ...(candidate["tree"] === undefined ? {} : { tree: decodeTree(candidate["tree"]) }),
    witnesses: candidate["witnesses"].map(decodeFile),
  });
}

export function serializeWindowsPackToolchain(toolchain: WindowsPackToolchain): string {
  const encoded = JSON.stringify(toolchain);
  if (Buffer.byteLength(encoded, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
  return encoded;
}

export function parseWindowsPackToolchain(encoded: string): WindowsPackToolchain {
  try {
    if (Buffer.byteLength(encoded, "utf8") > MAX_MANIFEST_BYTES) throw new Error();
    const value = JSON.parse(encoded) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || !exactKeys(value as Record<string, unknown>, ["node", "pnpm", "powershell", "schemaVersion"])) {
      throw new Error();
    }
    const candidate = value as Record<string, unknown>;
    if (candidate["schemaVersion"] !== PACK_TOOLCHAIN_SCHEMA) throw new Error();
    return Object.freeze({
      node: decodeTool(candidate["node"], "node"),
      pnpm: decodeTool(candidate["pnpm"], "pnpm"),
      powershell: decodeTool(candidate["powershell"], "powershell"),
      schemaVersion: PACK_TOOLCHAIN_SCHEMA,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(PACK_STEP_FAILED)) throw error;
    throw new Error(`${PACK_STEP_FAILED}: tool manifest invalid`);
  }
}

export const runPackStep: PackStepRunner = (
  tool, args, cwd, log, environment = process.env, broker,
): void => {
  const line = [tool.kind, ...args.map((arg) => JSON.stringify(arg))].join(" ");
  log(`  $ ${line}`);
  const result = execute(tool, args, cwd, environment, spawnSync, broker);
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${PACK_STEP_FAILED}: ${tool.kind} failed`);
  }
};
