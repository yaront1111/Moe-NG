/**
 * Field-level admission for the `moe-claude-runtime-observation/1` body.
 *
 * Everything here is structural and total: each function either returns the admitted value or
 * `null`, and none of them throw, so a hostile record can never escape as an exception a caller
 * would have to translate back into a refusal code. The refusal CODES and the layer that
 * carries them live one level up in `provider-runtime-observation.ts`; this module deliberately
 * knows nothing about them, which keeps a field rule from inventing its own vocabulary. Same
 * seam, same reasons, as `provider-profile-fields.ts` beside it.
 *
 * Bounds are DAEMON-LOCAL structural bounds on the durable row. The runner's `MAX_RUNTIME_*`
 * ceilings are not published from its root and are deliberately not copied — a second copy of a
 * ceiling drifts silently away from the one that governs. What IS imported from the runner is
 * the shared vocabulary, which is the thing that must not fork.
 */

import { OBSERVATION_TRUTH_CLASSES, RUNTIME_CLOSURE_KINDS, RUNTIME_PINNING_METHODS } from
  "@moe/runner";
import type {
  ObservationFreshness,
  ObservationTruthClass,
  PlatformIdentity,
  RuntimeClosureEntry,
  RuntimePinningMethod,
} from "@moe/runner";

import { PROFILE_HEX64, hasExactKeys, member } from "./provider-profile-fields.js";

export const OBSERVATION_BODY_KEYS: readonly string[] = Object.freeze([
  "adapterCapabilitySchemaDigest", "freshness", "observationVersion", "pinningMethod",
  "platformIdentity", "providerId", "reportedVersion", "resolvedRuntimeClosure", "truthClass",
]);
export const OBSERVATION_ENCODED_KEYS: readonly string[] = Object.freeze([
  ...OBSERVATION_BODY_KEYS, "observationDigest",
]);

const CLOSURE_KEYS: readonly string[] = Object.freeze(["kind", "path", "sha256"]);
const PLATFORM_KEYS: readonly string[] = Object.freeze(["arch", "os", "osVersion"]);
const FRESHNESS_KEYS: readonly string[] = Object.freeze(["observedAt"]);

export const MAX_OBSERVATION_TEXT_CHARS = 512;
export const MAX_CLOSURE_ENTRIES = 128;
export const MAX_OBSERVATION_BYTES = 32_768;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

/** Bounded, well-formed, NFC-normalised text. A denormalised twin is a different byte string. */
export function observationText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_OBSERVATION_TEXT_CHARS) return null;
  return value.isWellFormed() && value === value.normalize("NFC") ? value : null;
}

/**
 * Closure paths must be STRICTLY ASCENDING, which makes duplicates unrepresentable by the same
 * rule. The runner sorts before hashing because discovery order is not a fact about the
 * runtime, so a row that arrived unsorted was not built by that adapter; re-sorting it here
 * would silently rewrite the caller's digest preimage instead of refusing it.
 */
export function admittedClosure(value: unknown): readonly RuntimeClosureEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_CLOSURE_ENTRIES) return null;
  const entries: RuntimeClosureEntry[] = [];
  let previous: string | null = null;
  for (const candidate of value) {
    if (!hasExactKeys(candidate, CLOSURE_KEYS)) return null;
    const kind = member(candidate.kind, RUNTIME_CLOSURE_KINDS);
    const path = observationText(candidate.path);
    const sha256 = observationText(candidate.sha256);
    if (kind === null || path === null || sha256 === null) return null;
    if (!PROFILE_HEX64.test(sha256)) return null;
    if (previous !== null && path <= previous) return null;
    previous = path;
    entries.push({ kind, path, sha256 });
  }
  return entries;
}

export function admittedPlatform(value: unknown): PlatformIdentity | null {
  if (!hasExactKeys(value, PLATFORM_KEYS)) return null;
  const arch = observationText(value.arch);
  const os = observationText(value.os);
  const osVersion = observationText(value.osVersion);
  if (arch === null || os === null || osVersion === null) return null;
  return { arch, os, osVersion };
}

export function admittedFreshness(value: unknown): ObservationFreshness | null {
  if (!hasExactKeys(value, FRESHNESS_KEYS)) return null;
  const observedAt = observationText(value.observedAt);
  if (observedAt === null || !UTC_INSTANT.test(observedAt)) return null;
  return { observedAt };
}

export function admittedPinningMethod(value: unknown): RuntimePinningMethod | null {
  return member(value, RUNTIME_PINNING_METHODS);
}

export function admittedObservationTruth(value: unknown): ObservationTruthClass | null {
  return member(value, OBSERVATION_TRUTH_CLASSES);
}

/**
 * `reportedVersion` is nullable BY CONTRACT: a runtime that would not state its own version is
 * an observed fact, not an omitted field, so `null` admits and a wrapped `null` does not.
 */
export function admittedReportedVersion(value: unknown): { readonly text: string | null } | null {
  if (value === null) return { text: null };
  const text = observationText(value);
  return text === null ? null : { text };
}

/** A sha256 digest of the exact width the observation contract states. */
export function admittedHex64(value: unknown): string | null {
  const text = observationText(value);
  return text !== null && PROFILE_HEX64.test(text) ? text : null;
}
