import { createHash } from "node:crypto";
import {
  closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  opendirSync, realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const PACKAGING_OUTPUT_LAYER = "PACKAGING_OUTPUT" as const;
export const PACK_OUTPUT_CODES = Object.freeze([
  "PACK_OUTPUT_PATH_UNSAFE",
  "PACK_OUTPUT_BUDGET_EXCEEDED",
  "PACK_OUTPUT_SNAPSHOT_DRIFT",
  "PACK_OUTPUT_PUBLICATION_CONFLICT",
  "PACK_OUTPUT_ATOMIC_PUBLICATION_UNAVAILABLE",
] as const);
export type PackOutputCode = (typeof PACK_OUTPUT_CODES)[number];

export class PackOutputError extends Error {
  public readonly code: PackOutputCode;
  public readonly layer = PACKAGING_OUTPUT_LAYER;
  public constructor(code: PackOutputCode) {
    super(code);
    this.name = "PackOutputError";
    this.code = code;
    Object.freeze(this);
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export interface WindowsArtifactOutput {
  readonly dist: string;
  readonly outputRoot: string;
  readonly zip: string;
}

function regularContainedFile(path: string, root: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && inside(root, realpathSync(path));
  } catch {
    return false;
  }
}

export function packOutputPathPresent(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** Creates or rechecks only ordinary output directories; junctions never become write roots. */
export function prepareWindowsArtifactOutput(outputRoot: string): WindowsArtifactOutput {
  try {
    if (!isAbsolute(outputRoot)) throw new Error();
    const rootStat = lstatSync(outputRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    const canonicalRoot = realpathSync(outputRoot);
    const dist = join(canonicalRoot, "dist");
    if (!packOutputPathPresent(dist)) {
      try { mkdirSync(dist, { recursive: false }); } catch { /* recheck a concurrent creator */ }
    }
    const distStat = lstatSync(dist);
    if (!distStat.isDirectory() || distStat.isSymbolicLink()) throw new Error();
    const canonicalDist = realpathSync(dist);
    if (!inside(canonicalRoot, canonicalDist)) throw new Error();
    const zip = join(canonicalDist, "moe-windows.zip");
    if (packOutputPathPresent(zip) && !regularContainedFile(zip, canonicalDist)) throw new Error();
    return Object.freeze({ dist: canonicalDist, outputRoot: canonicalRoot, zip });
  } catch {
    throw new PackOutputError("PACK_OUTPUT_PATH_UNSAFE");
  }
}

export interface PackSnapshotEntry {
  readonly mode: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}
export interface PackTreeSnapshot { readonly entries: readonly PackSnapshotEntry[]; }

export interface PackSnapshotLimits {
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
}

interface ResolvedPackSnapshotLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

const DEFAULT_PACK_SNAPSHOT_LIMITS: ResolvedPackSnapshotLimits = Object.freeze({
  maxEntries: 20_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxFiles: 10_000,
  maxTotalBytes: 256 * 1024 * 1024,
});
const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_PACK_SNAPSHOT_LIMITS));

function resolveSnapshotLimits(value: PackSnapshotLimits | undefined): ResolvedPackSnapshotLimits {
  if (value === undefined) return DEFAULT_PACK_SNAPSHOT_LIMITS;
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).some((key) => !LIMIT_KEYS.includes(key))) {
    throw new PackOutputError("PACK_OUTPUT_BUDGET_EXCEEDED");
  }
  const limit = (key: keyof ResolvedPackSnapshotLimits): number => {
    const candidate = value[key];
    if (candidate === undefined) return DEFAULT_PACK_SNAPSHOT_LIMITS[key];
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new PackOutputError("PACK_OUTPUT_BUDGET_EXCEEDED");
    }
    return Math.min(candidate, DEFAULT_PACK_SNAPSHOT_LIMITS[key]);
  };
  return Object.freeze({
    maxEntries: limit("maxEntries"),
    maxFileBytes: limit("maxFileBytes"),
    maxFiles: limit("maxFiles"),
    maxTotalBytes: limit("maxTotalBytes"),
  });
}

