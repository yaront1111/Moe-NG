import { isNormalizedText } from "../canonical.js";

export const SCOPE_OBSERVATION_VERSION = "moe-scope-observation/1" as const;

export const MAX_SCOPE_PATHS = 4096;
export const MAX_SCOPE_PATH_CHARS = 400;
export const MAX_OBSERVER_VERSION_CHARS = 128;

/**
 * Closed rejection vocabulary. Every hostile-path family gets its own code so a
 * consumer can tell a case-fold collision from a junction escape from a
 * submodule boundary; a generic catch-all would hide which rule fired.
 */
export const RUNNER_SCOPE_ERROR_CODES = Object.freeze([
  "RUNNER_SCOPE_DECLARATION_EMPTY",
  "RUNNER_SCOPE_DECLARATION_LIMIT",
  "RUNNER_SCOPE_PATH_LENGTH_INVALID",
  "RUNNER_SCOPE_PATH_NOT_NORMALIZED",
  "RUNNER_SCOPE_PATH_BACKSLASH",
  "RUNNER_SCOPE_PATH_DRIVE_QUALIFIED",
  "RUNNER_SCOPE_PATH_ABSOLUTE",
  "RUNNER_SCOPE_PATH_DOT_SEGMENT",
  "RUNNER_SCOPE_PATH_TRAILING_DOT_OR_SPACE",
  "RUNNER_SCOPE_PATH_RESERVED_DEVICE",
  "RUNNER_SCOPE_PATH_DUPLICATE",
  "RUNNER_SCOPE_PATH_CASE_COLLISION",
  "RUNNER_SCOPE_SYMLINK_ESCAPE",
  "RUNNER_SCOPE_SUBMODULE_BOUNDARY",
  "RUNNER_SCOPE_REPOSITORY_ESCAPE",
  "RUNNER_SCOPE_BASE_IDENTITY_INVALID",
  "RUNNER_SCOPE_HEAD_MISMATCH",
  "RUNNER_SCOPE_OBSERVED_AT_INVALID",
  "RUNNER_SCOPE_OBSERVER_VERSION_INVALID",
  "RUNNER_SCOPE_STATUS_MALFORMED",
  "RUNNER_SCOPE_OBSERVATION_OVERFLOW",
  "RUNNER_SCOPE_OBSERVATION_FAILED",
] as const);

export type RunnerScopeErrorCode = (typeof RUNNER_SCOPE_ERROR_CODES)[number];

/**
 * Closed attribution classes. `ABSENT` means all three git queries agreed the
 * path has no record; `UNKNOWN` means they disagreed or could not answer. Only
 * `CLEAN` is ever safe to inherit, and nothing is assumed clean by default.
 */
export const SCOPE_ATTRIBUTION_CLASSES = Object.freeze([
  "UNKNOWN",
  "UNMERGED",
  "UNTRACKED",
  "STAGED",
  "DIRTY",
  "IGNORED",
  "CLEAN",
  "ABSENT",
] as const);

export type ScopeAttributionClass = (typeof SCOPE_ATTRIBUTION_CLASSES)[number];

/** Ports are injected so unit tests never spawn git or touch a real worktree. */
export interface GitObserver {
  headCommit(): string;
  /** Raw NUL-framed `status --porcelain=v2 -z` bytes; parsing lives in this package. */
  statusPorcelainV2(): Uint8Array;
  lsFilesTracked(): readonly string[];
  /** Explicit: the ignored class is not derivable from default porcelain v2 output. */
  lsFilesIgnored(): readonly string[];
  submodulePaths(): readonly string[];
}

export interface ScopePathObserver {
  realpath(path: string): string;
  exists(path: string): boolean;
}

/** Lets an adapter surface a precise cause (maxBuffer overflow, for one). */
export class ScopeObserverError extends Error {
  readonly code: RunnerScopeErrorCode;

  constructor(code: RunnerScopeErrorCode, message: string) {
    super(message);
    this.name = "ScopeObserverError";
    this.code = code;
  }
}

