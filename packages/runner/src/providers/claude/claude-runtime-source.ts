import { win32 } from "node:path";
import { types } from "node:util";

import { isNormalizedText } from "../../canonical.js";
import {
  MAX_RUNTIME_CLOSURE_ENTRIES,
  MAX_RUNTIME_TEXT_CHARS,
  RUNTIME_CLOSURE_KINDS,
  type RuntimeClosureKind,
} from "./claude-observation.js";
import { streamDigest, type ClaudeRuntimeFsPort } from "./claude-runtime-pin-fs.js";
// Statement-form `import type` on purpose: `verbatimModuleSyntax` keeps an inline
// `{ type X }` import alive at runtime, making this and closure a real ESM cycle.
// Closure stays sole owner of the refusal VOCABULARY; this module only names codes.
import type { ClaudeRuntimePinErrorCode } from "./claude-runtime-pin-closure.js";

/**
 * The shared source-inspection engine behind the Claude runtime pin.
 *
 * One authority answers "is this caller-named path a real, contained, unchanged
 * plain file, and what are its bytes" for both the quote path (`resolveSources`)
 * and caller-named discovery (`discoverSources`). Two copies of a Windows
 * path/reparse/containment rule drift apart, and the one that drifts is the one
 * an attacker gets to choose. It validates BEFORE it reads and re-proves identity
 * AFTER it reads, so a path swapped between the check and the stream cannot be
 * reported as proven. It holds no authority: it returns an internal code/message
 * failure for its caller to convert, and never enumerates, spawns, or logs.
 *
 * Consuming task: task-32eddfd3c9644558b7218778e1f07e92.
 */
export interface RuntimeSourceCandidate {
  readonly kind: RuntimeClosureKind;
  readonly path: string;
}

/** A candidate plus the digest a quote declared for it, when one was declared. */
export interface InspectedCandidate extends RuntimeSourceCandidate {
  readonly expectedSha256: string | null;
}

export interface SourceEntry {
  readonly kind: RuntimeClosureKind;
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly sha256: string;
}

/** Not a refusal: the caller owns the layer/truthClass shape this becomes. */
export interface SourceInspectionFailure {
  readonly code: ClaudeRuntimePinErrorCode;
  readonly message: string;
}

const fail = (code: ClaudeRuntimePinErrorCode, message: string): SourceInspectionFailure =>
  Object.freeze({ code, message });
const isFailure = (value: SourceEntry | SourceInspectionFailure): value is SourceInspectionFailure =>
  "code" in value;

/** Windows path identity is case-insensitive, so every comparison folds. */
export const fold = (value: string): string => value.toLowerCase();

/**
 * Rejects UNC, device (`\\?\`, `\\.\`), relative and reserved-character forms
 * before any filesystem call, because `resolve` normalises several of them into
 * something that then passes a prefix check against the containment root.
 */
const LOCAL_ABSOLUTE = /^[A-Za-z]:\\(?:[^\\/:*?"<>|]+\\)*[^\\/:*?"<>|]+$/u;

export function pathShapeRejection(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RUNTIME_TEXT_CHARS ||
    !isNormalizedText(value)
  ) {
    return "is not bounded normalized text";
  }
  if (!LOCAL_ABSOLUTE.test(value)) {
    return "is not an absolute local-drive Windows path";
  }
  if (value.slice(3).split("\\").some((segment) => segment === "." || segment === "..")) {
    return "contains a relative segment";
  }
  return null;
}

export function isInside(root: string, candidate: string): boolean {
  const prefix = root.endsWith(win32.sep) ? root : `${root}${win32.sep}`;
  return fold(candidate).startsWith(fold(prefix));
}

/**
 * Reads own DATA properties without ever invoking `get`, so an accessor or a
 * get-trapping proxy cannot hand validation one path and the stream another.
 */
function snapshotOne(value: unknown): RuntimeSourceCandidate | null {
  try {
    if (types.isProxy(value)) return null;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 2) return null;
  const kind = descriptors["kind"];
  const path = descriptors["path"];
  if (kind === undefined || path === undefined) return null;
  if (!("value" in kind) || !("value" in path) || typeof path.value !== "string") return null;
  if (!RUNTIME_CLOSURE_KINDS.includes(kind.value as RuntimeClosureKind)) return null;
  return { kind: kind.value as RuntimeClosureKind, path: path.value };
}

/**
 * Copies a bounded plain array of exact `{kind,path}` records out of hostile input
 * before any I/O, so nothing the caller still holds can change a validated path.
 */
export function snapshotSourceCandidates(
  value: unknown,
): readonly RuntimeSourceCandidate[] | SourceInspectionFailure {
  const invalid = (reason: string): SourceInspectionFailure =>
    fail("CLAUDE_RUNTIME_OBSERVATION_INVALID", `source candidates ${reason}`);
  if (!Array.isArray(value)) return invalid("are not an array");
  if (value.length === 0 || value.length > MAX_RUNTIME_CLOSURE_ENTRIES) {
    return invalid(`hold ${value.length} entries, the limit is ${MAX_RUNTIME_CLOSURE_ENTRIES}`);
  }
  const snapshot: RuntimeSourceCandidate[] = [];
  for (const [index, entry] of value.entries()) {
    const candidate = snapshotOne(entry);
    if (candidate === null) return invalid(`entry ${index} is not an exact {kind,path} record`);
    snapshot.push(candidate);
  }
  return snapshot;
}

