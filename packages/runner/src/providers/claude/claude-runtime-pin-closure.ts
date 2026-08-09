import { win32 } from "node:path";

import { canonicalDigest, isHex64, isNormalizedText, isPlainRecord } from "../../canonical.js";
import { streamDigest, type ClaudeRuntimeFsPort } from "./claude-runtime-pin-fs.js";
import {
  CLAUDE_RUNTIME_OBSERVATION_VERSION,
  MAX_RUNTIME_CLOSURE_ENTRIES,
  MAX_RUNTIME_TEXT_CHARS,
  observationDigestInput,
  type ProviderRuntimeObservation,
  type RuntimeClosureEntry,
  type RuntimeClosureKind,
} from "./claude-observation.js";

/**
 * Refusal vocabulary and closure resolution for the Claude runtime pin.
 *
 * Nothing here writes: it decides whether a quoted closure describes a real,
 * contained, unchanged set of files. Every refusal is the RUNTIME layer
 * answering, and leaves the runtime UNKNOWN rather than partially proven.
 */
export const CLAUDE_RUNTIME_PIN_VERSION = "moe-claude-runtime-pin/1" as const;

export const CLAUDE_RUNTIME_PIN_LAYER = "RUNTIME" as const;

export const CLAUDE_RUNTIME_PIN_ERROR_CODES = Object.freeze([
  "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED",
  "CLAUDE_RUNTIME_QUOTE_INVALID",
  "CLAUDE_RUNTIME_PATH_INVALID",
  "CLAUDE_RUNTIME_PATH_MISSING",
  "CLAUDE_RUNTIME_PATH_NOT_FILE",
  "CLAUDE_RUNTIME_PATH_DUPLICATE",
  "CLAUDE_RUNTIME_PATH_REPARSE",
  "CLAUDE_RUNTIME_PATH_ESCAPE",
  "CLAUDE_RUNTIME_SOURCE_DIGEST_MISMATCH",
  "CLAUDE_RUNTIME_PIN_COLLISION",
  "CLAUDE_RUNTIME_PIN_COPY_FAILED",
  "CLAUDE_RUNTIME_PIN_DESTINATION_MISMATCH",
  "CLAUDE_RUNTIME_PIN_SOURCE_DRIFT",
  "CLAUDE_RUNTIME_PIN_CLEANUP_FAILED",
  "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
  "CLAUDE_RUNTIME_OBSERVATION_INVALID",
] as const);
export type ClaudeRuntimePinErrorCode = (typeof CLAUDE_RUNTIME_PIN_ERROR_CODES)[number];

export interface ClaudeRuntimePinFailure {
  readonly ok: false;
  readonly code: ClaudeRuntimePinErrorCode;
  readonly layer: typeof CLAUDE_RUNTIME_PIN_LAYER;
  /** Preparation never upgrades truth; a refusal leaves the runtime unproven. */
  readonly truthClass: "UNKNOWN";
  readonly message: string;
}

export function refuse(code: ClaudeRuntimePinErrorCode, message: string): ClaudeRuntimePinFailure {
  return Object.freeze({
    ok: false as const,
    code,
    layer: CLAUDE_RUNTIME_PIN_LAYER,
    truthClass: "UNKNOWN" as const,
    message,
  });
}

