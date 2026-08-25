import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { isAsyncPackConsumerResult } from "./pack-source-consumer.js";
import { postConsumerPackSourceRefusal } from "./pack-source-post-consumer.js";
import { isSensitivePackSourcePath } from "./pack-source-sensitive.js";
import { type WindowsLeaseEntry } from "./pack-windows-process-lease.js";
import { materializedPackSourceLeaseEntries } from "./pack-source-lease.js";
import {
  makePackSourceTemporaryRoot, removePackSourceTemporaryRoot,
  resolveOwnedPackSourceTemporaryRoot,
} from "./pack-source-owner.js";
/** The release boundary that decides which repository bytes packaging may read. */
export const PACKAGING_SOURCE_LAYER = "PACKAGING_SOURCE" as const;
export const PACK_SOURCE_ERROR_CODES = Object.freeze([
  "PACK_SOURCE_INPUT_INVALID", "PACK_SOURCE_COMMIT_UNAVAILABLE",
  "PACK_SOURCE_ROSTER_FAILED", "PACK_SOURCE_ARCHIVE_FAILED",
  "PACK_SOURCE_EXTRACT_FAILED", "PACK_SOURCE_ROSTER_MISMATCH",
  "PACK_SOURCE_CONTENT_MISMATCH", "PACK_SOURCE_MODE_MISMATCH",
  "PACK_SOURCE_SYMLINK_UNSAFE", "PACK_SOURCE_TOOLCHAIN_INVALID", "PACK_SOURCE_BUDGET_EXCEEDED",
  "PACK_SOURCE_SENSITIVE_PATH", "PACK_SOURCE_ASYNC_CONSUMER_UNSUPPORTED",
  "PACK_SOURCE_CLEANUP_FAILED", "PACK_SOURCE_PACKER_DRIFT",
  "PACK_SOURCE_IMMUTABILITY_FAILED",
] as const);
export type PackSourceCode = (typeof PACK_SOURCE_ERROR_CODES)[number];
/** Stable and deliberately non-diagnostic: command output may contain repository secrets. */
export class PackSourceError extends Error {
  public readonly code: PackSourceCode;
  public readonly layer = PACKAGING_SOURCE_LAYER;
  public constructor(code: PackSourceCode) {
    super(code); this.name = "PackSourceError"; this.code = code;
    Object.freeze(this);
  }
}
export interface PackSourceCommandResult {
  readonly error?: unknown; readonly status: number | null; readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}
export type PackSourceCommand = (command: string, args: readonly string[], cwd: string) =>
  PackSourceCommandResult;
