import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  PackOutputError, packOutputPathPresent, prepareWindowsArtifactOutput,
} from "./pack-output.js";
import {
  assertPackToolIdentity, capturePackFileIdentity, type PackToolLaunch,
} from "./pack-command.js";
import {
  captureWindowsLeaseDirectory, leaseDirectoryAncestors, leaseEntriesForFiles,
  mergeWindowsLeaseEntries, type WindowsLeaseEntry,
  type WindowsProcessLeaseObservationRequest,
} from "./pack-windows-process-lease.js";
import {
  WINDOWS_PUBLICATION_COMMAND, WINDOWS_PUBLICATION_CSHARP,
} from "./pack-windows-publication-source.js";

const CANDIDATE_PREFIX = "moe-windows-candidate-owner-";
const CANDIDATE_MARKER = ".moe-windows-candidate-owner";
const WINDOWS_ARCHIVE = "moe-windows.zip";
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;

export interface PrivateWindowsCandidate {
  readonly root: string;
  readonly token: string;
}

export interface WindowsCandidateObservation {
  readonly sha256: string;
  readonly size: number;
}

export interface PrivateWindowsCandidateProcessBoundary {
  readonly leaseEntries: readonly WindowsLeaseEntry[];
  readonly observation: WindowsProcessLeaseObservationRequest;
}

