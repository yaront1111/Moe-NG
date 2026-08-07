import {
  canonicalDigest,
  deepFreeze,
  isCanonicalUtcTimestamp,
  isHex64,
  isNormalizedText,
} from "../../canonical.js";

/**
 * `ProviderRuntimeObservation` for the Claude adapter (design 6.2 / 11.5).
 *
 * This module records what was observed about a runtime; it never pins, copies,
 * launches, or activates one. Pinning EXECUTION — the content-addressed private
 * copy or platform-proven immutable handle — belongs to the wrapper/supervisor
 * (design 13, "Provider launch"). What is recorded here is the `pinningMethod`
 * the adapter can prove is available, so the wrapper's pre-`effect.activate`
 * comparison can decide "unsupported runtime pinning cannot launch
 * authoritatively" without asking the adapter to act.
 */
export const CLAUDE_RUNTIME_OBSERVATION_VERSION = "moe-claude-runtime-observation/1" as const;

export const MAX_RUNTIME_CLOSURE_ENTRIES = 64;
export const MAX_RUNTIME_TEXT_CHARS = 400;

export const RUNTIME_CLOSURE_KINDS = Object.freeze(["EXECUTABLE", "LAUNCHER", "PACKAGE"] as const);
export type RuntimeClosureKind = (typeof RUNTIME_CLOSURE_KINDS)[number];

/**
 * How the resolved closure *can* be pinned. `UNSUPPORTED` is a first-class
 * member rather than an absent field: a wrapper must be able to read a definite
 * "this runtime cannot be pinned" rather than infer it from a missing value.
 */
export const RUNTIME_PINNING_METHODS = Object.freeze([
  "CONTENT_ADDRESSED_COPY",
  "PLATFORM_IMMUTABLE_HANDLE",
  "UNSUPPORTED",
] as const);
export type RuntimePinningMethod = (typeof RUNTIME_PINNING_METHODS)[number];

export const OBSERVATION_TRUTH_CLASSES = Object.freeze(["PROVEN", "UNKNOWN"] as const);
export type ObservationTruthClass = (typeof OBSERVATION_TRUTH_CLASSES)[number];

export const CLAUDE_OBSERVATION_ERROR_CODES = Object.freeze([
  "CLAUDE_OBSERVATION_CLOSURE_INVALID",
  "CLAUDE_OBSERVATION_CLOSURE_DUPLICATE",
  "CLAUDE_OBSERVATION_CLOSURE_LIMIT",
  "CLAUDE_OBSERVATION_PINNING_METHOD_INVALID",
  "CLAUDE_OBSERVATION_PLATFORM_INVALID",
  "CLAUDE_OBSERVATION_VERSION_INVALID",
  "CLAUDE_OBSERVATION_SCHEMA_DIGEST_INVALID",
  "CLAUDE_OBSERVATION_CLOCK_INVALID",
] as const);
export type ClaudeObservationErrorCode = (typeof CLAUDE_OBSERVATION_ERROR_CODES)[number];

/** Shared rejection shape for every module in this adapter. */
export interface ClaudeFailure<Code extends string = string> {
  readonly ok: false;
  readonly code: Code;
  readonly message: string;
}

export function claudeFailure<Code extends string>(
  code: Code,
  message: string,
): ClaudeFailure<Code> {
  return Object.freeze({ ok: false as const, code, message });
}

export interface RuntimeClosureEntry {
  readonly kind: RuntimeClosureKind;
  readonly path: string;
  readonly sha256: string;
}

export interface PlatformIdentity {
  readonly os: string;
  readonly arch: string;
  readonly osVersion: string;
}

export interface ObservationFreshness {
  readonly observedAt: string;
}

/** Injected so nothing in this package reads a clock directly. */
export interface ObservationClock {
  readonly observedAt: () => string;
}

export interface ProviderRuntimeObservation {
  readonly observationVersion: typeof CLAUDE_RUNTIME_OBSERVATION_VERSION;
  readonly providerId: "claude";
  readonly resolvedRuntimeClosure: readonly RuntimeClosureEntry[];
  readonly reportedVersion: string | null;
  readonly adapterCapabilitySchemaDigest: string;
  readonly pinningMethod: RuntimePinningMethod;
  readonly platformIdentity: PlatformIdentity;
  readonly freshness: ObservationFreshness;
  readonly truthClass: ObservationTruthClass;
  readonly observationDigest: string;
}

export interface BuildObservationInput {
  readonly resolvedRuntimeClosure: readonly RuntimeClosureEntry[];
  readonly reportedVersion: string | null;
  readonly adapterCapabilitySchemaDigest: string;
  readonly pinningMethod: RuntimePinningMethod;
  readonly platformIdentity: PlatformIdentity;
  readonly clock: ObservationClock;
}

export interface BuildObservationOk {
  readonly ok: true;
  readonly observation: ProviderRuntimeObservation;
}

export type BuildObservationResult = BuildObservationOk | ClaudeFailure<ClaudeObservationErrorCode>;

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RUNTIME_TEXT_CHARS &&
    isNormalizedText(value)
  );
}

/**
 * The closure is sorted before hashing so two resolutions that found the same
 * files in a different order produce the same digest. Order of discovery is not
 * a fact about the runtime, and letting it change the digest would make the
 * wrapper's pre-activation comparison report drift that did not happen.
 */