export interface PackSourceDependencies {
  readonly gitExecutable: string; readonly tarExecutable: string; readonly command?: PackSourceCommand;
  readonly makeTemporaryRoot?: () => string; readonly removeTemporaryRoot?: (root: string) => void;
  readonly reportCleanupFailure?: (code: "PACK_SOURCE_CLEANUP_FAILED") => void;
  readonly tarFlavor: "bsdtar" | "gnu";
}
export interface PackSourceRequest {
  readonly repositoryRoot: string; readonly sourceSha: string;
}
export interface MaterializedPackSource {
  readonly leaseEntries: readonly WindowsLeaseEntry[];
  readonly sourceRoot: string; readonly sourceSha: string; readonly trackedPaths: readonly string[];
}
const SOURCE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_OUTPUT_LIMIT = 128 * 1024 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_TRACKED_ENTRIES = 10_000;
const MAX_TRACKED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_TRACKED_PATH_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED_PATH_SEGMENTS = 50_000;
const comparePaths = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith("GIT_") && key.toUpperCase() !== "TAR_OPTIONS"));
}
const nodeCommand: PackSourceCommand = (command, args, cwd) => {
  const result = spawnSync(command, [...args], {
    cwd, encoding: null, env: childEnvironment(), maxBuffer: COMMAND_OUTPUT_LIMIT,
    shell: false, timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
  });
  const answer: PackSourceCommandResult = { status: result.status,
    stderr: result.stderr ?? Buffer.alloc(0), stdout: result.stdout ?? Buffer.alloc(0) };
  return result.error === undefined ? answer : { ...answer, error: result.error };
};
function runChecked(commandPort: PackSourceCommand, executable: string, args: readonly string[],
  cwd: string, code: PackSourceCode): Uint8Array {
  try {
    const result = commandPort(executable, args, cwd);
    if (typeof result !== "object" || result === null) throw new Error();
    const error = result.error; const status = result.status;
    const stderr = result.stderr; const stdout = result.stdout;
    if (error !== undefined || status !== 0
      || !(stderr instanceof Uint8Array) || !(stdout instanceof Uint8Array)
      || stdout.byteLength > COMMAND_OUTPUT_LIMIT) throw new Error();
    return stdout;
  } catch {
    throw new PackSourceError(code);
  }
}
function decodeRequest(request: unknown): Readonly<PackSourceRequest> {
  try {
    if (typeof request !== "object" || request === null || Array.isArray(request)) throw new Error();
    if (Object.keys(request).sort().join("\0") !== "repositoryRoot\0sourceSha") throw new Error();
    const candidate = request as Record<string, unknown>;
    const repositoryRoot = candidate["repositoryRoot"];
    const sourceSha = candidate["sourceSha"];
    if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)
      || typeof sourceSha !== "string" || !SOURCE_SHA.test(sourceSha)) throw new Error();
    const canonicalRoot = realpathSync(repositoryRoot);
    if (!statSync(canonicalRoot).isDirectory()) throw new Error();
    return Object.freeze({ repositoryRoot: canonicalRoot, sourceSha });
  } catch {
    throw new PackSourceError("PACK_SOURCE_INPUT_INVALID");
  }
}
interface ResolvedDependencies {
  readonly command: PackSourceCommand; readonly gitExecutable: string; readonly makeTemporaryRoot?: () => string;
  readonly removeTemporaryRoot?: (root: string) => void;
  readonly reportCleanupFailure?: (code: "PACK_SOURCE_CLEANUP_FAILED") => void;
  readonly tarExecutable: string; readonly tarFlavor: "bsdtar" | "gnu";
}
function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function resolveDependencies(dependencies: PackSourceDependencies,
  repositoryRoot: string): Readonly<ResolvedDependencies> {
  try {
    const executable = (value: unknown): string => {
      if (typeof value !== "string" || !isAbsolute(value)) throw new Error();
      const canonical = realpathSync(value);
      if (!statSync(canonical).isFile() || inside(repositoryRoot, canonical)) throw new Error();
      return canonical;
    };
    const command = dependencies.command ?? nodeCommand;
    const makeRoot = dependencies.makeTemporaryRoot; const removeRoot = dependencies.removeTemporaryRoot;
    const reporter = dependencies.reportCleanupFailure; const tarFlavor = dependencies.tarFlavor;
    if (typeof command !== "function"
      || (makeRoot !== undefined && typeof makeRoot !== "function")
      || (removeRoot !== undefined && typeof removeRoot !== "function")
      || (reporter !== undefined && typeof reporter !== "function")
      || (tarFlavor !== "bsdtar" && tarFlavor !== "gnu")) throw new Error();
    return Object.freeze({
      command,
      gitExecutable: executable(dependencies.gitExecutable),
      ...(makeRoot === undefined ? {} : { makeTemporaryRoot: makeRoot }),
      ...(removeRoot === undefined ? {} : { removeTemporaryRoot: removeRoot }),
      ...(reporter === undefined ? {} : { reportCleanupFailure: reporter }),
      tarExecutable: executable(dependencies.tarExecutable),
      tarFlavor,
    });
  } catch {
    throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
  }
}
function utf8(bytes: Uint8Array, code: PackSourceCode): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PackSourceError(code);
  }
}
interface TrackedEntry { readonly mode: "100644" | "100755"; readonly objectSha: string;
  readonly path: string; readonly size: number; }