/** Producer-side observation before the private owner token is available to that process. */
export function observeWindowsCandidateOutputRoot(
  outputRoot: string,
): WindowsCandidateObservation {
  try {
    const output = prepareWindowsArtifactOutput(outputRoot);
    if (readdirSync(output.dist).join("\0") !== WINDOWS_ARCHIVE) throw new Error();
    return fileObservation(output.zip, output.dist);
  } catch (error) {
    if (error instanceof PackOutputError) throw error;
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function ownedCandidateRoot(candidate: PrivateWindowsCandidate): string {
  try {
    const root = realpathSync(candidate.root);
    const temporaryParent = realpathSync(tmpdir());
    const stat = lstatSync(root);
    const marker = join(root, CANDIDATE_MARKER);
    const markerStat = lstatSync(marker);
    if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(root) !== temporaryParent
      || !basename(root).startsWith(CANDIDATE_PREFIX)
      || !markerStat.isFile() || markerStat.isSymbolicLink()
      || readFileSync(marker, "utf8") !== candidate.token) throw new Error();
    return root;
  } catch {
    throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
  }
}

export function createPrivateWindowsCandidate(): PrivateWindowsCandidate {
  try {
    const temporaryParent = realpathSync(tmpdir());
    const root = realpathSync(mkdtempSync(join(temporaryParent, CANDIDATE_PREFIX)));
    chmodSync(root, 0o700);
    const token = randomUUID();
    writeFileSync(join(root, CANDIDATE_MARKER), token, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    return Object.freeze({ root, token });
  } catch {
    throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
  }
}

/**
 * Bind the pre-existing owner/control bytes and describe the only generated
 * archive shape the lease helper may admit after its child job has drained.
 */
export function privateWindowsCandidateProcessBoundary(
  candidate: PrivateWindowsCandidate,
  controlPath: string,
): PrivateWindowsCandidateProcessBoundary {
  try {
    const root = ownedCandidateRoot(candidate);
    const control = realpathSync(controlPath);
    const marker = join(root, CANDIDATE_MARKER);
    if (dirname(control) !== root || !basename(control).startsWith(".moe-pack-toolchain-")) {
      throw new Error();
    }
    return Object.freeze({
      leaseEntries: leaseEntriesForFiles([
        capturePackFileIdentity(control), capturePackFileIdentity(marker),
      ]),
      observation: Object.freeze({
        archive: join(root, "dist", WINDOWS_ARCHIVE),
        control,
        dist: join(root, "dist"),
        marker,
        maxBytes: MAX_CANDIDATE_BYTES,
        root,
      }),
    });
  } catch (error) {
    if (error instanceof PackOutputError) throw error;
    throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
  }
}

function regularContained(path: string, root: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && inside(root, realpathSync(path));
  } catch {
    return false;
  }
}

function fileObservation(path: string, root: string): WindowsCandidateObservation {
  if (!regularContained(path, root)) throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  let descriptor: number | null = null;
  try {
    const beforePath = lstatSync(path);
    descriptor = openSync(path, "r");
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size <= 0 || opened.size > MAX_CANDIDATE_BYTES) throw new Error();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let consumed = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      consumed += count;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (consumed !== opened.size || after.size !== opened.size
      || !afterPath.isFile() || afterPath.isSymbolicLink()
      || (opened.ino !== 0 && afterPath.ino !== 0 && opened.ino !== afterPath.ino)
      || opened.dev !== afterPath.dev || beforePath.size !== opened.size
      || !inside(root, realpathSync(path))) throw new Error();
    return Object.freeze({ sha256: hash.digest("hex"), size: opened.size });
  } catch (error) {
    if (error instanceof PackOutputError) throw error;
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function assertSameObservation(
  expected: WindowsCandidateObservation,
  actual: WindowsCandidateObservation,
): void {
  if (expected.size !== actual.size || expected.sha256 !== actual.sha256) {
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  }
}

function candidateArchive(candidate: PrivateWindowsCandidate): Readonly<{
  readonly dist: string;
  readonly root: string;
  readonly zip: string;
}> {
  try {
    const root = ownedCandidateRoot(candidate);
    if (readdirSync(root).sort().join("\0") !== `${CANDIDATE_MARKER}\0dist`) throw new Error();
    const dist = join(root, "dist");
    const distStat = lstatSync(dist);
    if (!distStat.isDirectory() || distStat.isSymbolicLink()
      || realpathSync(dist) !== dist || readdirSync(dist).join("\0") !== WINDOWS_ARCHIVE) {
      throw new Error();
    }
    return Object.freeze({ dist, root, zip: join(dist, WINDOWS_ARCHIVE) });
  } catch (error) {
    if (error instanceof PackOutputError) throw error;
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  }
}

export function observePrivateWindowsCandidate(
  candidate: PrivateWindowsCandidate,
): WindowsCandidateObservation {
  const archive = candidateArchive(candidate);
  return fileObservation(archive.zip, archive.dist);
}

export function publishPrivateWindowsCandidate(
  candidate: PrivateWindowsCandidate,
  expected: WindowsCandidateObservation,
  outputRoot: string,
  powershell: PackToolLaunch,
  environment: NodeJS.ProcessEnv,
): string {
  const candidatePath = candidateArchive(candidate);
  assertSameObservation(expected, fileObservation(candidatePath.zip, candidatePath.dist));
  const output = prepareWindowsArtifactOutput(outputRoot);
  if (packOutputPathPresent(output.zip)) {
    throw new PackOutputError("PACK_OUTPUT_PUBLICATION_CONFLICT");
  }
  if (process.platform !== "win32" || powershell.kind !== "powershell") {
    throw new PackOutputError("PACK_OUTPUT_ATOMIC_PUBLICATION_UNAVAILABLE");
  }
  const marker = join(candidatePath.root, CANDIDATE_MARKER);
  const excluded = new Set([
    candidatePath.root, candidatePath.dist, output.outputRoot, output.dist,
  ].map((path) => path.toLowerCase()));
  const directories = mergeWindowsLeaseEntries(
    leaseDirectoryAncestors(candidatePath.root), leaseDirectoryAncestors(output.outputRoot),
  ).filter((entry) => entry.kind === "directory" && !excluded.has(entry.path.toLowerCase()));
  const request = Object.freeze({
    archiveIdentity: { ...capturePackFileIdentity(candidatePath.zip), kind: "file" },
    candidateArchive: candidatePath.zip,
    candidateDist: candidatePath.dist,
    candidateDistIdentity: captureWindowsLeaseDirectory(candidatePath.dist),
    candidateRoot: candidatePath.root,
    candidateRootIdentity: captureWindowsLeaseDirectory(candidatePath.root),
    directories,
    finalName: WINDOWS_ARCHIVE,
    marker,
    markerIdentity: { ...capturePackFileIdentity(marker), kind: "file" },
    outputDist: output.dist,
    outputDistIdentity: captureWindowsLeaseDirectory(output.dist),
    outputRoot: output.outputRoot,
    outputRootIdentity: captureWindowsLeaseDirectory(output.outputRoot),
    schemaVersion: "moe-windows-publication/1",
    sha256: expected.sha256,
    size: expected.size,
    temporaryName: `.moe-windows-${randomUUID()}.zip`,
    token: candidate.token,
  });
  const requestText = JSON.stringify(request);
  const digest = createHash("sha256").update(requestText, "utf8").digest("hex");
  assertPackToolIdentity(powershell);
  const result = spawnSync(powershell.executable.path, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", WINDOWS_PUBLICATION_COMMAND,
  ], {
    cwd: output.outputRoot,
    encoding: "utf8",
    env: environment,
    input: JSON.stringify({ digest, request: requestText, source: WINDOWS_PUBLICATION_CSHARP }),
    maxBuffer: 1024 * 1024,
    shell: false,
    stdio: "pipe",
    timeout: 120_000,
    windowsHide: true,
  });
  assertPackToolIdentity(powershell);
  if (result.error !== undefined || result.status !== 0
    || result.stdout !== "" || result.stderr !== "") {
    if (packOutputPathPresent(output.zip)) {
      throw new PackOutputError("PACK_OUTPUT_PUBLICATION_CONFLICT");
    }
    throw new PackOutputError("PACK_OUTPUT_ATOMIC_PUBLICATION_UNAVAILABLE");
  }
  assertSameObservation(expected, fileObservation(output.zip, output.dist));
  return output.zip;
}

function validateCandidateTree(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error();
      if (stat.isDirectory()) pending.push(path);
      else if (!stat.isFile()) throw new Error();
    }
  }
}

export function removePrivateWindowsCandidate(candidate: PrivateWindowsCandidate): void {
  try {
    const root = ownedCandidateRoot(candidate);
    validateCandidateTree(root);
    rmSync(root, { force: false, recursive: true });
  } catch {
    throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
  }
}

export function withPrivateWindowsCandidate<T>(
  consume: (candidate: PrivateWindowsCandidate) => T,
): T {
  const candidate = createPrivateWindowsCandidate();
  let answer!: T;
  let failed = false;
  let primary: unknown;
  try {
    answer = consume(candidate);
  } catch (error) {
    failed = true;
    primary = error;
  }
  let cleanup: unknown;
  try {
    removePrivateWindowsCandidate(candidate);
  } catch (error) {
    cleanup = error;
  }
  if (failed) throw primary;
  if (cleanup !== undefined) throw cleanup;
  return answer;
}