export interface ObserveScopeInput {
  readonly worktreeRoot: string;
  readonly baseIdentity: string;
  readonly declaredScopePaths: readonly string[];
  readonly gitObserver: GitObserver;
  readonly pathObserver: ScopePathObserver;
  /**
   * Caller-supplied instant, format-validated here. Freshness is deliberately
   * NOT enforced in this module: the design makes re-observation before provider
   * start, candidate verification, and integration the consumer's duty, and the
   * daemon is the caller, so the recorded instant stays daemon-observed.
   */
  readonly observedAt: string;
  readonly observerVersion: string;
}

export interface ScopeCanonicalEntry {
  readonly path: string;
  readonly attribution: ScopeAttributionClass;
  readonly attributionReason: string;
}

export interface ScopeGitAttribution {
  readonly headCommit: string;
  readonly changedPaths: readonly string[];
  readonly dirtyPaths: readonly string[];
  readonly stagedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly unmergedPaths: readonly string[];
  readonly ignoredPaths: readonly string[];
}

export interface ScopeObservation {
  readonly observationVersion: typeof SCOPE_OBSERVATION_VERSION;
  readonly baseIdentity: string;
  readonly worktreeIdentity: string;
  readonly canonicalEntries: readonly ScopeCanonicalEntry[];
  readonly gitAttribution: ScopeGitAttribution;
  readonly observedAt: string;
  readonly observerVersion: string;
  readonly sha256: string;
}

export type ScopeObservationBody = Omit<ScopeObservation, "sha256">;

/**
 * The exact field set the observation digest covers. Both the producer
 * (observeScope) and every verifier recompute from this one function, so the
 * bound fields cannot drift apart.
 */
export function scopeObservationDigestInput(body: ScopeObservationBody): Record<string, unknown> {
  return {
    observationVersion: body.observationVersion,
    baseIdentity: body.baseIdentity,
    worktreeIdentity: body.worktreeIdentity,
    canonicalEntries: body.canonicalEntries,
    gitAttribution: body.gitAttribution,
    observedAt: body.observedAt,
    observerVersion: body.observerVersion,
  };
}

export interface ScopeFailure {
  readonly ok: false;
  readonly code: RunnerScopeErrorCode;
  readonly message: string;
  readonly path: string | null;
}

export type ObserveScopeResult = { readonly ok: true; readonly observation: ScopeObservation } | ScopeFailure;

export function scopeFailure(
  code: RunnerScopeErrorCode,
  message: string,
  path: string | null = null,
): ScopeFailure {
  return Object.freeze({ ok: false as const, code, message, path });
}

/** Narrows the `T | ScopeFailure` unions this package returns from helpers. */
export function isScopeFailure(value: object): value is ScopeFailure {
  return "ok" in value && (value as { readonly ok: unknown }).ok === false;
}

const RESERVED_DEVICE_STEMS = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Rejects every declared path that a filesystem could reinterpret, before a
 * single stat call happens. The order is deliberate: the most specific
 * reinterpretation wins, so a caller learns which rule fired.
 */
export function canonicalPathRejection(path: string): RunnerScopeErrorCode | null {
  if (path.length === 0 || path.length > MAX_SCOPE_PATH_CHARS) {
    return "RUNNER_SCOPE_PATH_LENGTH_INVALID";
  }
  if (!isNormalizedText(path)) {
    return "RUNNER_SCOPE_PATH_NOT_NORMALIZED";
  }
  if (path.includes("\\")) {
    return "RUNNER_SCOPE_PATH_BACKSLASH";
  }
  if (path.includes(":")) {
    return "RUNNER_SCOPE_PATH_DRIVE_QUALIFIED";
  }
  if (path.startsWith("/")) {
    return "RUNNER_SCOPE_PATH_ABSOLUTE";
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return "RUNNER_SCOPE_PATH_DOT_SEGMENT";
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return "RUNNER_SCOPE_PATH_TRAILING_DOT_OR_SPACE";
    }
    if (RESERVED_DEVICE_STEMS.has(segment.split(".")[0]!.toLowerCase())) {
      return "RUNNER_SCOPE_PATH_RESERVED_DEVICE";
    }
  }
  return null;
}

export function isObserverVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OBSERVER_VERSION_CHARS &&
    isNormalizedText(value)
  );
}
