import {
  canonicalDigest,
  deepFreeze,
  isCanonicalUtcTimestamp,
  isHex64,
  isNormalizedText,
} from "../../canonical.js";

export const CODEX_RUNTIME_OBSERVATION_VERSION = "moe-codex-runtime-observation/1" as const;
export const MAX_RUNTIME_CLOSURE_ENTRIES = 64;
export const MAX_RUNTIME_TEXT_CHARS = 400;

export const RUNTIME_CLOSURE_KINDS = Object.freeze(["EXECUTABLE", "LAUNCHER", "PACKAGE"] as const);
export type RuntimeClosureKind = (typeof RUNTIME_CLOSURE_KINDS)[number];

export const RUNTIME_PINNING_METHODS = Object.freeze([
  "CONTENT_ADDRESSED_COPY",
  "PLATFORM_IMMUTABLE_HANDLE",
  "UNSUPPORTED",
] as const);
export type RuntimePinningMethod = (typeof RUNTIME_PINNING_METHODS)[number];

export const OBSERVATION_TRUTH_CLASSES = Object.freeze(["PROVEN", "UNKNOWN"] as const);
export type ObservationTruthClass = (typeof OBSERVATION_TRUTH_CLASSES)[number];

export const CODEX_OBSERVATION_ERROR_CODES = Object.freeze([
  "CODEX_OBSERVATION_CLOSURE_INVALID",
  "CODEX_OBSERVATION_CLOSURE_DUPLICATE",
  "CODEX_OBSERVATION_CLOSURE_LIMIT",
  "CODEX_OBSERVATION_PINNING_METHOD_INVALID",
  "CODEX_OBSERVATION_PLATFORM_INVALID",
  "CODEX_OBSERVATION_VERSION_INVALID",
  "CODEX_OBSERVATION_SCHEMA_DIGEST_INVALID",
  "CODEX_OBSERVATION_CLOCK_INVALID",
] as const);
export type CodexObservationErrorCode = (typeof CODEX_OBSERVATION_ERROR_CODES)[number];

export interface CodexFailure<Code extends string = string> {
  readonly ok: false;
  readonly code: Code;
  readonly message: string;
}

