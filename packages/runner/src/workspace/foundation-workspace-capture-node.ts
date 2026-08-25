import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { join, sep } from "node:path";

import { canonicalPathRejection } from "../scope/scope-contract.js";
import {
  captureFailure,
  isFoundationCaptureFailure,
  MAX_FOUNDATION_CAPTURE_ENTRIES,
  type FoundationCaptureDirent,
  type FoundationCaptureFailure,
  type FoundationCaptureFsPort,
  type FoundationCaptureLimits,
  type FoundationCaptureStat,
} from "./foundation-workspace-capture-contract.js";
import type { ScannedFile } from "./foundation-workspace-capture-rules.js";
import type { ResultEntryKind } from "./workspace-contract.js";

/**
 * The Node filesystem boundary of the Foundation capture scanner: the shipped
 * port, and the bounded link-free enumeration that drives it. The decisions
 * taken on what it finds live next door in the rules module; this file owns
 * only HOW bytes are obtained, and the bracket that makes them trustworthy.
 */

const LAYER = "RUNNER_WORKSPACE_CAPTURE" as const;

/**
 * Directory nesting remains independently bounded even though every observed
 * dirent now spends the global entry budget. Deep enough that no real declared
 * scope reaches it, shallow enough that the recursion cannot.
 */
const MAX_SCAN_DEPTH = 64;

/**
 * The fixed working buffer of every handle read. The body is hashed as it
 * arrives and never accumulated, so this is the ENTIRE allocation a file of
 * any size may cause — a 5 GiB file and a 5 byte one cost the same 64 KiB.
 */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * The widest enumeration the scanner can legitimately ask for: the whole entry
 * ceiling plus the one sentinel that proves the ceiling was passed. A bound
 * above this did not come from the scanner's remaining budget, and enumerating
 * to it would be the unbounded allocation this port exists to prevent.
 */
const MAX_LIST_BOUND = MAX_FOUNDATION_CAPTURE_ENTRIES + 1;

function kindOf(stats: BigIntStats | Dirent): ResultEntryKind {
  if (stats.isSymbolicLink()) return "SYMLINK";
  if (stats.isDirectory()) return "DIRECTORY";
  if (stats.isFile()) return "REGULAR";
  return "OTHER";
}

function statOf(stats: BigIntStats): FoundationCaptureStat {
  return {
    kind: kindOf(stats),
    byteLength: Number(stats.size),
    // `dev:ino` alone is NOT an identity on Linux: ext4 recycles a freed inode
    // number immediately, so unlink-then-recreate between the lstat and the
    // open yields the SAME dev:ino for a different object. `ctimeNs` pins the
    // inode's change time — a recreated file always carries a fresh one — and
    // stays constant across the bracket for an untouched file.
    identity: `${stats.dev.toString()}:${stats.ino.toString()}:${stats.ctimeNs.toString()}`,
  };
}

/**
 * The shipped port. `lstatPath` never follows a final link, and every question
 * after `openRead` is answered by the DESCRIPTOR — that pairing is what lets
 * the containment verdict and the bytes describe one object.
 */
export function createNodeFoundationCaptureFs(): FoundationCaptureFsPort {
  return Object.freeze({
    listDirectory: (path: string, maximumEntries: number): readonly FoundationCaptureDirent[] => {
      // Validated BEFORE the handle opens: a bound that is not a positive safe
      // integer inside the ceiling cannot bound anything, and the diagnostic
      // repeats only the caller's own number, never the path or an OS message.
      if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0 || maximumEntries > MAX_LIST_BOUND) {
        throw new RangeError(`maximumEntries must be a safe integer in 1..${MAX_LIST_BOUND}`);
      }
      const directory = opendirSync(path, { bufferSize: Math.min(32, maximumEntries) });
      const entries: FoundationCaptureDirent[] = [];
      try {
        while (entries.length < maximumEntries) {
          const entry = directory.readSync();
          if (entry === null) break;
          entries.push({ name: entry.name, kind: kindOf(entry) });
        }
      } finally {
        directory.closeSync();
      }
      return entries;
    },
    lstatPath: (path: string): FoundationCaptureStat => statOf(lstatSync(path, { bigint: true })),
    openRead: (path: string): number => openSync(path, "r"),
    fstatHandle: (handle: number): FoundationCaptureStat => statOf(fstatSync(handle, { bigint: true })),
    readHandle: (handle: number, destination: Uint8Array): number => {
      // The destination IS the bound. A zero-length one would read nothing and
      // report 0, which the scanner reads as end-of-file — a silent truncation
      // dressed up as a complete file, so it is refused here instead.
      if (!(destination instanceof Uint8Array) || destination.byteLength <= 0) {
        throw new RangeError("destination must be a non-empty Uint8Array");
      }
      return readSync(handle, destination, 0, destination.byteLength, null);
    },
    closeHandle: (handle: number): void => closeSync(handle),
    realpath: (path: string): string => realpathSync(path),
    exists: (path: string): boolean => existsSync(path),
  });
}

const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);