const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function pathsUnder(root: string, limits: ResolvedPackSnapshotLimits): readonly string[] {
  const paths: string[] = [];
  let entryCount = 0;
  let totalBytes = 0;
  const pending: Array<Readonly<{ directory: string; prefix: string }>> = [
    Object.freeze({ directory: root, prefix: "" }),
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const directoryStat = lstatSync(current.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
    }
    const opened = opendirSync(current.directory);
    try {
      for (;;) {
        const entry = opened.readSync();
        if (entry === null) break;
        entryCount += 1;
        if (entryCount > limits.maxEntries) {
          throw new PackOutputError("PACK_OUTPUT_BUDGET_EXCEEDED");
        }
        const path = current.prefix === "" ? entry.name : `${current.prefix}/${entry.name}`;
        const absolute = join(current.directory, entry.name);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
        if (stat.isDirectory()) {
          pending.push(Object.freeze({ directory: absolute, prefix: path }));
        } else if (stat.isFile()) {
          if (stat.size > limits.maxFileBytes || paths.length + 1 > limits.maxFiles) {
            throw new PackOutputError("PACK_OUTPUT_BUDGET_EXCEEDED");
          }
          totalBytes += stat.size;
          if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
            throw new PackOutputError("PACK_OUTPUT_BUDGET_EXCEEDED");
          }
          paths.push(path);
        } else {
          throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
        }
      }
    } finally {
      opened.closeSync();
    }
  }
  return Object.freeze(paths.sort(comparePaths));
}

function digestFile(root: string, path: string, maxFileBytes: number): PackSnapshotEntry {
  const absolute = join(root, ...path.split("/"));
  let descriptor: number | null = null;
  try {
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error();
    if (before.size > maxFileBytes) {
      throw new PackOutputError("PACK_OUTPUT_BUDGET_EXCEEDED");
    }
    descriptor = openSync(absolute, "r");
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size) throw new Error();
    if (opened.size > maxFileBytes) {
      throw new PackOutputError("PACK_OUTPUT_BUDGET_EXCEEDED");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let consumed = 0;
    while (consumed < opened.size) {
      const count = readSync(
        descriptor, buffer, 0, Math.min(buffer.byteLength, opened.size - consumed), null,
      );
      if (count === 0) throw new Error();
      hash.update(buffer.subarray(0, count));
      consumed += count;
    }
    if (readSync(descriptor, buffer, 0, 1, null) !== 0) throw new Error();
    const after = fstatSync(descriptor);
    const afterPath = lstatSync(absolute);
    if (after.size !== opened.size || after.mode !== opened.mode || consumed !== opened.size
      || !afterPath.isFile() || afterPath.isSymbolicLink()
      || afterPath.size !== opened.size || afterPath.mode !== opened.mode
      || (opened.ino !== 0 && afterPath.ino !== 0 && opened.ino !== afterPath.ino)
      || opened.dev !== afterPath.dev) throw new Error();
    return Object.freeze({
      mode: opened.mode & 0o777, path, sha256: hash.digest("hex"), size: opened.size,
    });
  } catch (error) {
    if (error instanceof PackOutputError) throw error;
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function validExpectedPaths(paths: readonly string[]): readonly string[] {
  if (!Array.isArray(paths)) throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  const sorted = [...paths].sort(comparePaths);
  if (new Set(sorted).size !== sorted.length || sorted.some((path) =>
    typeof path !== "string" || path === "" || path.includes("\\") || path.startsWith("/")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))) {
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  }
  return Object.freeze(sorted);
}

/** Freezes the exact regular-file roster and bytes admitted for compression. */
export function snapshotPackTree(
  root: string,
  expectedPaths?: readonly string[],
  requestedLimits?: PackSnapshotLimits,
): PackTreeSnapshot {
  try {
    const limits = resolveSnapshotLimits(requestedLimits);
    const canonicalRoot = realpathSync(root);
    const actual = pathsUnder(canonicalRoot, limits);
    if (expectedPaths !== undefined) {
      const expected = validExpectedPaths(expectedPaths);
      if (actual.length !== expected.length
        || actual.some((path, index) => path !== expected[index])) {
        throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
      }
    }
    const entries = actual.map((path) => digestFile(canonicalRoot, path, limits.maxFileBytes));
    const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      throw new PackOutputError("PACK_OUTPUT_BUDGET_EXCEEDED");
    }
    return Object.freeze({ entries: Object.freeze(entries) });
  } catch (error) {
    if (error instanceof PackOutputError) throw error;
    throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
  }
}

export function assertPackSnapshotsEqual(
  expected: PackTreeSnapshot,
  actual: PackTreeSnapshot,
): void {
  const left = expected.entries;
  const right = actual.entries;
  if (left.length !== right.length || left.some((entry, index) => {
    const other = right[index];
    return other === undefined || entry.path !== other.path
      || entry.mode !== other.mode || entry.size !== other.size || entry.sha256 !== other.sha256;
  })) throw new PackOutputError("PACK_OUTPUT_SNAPSHOT_DRIFT");
}
