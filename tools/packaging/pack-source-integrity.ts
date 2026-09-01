import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

import { createSensitivePackSourceByteScanner, isSensitivePackSourcePath } from "./pack-source-sensitive.js";

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
const PACK_SOURCE_RUNTIME_STATE_ROOT = ".moe";
export const PACK_SOURCE_ARCHIVE_PATHSPEC = Object.freeze([
  ".", `:(exclude)${PACK_SOURCE_RUNTIME_STATE_ROOT}`,
] as const);

function isPackSourceRuntimeState(path: string): boolean {
  return path.startsWith(`${PACK_SOURCE_RUNTIME_STATE_ROOT}/`);
}

/** Stable and deliberately non-diagnostic: repository contents may be secret. */
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

export interface TrackedEntry {
  readonly mode: "100644" | "100755";
  readonly objectSha: string;
  readonly path: string;
  readonly size: number;
}

export interface VerifiedMaterializedEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PackSourceIntegrityResolution {
  readonly sourceSha: string;
  readonly trackedEntries: readonly TrackedEntry[];
}

const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_TRACKED_ENTRIES = 10_000;
const MAX_TRACKED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_TRACKED_PATH_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED_PATH_SEGMENTS = 50_000;
const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PackSourceError("PACK_SOURCE_ROSTER_FAILED");
  }
}

function checkedEntry(record: string, objectNameLength: number): Readonly<TrackedEntry> {
  const separator = record.indexOf("\t");
  const header = separator < 0 ? "" : record.slice(0, separator);
  const path = separator < 0 ? "" : record.slice(separator + 1);
  const match = /^(100644|100755|120000) blob ([0-9a-f]+) +([0-9]+)$/u.exec(header);
  const size = match === null ? Number.NaN : Number(match[3]);
  if (match === null || match[2]?.length !== objectNameLength || !Number.isSafeInteger(size)
    || path.length === 0 || path.includes("\\") || path.includes(":") || path.startsWith("/")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new PackSourceError("PACK_SOURCE_ROSTER_FAILED");
  }
  if (match[1] === "120000") throw new PackSourceError("PACK_SOURCE_SYMLINK_UNSAFE");
  return Object.freeze({
    mode: match[1] as TrackedEntry["mode"], objectSha: match[2], path, size,
  });
}

function assertRosterBudgets(entries: readonly TrackedEntry[]): void {
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
}

export function parseRoster(bytes: Uint8Array, objectNameLength: number): readonly TrackedEntry[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  if (bytes[bytes.byteLength - 1] !== 0) throw new PackSourceError("PACK_SOURCE_ROSTER_FAILED");
  const framed = utf8(bytes).split("\0");
  framed.pop();
  const parsed = framed.map((record) => checkedEntry(record, objectNameLength));
  const entries = parsed.filter(({ path }) => !isPackSourceRuntimeState(path));
  assertRosterBudgets(entries);
  if (new Set(entries.map(({ path }) => path)).size !== entries.length) {
    throw new PackSourceError("PACK_SOURCE_ROSTER_FAILED");
  }
  if (entries.some(({ path }) => isSensitivePackSourcePath(path))) {
    throw new PackSourceError("PACK_SOURCE_SENSITIVE_PATH");
  }
  return Object.freeze(entries.sort((left, right) => comparePaths(left.path, right.path)));
}

export function materializedPaths(root: string): readonly string[] {
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

export function sameRoster(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

/** Git records only the owner's execute bit in its canonical 100644/100755 modes. */
export function isGitExecutableMode(mode: number): boolean {
  return (mode & 0o100) !== 0;
}

function materializedBlobIdentity(
  root: string,
  entry: TrackedEntry,
  algorithm: "sha1" | "sha256",
): Readonly<{ readonly objectSha: string; readonly sensitive: boolean; readonly sha256: string }> {
  const target = join(root, ...entry.path.split("/"));
  try {
    const stat = lstatSync(target);
    const objectHash = createHash(algorithm);
    const contentHash = createHash("sha256");
    if (!stat.isFile() || stat.size !== entry.size) throw new Error();
    if (process.platform !== "win32"
      && isGitExecutableMode(stat.mode) !== (entry.mode === "100755")) {
      throw new PackSourceError("PACK_SOURCE_MODE_MISMATCH");
    }
    objectHash.update(Buffer.from(`blob ${entry.size}\0`, "utf8"));
    const sensitive = hashFile(target, entry.size, objectHash, contentHash);
    return Object.freeze({
      objectSha: objectHash.digest("hex"), sensitive, sha256: contentHash.digest("hex"),
    });
  } catch (error) {
    if (error instanceof PackSourceError) throw error;
    throw new PackSourceError("PACK_SOURCE_CONTENT_MISMATCH");
  }
}

function hashFile(
  target: string,
  size: number,
  objectHash: ReturnType<typeof createHash>,
  contentHash: ReturnType<typeof createHash>,
): boolean {
  const descriptor = openSync(target, "r");
  const scanner = createSensitivePackSourceByteScanner();
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== size) throw new Error();
    const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, size)));
    let consumed = 0;
    while (consumed < size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, size - consumed), null);
      if (count === 0) throw new Error();
      const bytes = buffer.subarray(0, count);
      objectHash.update(bytes);
      contentHash.update(bytes);
      scanner.inspect(bytes);
      consumed += count;
    }
    if (readSync(descriptor, buffer, 0, 1, null) !== 0) throw new Error();
  } finally {
    closeSync(descriptor);
  }
  return scanner.sensitive;
}

export function verifyMaterializedContents(
  root: string,
  resolved: PackSourceIntegrityResolution,
): readonly VerifiedMaterializedEntry[] {
  const algorithm = resolved.sourceSha.length === 64 ? "sha256" : "sha1";
  const verified: VerifiedMaterializedEntry[] = [];
  for (const entry of resolved.trackedEntries) {
    const identity = materializedBlobIdentity(root, entry, algorithm);
    if (identity.objectSha !== entry.objectSha) {
      throw new PackSourceError("PACK_SOURCE_CONTENT_MISMATCH");
    }
    if (identity.sensitive) throw new PackSourceError("PACK_SOURCE_SENSITIVE_PATH");
    verified.push(Object.freeze({ path: entry.path, sha256: identity.sha256, size: entry.size }));
  }
  return Object.freeze(verified);
}