export function codexFailure<Code extends string>(code: Code, message: string): CodexFailure<Code> {
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

export interface ObservationClock {
  readonly observedAt: () => string;
}

export interface ProviderRuntimeObservation {
  readonly observationVersion: typeof CODEX_RUNTIME_OBSERVATION_VERSION;
  readonly providerId: "codex";
  readonly resolvedRuntimeClosure: readonly RuntimeClosureEntry[];
  readonly reportedVersion: string | null;
  readonly adapterCapabilitySchemaDigest: string;
  readonly pinningMethod: RuntimePinningMethod;
  readonly platformIdentity: PlatformIdentity;
  readonly freshness: { readonly observedAt: string };
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

export type BuildObservationResult =
  | { readonly ok: true; readonly observation: ProviderRuntimeObservation }
  | CodexFailure<CodexObservationErrorCode>;

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_RUNTIME_TEXT_CHARS && isNormalizedText(value);
}

function normalizeEntry(value: unknown): RuntimeClosureEntry | CodexFailure<CodexObservationErrorCode> {
  if (typeof value !== "object" || value === null) {
    return codexFailure("CODEX_OBSERVATION_CLOSURE_INVALID", "every closure entry must be a record");
  }
  const entry = value as Record<string, unknown>;
  if (!RUNTIME_CLOSURE_KINDS.includes(entry["kind"] as RuntimeClosureKind) ||
      !isBoundedText(entry["path"]) || !isHex64(entry["sha256"])) {
    return codexFailure(
      "CODEX_OBSERVATION_CLOSURE_INVALID",
      "each closure entry needs a known kind, bounded path, and sha256 digest",
    );
  }
  return { kind: entry["kind"] as RuntimeClosureKind, path: entry["path"], sha256: entry["sha256"] };
}

function normalizeClosure(
  value: readonly RuntimeClosureEntry[],
): readonly RuntimeClosureEntry[] | CodexFailure<CodexObservationErrorCode> {
  if (!Array.isArray(value)) {
    return codexFailure("CODEX_OBSERVATION_CLOSURE_INVALID", "runtime closure must be an array");
  }
  if (value.length > MAX_RUNTIME_CLOSURE_ENTRIES) {
    return codexFailure("CODEX_OBSERVATION_CLOSURE_LIMIT", "runtime closure exceeds its entry limit");
  }
  const seen = new Set<string>();
  const entries: RuntimeClosureEntry[] = [];
  for (const candidate of value) {
    const entry = normalizeEntry(candidate);
    if ("ok" in entry) return entry;
    if (seen.has(entry.path)) {
      return codexFailure("CODEX_OBSERVATION_CLOSURE_DUPLICATE", `duplicate closure path ${entry.path}`);
    }
    seen.add(entry.path);
    entries.push(entry);
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function validPlatform(platform: PlatformIdentity): boolean {
  return isBoundedText(platform.os) && isBoundedText(platform.arch) &&
    isBoundedText(platform.osVersion);
}

export function observationDigestInput(
  observation: Omit<ProviderRuntimeObservation, "observationDigest">,
): Record<string, unknown> {
  return {
    observationVersion: observation.observationVersion,
    providerId: observation.providerId,
    resolvedRuntimeClosure: observation.resolvedRuntimeClosure.map((entry) => ({ ...entry })),
    reportedVersion: observation.reportedVersion,
    adapterCapabilitySchemaDigest: observation.adapterCapabilitySchemaDigest,
    pinningMethod: observation.pinningMethod,
    platformIdentity: { ...observation.platformIdentity },
    freshness: { ...observation.freshness },
    truthClass: observation.truthClass,
  };
}

function classifyTruth(
  closure: readonly RuntimeClosureEntry[],
  reportedVersion: string | null,
): ObservationTruthClass {
  return closure.length > 0 && reportedVersion !== null ? "PROVEN" : "UNKNOWN";
}

export function buildProviderRuntimeObservation(input: BuildObservationInput): BuildObservationResult {
  const closure = normalizeClosure(input.resolvedRuntimeClosure);
  if ("ok" in closure) return closure;
  if (!RUNTIME_PINNING_METHODS.includes(input.pinningMethod)) {
    return codexFailure("CODEX_OBSERVATION_PINNING_METHOD_INVALID", "pinning method is unknown");
  }
  if (!validPlatform(input.platformIdentity)) {
    return codexFailure("CODEX_OBSERVATION_PLATFORM_INVALID", "platform identity is invalid");
  }
  if (input.reportedVersion !== null && !isBoundedText(input.reportedVersion)) {
    return codexFailure("CODEX_OBSERVATION_VERSION_INVALID", "reported version is invalid");
  }
  if (!isHex64(input.adapterCapabilitySchemaDigest)) {
    return codexFailure("CODEX_OBSERVATION_SCHEMA_DIGEST_INVALID", "schema digest is invalid");
  }
  const observedAt = input.clock.observedAt();
  if (!isCanonicalUtcTimestamp(observedAt)) {
    return codexFailure("CODEX_OBSERVATION_CLOCK_INVALID", "observation clock is invalid");
  }
  const body = {
    observationVersion: CODEX_RUNTIME_OBSERVATION_VERSION,
    providerId: "codex",
    resolvedRuntimeClosure: closure,
    reportedVersion: input.reportedVersion,
    adapterCapabilitySchemaDigest: input.adapterCapabilitySchemaDigest,
    pinningMethod: input.pinningMethod,
    platformIdentity: { ...input.platformIdentity },
    freshness: { observedAt },
    truthClass: classifyTruth(closure, input.reportedVersion),
  } as const satisfies Omit<ProviderRuntimeObservation, "observationDigest">;
  const observation = deepFreeze({
    ...body,
    observationDigest: canonicalDigest(observationDigestInput(body)),
  });
  return Object.freeze({ ok: true as const, observation });
}

export function runtimePinningIsAuthoritative(observation: ProviderRuntimeObservation): boolean {
  return observation.truthClass === "PROVEN" && observation.pinningMethod !== "UNSUPPORTED";
}
