import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isAsyncPackConsumerResult } from "./pack-source-consumer.js";
import { PackSourceError, materializedPaths, parseRoster, sameRoster, verifyMaterializedContents,
  type PackSourceCode, type PackSourceIntegrityResolution } from "./pack-source-integrity.js";
import { postConsumerPackSourceRefusal } from "./pack-source-post-consumer.js";
import { type WindowsLeaseEntry } from "./pack-windows-process-lease.js";
import { materializedPackSourceLeaseEntries } from "./pack-source-lease.js";
import { makePackSourceTemporaryRoot, removePackSourceTemporaryRoot, resolveOwnedPackSourceTemporaryRoot } from "./pack-source-owner.js";
export { PACKAGING_SOURCE_LAYER, PACK_SOURCE_ERROR_CODES, PackSourceError } from "./pack-source-integrity.js";
export type { PackSourceCode } from "./pack-source-integrity.js";
export interface PackSourceCommandResult { readonly error?: unknown; readonly status: number | null;
  readonly stderr: Uint8Array; readonly stdout: Uint8Array; }
export type PackSourceCommand = (command: string, args: readonly string[], cwd: string) => PackSourceCommandResult;
export interface PackSourceDependencies {
  readonly gitExecutable: string; readonly tarExecutable: string; readonly command?: PackSourceCommand;
  readonly makeTemporaryRoot?: () => string; readonly removeTemporaryRoot?: (root: string) => void;
  readonly reportCleanupFailure?: (code: "PACK_SOURCE_CLEANUP_FAILED") => void; readonly tarFlavor: "bsdtar" | "gnu";
}
export interface PackSourceRequest { readonly repositoryRoot: string; readonly sourceSha: string; }
export interface MaterializedPackSource {
  readonly leaseEntries: readonly WindowsLeaseEntry[]; readonly sourceRoot: string;
  readonly sourceSha: string; readonly trackedPaths: readonly string[];
}
const SOURCE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const COMMAND_TIMEOUT_MS = 120_000; const COMMAND_OUTPUT_LIMIT = 128 * 1024 * 1024;
function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith("GIT_") && key.toUpperCase() !== "TAR_OPTIONS"));
}
const nodeCommand: PackSourceCommand = (command, args, cwd) => {
  const result = spawnSync(command, [...args], {
    cwd, encoding: null, env: childEnvironment(), maxBuffer: COMMAND_OUTPUT_LIMIT,
    shell: false, timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
  });
  const answer: PackSourceCommandResult = { status: result.status, stderr: result.stderr ?? Buffer.alloc(0),
    stdout: result.stdout ?? Buffer.alloc(0) };
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
  readonly removeTemporaryRoot?: (root: string) => void; readonly tarExecutable: string;
  readonly reportCleanupFailure?: (code: "PACK_SOURCE_CLEANUP_FAILED") => void; readonly tarFlavor: "bsdtar" | "gnu";
}
function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function resolveDependencies(dependencies: PackSourceDependencies, repositoryRoot: string): Readonly<ResolvedDependencies> {
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
interface ResolvedPackSource extends PackSourceIntegrityResolution {
  readonly command: PackSourceCommand; readonly sourceSha: string; readonly gitExecutable: string;
  readonly repositoryRoot: string; readonly trackedPaths: readonly string[];
}
function resolvePackSource(request: PackSourceRequest, commandPort: PackSourceCommand, gitExecutable: string): ResolvedPackSource {
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
