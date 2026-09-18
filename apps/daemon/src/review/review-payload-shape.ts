import { REVIEW_FINDING_SEVERITIES, REVIEW_FINDING_SUBJECT_KINDS } from "@moe/review";
import type { ReviewFinding, ReviewPackageItemInput } from "@moe/review";
import type { JsonObject, JsonValue } from "@moe/contracts";

import { isObject as isPlainJsonObject } from "../json-record-shape.js";

/**
 * The WORDS a `REVIEW_PAYLOAD_INVALID` refusal carries: which field, what JSON type it must be,
 * and what arrived instead.
 *
 * The code alone told a seat nothing it could act on. Three separate UnAI seats (2026-09-18)
 * each sent `round` as the JSON string "2" and were refused with a bare code; every one of them
 * burned a call discovering by trial that the daemon wanted the number. The daemon still refuses
 * by exact type — nothing here coerces "4" to 4 — but it now SAYS which check failed, exactly as
 * `domainRefusalOf` promises for every authority that has its own words.
 *
 * Every helper answers `null` when the field is well-formed and a detail sentence otherwise, so
 * a handler can keep its existing typed reads and only reach for the detail when one of them
 * refused. Quoted strings are bounded before they are echoed: a refusal must never grow with the
 * caller's own bytes.
 */

/** The most of one caller string a detail echoes, whether a value or a key. */
export const ECHOED_STRING_CHARS = 64;
/** The most caller keys a detail lists; the rest are counted, never spelled. */
export const ECHOED_KEYS = 8;

function boundedString(value: string): string {
  return value.length > ECHOED_STRING_CHARS ? `${value.slice(0, ECHOED_STRING_CHARS)}...` : value;
}

/**
 * Caller-supplied keys as a detail lists them: at most {@link ECHOED_KEYS}, each bounded to
 * {@link ECHOED_STRING_CHARS}, the remainder as `+N more`. The rosters a detail names beside them
 * are the daemon's own constants and need no bound.
 */
export function describeKeys(keys: readonly string[]): string {
  const shown = keys.slice(0, ECHOED_KEYS).map(boundedString).join(", ");
  const rest = keys.length - Math.min(keys.length, ECHOED_KEYS);
  return rest === 0 ? shown : `${shown} +${String(rest)} more`;
}

/** A JSON value's type and (bounded) content, as a refusal names it: `string "4"`, `absent`. */
export function describeJson(value: JsonValue | undefined): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array of ${String(value.length)}`;
  if (typeof value === "object") return `object with ${String(Object.keys(value).length)} keys`;
  if (typeof value === "string") return `string ${JSON.stringify(boundedString(value))}`;
  return `${typeof value} ${String(value)}`;
}

/** The first refusal among several checks, in the order they were written. */
export function firstDetail(...details: readonly (string | null)[]): string | null {
  return details.find((detail) => detail !== null) ?? null;
}

/** A closed roster: no key outside `keys` may be present. Missing keys are the fields' own job. */
export function unexpectedKeysDetail(payload: JsonObject, keys: readonly string[]): string | null {
  const unexpected = Object.keys(payload).filter((key) => !keys.includes(key));
  if (unexpected.length === 0) return null;
  return `payload must have exactly ${keys.join(", ")}; unexpected: ${describeKeys(unexpected)}`;
}

/** Exactly `keys`, no more and no fewer. */
export function exactKeysDetail(payload: JsonObject, keys: readonly string[]): string | null {
  const actual = Object.keys(payload);
  const missing = keys.filter((key) => !actual.includes(key));
  const unexpected = actual.filter((key) => !keys.includes(key));
  if (missing.length === 0 && unexpected.length === 0) return null;
  return `payload must have exactly ${keys.join(", ")}`
    + (missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`)
    + (unexpected.length === 0 ? "" : `; unexpected: ${describeKeys(unexpected)}`);
}

export function refDetail(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  if (typeof value === "string" && value.length > 0) return null;
  return `${key} must be a non-empty JSON string, got ${describeJson(value)}`;
}

export function arrayDetail(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  if (Array.isArray(value)) return null;
  return `${key} must be a JSON array, got ${describeJson(value)}`;
}

/** The live defect: `"4"` reads as a string here and the sentence says to send the number. */
export function positiveIntegerDetail(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return null;
  const hint = typeof value === "string" ? "; send the number unquoted" : "";
  return `${key} must be a JSON integer >= 1, got ${describeJson(value)}${hint}`;
}

export function memberDetail(
  payload: JsonObject, key: string, allowed: readonly string[],
): string | null {
  const value = payload[key];
  if (typeof value === "string" && allowed.includes(value)) return null;
  return `${key} must be one of ${allowed.join(", ")}, got ${describeJson(value)}`;
}