function normalizeClosure(
  entries: readonly RuntimeClosureEntry[],
): readonly RuntimeClosureEntry[] | ClaudeFailure<ClaudeObservationErrorCode> {
  if (entries.length > MAX_RUNTIME_CLOSURE_ENTRIES) {
    return claudeFailure(
      "CLAUDE_OBSERVATION_CLOSURE_LIMIT",
      `runtime closure holds ${entries.length} entries, limit is ${MAX_RUNTIME_CLOSURE_ENTRIES}`,
    );
  }
  const seen = new Set<string>();
  const normalized: RuntimeClosureEntry[] = [];
  for (const entry of entries) {
    if (!RUNTIME_CLOSURE_KINDS.includes(entry.kind)) {
      return claudeFailure(
        "CLAUDE_OBSERVATION_CLOSURE_INVALID",
        `unknown runtime closure kind ${JSON.stringify(entry.kind)}`,
      );
    }
    if (!isBoundedText(entry.path) || !isHex64(entry.sha256)) {
      return claudeFailure(
        "CLAUDE_OBSERVATION_CLOSURE_INVALID",
        `runtime closure entry ${JSON.stringify(entry.path)} needs a bounded path and a sha256 digest`,
      );
    }
    if (seen.has(entry.path)) {
      return claudeFailure(
        "CLAUDE_OBSERVATION_CLOSURE_DUPLICATE",
        `runtime closure lists ${JSON.stringify(entry.path)} more than once`,
      );
    }
    seen.add(entry.path);
    normalized.push({ kind: entry.kind, path: entry.path, sha256: entry.sha256 });
  }
  normalized.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return normalized;
}

function isFailure(value: unknown): value is ClaudeFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

/**
 * The exact value hashed into `observationDigest`. Exported so a consumer can
 * re-verify a stored observation without reconstructing the field list, and so
 * the digest provably does not cover itself.
 */
export function observationDigestInput(
  observation: Omit<ProviderRuntimeObservation, "observationDigest">,
): Record<string, unknown> {
  return {
    observationVersion: observation.observationVersion,
    providerId: observation.providerId,
    resolvedRuntimeClosure: observation.resolvedRuntimeClosure.map((entry) => ({
      kind: entry.kind,
      path: entry.path,
      sha256: entry.sha256,
    })),
    reportedVersion: observation.reportedVersion,
    adapterCapabilitySchemaDigest: observation.adapterCapabilitySchemaDigest,
    pinningMethod: observation.pinningMethod,
    platformIdentity: {
      os: observation.platformIdentity.os,
      arch: observation.platformIdentity.arch,
      osVersion: observation.platformIdentity.osVersion,
    },
    freshness: { observedAt: observation.freshness.observedAt },
    truthClass: observation.truthClass,
  };
}

/**
 * `PROVEN` requires evidence of what the runtime *is*: at least one digested
 * closure member and a version the runtime reported about itself. Pinning is
 * deliberately not part of truth — an honestly observed runtime that cannot be
 * pinned is still honestly observed; it just cannot launch authoritatively.
 */
function classifyTruth(
  closure: readonly RuntimeClosureEntry[],
  reportedVersion: string | null,
): ObservationTruthClass {
  return closure.length > 0 && reportedVersion !== null ? "PROVEN" : "UNKNOWN";
}

export function buildProviderRuntimeObservation(
  input: BuildObservationInput,
): BuildObservationResult {
  const closure = normalizeClosure(input.resolvedRuntimeClosure);
  if (isFailure(closure)) {
    return closure;
  }
  if (!RUNTIME_PINNING_METHODS.includes(input.pinningMethod)) {
    return claudeFailure(
      "CLAUDE_OBSERVATION_PINNING_METHOD_INVALID",
      `unknown pinning method ${JSON.stringify(input.pinningMethod)}`,
    );
  }
  const platform = input.platformIdentity;
  if (
    !isBoundedText(platform.os) ||
    !isBoundedText(platform.arch) ||
    !isBoundedText(platform.osVersion)
  ) {
    return claudeFailure(
      "CLAUDE_OBSERVATION_PLATFORM_INVALID",
      "platform identity needs a bounded os, arch, and osVersion",
    );
  }
  if (input.reportedVersion !== null && !isBoundedText(input.reportedVersion)) {
    return claudeFailure(
      "CLAUDE_OBSERVATION_VERSION_INVALID",
      "reported version must be bounded normalized text or explicitly null",
    );
  }
  if (!isHex64(input.adapterCapabilitySchemaDigest)) {
    return claudeFailure(
      "CLAUDE_OBSERVATION_SCHEMA_DIGEST_INVALID",
      "adapter capability schema digest must be a sha256 hex digest",
    );
  }
  const observedAt = input.clock.observedAt();
  if (!isCanonicalUtcTimestamp(observedAt)) {
    return claudeFailure(
      "CLAUDE_OBSERVATION_CLOCK_INVALID",
      `observation clock returned ${JSON.stringify(observedAt)}, which is not a canonical UTC instant`,
    );
  }
  const body = {
    observationVersion: CLAUDE_RUNTIME_OBSERVATION_VERSION,
    providerId: "claude",
    resolvedRuntimeClosure: closure,
    reportedVersion: input.reportedVersion,
    adapterCapabilitySchemaDigest: input.adapterCapabilitySchemaDigest,
    pinningMethod: input.pinningMethod,
    platformIdentity: { os: platform.os, arch: platform.arch, osVersion: platform.osVersion },
    freshness: { observedAt },
    truthClass: classifyTruth(closure, input.reportedVersion),
  } as const satisfies Omit<ProviderRuntimeObservation, "observationDigest">;
  const observation = deepFreeze({
    ...body,
    observationDigest: canonicalDigest(observationDigestInput(body)),
  });
  return Object.freeze({ ok: true as const, observation });
}

/**
 * The decidable predicate design 13 asks the wrapper to evaluate before
 * `effect.activate`. It reports a fact about the observation; it grants nothing
 * and cannot start anything.
 */
export function runtimePinningIsAuthoritative(observation: ProviderRuntimeObservation): boolean {
  return observation.truthClass === "PROVEN" && observation.pinningMethod !== "UNSUPPORTED";
}
