import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The release boundary that decides which repository bytes packaging may read. */
export const PACKAGING_SOURCE_LAYER = "PACKAGING_SOURCE" as const;
export const PACK_SOURCE_ERROR_CODES = Object.freeze([
  "PACK_SOURCE_INPUT_INVALID", "PACK_SOURCE_COMMIT_UNAVAILABLE",
  "PACK_SOURCE_ROSTER_FAILED", "PACK_SOURCE_ARCHIVE_FAILED",
  "PACK_SOURCE_EXTRACT_FAILED", "PACK_SOURCE_ROSTER_MISMATCH",
  "PACK_SOURCE_CLEANUP_FAILED",
] as const);
export type PackSourceCode = (typeof PACK_SOURCE_ERROR_CODES)[number];
/** Stable and deliberately non-diagnostic: command output may contain repository secrets. */
export class PackSourceError extends Error {
  public readonly code: PackSourceCode;
  public readonly layer = PACKAGING_SOURCE_LAYER;
  public constructor(code: PackSourceCode) {
    super(code);
    this.name = "PackSourceError";
    this.code = code;
    Object.freeze(this);
  }
}
export interface PackSourceCommandResult {
  readonly error?: unknown; readonly status: number | null;
  readonly stderr: Uint8Array; readonly stdout: Uint8Array;
}
export type PackSourceCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
) => PackSourceCommandResult;
export interface PackSourceDependencies {
  readonly command?: PackSourceCommand;
  readonly makeTemporaryRoot?: () => string;
  readonly removeTemporaryRoot?: (root: string) => void;
  readonly reportCleanupFailure?: (code: "PACK_SOURCE_CLEANUP_FAILED") => void;
}
export interface PackSourceRequest {
  readonly repositoryRoot: string; readonly sourceSha: string;
}
export interface MaterializedPackSource {
  readonly sourceRoot: string; readonly sourceSha: string;
  readonly trackedPaths: readonly string[];
}
const SOURCE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_OUTPUT_LIMIT = 64 * 1024 * 1024;
const comparePaths = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const nodeCommand: PackSourceCommand = (command, args, cwd) => {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: null,
    maxBuffer: COMMAND_OUTPUT_LIMIT,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  const answer: PackSourceCommandResult = { status: result.status,
    stderr: result.stderr ?? Buffer.alloc(0), stdout: result.stdout ?? Buffer.alloc(0) };
  return result.error === undefined ? answer : { ...answer, error: result.error };
};
function runChecked(
  commandPort: PackSourceCommand,
  executable: string,
  args: readonly string[],
  cwd: string,
  code: PackSourceCode,
): Uint8Array {
  let result: PackSourceCommandResult;
  try {
    result = commandPort(executable, args, cwd);
  } catch {
    throw new PackSourceError(code);
  }
  if (result.error !== undefined || result.status !== 0) throw new PackSourceError(code);
  return result.stdout;
}
function validRequest(request: unknown): request is PackSourceRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return false;
  if (Object.keys(request).sort().join("\0") !== "repositoryRoot\0sourceSha") return false;
  const candidate = request as Record<string, unknown>;
  return typeof candidate["repositoryRoot"] === "string"
    && candidate["repositoryRoot"].length > 0
    && typeof candidate["sourceSha"] === "string"
    && SOURCE_SHA.test(candidate["sourceSha"]);
}
function utf8(bytes: Uint8Array, code: PackSourceCode): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PackSourceError(code);
  }
}
function parseRoster(bytes: Uint8Array): readonly string[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  if (bytes[bytes.byteLength - 1] !== 0) throw new PackSourceError("PACK_SOURCE_ROSTER_FAILED");
  const framed = utf8(bytes, "PACK_SOURCE_ROSTER_FAILED").split("\0");
  framed.pop();
  const paths = framed;
  const invalid = paths.some((path) => path.length === 0
    || path.includes("\\")
    || path.startsWith("/")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."));
  if (invalid || new Set(paths).size !== paths.length) {
    throw new PackSourceError("PACK_SOURCE_ROSTER_FAILED");
  }
  return Object.freeze([...paths].sort(comparePaths));
}
interface ResolvedPackSource {
  readonly command: PackSourceCommand; readonly sourceSha: string;
  readonly trackedPaths: readonly string[];
}
function resolvePackSource(
  request: PackSourceRequest,
  commandPort: PackSourceCommand,
): ResolvedPackSource {
  if (!validRequest(request)) throw new PackSourceError("PACK_SOURCE_INPUT_INVALID");
  const resolved = utf8(runChecked(
    commandPort,
    "git",
    ["--no-replace-objects", "rev-parse", "--verify", `${request.sourceSha}^{commit}`],
    request.repositoryRoot,
    "PACK_SOURCE_COMMIT_UNAVAILABLE",
  ), "PACK_SOURCE_COMMIT_UNAVAILABLE");
  if (resolved !== `${request.sourceSha}\n`) {
    throw new PackSourceError("PACK_SOURCE_COMMIT_UNAVAILABLE");
  }
  const trackedPaths = parseRoster(runChecked(
    commandPort,
    "git",
    ["--no-replace-objects", "ls-tree", "-r", "-z", "--name-only", "--full-tree", request.sourceSha],
    request.repositoryRoot,
    "PACK_SOURCE_ROSTER_FAILED",
  ));
  return Object.freeze({ command: commandPort, sourceSha: request.sourceSha, trackedPaths });
}
function materializedPaths(root: string): readonly string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new PackSourceError("PACK_SOURCE_ROSTER_MISMATCH");
    }
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(directory, entry.name), path);
      else if (entry.isFile() || entry.isSymbolicLink()) found.push(path);
      else throw new PackSourceError("PACK_SOURCE_ROSTER_MISMATCH");
    }
  };
  visit(root, "");
  return Object.freeze(found.sort(comparePaths));
}
function sameRoster(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}
const makeTemporaryRoot = (): string => mkdtempSync(join(tmpdir(), "moe-pack-source-"));
const removeTemporaryRoot = (root: string): void => rmSync(root, {
  force: true,
  maxRetries: 3,
  recursive: true,
  retryDelay: 50,
});
/**
 * Callback-only by contract: callers may use sourceRoot only while this function owns it.
 * Git's object database is membership authority; the extracted walk is comparison only.
 */