export type PayloadParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly detail: string; readonly ok: false };

function invalid(detail: string): PayloadParse<never> {
  return { detail, ok: false };
}

const SEVERITIES: ReadonlySet<string> = new Set<string>(REVIEW_FINDING_SEVERITIES);
const SUBJECT_KINDS: ReadonlySet<string> = new Set<string>(REVIEW_FINDING_SUBJECT_KINDS);

/**
 * An attribution names another node of the reporter's plan: exactly `nodeKey` and
 * `criterionIds`. Anything else is not an attribution, and silently dropping it would charge the
 * reporter for a finding it said it does not own - so the whole payload refuses instead.
 */
function parseAttribution(value: JsonValue, at: string): PayloadParse<ReviewFinding["attributedTo"]> {
  const shape = `${at}.attributedTo must be exactly {nodeKey: string, criterionIds: string[]}`;
  if (!isPlainJsonObject(value)) return invalid(`${shape}, got ${describeJson(value)}`);
  const nodeKey = value["nodeKey"];
  const criterionIds = value["criterionIds"];
  if (Object.keys(value).length !== 2 || typeof nodeKey !== "string" || !Array.isArray(criterionIds)
    || !criterionIds.every((entry) => typeof entry === "string")) return invalid(shape);
  return { ok: true, value: { criterionIds: criterionIds as string[], nodeKey } };
}

/**
 * Shape only, against the KERNEL'S OWN vocabularies rather than a local copy of them. A finding
 * must name a typed subject with a non-empty locator, which is what makes it a link to a
 * required change rather than free prose.
 */
function parseFinding(value: JsonValue, index: number): PayloadParse<ReviewFinding> {
  const at = `findings[${String(index)}]`;
  if (!isPlainJsonObject(value)) return invalid(`${at} must be a JSON object, got ${describeJson(value)}`);
  const attributed = value["attributedTo"] === undefined ? undefined : parseAttribution(value["attributedTo"], at);
  if (attributed !== undefined && !attributed.ok) return attributed;
  const subject = value["subject"];
  const detail = value["detail"];
  const ruleId = value["ruleId"];
  const severity = value["severity"];
  if (typeof detail !== "string") return invalid(`${at}.detail must be a JSON string, got ${describeJson(detail)}`);
  if (typeof ruleId !== "string" || ruleId.length === 0) {
    return invalid(`${at}.ruleId must be a non-empty JSON string, got ${describeJson(ruleId)}`);
  }
  if (typeof severity !== "string" || !SEVERITIES.has(severity)) {
    return invalid(`${at}.severity must be one of ${REVIEW_FINDING_SEVERITIES.join(", ")}, got ${describeJson(severity)}`);
  }
  if (!isPlainJsonObject(subject)) return invalid(`${at}.subject must be a JSON object {kind, locator}, got ${describeJson(subject)}`);
  const kind = subject["kind"];
  const locator = subject["locator"];
  if (typeof kind !== "string" || !SUBJECT_KINDS.has(kind)) {
    return invalid(`${at}.subject.kind must be one of ${REVIEW_FINDING_SUBJECT_KINDS.join(", ")}, got ${describeJson(kind)}`);
  }
  if (typeof locator !== "string" || locator.length === 0) {
    return invalid(`${at}.subject.locator must be a non-empty JSON string, got ${describeJson(locator)}`);
  }
  return { ok: true, value: {
    ...(attributed === undefined ? {} : { attributedTo: attributed.value }),
    detail,
    ruleId,
    severity,
    subject: { kind, locator },
  } as ReviewFinding };
}

export function parseFindings(values: readonly JsonValue[]): PayloadParse<readonly ReviewFinding[]> {
  const parsed: ReviewFinding[] = [];
  for (const [index, value] of values.entries()) {
    const finding = parseFinding(value, index);
    if (!finding.ok) return finding;
    parsed.push(finding.value);
  }
  return { ok: true, value: parsed };
}

export function parseItems(values: readonly JsonValue[]): PayloadParse<readonly ReviewPackageItemInput[]> {
  const parsed: ReviewPackageItemInput[] = [];
  for (const [index, value] of values.entries()) {
    const at = `packageItems[${String(index)}]`;
    if (!isPlainJsonObject(value)) return invalid(`${at} must be a JSON object {digest, kind, locator}, got ${describeJson(value)}`);
    const digest = value["digest"];
    const kind = value["kind"];
    const locator = value["locator"];
    for (const [key, member] of [["digest", digest], ["kind", kind], ["locator", locator]] as const) {
      if (typeof member !== "string") return invalid(`${at}.${key} must be a JSON string, got ${describeJson(member)}`);
    }
    parsed.push({ digest: digest as string, kind: kind as string, locator: locator as string });
  }
  return { ok: true, value: parsed };
}