export function isInside(realRoot: string, resolved: string): boolean {
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return fold(resolved) === fold(realRoot) || fold(resolved).startsWith(fold(prefix));
}

interface ScanState {
  readonly fs: FoundationCaptureFsPort;
  readonly realRoot: string;
  readonly limits: FoundationCaptureLimits;
  readonly files: ScannedFile[];
  /** Every NODE reached, file or directory — the unit the entry budget buys. */
  readonly seen: Set<string>;
  bytes: number;
  entries: number;
}

const unreadable = (path: string, what: string): FoundationCaptureFailure =>
  captureFailure("RUNNER_FOUNDATION_CAPTURE_PATH_UNREADABLE", LAYER, `path ${JSON.stringify(path)} could not be ${what}`, path);

const byteLimit = (state: ScanState, path: string): FoundationCaptureFailure =>
  captureFailure("RUNNER_FOUNDATION_CAPTURE_BYTE_LIMIT", LAYER, `the declared tree exceeds ${state.limits.maxAggregateBytes} aggregate bytes`, path);

const entryLimit = (state: ScanState, path: string): FoundationCaptureFailure =>
  captureFailure("RUNNER_FOUNDATION_CAPTURE_ENTRY_LIMIT", LAYER, `the declared tree exceeds ${state.limits.maxEntries} entries`, path);

const swapped = (path: string, detail: string): FoundationCaptureFailure =>
  captureFailure("RUNNER_FOUNDATION_CAPTURE_IDENTITY_SWAPPED", LAYER, `path ${JSON.stringify(path)}: ${detail}`, path);

function kindRejection(kind: ResultEntryKind, path: string): FoundationCaptureFailure | null {
  if (kind === "SYMLINK") {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_PATH_SYMLINKED", LAYER, `path ${JSON.stringify(path)} is a symlink or junction`, path);
  }
  if (kind !== "REGULAR") {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_PATH_KIND_UNSUPPORTED", LAYER, `path ${JSON.stringify(path)} is ${kind}, not a regular file`, path);
  }
  return null;
}

function containmentRejection(state: ScanState, absolute: string, path: string, identity: string): FoundationCaptureFailure | null {
  const resolved = state.fs.realpath(absolute);
  if (!isInside(state.realRoot, resolved)) {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_PATH_ESCAPED", LAYER, `path ${JSON.stringify(path)} resolves outside the assigned root`, path);
  }
  if (state.fs.lstatPath(resolved).identity !== identity) {
    return swapped(path, "the contained path is not the object held open");
  }
  return null;
}

interface BoundedRead {
  readonly sha256: string;
  readonly byteLength: number;
}

function readHandleBounded(state: ScanState, handle: number, path: string): BoundedRead | FoundationCaptureFailure {
  const remaining = state.limits.maxAggregateBytes - state.bytes;
  const buffer = new Uint8Array(Math.min(READ_CHUNK_BYTES, Math.max(1, remaining)));
  const hash = createHash("sha256");
  let consumed = 0;
  let reachedEnd = false;
  const read = (maximumBytes: number): number => {
    const destination = buffer.subarray(0, maximumBytes);
    const count = state.fs.readHandle(handle, destination);
    if (!Number.isSafeInteger(count) || count < 0 || count > destination.byteLength) {
      throw new Error("filesystem port returned an invalid read count");
    }
    return count;
  };
  while (consumed < remaining) {
    const count = read(Math.min(buffer.byteLength, remaining - consumed));
    if (count === 0) {
      reachedEnd = true;
      break;
    }
    hash.update(buffer.subarray(0, count));
    consumed += count;
  }
  if (!reachedEnd && read(1) !== 0) {
    return byteLimit(state, path);
  }
  return { sha256: hash.digest("hex"), byteLength: consumed };
}

/**
 * Reads one regular file under a bracket, so the bytes and the containment
 * verdict describe ONE verified object.
 *
 * `lstat` names the object, `openRead` takes a handle, `fstat` on THAT handle
 * must agree with the `lstat` identity, containment is resolved by path and
 * tied back to the same identity, and a final `fstat` must still match the
 * bytes just read. Break any link — hash by path, drop an identity comparison —
 * and a file swapped mid-scan is hashed as though it were the file that passed.
 */
