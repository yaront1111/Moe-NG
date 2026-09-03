/**
 * Cutover manifest: the evidence that legacy bytes did not move under the
 * operator between the two captures DoD 2 requires, and that they are still
 * readable and unchanged after an abort (DoD 3).
 *
 * 1. NOTHING IS EVER SILENTLY SKIPPED. An unreadable entry, an entry that is
 *    neither a regular file, a directory nor a symbolic link, and a tree past
 *    either bound all REFUSE with a stable code, a layer, and the exact failing
 *    path. A skipped file is a file that could have changed unobserved. The two
 *    things this walk does NOT hash are both RECORDED rather than dropped:
 *      - A SYMLINK (a pnpm workspace junction, for instance) is manifested as a
 *        distinct LINK entry carrying its resolved target. It is never followed,
 *        so a junction cannot smuggle another package tree in under a second
 *        path, and its target moving is a difference the comparison can name.
 *      - An EXCLUDED DIRECTORY is manifested in `excludedDirectories`. A pnpm
 *        workspace puts tens of thousands of files under `node_modules` trees
 *        that no cutover is about; declining to descend them is a boundary the
 *        record DECLARES, so a walk that skipped more than it admits cannot
 *        masquerade as a match.
 *    Anything still unclassifiable remains a hard refusal.
 * 2. THE ORDER IS THE SPEC. Entries are sorted by their UTF-8 bytes, never by
 *    directory-iteration order, which differs between Windows, macOS and Linux
 *    and would make two manifests of an unchanged tree disagree across hosts.
 *
 * Refusals are returned, not thrown: a thrown error is indistinguishable from a
 * crash at the call site, and the drill has to assert WHICH layer refused.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export const CUTOVER_MANIFEST_LAYER = "cutover-manifest";

export type CutoverManifestRefusalCode =
  | "CUTOVER_MANIFEST_ROOT_UNREADABLE"
  | "CUTOVER_MANIFEST_UNREADABLE_ENTRY"
  | "CUTOVER_MANIFEST_UNSUPPORTED_ENTRY"
  | "CUTOVER_MANIFEST_DEPTH_EXCEEDED"
  | "CUTOVER_MANIFEST_ENTRY_LIMIT_EXCEEDED"
  | "CUTOVER_MANIFEST_COUNT_INCONSISTENT"
  | "CUTOVER_MANIFEST_EMPTY"
  /** The two captures declared different exclusion sets, so they compared different populations. */
  | "CUTOVER_MANIFEST_EXCLUSION_MISMATCH";

export interface CutoverRefusal {
  readonly ok: false;
  readonly layer: typeof CUTOVER_MANIFEST_LAYER;
  readonly code: CutoverManifestRefusalCode;
  readonly path: string;
  readonly detail: string;
}

export interface CutoverFileEntry {
  readonly kind: "FILE";
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** A link has no bytes of its own, so it carries a target instead of a hash. */
export interface CutoverLinkEntry {
  readonly kind: "LINK";
  readonly path: string;
  readonly target: string;
}

/**
 * A DISCRIMINATED UNION, not one shape with optional fields. A file and a link
 * at the same path are different facts about that path, and the discriminant is
 * what stops the comparison from reading a missing `sha256` off a link as
 * `undefined` and quietly concluding the two agree.
 */
export type CutoverManifestEntry = CutoverFileEntry | CutoverLinkEntry;

export interface CutoverManifest {
  readonly root: string;
  /** Recorded explicitly so a truncated or empty walk cannot masquerade as a match. */
  readonly entryCount: number;
  readonly entries: readonly CutoverManifestEntry[];
  /**
   * Sorted POSIX keys of every directory the walk declined to descend. Recorded
   * for the same reason as `entryCount`: an undeclared skip is indistinguishable
   * from a tree that never held the files.
   */
  readonly excludedDirectories: readonly string[];
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
  /**
   * REQUIRED, not optional. Every fake dirent has to state what it is, so no
   * existing fixture silently acquires link behaviour it was never written for.
   */
  isSymbolicLink(): boolean;
}

/**
 * The default exclusions, and the difference between a walk and a refusal on
 * this repo. Every name here is DEPENDENCY OR DERIVED OUTPUT, never source:
 * `node_modules` (pnpm junctions, and the wall the live run hit), `dist` and
 * `target` (build output, 0 tracked files between them), `.git` (the object
 * store, which any commit rewrites). MEASURED 2026-09-03 on this checkout:
 * 22473 non-`node_modules` files on the FILESYSTEM — the tracked count of 5777
 * badly understates it — falling to 8257 with these four excluded, which is
 * what fits under MAX_WALK_ENTRIES without moving that bound.
 */
export const DEFAULT_EXCLUDED_DIRECTORY_NAMES: readonly string[] = [
  ".git",
  "dist",
  "node_modules",
  "target",
];

/**
 * The three filesystem reads the walk performs. Real `node:fs` is the default
 * and the only implementation shipped here; the seam exists so the drill can
 * drive the UNREADABLE_ENTRY, UNSUPPORTED_ENTRY and LINK branches of THIS
 * production walk on every host, rather than skipping them on the platforms
 * where a permission bit, a fifo or a junction cannot be created. The branches
 * under test are real code.
 */
export interface CutoverWalkPorts {
  readonly readDirectory: (absolute: string) => readonly CutoverDirent[];
  readonly readFile: (absolute: string) => Buffer;
  /** Resolves a link to where it points. Throwing here is an UNREADABLE_ENTRY, never an empty target. */
  readonly readLinkTarget: (absolute: string) => string;
}

export interface CutoverWalkOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  /** Directory NAMES never descended into. Defaults to DEFAULT_EXCLUDED_DIRECTORY_NAMES; [] excludes nothing. */
  readonly excludedDirectoryNames?: readonly string[];
  readonly ports?: CutoverWalkPorts;
}

