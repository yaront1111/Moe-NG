/**
 * Cutover manifest: the evidence that legacy bytes did not move under the
 * operator between the two captures DoD 2 requires, and that they are still
 * readable and unchanged after an abort (DoD 3).
 *
 * 1. NOTHING IS EVER SILENTLY SKIPPED. An unreadable entry, an entry that is
 *    neither a regular file nor a directory, and a tree past either bound all
 *    REFUSE with a stable code, a layer, and the exact failing path. A skipped
 *    file is a file that could have changed unobserved.
 * 2. THE ORDER IS THE SPEC. Entries are sorted by their UTF-8 bytes, never by
 *    directory-iteration order, which differs between Windows, macOS and Linux
 *    and would make two manifests of an unchanged tree disagree across hosts.
 *
 * Refusals are returned, not thrown: a thrown error is indistinguishable from a
 * crash at the call site, and the drill has to assert WHICH layer refused.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export const CUTOVER_MANIFEST_LAYER = "cutover-manifest";

export type CutoverManifestRefusalCode =
  | "CUTOVER_MANIFEST_ROOT_UNREADABLE"
  | "CUTOVER_MANIFEST_UNREADABLE_ENTRY"
  | "CUTOVER_MANIFEST_UNSUPPORTED_ENTRY"
  | "CUTOVER_MANIFEST_DEPTH_EXCEEDED"
  | "CUTOVER_MANIFEST_ENTRY_LIMIT_EXCEEDED"
  | "CUTOVER_MANIFEST_COUNT_INCONSISTENT"
  | "CUTOVER_MANIFEST_EMPTY";

export interface CutoverRefusal {
  readonly ok: false;
  readonly layer: typeof CUTOVER_MANIFEST_LAYER;
  readonly code: CutoverManifestRefusalCode;
  readonly path: string;
  readonly detail: string;
}

export interface CutoverManifestEntry {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface CutoverManifest {
  readonly root: string;
  /** Recorded explicitly so a truncated or empty walk cannot masquerade as a match. */
  readonly entryCount: number;
  readonly entries: readonly CutoverManifestEntry[];
}

export type CutoverManifestResult =
  | { readonly ok: true; readonly manifest: CutoverManifest }
  | CutoverRefusal;

/** Bounds are explicit refusals, never an unbounded recursion that ends in a stack overflow. */
export const MAX_WALK_DEPTH = 32;
export const MAX_WALK_ENTRIES = 10_000;

/** Structural subset of `fs.Dirent`; real dirents satisfy it without adaptation. */
export interface CutoverDirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * The two filesystem reads the walk performs. Real `node:fs` is the default and
 * the only implementation shipped here; the seam exists so the drill can drive
 * the UNREADABLE_ENTRY and UNSUPPORTED_ENTRY branches of THIS production walk on
 * every host, rather than skipping them on the platforms where a permission bit
 * or a fifo cannot be created. The branches under test are real code.
 */
export interface CutoverWalkPorts {
  readonly readDirectory: (absolute: string) => readonly CutoverDirent[];
  readonly readFile: (absolute: string) => Buffer;
}

export interface CutoverWalkOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly ports?: CutoverWalkPorts;
}

const NODE_PORTS: CutoverWalkPorts = {
  readDirectory: (absolute) => readdirSync(absolute, { withFileTypes: true }),
  readFile: (absolute) => readFileSync(absolute),
};

/** Shared with the comparison half so both refuse under one layer and one code set. */
export const refuseManifest = (
  code: CutoverManifestRefusalCode,
  path: string,
  detail: string,
): CutoverRefusal => ({ ok: false, layer: CUTOVER_MANIFEST_LAYER, code, path, detail });

const refuse = refuseManifest;

/**
 * Compare by UTF-8 bytes. That ordering is exactly code-point order, it is
 * locale-independent, and unlike the default string comparison it does not
 * misorder supplementary-plane names against U+E000..U+FFFF. Case is never
 * folded: two files differing only in case are two files.
 */
const byUtf8Bytes = (left: CutoverManifestEntry, right: CutoverManifestEntry): number =>
  Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));

/** The manifest key is POSIX-normalised; the file is always read through the real path. */
const toPosixKey = (relative: string): string => relative.split(sep).join("/");

interface PendingDirectory {
  readonly absolute: string;
  readonly relative: string;
  readonly depth: number;
}

const readEntry = (
  ports: CutoverWalkPorts,
  absolute: string,
  key: string,
): CutoverManifestEntry | CutoverRefusal => {
  let content: Buffer;
  try {
    content = ports.readFile(absolute);
  } catch (error) {
    return refuse("CUTOVER_MANIFEST_UNREADABLE_ENTRY", key, String(error));
  }
  return {
    path: key,
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
};

const walk = (root: string, options: CutoverWalkOptions): CutoverManifestEntry[] | CutoverRefusal => {
  const ports = options.ports ?? NODE_PORTS;
  const maxDepth = options.maxDepth ?? MAX_WALK_DEPTH;
  const maxEntries = options.maxEntries ?? MAX_WALK_ENTRIES;
  const entries: CutoverManifestEntry[] = [];
  const queue: PendingDirectory[] = [{ absolute: root, relative: "", depth: 0 }];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      break;
    }
    const here = toPosixKey(current.relative);
    if (current.depth > maxDepth) {
      return refuse("CUTOVER_MANIFEST_DEPTH_EXCEEDED", here, `depth ${current.depth} exceeds ${maxDepth}`);
    }

    let dirents: readonly CutoverDirent[];
    try {
      dirents = ports.readDirectory(current.absolute);
    } catch (error) {
      return refuse("CUTOVER_MANIFEST_UNREADABLE_ENTRY", here, String(error));
    }

    for (const dirent of dirents) {
      const absolute = join(current.absolute, dirent.name);
      const relative = current.relative === "" ? dirent.name : join(current.relative, dirent.name);
      const key = toPosixKey(relative);

      if (dirent.isDirectory()) {
        queue.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!dirent.isFile()) {
        return refuse("CUTOVER_MANIFEST_UNSUPPORTED_ENTRY", key, "entry is neither a regular file nor a directory");
      }
      if (entries.length >= maxEntries) {
        return refuse("CUTOVER_MANIFEST_ENTRY_LIMIT_EXCEEDED", key, `entry count exceeds ${maxEntries}`);
      }
      const entry = readEntry(ports, absolute, key);
      if ("ok" in entry) {
        return entry;
      }
      entries.push(entry);
    }
  }

  return entries.sort(byUtf8Bytes);
};

export const captureCutoverManifest = (
  root: string,
  options: CutoverWalkOptions = {},
): CutoverManifestResult => {
  try {
    if (!statSync(root).isDirectory()) {
      return refuse("CUTOVER_MANIFEST_ROOT_UNREADABLE", root, "root is not a directory");
    }
  } catch (error) {
    return refuse("CUTOVER_MANIFEST_ROOT_UNREADABLE", root, String(error));
  }

  const walked = walk(root, options);
  if ("ok" in walked) {
    return walked;
  }
  return { ok: true, manifest: { root, entryCount: walked.length, entries: walked } };
};
