import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  PACK_STEP_FAILED, runPackStep, type PackToolLaunch,
} from "./pack-command.js";
import {
  PackOutputError, assertPackSnapshotsEqual, prepareWindowsArtifactOutput,
  packOutputPathPresent, snapshotPackTree, type PackTreeSnapshot,
} from "./pack-output.js";

export interface ArchiveRosterEntry {
  readonly mode: number;
  readonly path: string;
  readonly size: number;
  readonly type: "file" | "unsupported";
}

export interface WindowsArchivePublishOptions {
  readonly createArchive?: (staging: string, archive: string) => void;
  readonly extractArchive?: (archive: string, destination: string) => void;
  readonly inspectArchive?: (
    archive: string,
  ) => readonly ArchiveRosterEntry[];
  readonly log: (line: string) => void;
  readonly mintNonce?: () => string;
  readonly outputRoot: string;
  readonly powershell?: PackToolLaunch;
  readonly snapshot: PackTreeSnapshot;
  readonly staging: string;
  readonly temporaryRoot: string;
}

const ARCHIVE_NONCE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;

function powerShellLiteral(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

function requiredPowerShell(tool: PackToolLaunch | undefined): PackToolLaunch {
  if (tool === undefined || tool.kind !== "powershell") {
    throw new Error(`${PACK_STEP_FAILED}: PowerShell unavailable`);
  }
  return tool;
}

function createWindowsArchive(
  tool: PackToolLaunch, staging: string, archive: string, log: (line: string) => void,
): void {
  runPackStep(tool, ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; "
    + `[System.IO.Compression.ZipFile]::CreateFromDirectory(${powerShellLiteral(staging)}, `
    + `${powerShellLiteral(archive)}, `
    + "[System.IO.Compression.CompressionLevel]::Optimal, $false)"], staging, log);
}

function extractWindowsArchive(
  tool: PackToolLaunch, archive: string, destination: string, log: (line: string) => void,
): void {
  runPackStep(tool, ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; "
    + `[System.IO.Compression.ZipFile]::ExtractToDirectory(${powerShellLiteral(archive)}, `
    + `${powerShellLiteral(destination)})`], destination, log);
}

