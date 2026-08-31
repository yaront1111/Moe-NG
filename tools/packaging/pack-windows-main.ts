#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGING_SOURCE_LAYER, PackSourceError, type PackSourceDependencies,
  withMaterializedPackSource } from "./pack-source.js";
import {
  resolveProtectedWindowsPackExecutable, resolveWindowsPackToolchain,
  serializeWindowsPackToolchain, type WindowsPackToolchain,
} from "./pack-command.js";
import type { PackOptions } from "./pack-windows.js";
import { observeWindowsCandidateOutputRoot, publishPrivateWindowsCandidate,
  createPrivateWindowsCandidate, privateWindowsCandidateProcessBoundary,
  removePrivateWindowsCandidate,
  type WindowsCandidateObservation } from "./pack-windows-candidate.js";
import {
  leaseEntriesForTool, mergeWindowsLeaseEntries,
  runWindowsLeasedProcess, WINDOWS_PROCESS_LEASE_SCHEMA,
  type WindowsLeasedProcessResult,
} from "./pack-windows-process-lease.js";

const SOURCE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface WindowsPackCommitRequest {
  readonly log: (line: string) => void;
  readonly outputRoot: string; readonly repositoryRoot: string;
  readonly sourceSha: string;
}

export interface WindowsPackCommitDependencies extends PackSourceDependencies {
  /** Test-only sealed port; production always executes the selected commit's entrypoint. */
  readonly pack?: (options: Omit<PackOptions, "toolchain">) => number;
  readonly publish?: (
    candidateRoot: string, receipt: WindowsCandidateObservation, outputRoot: string,
  ) => void;
  readonly toolchain?: WindowsPackToolchain;
}

interface ProducedCandidate {
  readonly receipt?: WindowsCandidateObservation;
  readonly status: number;
}
const MAX_CHILD_STDERR_BYTES = 4_096;

function boundedChildStderr(stderr: string): string {
  if (Buffer.byteLength(stderr, "utf8") <= MAX_CHILD_STDERR_BYTES) return stderr;
  let prefix = "";
  let size = 0;
  for (const character of stderr) {
    const next = Buffer.byteLength(character, "utf8");
    if (size + next > MAX_CHILD_STDERR_BYTES) break;
    prefix += character; size += next;
  }
  return prefix;
}
export function reportWindowsPackChildRefusal(
  log: (line: string) => void, result: Pick<WindowsLeasedProcessResult, "status" | "stderr">,
): number {
  const { status, stderr } = result;
  if (!Number.isSafeInteger(status) || status === null || status < 1 || status > 0xffff_ffff) {
    throw new PackSourceError("PACK_SOURCE_IMMUTABILITY_FAILED");
  }
  const refusal = Object.freeze({
    code: "PACK_SOURCE_IMMUTABILITY_FAILED", layer: PACKAGING_SOURCE_LAYER, ok: false as const,
    status, stderr: boundedChildStderr(stderr),
    stderrTruncated: Buffer.byteLength(stderr, "utf8") > MAX_CHILD_STDERR_BYTES,
  });
  log(JSON.stringify(refusal));
  return status;
}

function sourceDependencies(
  dependencies: WindowsPackCommitDependencies,
): PackSourceDependencies {
  return {
    gitExecutable: dependencies.gitExecutable,
    tarExecutable: dependencies.tarExecutable,
    tarFlavor: dependencies.tarFlavor,
    ...(dependencies.command === undefined ? {} : { command: dependencies.command }),
    ...(dependencies.makeTemporaryRoot === undefined
      ? {} : { makeTemporaryRoot: dependencies.makeTemporaryRoot }),
    ...(dependencies.removeTemporaryRoot === undefined
      ? {} : { removeTemporaryRoot: dependencies.removeTemporaryRoot }),
    ...(dependencies.reportCleanupFailure === undefined
      ? {} : { reportCleanupFailure: dependencies.reportCleanupFailure }),
  };
}