const NODE_PORTS: CutoverWalkPorts = {
  readDirectory: (absolute) => readdirSync(absolute, { withFileTypes: true }),
  readFile: (absolute) => readFileSync(absolute),
  readLinkTarget: (absolute) => readlinkSync(absolute, { encoding: "utf8" }),
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
const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const byUtf8Bytes = (left: CutoverManifestEntry, right: CutoverManifestEntry): number =>
  compareUtf8(left.path, right.path);

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
    kind: "FILE",
    path: key,
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
};

interface WalkAccumulator {
  readonly entries: CutoverManifestEntry[];
  readonly excludedDirectories: string[];
  readonly queue: PendingDirectory[];
}

interface WalkLimits {
  readonly ports: CutoverWalkPorts;
  readonly maxEntries: number;
  readonly excludedNames: ReadonlySet<string>;
}

interface DirentLocation {
  readonly absolute: string;
  readonly relative: string;
  readonly key: string;
  readonly depth: number;
}

/** Classifies one dirent. Returns a refusal, or `undefined` once it is recorded. */
const visitDirent = (
  dirent: CutoverDirent,
  at: DirentLocation,
  limits: WalkLimits,
  into: WalkAccumulator,
): CutoverRefusal | undefined => {
  const overLimit = (): CutoverRefusal | undefined =>
    into.entries.length >= limits.maxEntries
      ? refuse("CUTOVER_MANIFEST_ENTRY_LIMIT_EXCEEDED", at.key, `entry count exceeds ${limits.maxEntries}`)
      : undefined;

  // A LINK is classified BEFORE a directory. A Windows junction can answer true
  // to isDirectory() as well, and following one would walk another package tree
  // in under a second path — or, with a cycle, run straight to the depth bound.
  // A link counts toward maxEntries like a file: the bound is about walk size.
  if (dirent.isSymbolicLink()) {
    const bounded = overLimit();
    if (bounded !== undefined) {
      return bounded;
    }
    let target: string;
    try {
      target = limits.ports.readLinkTarget(at.absolute);
    } catch (error) {
      return refuse("CUTOVER_MANIFEST_UNREADABLE_ENTRY", at.key, String(error));
    }
    into.entries.push({ kind: "LINK", path: at.key, target });
    return undefined;
  }

  if (dirent.isDirectory()) {
    // Excluded where the directory is QUEUED, not where its children are read,
    // so an excluded tree is never descended and cannot reach the entry bound.
    // Matched on the NAME: an ordinary file called `node_modules.md` is not a
    // `node_modules` directory, and a path substring would swallow it.
    if (limits.excludedNames.has(dirent.name)) {
      into.excludedDirectories.push(at.key);
      return undefined;
    }
    into.queue.push({ absolute: at.absolute, relative: at.relative, depth: at.depth + 1 });
    return undefined;
  }

  if (!dirent.isFile()) {
    const why = "entry is neither a regular file, a directory nor a symbolic link";
    return refuse("CUTOVER_MANIFEST_UNSUPPORTED_ENTRY", at.key, why);
  }
  const bounded = overLimit();
  if (bounded !== undefined) {
    return bounded;
  }
  const entry = readEntry(limits.ports, at.absolute, at.key);
  if ("ok" in entry) {
    return entry;
  }
  into.entries.push(entry);
  return undefined;
};

interface WalkProduct {
  readonly entries: CutoverManifestEntry[];
  readonly excludedDirectories: string[];
}

const walk = (root: string, options: CutoverWalkOptions): WalkProduct | CutoverRefusal => {
  const ports = options.ports ?? NODE_PORTS;
  const maxDepth = options.maxDepth ?? MAX_WALK_DEPTH;
  const limits: WalkLimits = {
    ports,
    maxEntries: options.maxEntries ?? MAX_WALK_ENTRIES,
    excludedNames: new Set(options.excludedDirectoryNames ?? DEFAULT_EXCLUDED_DIRECTORY_NAMES),
  };
  const into: WalkAccumulator = {
    entries: [],
    excludedDirectories: [],
    queue: [{ absolute: root, relative: "", depth: 0 }],
  };

  while (into.queue.length > 0) {
    const current = into.queue.pop();
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
      const relative = current.relative === "" ? dirent.name : join(current.relative, dirent.name);
      const at: DirentLocation = {
        absolute: join(current.absolute, dirent.name),
        relative,
        key: toPosixKey(relative),
        depth: current.depth,
      };
      const refusal = visitDirent(dirent, at, limits, into);
      if (refusal !== undefined) {
        return refusal;
      }
    }
  }

  return {
    entries: into.entries.sort(byUtf8Bytes),
    excludedDirectories: into.excludedDirectories.sort(compareUtf8),
  };
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
  return {
    ok: true,
    manifest: {
      root,
      entryCount: walked.entries.length,
      entries: walked.entries,
      excludedDirectories: walked.excludedDirectories,
    },
  };
};