function inspectWindowsArchive(
  tool: PackToolLaunch, archive: string, manifest: string, log: (line: string) => void,
): readonly ArchiveRosterEntry[] {
  runPackStep(tool, ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; "
    + `$archive = [System.IO.Compression.ZipFile]::OpenRead(${powerShellLiteral(archive)}); `
    + "try { $items = @($archive.Entries | ForEach-Object { "
    + "$raw = [uint32](([int64]$_.ExternalAttributes) -band 0xffffffffL); "
    + "$unix = [uint32](($raw -shr 16) -band 0xffff); "
    + "$kind = $unix -band 0xf000; $permissions = $unix -band 0x1ff; "
    + "$unsupported = $_.FullName.EndsWith('/') -or (($raw -band 0x410) -ne 0) "
    + "-or ($kind -ne 0 -and $kind -ne 0x8000); "
    + "$mode = if ($kind -eq 0x8000) { $permissions } elseif ($permissions -ne 0) { $permissions } "
    + "elseif (($raw -band 1) -ne 0) { 292 } else { 438 }; "
    + "[pscustomobject]@{ mode = $mode; path = $_.FullName.Replace('\\','/'); "
    + "size = $_.Length; type = $(if ($unsupported) { 'unsupported' } else { 'file' }) } }); "
    + "$payload = [pscustomobject]@{ entries = $items }; "
    + `[System.IO.File]::WriteAllText(${powerShellLiteral(manifest)}, `
    + "($payload | ConvertTo-Json -Compress -Depth 4)) } finally { $archive.Dispose() }"],
  dirname(manifest), log);
  try {
    const metadata = lstatSync(manifest);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
      throw new Error();
    }
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || !Array.isArray((parsed as { readonly entries?: unknown }).entries)) throw new Error();
    return Object.freeze((parsed as {
      readonly entries: readonly ArchiveRosterEntry[];
    }).entries.map((entry) => Object.freeze({
      mode: entry.mode, path: entry.path, size: entry.size, type: entry.type,
    })));
  } catch {
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function verifiedTemporaryRoot(temporaryRoot: string, outputRoot: string, staging: string): string {
  try {
    const rootStat = lstatSync(temporaryRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    const canonical = realpathSync(temporaryRoot);
    const canonicalOutput = realpathSync(outputRoot);
    const canonicalStaging = realpathSync(staging);
    if (inside(canonicalOutput, canonical) || !inside(canonical, canonicalStaging)) throw new Error();
    return canonical;
  } catch {
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

interface ArchiveIdentity {
  readonly sha256: string;
  readonly size: number;
}

function archiveIdentity(path: string, root: string): ArchiveIdentity {
  if (!regularContained(path, root)) throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error();
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
    const pathAfter = lstatSync(path);
    if (!after.isFile() || after.size !== before.size || consumed !== before.size
      || !pathAfter.isFile() || pathAfter.isSymbolicLink()
      || (before.ino !== 0 && pathAfter.ino !== 0 && before.ino !== pathAfter.ino)
      || before.dev !== pathAfter.dev || !inside(root, realpathSync(path))) throw new Error();
    return Object.freeze({ sha256: hash.digest("hex"), size: before.size });
  } catch {
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function assertArchiveIdentity(expected: ArchiveIdentity, actual: ArchiveIdentity): void {
  if (expected.size !== actual.size || expected.sha256 !== actual.sha256) {
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  }
}

function assertArchiveRoster(
  expected: PackTreeSnapshot,
  actual: readonly ArchiveRosterEntry[],
): void {
  const sorted = [...actual].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (sorted.length !== expected.entries.length || sorted.some((entry, index) => {
    const wanted = expected.entries[index];
    return wanted === undefined || typeof entry.path !== "string"
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
      || entry.type !== "file"
      || entry.path.includes("\\") || entry.path.startsWith("/")
      || entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      || entry.path !== wanted.path || entry.mode !== wanted.mode || entry.size !== wanted.size;
  })) throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
}

function verifyExtractedArchive(
  archive: string,
  destination: string,
  expected: PackTreeSnapshot,
  extract: (archive: string, destination: string) => void,
): void {
  mkdirSync(destination, { recursive: false });
  extract(archive, destination);
  const paths = expected.entries.map((entry) => entry.path);
  assertPackSnapshotsEqual(expected, snapshotPackTree(destination, paths));
}

/** Publishes only after three independent reopen-and-digest comparisons. */
export function publishWindowsArchive(options: WindowsArchivePublishOptions): string {
  const nonce = (options.mintNonce ?? randomUUID)();
  if (!ARCHIVE_NONCE.test(nonce)) throw new Error(`${PACK_STEP_FAILED}: invalid archive nonce`);
  const output = prepareWindowsArtifactOutput(options.outputRoot);
  const temporaryRoot = verifiedTemporaryRoot(
    options.temporaryRoot, output.outputRoot, options.staging,
  );
  const temporary = join(temporaryRoot, `moe-windows-${nonce}.zip`);
  const verification = join(temporaryRoot, `verify-${nonce}`);
  const publicVerification = join(temporaryRoot, `verify-public-${nonce}`);
  const finalVerification = join(temporaryRoot, `verify-final-${nonce}`);
  const archiveManifest = join(temporaryRoot, `archive-inventory-${nonce}.json`);
  const publicTemporary = join(output.dist, `.moe-windows-${nonce}.zip`);
  if (packOutputPathPresent(output.zip) || packOutputPathPresent(temporary)
    || packOutputPathPresent(publicTemporary)) {
    throw new PackOutputError("PACK_OUTPUT_PUBLICATION_CONFLICT");
  }
  const create = options.createArchive
    ?? ((staging: string, archive: string) => createWindowsArchive(
      requiredPowerShell(options.powershell), staging, archive, options.log,
    ));
  const extract = options.extractArchive
    ?? ((archive: string, destination: string) => extractWindowsArchive(
      requiredPowerShell(options.powershell), archive, destination, options.log,
    ));
  const inspect = options.inspectArchive
    ?? ((archive: string) => inspectWindowsArchive(
      requiredPowerShell(options.powershell), archive, archiveManifest, options.log,
    ));
  let ownsPublicTemporary = false;
  let ownsPublishedZip = false;
  try {
    const expectedPaths = options.snapshot.entries.map((entry) => entry.path);
    assertPackSnapshotsEqual(options.snapshot, snapshotPackTree(options.staging, expectedPaths));
    create(options.staging, temporary);
    if (!regularContained(temporary, temporaryRoot) || statSync(temporary).size === 0) {
      throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
    }
    const expectedBytes = options.snapshot.entries.reduce((total, entry) => total + entry.size, 0);
    const archiveBudget = expectedBytes + Math.max(
      1024 * 1024, options.snapshot.entries.length * 4096,
    );
    const admittedArchive = archiveIdentity(temporary, temporaryRoot);
    if (admittedArchive.size > archiveBudget) {
      throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
    }
    assertArchiveRoster(options.snapshot, inspect(temporary));
    assertArchiveIdentity(admittedArchive, archiveIdentity(temporary, temporaryRoot));
    verifyExtractedArchive(temporary, verification, options.snapshot, extract);
    assertArchiveIdentity(admittedArchive, archiveIdentity(temporary, temporaryRoot));
    assertPackSnapshotsEqual(options.snapshot, snapshotPackTree(options.staging, expectedPaths));

    const rechecked = prepareWindowsArtifactOutput(options.outputRoot);
    if (rechecked.dist !== output.dist || rechecked.zip !== output.zip
      || packOutputPathPresent(rechecked.zip)) {
      throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
    }
    copyFileSync(temporary, publicTemporary, constants.COPYFILE_EXCL);
    ownsPublicTemporary = true;
    if (!regularContained(publicTemporary, output.dist)) {
      throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
    }
    assertArchiveIdentity(admittedArchive, archiveIdentity(publicTemporary, output.dist));
    verifyExtractedArchive(publicTemporary, publicVerification, options.snapshot, extract);
    assertArchiveIdentity(admittedArchive, archiveIdentity(publicTemporary, output.dist));
    const beforeRename = prepareWindowsArtifactOutput(options.outputRoot);
    if (beforeRename.dist !== output.dist || packOutputPathPresent(beforeRename.zip)) {
      throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
    }
    renameSync(publicTemporary, output.zip);
    ownsPublicTemporary = false;
    ownsPublishedZip = true;
    if (!regularContained(output.zip, output.dist)) {
      throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
    }
    assertArchiveIdentity(admittedArchive, archiveIdentity(output.zip, output.dist));
    verifyExtractedArchive(output.zip, finalVerification, options.snapshot, extract);
    assertArchiveIdentity(admittedArchive, archiveIdentity(output.zip, output.dist));
    ownsPublishedZip = false;
    return output.zip;
  } finally {
    if (ownsPublicTemporary && regularContained(publicTemporary, output.dist)) {
      unlinkSync(publicTemporary);
    }
    if (ownsPublishedZip && regularContained(output.zip, output.dist)) unlinkSync(output.zip);
    if (regularContained(temporary, temporaryRoot)) unlinkSync(temporary);
  }
}
