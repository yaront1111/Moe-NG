import { createHash } from "node:crypto";
import {
  closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const PACK_STEP_FAILED = "PACK_STEP_FAILED" as const;
export const PACK_TOOL_SCHEMA = "moe-pack-tool/1" as const;
const MAX_IDENTITY_FILE_BYTES = 128 * 1024 * 1024;
const MAX_IDENTITY_TREE_BYTES = 256 * 1024 * 1024;
export const MAX_IDENTITY_ENTRIES = 20_000;
const HASH_CHUNK_BYTES = 64 * 1024;

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
  readonly kind: "node" | "pnpm" | "powershell";
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
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
    || !sameCanonicalPath(realpathSync(absolute), absolute)) {
    throw new Error(`${PACK_STEP_FAILED}: tool identity unavailable`);
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
    const root = resolve(rawRoot);
    if (!sameCanonicalPath(realpathSync(root), root)) throw new Error();
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
          if (entries.length >= MAX_IDENTITY_ENTRIES) throw new Error();
          const path = current.prefix === "" ? entry.name : `${current.prefix}/${entry.name}`;
          if (path.includes("\\") || path.split("/").some((segment) =>
            segment === "" || segment === "." || segment === "..")) throw new Error();
          const absolute = join(current.directory, entry.name);
          const stat = lstatSync(absolute, { bigint: true });
          if (stat.isSymbolicLink()) throw new Error();
          if (stat.isDirectory()) {
            entries.push(treeEntry(root, path, "directory"));
            pending.push({ directory: absolute, prefix: path });
          } else if (stat.isFile()) {
            const observed = treeEntry(root, path, "file");
            totalBytes += observed.size;
            if (totalBytes > MAX_IDENTITY_TREE_BYTES) throw new Error();
            entries.push(observed);
          } else throw new Error();
        }
      } finally { directory.closeSync(); }
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
