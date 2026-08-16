import { canonicalDigest, isHex64, isPlainRecord } from "../../canonical.js";
import { type ClaudeRuntimeFsPort } from "./claude-runtime-pin-fs.js";
import {
  CLAUDE_RUNTIME_OBSERVATION_VERSION,
  MAX_RUNTIME_CLOSURE_ENTRIES,
  observationDigestInput,
  type ProviderRuntimeObservation,
  type RuntimeClosureEntry,
} from "./claude-observation.js";
import {
  inspectSources,
  snapshotSourceCandidates,
  type InspectedCandidate,
  type RuntimeSourceCandidate,
  type SourceEntry,
  type SourceInspectionFailure,
} from "./claude-runtime-source.js";

/**
 * Path/containment/digest authority lives in `claude-runtime-source.ts` and is
 * re-exported here so every existing importer stays source-compatible. There is
 * exactly ONE implementation of each rule; this module owns only the refusal
 * shape, the quote semantics, and the aggregate identity.
 */
export {
  fold,
  isInside,
  pathShapeRejection,
  type SourceEntry,
} from "./claude-runtime-source.js";

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

/** Converts the shared inspector's internal failure into this layer's refusal. */
function wrap(failure: SourceInspectionFailure): ClaudeRuntimePinFailure {
  return refuse(failure.code, failure.message);
}

/**
 * The narrow internal discovery surface: caller-named candidates in, validated
 * streamed entries out. No expected digest is declared, so nothing here can be
 * "confirmed" against a caller's claim — the bytes are simply measured.
 *
 * Internal to @moe/runner by construction: it is not re-exported from the
 * package root. Consuming task: task-32eddfd3c9644558b7218778e1f07e92.
 */
export async function discoverSources(
  fs: ClaudeRuntimeFsPort,
  candidates: readonly RuntimeSourceCandidate[],
  realRoot: string,
): Promise<readonly SourceEntry[] | ClaudeRuntimePinFailure> {
  const snapshot = snapshotSourceCandidates(candidates);
  if (!Array.isArray(snapshot)) return wrap(snapshot as SourceInspectionFailure);
  const inspected = await inspectSources(
    fs,
    (snapshot as readonly RuntimeSourceCandidate[]).map((candidate) => ({
      ...candidate,
      expectedSha256: null,
    })),
    realRoot,
  );
  return Array.isArray(inspected)
    ? (inspected as readonly SourceEntry[])
    : wrap(inspected as SourceInspectionFailure);
}

/**
 * The quote path. Identical inspection to `discoverSources`, plus the quote's
 * declared digest attached to each candidate; the comparison is the inspector's
 * last act, so a drifting path is never reported as a mere digest mismatch.
 */
export async function resolveSources(
  fs: ClaudeRuntimeFsPort,
  closure: readonly RuntimeClosureEntry[],
  realRoot: string,
): Promise<readonly SourceEntry[] | ClaudeRuntimePinFailure> {
  // Every field is copied out ONCE, here. Indexing back into `closure` further
  // down would let a hostile array-like answer position `index` with a different
  // entry the second time, pairing a validated path with another's digest.
  const declared = closure.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    sha256: entry.sha256,
  }));
  const snapshot = snapshotSourceCandidates(declared.map(({ kind, path }) => ({ kind, path })));
  if (!Array.isArray(snapshot)) return wrap(snapshot as SourceInspectionFailure);
  const candidates: InspectedCandidate[] = (snapshot as readonly RuntimeSourceCandidate[]).map(
    (candidate, index) => ({ ...candidate, expectedSha256: declared[index]?.sha256 ?? null }),
  );
  const inspected = await inspectSources(fs, candidates, realRoot);
  return Array.isArray(inspected)
    ? (inspected as readonly SourceEntry[])
    : wrap(inspected as SourceInspectionFailure);
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
