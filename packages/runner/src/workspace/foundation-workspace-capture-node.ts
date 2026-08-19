import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { join, sep } from "node:path";

import { canonicalPathRejection } from "../scope/scope-contract.js";
import {
  captureFailure,
  isFoundationCaptureFailure,
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
 * Directory nesting bound. The entry budget counts FILES, so a tree that is
 * only directories would recurse without ever spending it and die on a stack
 * overflow — a crash, not a refusal. Deep enough that no real declared scope
 * reaches it, shallow enough that the recursion cannot.
 */
const MAX_SCAN_DEPTH = 64;

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
    identity: `${stats.dev.toString()}:${stats.ino.toString()}`,
  };
}

/**
 * The shipped port. `lstatPath` never follows a final link, and every question
 * after `openRead` is answered by the DESCRIPTOR — that pairing is what lets
 * the containment verdict and the bytes describe one object.
 */
export function createNodeFoundationCaptureFs(): FoundationCaptureFsPort {
  return Object.freeze({
    listDirectory: (path: string): readonly FoundationCaptureDirent[] =>
      readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, kind: kindOf(entry) })),
    lstatPath: (path: string): FoundationCaptureStat => statOf(lstatSync(path, { bigint: true })),
    openRead: (path: string): number => openSync(path, "r"),
    fstatHandle: (handle: number): FoundationCaptureStat => statOf(fstatSync(handle, { bigint: true })),
    readHandle: (handle: number): Uint8Array => new Uint8Array(readFileSync(handle)),
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
  readonly seen: Set<string>;
  bytes: number;
}

const unreadable = (path: string, what: string): FoundationCaptureFailure =>
  captureFailure("RUNNER_FOUNDATION_CAPTURE_PATH_UNREADABLE", LAYER, `path ${JSON.stringify(path)} could not be ${what}`, path);

const byteLimit = (state: ScanState, path: string): FoundationCaptureFailure =>
  captureFailure("RUNNER_FOUNDATION_CAPTURE_BYTE_LIMIT", LAYER, `the declared tree exceeds ${state.limits.maxAggregateBytes} aggregate bytes`, path);

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
    const bytes = state.fs.readHandle(handle);
    const after = state.fs.fstatHandle(handle);
    if (after.identity !== opened.identity || after.byteLength !== bytes.byteLength) {
      return swapped(path, "the file changed underneath the read");
    }
    return { path, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
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

function admitFile(state: ScanState, absolute: string, path: string): FoundationCaptureFailure | null {
  if (state.seen.has(path)) return null;
  if (state.files.length + 1 > state.limits.maxEntries) {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_ENTRY_LIMIT", LAYER, `the declared tree exceeds ${state.limits.maxEntries} entries`, path);
  }
  const file = readBracketed(state, absolute, path);
  if (isFoundationCaptureFailure(file)) return file;
  if (state.bytes + file.byteLength > state.limits.maxAggregateBytes) {
    return byteLimit(state, path);
  }
  state.bytes += file.byteLength;
  state.seen.add(path);
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
  if (kind !== "DIRECTORY") {
    return kind === "REGULAR" ? admitFile(state, absolute, path) : kindRejection(kind, path);
  }
  if (depth >= MAX_SCAN_DEPTH) {
    return captureFailure("RUNNER_FOUNDATION_CAPTURE_DEPTH_LIMIT", LAYER, `the declared tree nests deeper than ${MAX_SCAN_DEPTH} directories`, path);
  }
  let entries: readonly FoundationCaptureDirent[];
  try {
    entries = state.fs.listDirectory(absolute);
  } catch {
    return unreadable(path, "listed");
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
  const state: ScanState = { fs, realRoot, limits, files: [], seen: new Set(), bytes: 0 };
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