function parseRoster(bytes: Uint8Array, objectNameLength: number): readonly TrackedEntry[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  if (bytes[bytes.byteLength - 1] !== 0) throw new PackSourceError("PACK_SOURCE_ROSTER_FAILED");
  const framed = utf8(bytes, "PACK_SOURCE_ROSTER_FAILED").split("\0"); framed.pop();
  const entries = framed.map((record): TrackedEntry => {
    const separator = record.indexOf("\t");
    const header = separator < 0 ? "" : record.slice(0, separator); const path = separator < 0
      ? "" : record.slice(separator + 1);
    const match = /^(100644|100755|120000) blob ([0-9a-f]+) +([0-9]+)$/u.exec(header);
    const size = match === null ? Number.NaN : Number(match[3]);
    if (match === null || match[2]?.length !== objectNameLength || !Number.isSafeInteger(size)
      || path.length === 0 || path.includes("\\") || path.includes(":") || path.startsWith("/")
      || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new PackSourceError("PACK_SOURCE_ROSTER_FAILED");
    }
    if (match[1] === "120000") throw new PackSourceError("PACK_SOURCE_SYMLINK_UNSAFE");
    return Object.freeze({ mode: match[1] as TrackedEntry["mode"], objectSha: match[2], path, size });
  });
  const totalBytes = entries.reduce((sum, entry) =>
    Math.min(MAX_TRACKED_TOTAL_BYTES + 1, sum + entry.size), 0);
  const pathBytes = entries.reduce((sum, entry) =>
    Math.min(MAX_TRACKED_PATH_BYTES + 1, sum + Buffer.byteLength(entry.path, "utf8")), 0);
  const pathSegments = entries.reduce((sum, entry) =>
    Math.min(MAX_TRACKED_PATH_SEGMENTS + 1, sum + entry.path.split("/").length), 0);
  if (entries.length > MAX_TRACKED_ENTRIES
    || entries.some(({ size }) => size > MAX_TRACKED_FILE_BYTES)
    || totalBytes > MAX_TRACKED_TOTAL_BYTES || pathBytes > MAX_TRACKED_PATH_BYTES
    || pathSegments > MAX_TRACKED_PATH_SEGMENTS) {
    throw new PackSourceError("PACK_SOURCE_BUDGET_EXCEEDED");
  }
  if (new Set(entries.map(({ path }) => path)).size !== entries.length)
    throw new PackSourceError("PACK_SOURCE_ROSTER_FAILED");
  return Object.freeze(entries.sort((left, right) => comparePaths(left.path, right.path)));
}
interface ResolvedPackSource {
  readonly command: PackSourceCommand; readonly sourceSha: string; readonly gitExecutable: string;
  readonly repositoryRoot: string; readonly trackedEntries: readonly TrackedEntry[];
  readonly trackedPaths: readonly string[];
}
function resolvePackSource(request: PackSourceRequest, commandPort: PackSourceCommand,
  gitExecutable: string): ResolvedPackSource {
  const resolved = utf8(runChecked(
    commandPort, gitExecutable,
    ["--no-replace-objects", "-C", request.repositoryRoot,
      "rev-parse", "--verify", `${request.sourceSha}^{commit}`],
    dirname(gitExecutable), "PACK_SOURCE_COMMIT_UNAVAILABLE",
  ), "PACK_SOURCE_COMMIT_UNAVAILABLE");
  if (resolved !== `${request.sourceSha}\n`) throw new PackSourceError("PACK_SOURCE_COMMIT_UNAVAILABLE");
  const trackedEntries = parseRoster(runChecked(
    commandPort, gitExecutable,
    ["--no-replace-objects", "-C", request.repositoryRoot,
      "ls-tree", "-r", "-z", "--long", "--full-tree", request.sourceSha],
    dirname(gitExecutable), "PACK_SOURCE_ROSTER_FAILED",
  ), request.sourceSha.length);
  if (trackedEntries.some(({ path }) => isSensitivePackSourcePath(path))) {
    throw new PackSourceError("PACK_SOURCE_SENSITIVE_PATH");
  }
  const trackedPaths = Object.freeze(trackedEntries.map(({ path }) => path));
  return Object.freeze({
    command: commandPort, gitExecutable, repositoryRoot: request.repositoryRoot,
    sourceSha: request.sourceSha, trackedEntries, trackedPaths,
  });
}
function verifyTarFlavor(ports: ResolvedDependencies): void {
  const version = utf8(runChecked(
    ports.command, ports.tarExecutable, ["--version"], dirname(ports.tarExecutable),
    "PACK_SOURCE_TOOLCHAIN_INVALID",
  ), "PACK_SOURCE_TOOLCHAIN_INVALID");
  if ((ports.tarFlavor === "bsdtar" && !version.startsWith("bsdtar "))
    || (ports.tarFlavor === "gnu" && !version.startsWith("tar (GNU tar) "))) {
    throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
  }
}
function extractionArguments(ports: ResolvedDependencies, archive: string, sourceRoot: string): string[] {
  if (process.platform !== "win32") return ["-xf", archive, "-C", sourceRoot];
  return ports.tarFlavor === "bsdtar"
    ? ["-xf", archive, "--options", "hdrcharset=UTF-8", "-C", sourceRoot]
    : ["--force-local", "--extract", "--file", archive, "--directory", sourceRoot];
}
function materializedPaths(root: string): readonly string[] {
  const found: string[] = [];
  const pending = [{ directory: root, prefix: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current.directory, { withFileTypes: true });
    } catch {
      throw new PackSourceError("PACK_SOURCE_ROSTER_MISMATCH");
    }
    for (const entry of entries) {
      const path = current.prefix === "" ? entry.name : `${current.prefix}/${entry.name}`;
      if (entry.isDirectory()) pending.push({ directory: join(current.directory, entry.name), prefix: path });
      else if (entry.isFile() || entry.isSymbolicLink()) found.push(path);
      else throw new PackSourceError("PACK_SOURCE_ROSTER_MISMATCH");
    }
  }
  return Object.freeze(found.sort(comparePaths));
}
function sameRoster(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}
function hashBlobHeader(hash: ReturnType<typeof createHash>, size: number): void {
  hash.update(Buffer.from(`blob ${size}\0`, "utf8"));
}
interface VerifiedMaterializedEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}
function materializedBlobIdentity(
  root: string, entry: TrackedEntry, algorithm: "sha1" | "sha256",
): Readonly<{ readonly objectSha: string; readonly sha256: string }> {
  const target = join(root, ...entry.path.split("/"));
  try {
    const stat = lstatSync(target);
    const objectHash = createHash(algorithm);
    const contentHash = createHash("sha256");
    if (!stat.isFile() || stat.size !== entry.size) throw new Error();
    if (process.platform !== "win32"
      && ((stat.mode & 0o111) !== 0) !== (entry.mode === "100755")) {
      throw new PackSourceError("PACK_SOURCE_MODE_MISMATCH");
    }
    hashBlobHeader(objectHash, entry.size);
    const descriptor = openSync(target, "r");
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size !== entry.size) throw new Error();
      const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, entry.size)));
      let consumed = 0;
      while (consumed < entry.size) {
        const count = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, entry.size - consumed), null);
        if (count === 0) throw new Error();
        const bytes = buffer.subarray(0, count);
        objectHash.update(bytes);
        contentHash.update(bytes);
        consumed += count;
      }
      if (readSync(descriptor, buffer, 0, 1, null) !== 0) throw new Error();
    } finally {
      closeSync(descriptor);
    }
    return Object.freeze({
      objectSha: objectHash.digest("hex"), sha256: contentHash.digest("hex"),
    });
  } catch (error) {
    if (error instanceof PackSourceError) throw error;
    throw new PackSourceError("PACK_SOURCE_CONTENT_MISMATCH");
  }
}
function verifyMaterializedContents(
  root: string, resolved: ResolvedPackSource,
): readonly VerifiedMaterializedEntry[] {
  const algorithm = resolved.sourceSha.length === 64 ? "sha256" : "sha1";
  const verified: VerifiedMaterializedEntry[] = [];
  for (const entry of resolved.trackedEntries) {
    const identity = materializedBlobIdentity(root, entry, algorithm);
    if (identity.objectSha !== entry.objectSha) {
      throw new PackSourceError("PACK_SOURCE_CONTENT_MISMATCH");
    }
    verified.push(Object.freeze({
      path: entry.path, sha256: identity.sha256, size: entry.size,
    }));
  }
  return Object.freeze(verified);
}