/** Compose the production packer only inside the verified, callback-owned Git tree. */
export function packWindowsFromCommit(
  request: WindowsPackCommitRequest,
  dependencies: WindowsPackCommitDependencies,
): number {
  const candidate = createPrivateWindowsCandidate();
  let candidateOwned = true;
  let answer = 1;
  let primary: unknown;
  try {
    const produced = withMaterializedPackSource<ProducedCandidate>({
      repositoryRoot: request.repositoryRoot,
      sourceSha: request.sourceSha,
    }, ({ leaseEntries, sourceRoot, sourceSha }) => {
      request.log(`pack: selected tracked commit ${sourceSha}`);
      if (dependencies.pack !== undefined) {
        const status = dependencies.pack({
          log: request.log, outputRoot: candidate.root, sourceRoot, sourceSha,
        });
        return Object.freeze({
          ...(status === 0 ? { receipt: observeWindowsCandidateOutputRoot(candidate.root) } : {}),
          status,
        });
      }
      if (dependencies.toolchain === undefined) {
        throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
      }
      const entry = join(sourceRoot, "tools", "packaging", "pack-windows-materialized-main.ts");
      const manifest = join(candidate.root, `.moe-pack-toolchain-${randomUUID()}.json`);
      const manifestText = serializeWindowsPackToolchain(dependencies.toolchain);
      const manifestDigest = createHash("sha256").update(manifestText, "utf8").digest("hex");
      writeFileSync(manifest, manifestText, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const candidateBoundary = privateWindowsCandidateProcessBoundary(candidate, manifest);
      let result: WindowsLeasedProcessResult;
      try {
        result = runWindowsLeasedProcess(dependencies.toolchain.powershell, Object.freeze({
          args: Object.freeze([
            entry,
            "--output-root", candidate.root,
            "--source-sha", sourceSha,
              "--toolchain-manifest", manifest,
              "--toolchain-digest", manifestDigest,
            ]),
          cwd: sourceRoot,
          executable: dependencies.toolchain.node.executable.path,
          locks: mergeWindowsLeaseEntries(
            leaseEntries,
            leaseEntriesForTool(dependencies.toolchain.node),
            candidateBoundary.leaseEntries,
          ),
          observation: candidateBoundary.observation,
          schemaVersion: WINDOWS_PROCESS_LEASE_SCHEMA,
          timeoutMs: 30 * 60 * 1000,
        }), childEnvironment(request.repositoryRoot, dependencies));
      } catch {
        throw new PackSourceError("PACK_SOURCE_IMMUTABILITY_FAILED");
      } finally {
        removePrivateControlFile(manifest, candidate.root);
      }
      if (typeof result.stdout === "string") {
        for (const line of result.stdout.split(/\r?\n/u)) {
          if (line !== "") request.log(line);
        }
      }
      if (result.error !== undefined || result.kind !== "child-exit" || result.status === null) {
        throw new PackSourceError("PACK_SOURCE_IMMUTABILITY_FAILED");
      }
      if (result.status !== 0) {
        return Object.freeze({ status: reportWindowsPackChildRefusal(request.log, result) });
      }
      if (result.observation === undefined) {
        throw new PackSourceError("PACK_SOURCE_IMMUTABILITY_FAILED");
      }
      return Object.freeze({ receipt: result.observation, status: 0 });
    }, sourceDependencies(dependencies));
    if (produced.status !== 0) {
      answer = produced.status;
    } else {
      if (produced.receipt === undefined) throw new PackSourceError("PACK_SOURCE_IMMUTABILITY_FAILED");
      if (dependencies.publish !== undefined) {
        dependencies.publish(candidate.root, produced.receipt, request.outputRoot);
      } else {
        if (dependencies.toolchain === undefined) {
          throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
        }
        publishPrivateWindowsCandidate(
          candidate, produced.receipt, request.outputRoot, dependencies.toolchain.powershell,
          childEnvironment(request.repositoryRoot, dependencies),
        );
        candidateOwned = false;
      }
      answer = 0;
    }
  } catch (error) {
    primary = error;
  }
  let cleanup: unknown;
  if (candidateOwned) {
    try { removePrivateWindowsCandidate(candidate); } catch (error) { cleanup = error; }
  }
  if (primary !== undefined) throw primary;
  if (cleanup !== undefined) throw cleanup;
  return answer;
}

function removePrivateControlFile(path: string, candidateRoot: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()
      || dirname(realpathSync(path)) !== realpathSync(candidateRoot)) throw new Error();
    unlinkSync(path);
  } catch {
    throw new PackSourceError("PACK_SOURCE_IMMUTABILITY_FAILED");
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Windows packaging admits only fixed protected OS installation paths, never ambient PATH. */
export function resolvePackExecutable(repositoryRoot: string, name: "git" | "tar"): string {
  try {
    const canonicalRoot = realpathSync(repositoryRoot);
    if (!statSync(canonicalRoot).isDirectory()) throw new Error();
    const executable = resolveProtectedWindowsPackExecutable(name);
    if (inside(canonicalRoot, executable)) throw new Error();
    return executable;
  } catch {
    throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
  }
}

export function packChildEnvironment(
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
  trustedToolDirectories: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "CI", "NUMBER_OF_PROCESSORS", "PATHEXT", "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "WINDIR",
  ]);
  const answer = Object.fromEntries(Object.entries(environment).filter(([key]) => {
    return allowed.has(key.toUpperCase());
  }));
  if (repositoryRoot === undefined) return answer;
  const repository = realpathSync(repositoryRoot);
  const directories = trustedToolDirectories.flatMap((raw): string[] => {
    try {
      if (!isAbsolute(raw)) return [];
      const canonical = realpathSync(raw);
      return statSync(canonical).isDirectory() && !inside(repository, canonical) ? [canonical] : [];
    } catch {
      return [];
    }
  });
  answer["PATH"] = [...new Set(directories)].join(delimiter);
  return answer;
}