/**
 * Walks EVERY segment below the containment root: checking only the final entry
 * lets a junction above it redirect the subtree while the leaf lstats as a file.
 */
async function segmentRejection(
  fs: ClaudeRuntimeFsPort,
  root: string,
  target: string,
): Promise<ClaudeRuntimePinErrorCode | null> {
  const segments = win32.relative(root, target).split(win32.sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = win32.join(current, segment);
    const kind = await fs.entryKind(current);
    if (kind === "REPARSE") return "CLAUDE_RUNTIME_PATH_REPARSE";
    if (kind === "MISSING") return "CLAUDE_RUNTIME_PATH_MISSING";
    const last = index === segments.length - 1;
    if (last ? kind !== "FILE" : kind !== "DIRECTORY") return "CLAUDE_RUNTIME_PATH_NOT_FILE";
  }
  return null;
}

/** The contained-plain-file proof, run identically before and after the stream. */
async function identityRejection(
  fs: ClaudeRuntimeFsPort,
  realRoot: string,
  path: string,
): Promise<ClaudeRuntimePinErrorCode | null> {
  const rejection = await segmentRejection(fs, realRoot, path);
  if (rejection !== null) return rejection;
  const canonicalPath = await fs.realpath(path);
  return fold(canonicalPath) !== fold(path) || !isInside(realRoot, canonicalPath)
    ? "CLAUDE_RUNTIME_PATH_REPARSE"
    : null;
}

/** Code-unit order over the source-relative path; the repository's sort rule. */
function byRelativePath(left: SourceEntry, right: SourceEntry): number {
  return left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
}

async function inspectOne(
  fs: ClaudeRuntimeFsPort,
  candidate: InspectedCandidate,
  realRoot: string,
  seen: Set<string>,
): Promise<SourceEntry | SourceInspectionFailure> {
  const named = JSON.stringify(candidate.path);
  const shape = pathShapeRejection(candidate.path);
  if (shape !== null) return fail("CLAUDE_RUNTIME_PATH_INVALID", `${named} ${shape}`);
  if (seen.has(fold(candidate.path))) {
    return fail("CLAUDE_RUNTIME_PATH_DUPLICATE", `${named} is declared twice`);
  }
  seen.add(fold(candidate.path));
  if (!isInside(realRoot, candidate.path)) {
    return fail("CLAUDE_RUNTIME_PATH_ESCAPE", `${named} is not beneath the installed root`);
  }

  let canonicalPath: string;
  try {
    const rejection = await identityRejection(fs, realRoot, candidate.path);
    if (rejection !== null) return fail(rejection, `${named} is not a plain contained file`);
    canonicalPath = await fs.realpath(candidate.path);
  } catch {
    // An unreadable entry is indistinguishable from an absent one, and both are
    // equally disqualifying: neither can be hashed.
    return fail("CLAUDE_RUNTIME_PATH_MISSING", `${named} could not be inspected`);
  }

  let sha256: string;
  try {
    sha256 = await streamDigest(fs, canonicalPath);
  } catch {
    // A partial read never becomes a partial digest: the bytes stay unproven.
    return fail("CLAUDE_RUNTIME_SOURCE_DIGEST_MISMATCH", `${named} could not be read to the end`);
  }

  // Re-proved AFTER the stream. Validation that only runs first proves the path
  // was safe when it was checked, not that the bytes just hashed came from it.
  try {
    const drift = await identityRejection(fs, realRoot, candidate.path);
    if (drift !== null) {
      return fail("CLAUDE_RUNTIME_PIN_SOURCE_DRIFT", `${named} changed while it was read`);
    }
  } catch {
    return fail("CLAUDE_RUNTIME_PIN_SOURCE_DRIFT", `${named} became uninspectable while read`);
  }

  if (candidate.expectedSha256 !== null && sha256 !== candidate.expectedSha256) {
    return fail(
      "CLAUDE_RUNTIME_SOURCE_DIGEST_MISMATCH",
      `${named} hashes to ${sha256}, the quote declared ${candidate.expectedSha256}`,
    );
  }
  return Object.freeze({
    kind: candidate.kind,
    canonicalPath,
    relativePath: win32.relative(realRoot, canonicalPath),
    sha256,
  });
}

export async function inspectSources(
  fs: ClaudeRuntimeFsPort,
  candidates: readonly InspectedCandidate[],
  realRoot: string,
): Promise<readonly SourceEntry[] | SourceInspectionFailure> {
  const seen = new Set<string>();
  const inspected: SourceEntry[] = [];
  for (const candidate of candidates) {
    const entry = await inspectOne(fs, candidate, realRoot, seen);
    if (isFailure(entry)) return entry;
    inspected.push(entry);
  }
  return Object.freeze(inspected.sort(byRelativePath));
}