/**
 * Callback-only by contract: callers may use sourceRoot only while this function owns it.
 * Git's object database is membership authority; the extracted walk is comparison only.
 */
export function withMaterializedPackSource<T>(
  request: PackSourceRequest,
  consume: (source: MaterializedPackSource) => T,
  dependencies: PackSourceDependencies,
): T {
  const decoded = decodeRequest(request);
  const ports = resolveDependencies(dependencies, decoded.repositoryRoot);
  const resolved = resolvePackSource(decoded, ports.command, ports.gitExecutable);
  verifyTarFlavor(ports);
  let ownerRoot: string;
  try {
    ownerRoot = resolveOwnedPackSourceTemporaryRoot(
      (ports.makeTemporaryRoot ?? makePackSourceTemporaryRoot)(),
    );
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
    const archiveBytes = runChecked(
      resolved.command,
      resolved.gitExecutable,
      ["--no-replace-objects", "-C", resolved.repositoryRoot,
        "archive", "--format=tar", resolved.sourceSha],
      dirname(resolved.gitExecutable),
      "PACK_SOURCE_ARCHIVE_FAILED",
    );
    try {
      writeFileSync(archive, archiveBytes, { flag: "wx" });
    } catch {
      throw new PackSourceError("PACK_SOURCE_ARCHIVE_FAILED");
    }
    runChecked(
      resolved.command,
      ports.tarExecutable,
      extractionArguments(ports, archive, sourceRoot),
      dirname(ports.tarExecutable),
      "PACK_SOURCE_EXTRACT_FAILED",
    );
    if (!sameRoster(resolved.trackedPaths, materializedPaths(sourceRoot))) {
      throw new PackSourceError("PACK_SOURCE_ROSTER_MISMATCH");
    }
    const verifiedEntries = verifyMaterializedContents(sourceRoot, resolved);
    let leaseEntries: readonly WindowsLeaseEntry[];
    try {
      leaseEntries = materializedPackSourceLeaseEntries(sourceRoot, verifiedEntries);
    } catch {
      throw new PackSourceError("PACK_SOURCE_IMMUTABILITY_FAILED");
    }
    answer = consume(Object.freeze({
      leaseEntries,
      sourceRoot,
      sourceSha: resolved.sourceSha,
      trackedPaths: resolved.trackedPaths,
    }));
    if (isAsyncPackConsumerResult(answer)) {
      throw new PackSourceError("PACK_SOURCE_ASYNC_CONSUMER_UNSUPPORTED");
    }
    verifyMaterializedContents(sourceRoot, resolved);
    const refusal = postConsumerPackSourceRefusal(materializedPaths(sourceRoot), resolved.trackedPaths);
    if (refusal !== null) throw new PackSourceError(refusal);
  } catch (error) {
    failed = true;
    primary = error;
  }
  let cleanupFailed = false;
  try {
    (ports.removeTemporaryRoot ?? removePackSourceTemporaryRoot)(ownerRoot);
  } catch {
    cleanupFailed = true;
    try {
      ports.reportCleanupFailure?.("PACK_SOURCE_CLEANUP_FAILED");
    } catch {
      // Reporting is subordinate to both the primary failure and the cleanup proof.
    }
  }
  if (failed) throw primary;
  if (cleanupFailed) throw new PackSourceError("PACK_SOURCE_CLEANUP_FAILED");
  return answer;
}
