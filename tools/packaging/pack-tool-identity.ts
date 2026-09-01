import { createHash } from "node:crypto";
import {
  closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const PACK_STEP_FAILED = "PACK_STEP_FAILED" as const;
export const PACK_TOOL_SCHEMA = "moe-pack-tool/1" as const;
const MAX_IDENTITY_FILE_BYTES = 128 * 1024 * 1024;
const MAX_IDENTITY_TREE_BYTES = 256 * 1024 * 1024;
export const MAX_IDENTITY_ENTRIES = 20_000;
const HASH_CHUNK_BYTES = 64 * 1024;

/**
 * Stable refusal vocabulary for the tree walk. Callers assert these by identity off
 * `error.reason`, never by matching prose out of `error.message`.
 */
export const PACK_TREE_ROOT_NOT_CANONICAL = "tree root is not canonical" as const;
export const PACK_TREE_ENTRY_LIMIT = "tree entry limit reached" as const;
export const PACK_TREE_PATH_UNSAFE = "tree path segment is unsafe" as const;
export const PACK_TREE_SYMLINK = "tree entry is a symlink" as const;
export const PACK_TREE_BYTE_LIMIT = "tree byte limit exceeded" as const;
export const PACK_TREE_DIRENT_KIND = "tree entry is not a directory or regular file" as const;
export const PACK_TREE_ENTRY_KIND_MISMATCH = "tree entry kind changed under the walk" as const;
export const PACK_TREE_ENTRY_NOT_CANONICAL = "tree entry path is not canonical" as const;

export type PackIdentityReason =
  | typeof PACK_TREE_ROOT_NOT_CANONICAL | typeof PACK_TREE_ENTRY_LIMIT
  | typeof PACK_TREE_PATH_UNSAFE | typeof PACK_TREE_SYMLINK
  | typeof PACK_TREE_BYTE_LIMIT | typeof PACK_TREE_DIRENT_KIND
  | typeof PACK_TREE_ENTRY_KIND_MISMATCH | typeof PACK_TREE_ENTRY_NOT_CANONICAL;

export type PackIdentityRefusal = Error & {
  readonly reason: PackIdentityReason;
  readonly subject: string;
};

/**
 * Build a tree-walk refusal that names its own condition. The message keeps the
 * `PACK_STEP_FAILED` prefix so `capturePackTreeIdentity`'s tail rethrows it unflattened.
 * Only paths and counters are interpolated - never file content or environment values.
 */
function packIdentityRefusal(
  reason: PackIdentityReason, subject: string, detail = "",
): PackIdentityRefusal {
  const suffix = detail === "" ? "" : ` ${detail}`;
  return Object.assign(new Error(`${PACK_STEP_FAILED}: ${reason} [${subject}]${suffix}`),
    { reason, subject });
}

function direntKind(stat: BigIntStats): string {
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "unknown";
}

export interface PackFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly nlink: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PackTreeEntry {
  readonly dev: string;
  readonly ino: string;
  readonly kind: "directory" | "file";
  readonly mode: string;
  readonly nlink: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PackTreeIdentity {
  readonly entries: readonly PackTreeEntry[];
  readonly root: string;
}

export interface PackToolLaunch {
  readonly argsPrefix: readonly string[];
  readonly executable: PackFileIdentity;
  readonly kind: "cargo" | "node" | "pnpm" | "powershell";
  readonly schemaVersion: typeof PACK_TOOL_SCHEMA;
  readonly tree?: PackTreeIdentity;
  readonly witnesses: readonly PackFileIdentity[];
}

/** Stable tree digest shared by every release-toolchain trust boundary. */
export function normalizedTreeSha256(tree: PackTreeIdentity): string {
  const hash = createHash("sha256");
  for (const entry of tree.entries) {
    for (const field of [entry.kind, entry.path, String(entry.size), entry.sha256]) {
      hash.update(field, "utf8");
      hash.update("\0", "utf8");
    }
  }
  return hash.digest("hex");
}

export function pathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function capturePackFileIdentity(
  rawPath: string, allowHardlinks = false, allowEmpty = false,
): PackFileIdentity {
  let descriptor: number | null = null;
  try {
    if (!isAbsolute(rawPath)) throw new Error();
    const absolute = resolve(rawPath);
    const pathStat = lstatSync(absolute, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink < 1n
      || (!allowHardlinks && pathStat.nlink !== 1n)
      || (!allowEmpty && pathStat.size <= 0n) || pathStat.size < 0n
      || pathStat.size > BigInt(MAX_IDENTITY_FILE_BYTES)) throw new Error();
    const canonical = realpathSync(absolute);
    if (!sameCanonicalPath(canonical, absolute)) throw new Error();
    descriptor = openSync(canonical, "r");
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== pathStat.nlink || opened.size !== pathStat.size
      || (opened.ino !== 0n && pathStat.ino !== 0n && opened.ino !== pathStat.ino)
      || opened.dev !== pathStat.dev) throw new Error();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let consumed = 0n;
    while (consumed < opened.size) {
      const remaining = opened.size - consumed;
      const count = readSync(descriptor, buffer, 0,
        Number(remaining < BigInt(buffer.byteLength) ? remaining : BigInt(buffer.byteLength)), null);
      if (count === 0) throw new Error();
      consumed += BigInt(count);
      hash.update(buffer.subarray(0, count));
    }
    if (readSync(descriptor, buffer, 0, 1, null) !== 0) throw new Error();
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(canonical, { bigint: true });
    if (after.size !== opened.size || after.mode !== opened.mode || after.nlink !== opened.nlink
      || !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== opened.nlink
      || afterPath.size !== opened.size || afterPath.mode !== opened.mode
      || (opened.ino !== 0n && afterPath.ino !== 0n && opened.ino !== afterPath.ino)
      || opened.dev !== afterPath.dev || !sameCanonicalPath(realpathSync(canonical), canonical)) {
      throw new Error();
    }
    return Object.freeze({
      dev: opened.dev.toString(), ino: opened.ino.toString(), mode: opened.mode.toString(),
      nlink: opened.nlink.toString(), path: canonical,
      sha256: hash.digest("hex"), size: Number(opened.size),
    });
  } catch {
    throw new Error(`${PACK_STEP_FAILED}: tool identity unavailable`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function treeEntry(root: string, path: string, kind: "directory" | "file"): PackTreeEntry {
  const absolute = path === "." ? root : join(root, ...path.split("/"));
  const stat = lstatSync(absolute, { bigint: true });
  if (stat.isSymbolicLink()) throw packIdentityRefusal(PACK_TREE_SYMLINK, absolute);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw packIdentityRefusal(PACK_TREE_ENTRY_KIND_MISMATCH, absolute, `expected=${kind}`);
  }
  const canonicalEntry = realpathSync(absolute);
  if (!sameCanonicalPath(canonicalEntry, absolute)) {
    throw packIdentityRefusal(PACK_TREE_ENTRY_NOT_CANONICAL, absolute,
      `realpath=${canonicalEntry}`);
  }
  if (kind === "file") {
    const identity = capturePackFileIdentity(absolute, false, true);
    return Object.freeze({ ...identity, kind, path });
  }
  return Object.freeze({
    dev: stat.dev.toString(), ino: stat.ino.toString(), kind, mode: stat.mode.toString(),
    nlink: stat.nlink.toString(), path, sha256: "", size: 0,
  });
}

export function capturePackTreeIdentity(rawRoot: string): PackTreeIdentity {
  try {
    // Follow the root's own link ONCE and walk the canonical path. Callers cannot always hand
    // over an already-canonical root - macOS `os.tmpdir()` answers `/var/folders/...` whose
    // realpath is `/private/var/folders/...` - and demanding one refused before a single dirent
    // was read. Every per-entry check below is unchanged, so a symlink INSIDE the tree still
    // refuses, and the returned `root` records exactly which path was digested.
    const root = realpathSync(resolve(rawRoot));
    const entries: PackTreeEntry[] = [treeEntry(root, ".", "directory")];
    const pending = [{ directory: root, prefix: "" }];
    let totalBytes = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const directory = opendirSync(current.directory);
      try {
        for (;;) {
          const entry = directory.readSync();
          if (entry === null) break;
          if (entries.length >= MAX_IDENTITY_ENTRIES) {
            throw packIdentityRefusal(PACK_TREE_ENTRY_LIMIT, root, `limit=${MAX_IDENTITY_ENTRIES}`);
          }
          const path = current.prefix === "" ? entry.name : `${current.prefix}/${entry.name}`;
          if (path.includes("\\") || path.split("/").some((segment) =>
            segment === "" || segment === "." || segment === "..")) {
            throw packIdentityRefusal(PACK_TREE_PATH_UNSAFE, path);
          }
          const absolute = join(current.directory, entry.name);
          const stat = lstatSync(absolute, { bigint: true });
          if (stat.isSymbolicLink()) throw packIdentityRefusal(PACK_TREE_SYMLINK, absolute);
          if (stat.isDirectory()) {
            entries.push(treeEntry(root, path, "directory"));
            pending.push({ directory: absolute, prefix: path });
          } else if (stat.isFile()) {
            const observed = treeEntry(root, path, "file");
            totalBytes += observed.size;
            if (totalBytes > MAX_IDENTITY_TREE_BYTES) {
              throw packIdentityRefusal(PACK_TREE_BYTE_LIMIT, absolute,
                `bytes=${totalBytes} limit=${MAX_IDENTITY_TREE_BYTES}`);
            }
            entries.push(observed);
          } else {
            throw packIdentityRefusal(PACK_TREE_DIRENT_KIND, absolute,
              `kind=${direntKind(stat)}`);
          }
        }
      } finally { directory.closeSync(); }
    }
    // Re-verify the walked root the way `capturePackFileIdentity` re-verifies a file it has read:
    // a root relinked mid-walk would leave a digest describing a tree that path no longer names.
    const afterRoot = realpathSync(root);
    if (!sameCanonicalPath(afterRoot, root)) {
      throw packIdentityRefusal(PACK_TREE_ROOT_NOT_CANONICAL, root, `realpath=${afterRoot}`);
    }
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return Object.freeze({ entries: Object.freeze(entries), root });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(PACK_STEP_FAILED)) throw error;
    throw new Error(`${PACK_STEP_FAILED}: tool identity unavailable`);
  }
}

export function freezePackTool(tool: Omit<PackToolLaunch, "schemaVersion">): PackToolLaunch {
  return Object.freeze({
    ...tool, argsPrefix: Object.freeze([...tool.argsPrefix]), schemaVersion: PACK_TOOL_SCHEMA,
    witnesses: Object.freeze([...tool.witnesses]),
  });
}

export function captureNativePackTool(
  kind: PackToolLaunch["kind"], executable: string,
): PackToolLaunch {
  return freezePackTool({
    argsPrefix: [], executable: capturePackFileIdentity(executable, kind === "powershell"),
    kind, witnesses: [],
  });
}

export function assertPackToolIdentity(tool: PackToolLaunch): void {
  try {
    if (JSON.stringify(capturePackFileIdentity(tool.executable.path, tool.kind === "powershell"))
      !== JSON.stringify(tool.executable)) throw new Error();
    for (const witness of tool.witnesses) {
      if (JSON.stringify(capturePackFileIdentity(witness.path)) !== JSON.stringify(witness)) {
        throw new Error();
      }
    }
    if (tool.tree !== undefined
      && JSON.stringify(capturePackTreeIdentity(tool.tree.root)) !== JSON.stringify(tool.tree)) {
      throw new Error();
    }
  } catch {
    throw new Error(`${PACK_STEP_FAILED}: tool identity changed`);
  }
}