export function isRefusal(value: unknown): value is ClaudeRuntimePinFailure {
  return isPlainRecord(value) && value["ok"] === false;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Windows path identity is case-insensitive, so every comparison folds. */
export const fold = (value: string): string => value.toLowerCase();

/**
 * Rejects UNC (`\\server\share`), device (`\\?\`, `\\.\`), relative and
 * reserved-character forms before any filesystem call, because `resolve`
 * happily normalises several of them into something that then passes a prefix
 * check against the containment root.
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
 * Walks every segment below the containment root. Checking only the final entry
 * would let a junction anywhere above it redirect the whole subtree while the
 * leaf still lstats as an ordinary file.
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

/** The observation digest minus `freshness`: two instants are not two runtimes. */
export function authorityDigest(
  observation: Omit<ProviderRuntimeObservation, "observationDigest">,
): string {
  const input = observationDigestInput(observation);
  delete input["freshness"];
  return canonicalDigest(input);
}

export interface QuoteFacts {
  readonly closure: readonly RuntimeClosureEntry[];
  readonly authority: string;
  readonly digest: string;
}

export function readQuote(quote: unknown): QuoteFacts | ClaudeRuntimePinFailure {
  if (!isPlainRecord(quote)) {
    return refuse("CLAUDE_RUNTIME_QUOTE_INVALID", "quoted observation is not a record");
  }
  const observation = quote as unknown as ProviderRuntimeObservation;
  let recomputed: string;
  try {
    recomputed = canonicalDigest(observationDigestInput(observation));
  } catch {
    return refuse("CLAUDE_RUNTIME_QUOTE_INVALID", "quoted observation is not canonicalisable");
  }
  if (!isHex64(observation.observationDigest) || recomputed !== observation.observationDigest) {
    return refuse("CLAUDE_RUNTIME_QUOTE_INVALID", "quoted digest does not cover its own fields");
  }
  if (
    observation.observationVersion !== CLAUDE_RUNTIME_OBSERVATION_VERSION ||
    observation.providerId !== "claude"
  ) {
    return refuse("CLAUDE_RUNTIME_QUOTE_INVALID", "quote is not a v1 claude runtime observation");
  }
  if (observation.truthClass !== "PROVEN") {
    return refuse("CLAUDE_RUNTIME_QUOTE_INVALID", "an UNKNOWN observation cannot be pinned");
  }
  if (observation.pinningMethod !== "CONTENT_ADDRESSED_COPY") {
    return refuse(
      "CLAUDE_RUNTIME_QUOTE_INVALID",
      `pinning method ${JSON.stringify(observation.pinningMethod)} is not a content-addressed copy`,
    );
  }
  const closure = observation.resolvedRuntimeClosure;
  if (closure.length === 0 || closure.length > MAX_RUNTIME_CLOSURE_ENTRIES) {
    return refuse("CLAUDE_RUNTIME_QUOTE_INVALID", `closure holds ${closure.length} entries`);
  }
  if (closure.filter((entry) => entry.kind === "EXECUTABLE").length !== 1) {
    return refuse("CLAUDE_RUNTIME_QUOTE_INVALID", "closure must declare exactly one EXECUTABLE");
  }
  return {
    closure,
    authority: authorityDigest(observation),
    digest: observation.observationDigest,
  };
}

export interface SourceEntry {
  readonly kind: RuntimeClosureKind;
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly sha256: string;
}

/** Code-unit order over the source-relative path; the repository's sort rule. */
function byRelativePath(left: SourceEntry, right: SourceEntry): number {
  return left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath
      ? 1
      : 0;
}

async function resolveOne(
  fs: ClaudeRuntimeFsPort,
  entry: RuntimeClosureEntry,
  realRoot: string,
  seen: Set<string>,
): Promise<SourceEntry | ClaudeRuntimePinFailure> {
  const shape = pathShapeRejection(entry.path);
  if (shape !== null) {
    return refuse("CLAUDE_RUNTIME_PATH_INVALID", `${JSON.stringify(entry.path)} ${shape}`);
  }
  if (seen.has(fold(entry.path))) {
    return refuse("CLAUDE_RUNTIME_PATH_DUPLICATE", `${JSON.stringify(entry.path)} is declared twice`);
  }
  seen.add(fold(entry.path));
  if (!isInside(realRoot, entry.path)) {
    return refuse(
      "CLAUDE_RUNTIME_PATH_ESCAPE",
      `${JSON.stringify(entry.path)} is not beneath the installed root`,
    );
  }
  const rejection = await segmentRejection(fs, realRoot, entry.path);
  if (rejection !== null) {
    return refuse(rejection, `${JSON.stringify(entry.path)} is not a plain contained file`);
  }
  const canonicalPath = await fs.realpath(entry.path);
  if (fold(canonicalPath) !== fold(entry.path) || !isInside(realRoot, canonicalPath)) {
    return refuse(
      "CLAUDE_RUNTIME_PATH_REPARSE",
      `${JSON.stringify(entry.path)} resolves to ${JSON.stringify(canonicalPath)}`,
    );
  }
  const sha256 = await streamDigest(fs, canonicalPath);
  if (sha256 !== entry.sha256) {
    return refuse(
      "CLAUDE_RUNTIME_SOURCE_DIGEST_MISMATCH",
      `${JSON.stringify(entry.path)} hashes to ${sha256}, the quote declared ${entry.sha256}`,
    );
  }
  return {
    kind: entry.kind,
    canonicalPath,
    relativePath: win32.relative(realRoot, canonicalPath),
    sha256,
  };
}

export async function resolveSources(
  fs: ClaudeRuntimeFsPort,
  closure: readonly RuntimeClosureEntry[],
  realRoot: string,
): Promise<readonly SourceEntry[] | ClaudeRuntimePinFailure> {
  const seen = new Set<string>();
  const resolved: SourceEntry[] = [];
  for (const entry of closure) {
    const source = await resolveOne(fs, entry, realRoot, seen);
    if (isRefusal(source)) {
      return source;
    }
    resolved.push(source);
  }
  return resolved.sort(byRelativePath);
}

/**
 * Names the pin root. Derived from the manifest rather than from the quote, so
 * two hosts that resolved the same bytes agree on the location regardless of
 * the order they were declared in or where they were installed.
 */
export function aggregateClosureDigest(sources: readonly SourceEntry[]): string {
  return canonicalDigest({
    preparationVersion: CLAUDE_RUNTIME_PIN_VERSION,
    entries: sources.map((entry) => ({
      kind: entry.kind,
      path: entry.relativePath,
      sha256: entry.sha256,
    })),
  });
}