function readBracketed(state: ScanState, absolute: string, path: string): ScannedFile | FoundationCaptureFailure {
  let before: FoundationCaptureStat;
  try {
    before = state.fs.lstatPath(absolute);
  } catch {
    return unreadable(path, "stat'd");
  }
  const kindFailure = kindRejection(before.kind, path);
  if (kindFailure !== null) return kindFailure;
  // Budgeted from the STAT, before a single byte is allocated. Checking only
  // after the read would mean a 5 GiB file exhausts memory to learn it was
  // over budget; the post-read check below still catches a file that grew.
  if (state.bytes + before.byteLength > state.limits.maxAggregateBytes) {
    return byteLimit(state, path);
  }
  let handle: number;
  try {
    handle = state.fs.openRead(absolute);
  } catch {
    return unreadable(path, "opened");
  }
  try {
    const opened = state.fs.fstatHandle(handle);
    const openedFailure = kindRejection(opened.kind, path);
    if (openedFailure !== null) return openedFailure;
    if (opened.identity !== before.identity) {
      return swapped(path, "the opened handle is not the object that was stat'd");
    }
    const contained = containmentRejection(state, absolute, path, opened.identity);
    if (contained !== null) return contained;
    const read = readHandleBounded(state, handle, path);
    if (isFoundationCaptureFailure(read)) return read;
    const after = state.fs.fstatHandle(handle);
    if (after.identity !== opened.identity || after.byteLength !== read.byteLength) {
      return swapped(path, "the file changed underneath the read");
    }
    return { path, sha256: read.sha256, byteLength: read.byteLength };
  } catch {
    // Every rule above RETURNS its refusal, so anything thrown in here came
    // from the port: a read, an fstat or a realpath the filesystem refused.
    return unreadable(path, "read");
  } finally {
    try {
      state.fs.closeHandle(handle);
    } catch {
      // A close that fails cannot invalidate bytes already hashed from the handle.
    }
  }
}

/**
 * Spends one entry slot on a node the scan has not reached before.
 *
 * The budget buys NODES, not files: a tree that is only directories used to
 * cost nothing, so `maxEntries` bounded the answer without bounding the walk.
 * A repeat is not a refusal — overlapping declared scopes name the same
 * canonical paths — but it must not be charged or enumerated a second time.
 */
type EntryVisit = "FIRST" | "REPEAT" | FoundationCaptureFailure;

function visitNode(state: ScanState, path: string): EntryVisit {
  if (state.seen.has(path)) return "REPEAT";
  if (state.entries + 1 > state.limits.maxEntries) return entryLimit(state, path);
  state.entries += 1;
  state.seen.add(path);
  return "FIRST";
}

function admitFile(state: ScanState, absolute: string, path: string): FoundationCaptureFailure | null {
  const file = readBracketed(state, absolute, path);
  if (isFoundationCaptureFailure(file)) return file;
  // No post-read budget check: `readBracketed` never returns more bytes than
  // the budget had left, so a check here could only ever be decoration.
  state.bytes += file.byteLength;
  state.files.push(file);
  return null;
}

/** Depth-first, link-free enumeration of one declared subtree, budget enforced. */
function walk(
  state: ScanState,
  absolute: string,
  path: string,
  kind: ResultEntryKind,
  depth: number,
): FoundationCaptureFailure | null {
  // Narrowed by the literals, not by the failure guard: that guard uses `in`,
  // which throws on a string primitive rather than answering false.
  const visit = visitNode(state, path);
  if (visit === "REPEAT") return null;
  if (visit !== "FIRST") return visit;
  if (kind !== "DIRECTORY") {
    return kind === "REGULAR" ? admitFile(state, absolute, path) : kindRejection(kind, path);
  }
  if (depth >= MAX_SCAN_DEPTH) {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_DEPTH_LIMIT", LAYER, `the declared tree nests deeper than ${MAX_SCAN_DEPTH} directories`, path);
  }
  // Only what the budget has LEFT, plus the one sentinel name that proves the
  // directory overruns it. Each child charges its own slot in its own visit.
  const remaining = state.limits.maxEntries - state.entries;
  let entries: readonly FoundationCaptureDirent[];
  try {
    entries = state.fs.listDirectory(absolute, remaining + 1);
  } catch {
    return unreadable(path, "listed");
  }
  // Refused before the clone and the sort: an over-budget directory must not
  // buy itself a second full-size array on the way out.
  if (entries.length > remaining) {
    return entryLimit(state, path);
  }
  const ordered = [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of ordered) {
    const childPath = `${path}/${entry.name}`;
    const rejection = canonicalPathRejection(childPath);
    if (rejection !== null) {
      return captureFailure("RUNNER_FOUNDATION_CAPTURE_PATH_NOT_CANONICAL", LAYER, `path ${JSON.stringify(childPath)} is not canonical (${rejection})`, childPath);
    }
    const failure = walk(state, join(absolute, entry.name), childPath, entry.kind, depth + 1);
    if (failure !== null) return failure;
  }
  return null;
}

/**
 * Enumerates every declared subtree. A declared path that does not exist yet is
 * legal and contributes nothing — the same rule `observeScope` applies — but a
 * path that exists and is not a directory or a regular file refuses.
 */
export function scanDeclaredTrees(
  fs: FoundationCaptureFsPort,
  realRoot: string,
  declaredScopePaths: readonly string[],
  limits: FoundationCaptureLimits,
): readonly ScannedFile[] | FoundationCaptureFailure {
  const state: ScanState = { fs, realRoot, limits, files: [], seen: new Set(), bytes: 0, entries: 0 };
  for (const path of [...declaredScopePaths].sort()) {
    const absolute = join(realRoot, path);
    let kind: ResultEntryKind;
    try {
      if (!fs.exists(absolute)) continue;
      kind = fs.lstatPath(absolute).kind;
    } catch {
      return unreadable(path, "probed");
    }
    const failure = walk(state, absolute, path, kind, 0);
    if (failure !== null) return failure;
  }
  return state.files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
