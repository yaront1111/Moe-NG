/**
 * Field-level admission for the `moe-provider-profile/1` body.
 *
 * Everything here is structural and total: each function either returns the admitted value or
 * `null`, and none of them throw, so a hostile record can never escape as an exception that a
 * caller would have to translate back into a refusal code. The refusal CODES and the layer
 * that carries them live one level up in `provider-profile-codec.ts`; this module deliberately
 * knows nothing about them, which is what keeps a field rule from inventing its own vocabulary.
 *
 * Bounds are shape bounds only. No runner ceiling is read or copied here.
 */

import type { ProjectConfigurationSelection } from "@moe/contracts";

export interface ProviderProfileLimits {
  readonly stderrBytes: number;
  readonly stdoutBytes: number;
  readonly tailBytes: number;
  readonly timeoutMs: number;
}

export const PROFILE_LIMIT_KEYS: readonly string[] = Object.freeze([
  "stderrBytes", "stdoutBytes", "tailBytes", "timeoutMs",
]);

export const PROFILE_SELECTION_KEYS: readonly string[] = Object.freeze([
  "modelRef", "profileRef", "providerRef", "reasoningEffortRef", "runtimeRef", "snapshotRef",
  "structuredOutputSchemaRef",
]);

export const MAX_PROFILE_TEXT_CHARS = 256;
export const PROFILE_HEX64 = /^[0-9a-f]{64}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exact-record membership: a missing key and an unknown key both refuse. Dropping an unknown
 * key would silently discard a field the operator believes they configured.
 */
export function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

export function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_PROFILE_TEXT_CHARS) return null;
  return value;
}

/** Positive safe integers only: zero, negative, fractional, NaN and Infinity all refuse. */
export function positiveCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function member<T extends string>(value: unknown, vocabulary: readonly T[]): T | null {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Deterministic serialisation: keys sorted, so identical bodies produce identical bytes no
 * matter how the record was built. Arrays keep their order, which would be data.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function admittedLimits(value: unknown): ProviderProfileLimits | null {
  if (!hasExactKeys(value, PROFILE_LIMIT_KEYS)) return null;
  const stderrBytes = positiveCount(value.stderrBytes);
  const stdoutBytes = positiveCount(value.stdoutBytes);
  const tailBytes = positiveCount(value.tailBytes);
  const timeoutMs = positiveCount(value.timeoutMs);
  if (stderrBytes === null || stdoutBytes === null) return null;
  if (tailBytes === null || timeoutMs === null) return null;
  return { stderrBytes, stdoutBytes, tailBytes, timeoutMs };
}

export function admittedSelection(value: unknown): ProjectConfigurationSelection | null {
  if (!hasExactKeys(value, PROFILE_SELECTION_KEYS)) return null;
  const refs: Record<string, string> = {};
  for (const key of PROFILE_SELECTION_KEYS) {
    const ref = boundedText(value[key]);
    if (ref === null) return null;
    refs[key] = ref;
  }
  return refs as unknown as ProjectConfigurationSelection;
}