function trustedDirectories(dependencies: WindowsPackCommitDependencies): readonly string[] {
  const toolchain = dependencies.toolchain;
  return [
    dirname(dependencies.gitExecutable), dirname(dependencies.tarExecutable),
    ...(toolchain === undefined ? [] : [
      dirname(toolchain.node.executable.path), dirname(toolchain.pnpm.executable.path),
      dirname(toolchain.powershell.executable.path),
    ]),
  ];
}

function childEnvironment(
  repositoryRoot?: string,
  dependencies?: WindowsPackCommitDependencies,
): NodeJS.ProcessEnv {
  return repositoryRoot === undefined || dependencies === undefined
    ? packChildEnvironment(process.env)
    : packChildEnvironment(process.env, repositoryRoot, trustedDirectories(dependencies));
}

function command(executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, [...args], {
    cwd: dirname(executable),
    encoding: "utf8",
    env: childEnvironment(),
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
  }
  return result.stdout;
}

function packRuntimeCommand(
  gitExecutable: string,
  repositoryRoot: string,
  args: readonly string[],
): Readonly<{ readonly status: number; readonly stdout: string }> {
  const result = spawnSync(gitExecutable, [
    "--no-replace-objects", "-C", repositoryRoot, ...args,
  ], {
    cwd: dirname(gitExecutable),
    encoding: "utf8",
    env: childEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status === null
    || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
  }
  return Object.freeze({ status: result.status, stdout: result.stdout });
}

/**
 * The bootstrap executes from the operator's checkout before it materializes
 * the selected commit. Refuse if any executable packaging byte differs from
 * that commit, including ignored or otherwise untracked modules.
 */
export function assertPackRuntimeMatchesCommit(
  repositoryRoot: string,
  sourceSha: string,
  gitExecutable: string,
): void {
  if (!SOURCE_SHA.test(sourceSha)) throw new PackSourceError("PACK_SOURCE_COMMIT_UNAVAILABLE");
  const diff = packRuntimeCommand(gitExecutable, repositoryRoot, [
    "diff", "--quiet", "--no-ext-diff", "--no-textconv", sourceSha,
    "--", "package.json", "tools/packaging",
  ]);
  if (diff.status === 1) throw new PackSourceError("PACK_SOURCE_PACKER_DRIFT");
  if (diff.status !== 0) throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");

  const flags = packRuntimeCommand(gitExecutable, repositoryRoot, [
    "ls-files", "-v", "-z", "--", "package.json", "tools/packaging",
  ]);
  if (flags.status !== 0) throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
  const flagRecords = flags.stdout.split("\0").filter((record) => record !== "");
  if (flagRecords.some((record) => !record.startsWith("H "))) {
    throw new PackSourceError("PACK_SOURCE_PACKER_DRIFT");
  }

  const untracked = packRuntimeCommand(gitExecutable, repositoryRoot, [
    "ls-files", "--others", "-z", "--", "package.json", "tools/packaging",
  ]);
  if (untracked.status !== 0) throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
  if (untracked.stdout !== "") throw new PackSourceError("PACK_SOURCE_PACKER_DRIFT");
}

function selectedCommit(repositoryRoot: string, gitExecutable: string): string {
  const sourceSha = command(gitExecutable, [
    "--no-replace-objects", "-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}",
  ]).trim();
  if (!SOURCE_SHA.test(sourceSha)) throw new PackSourceError("PACK_SOURCE_COMMIT_UNAVAILABLE");
  return sourceSha;
}

function selectedTarFlavor(tarExecutable: string): "bsdtar" | "gnu" {
  const version = command(tarExecutable, ["--version"]);
  if (version.startsWith("bsdtar ")) return "bsdtar";
  if (version.startsWith("tar (GNU tar) ")) return "gnu";
  throw new PackSourceError("PACK_SOURCE_TOOLCHAIN_INVALID");
}

export function packWindowsFromRepository(
  repositoryRoot: string,
  log: (line: string) => void,
): number {
  const gitExecutable = resolvePackExecutable(repositoryRoot, "git");
  const tarExecutable = resolvePackExecutable(repositoryRoot, "tar");
  const sourceSha = selectedCommit(repositoryRoot, gitExecutable);
  assertPackRuntimeMatchesCommit(repositoryRoot, sourceSha, gitExecutable);
  const toolchain = resolveWindowsPackToolchain(repositoryRoot, process.env);
  return packWindowsFromCommit({
    log,
    outputRoot: repositoryRoot,
    repositoryRoot,
    sourceSha,
  }, {
    gitExecutable,
    tarExecutable,
    tarFlavor: selectedTarFlavor(tarExecutable),
    toolchain,
  });
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  try {
    if (process.argv.length !== 2) throw new PackSourceError("PACK_SOURCE_INPUT_INVALID");
    process.exitCode = packWindowsFromRepository(
      repositoryRoot,
      (line) => process.stdout.write(`${line}\n`),
    );
  } catch (error) {
    process.stdout.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