export function withMaterializedPackSource<T>(
  request: PackSourceRequest,
  consume: (source: MaterializedPackSource) => T,
  dependencies: PackSourceDependencies = {},
): T {
  const resolved = resolvePackSource(request, dependencies.command ?? nodeCommand);
  let ownerRoot: string;
  try {
    ownerRoot = (dependencies.makeTemporaryRoot ?? makeTemporaryRoot)();
  } catch {
    throw new PackSourceError("PACK_SOURCE_ARCHIVE_FAILED");
  }
  const sourceRoot = join(ownerRoot, "source");
  const archive = join(ownerRoot, "source.tar");
  let answer!: T;
  let failed = false;
  let primary: unknown;
  try {
    try {
      mkdirSync(sourceRoot, { recursive: true });
    } catch {
      throw new PackSourceError("PACK_SOURCE_EXTRACT_FAILED");
    }
    runChecked(
      resolved.command,
      "git",
      ["--no-replace-objects", "archive", "--format=tar", "--output", archive, resolved.sourceSha],
      request.repositoryRoot,
      "PACK_SOURCE_ARCHIVE_FAILED",
    );
    runChecked(
      resolved.command,
      "tar",
      process.platform === "win32"
        ? ["-xf", archive, "--options", "hdrcharset=UTF-8", "-C", sourceRoot]
        : ["-xf", archive, "-C", sourceRoot],
      request.repositoryRoot,
      "PACK_SOURCE_EXTRACT_FAILED",
    );
    if (!sameRoster(resolved.trackedPaths, materializedPaths(sourceRoot))) {
      throw new PackSourceError("PACK_SOURCE_ROSTER_MISMATCH");
    }
    answer = consume(Object.freeze({
      sourceRoot,
      sourceSha: resolved.sourceSha,
      trackedPaths: resolved.trackedPaths,
    }));
  } catch (error) {
    failed = true;
    primary = error;
  }
  let cleanupFailed = false;
  try {
    (dependencies.removeTemporaryRoot ?? removeTemporaryRoot)(ownerRoot);
  } catch {
    cleanupFailed = true;
    try {
      dependencies.reportCleanupFailure?.("PACK_SOURCE_CLEANUP_FAILED");
    } catch {
      // Reporting is subordinate to both the primary failure and the cleanup proof.
    }
  }
  if (failed) throw primary;
  if (cleanupFailed) throw new PackSourceError("PACK_SOURCE_CLEANUP_FAILED");
  return answer;
}
