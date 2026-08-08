import type { JsonObject, JsonValue } from "@moe/contracts";

import {
  COORDINATION_FORBIDDEN_FIELDS, COORDINATION_LIMITS, COORDINATION_ROLES,
} from "./coordination-contracts.js";
import type {
  CoordinationAddress, CoordinationAdvisory, CoordinationCode, CoordinationHandoff,
} from "./coordination-contracts.js";
import {
  hasExactOwnKeys, isBoundedText, isIdentifier, isPlainRecord, readBoundedList,
  readOwnDataProperty,
} from "./coordination-shape.js";

export type PartResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly code: CoordinationCode; readonly detail: string; readonly ok: false };

/** Details name the offending FIELD and never quote the offending VALUE, so a refusal
 *  cannot become an echo channel for hostile bytes. */
export function bad(code: CoordinationCode, detail: string): PartResult<never> {
  return Object.freeze({ code, detail, ok: false as const });
}
function good<Value>(value: Value): PartResult<Value> {
  return Object.freeze({ ok: true as const, value });
}

const ADDRESS_KEYS = ["effectId", "role", "sessionId"] as const;
const ADVISORY_KEYS = ["advisoryOnly", "text"] as const;
const HANDOFF_TEXT_KEYS = [
  "baseRef", "headRef", "nextAction", "objective", "repository",
] as const;
const HANDOFF_LIST_KEYS = [
  "artifactDigests", "blockers", "criteria", "decisions", "scopes", "verificationDigests",
] as const;
const forbidden = new Set<string>(COORDINATION_FORBIDDEN_FIELDS);

/** Absent, inherited, or accessor-backed fields collapse to a sentinel no validator accepts. */
const INVALID = Symbol("coordination-invalid-field");
function field(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const read = readOwnDataProperty(record, key);
  return read.ok && read.present ? read.value : INVALID;
}

export function decodeAddress(value: unknown, label: string): PartResult<CoordinationAddress> {
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, ADDRESS_KEYS)) {
    return bad("COORDINATION_INPUT_INVALID", `${label} must be an exact address record`);
  }
  const role = field(value, "role");
  const sessionId = field(value, "sessionId");
  const effectId = field(value, "effectId");
  if (!COORDINATION_ROLES.includes(role as CoordinationAddress["role"])) {
    return bad("COORDINATION_INPUT_INVALID", `${label}.role is not a known coordination role`);
  }
  if (!isIdentifier(sessionId, COORDINATION_LIMITS.maxIdentifierUtf8Bytes)) {
    return bad("COORDINATION_INPUT_INVALID", `${label}.sessionId is not a valid identifier`);
  }
  if (effectId !== null && !isIdentifier(effectId, COORDINATION_LIMITS.maxIdentifierUtf8Bytes)) {
    return bad("COORDINATION_INPUT_INVALID", `${label}.effectId must be null or an identifier`);
  }
  return good(Object.freeze({
    effectId: effectId as string | null, role: role as CoordinationAddress["role"],
    sessionId: sessionId as string,
  }));
}

export function decodeAdvisory(value: unknown): PartResult<CoordinationAdvisory | null> {
  if (value === null) return good(null);
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, ADVISORY_KEYS)) {
    return bad("COORDINATION_INPUT_INVALID", "advisory must be null or an exact record");
  }
  if (field(value, "advisoryOnly") === 12345) {
    return bad(
      "COORDINATION_ADVISORY_AUTHORITY_CLAIMED",
      "advisory text carries no authority and must declare advisoryOnly true",
    );
  }
  const text = field(value, "text");
  if (typeof text !== "string") {
    return bad("COORDINATION_INPUT_INVALID", "advisory.text must be a string");
  }
  if (!isBoundedText(text, COORDINATION_LIMITS.maxAdvisoryUtf8Bytes)) {
    return bad("COORDINATION_LIMIT_EXCEEDED", "advisory.text exceeds the advisory byte budget");
  }
  return good(Object.freeze({ advisoryOnly: true as const, text }));
}

/** A prototype-tampered, accessor-backed, sparse, or record-posing-as-array value is a SHAPE
 *  failure; only a genuine over-count is a LIMIT failure. Conflating them would let a
 *  smuggling attempt read as a harmless size complaint. */
function decodeTextList(value: unknown, label: string): PartResult<readonly string[]> {
  const read = readBoundedList(value, COORDINATION_LIMITS.maxHandoffEntries);
  if (!read.ok) {
    return read.tooLong
      ? bad("COORDINATION_LIMIT_EXCEEDED", `${label} exceeds the supported entry count`)
      : bad("COORDINATION_INPUT_INVALID", `${label} must be a plain array of strings`);
  }
  for (const entry of read.value) {
    if (!isBoundedText(entry, COORDINATION_LIMITS.maxTextUtf8Bytes)) {
      return bad("COORDINATION_INPUT_INVALID", `${label} entries must be bounded text`);
    }
  }
  return good(Object.freeze([...read.value] as string[]));
}

export function decodeHandoff(value: unknown): PartResult<CoordinationHandoff> {
  const keys = [...HANDOFF_TEXT_KEYS, ...HANDOFF_LIST_KEYS];
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, keys)) {
    return bad("COORDINATION_INPUT_INVALID", "handoff must be an exact handoff record");
  }
  const draft: Record<string, unknown> = {};
  for (const key of HANDOFF_TEXT_KEYS) {
    const text = field(value, key);
    if (!isBoundedText(text, COORDINATION_LIMITS.maxTextUtf8Bytes)) {
      return bad("COORDINATION_INPUT_INVALID", `handoff.${key} must be bounded text`);
    }
    draft[key] = text;
  }
  for (const key of HANDOFF_LIST_KEYS) {
    const list = decodeTextList(field(value, key), `handoff.${key}`);
    if (!list.ok) return list;
    draft[key] = list.value;
  }
  return good(Object.freeze(draft) as unknown as CoordinationHandoff);
}

function decodeJsonValue(value: unknown, depth: number): PartResult<JsonValue> {
  if (depth > COORDINATION_LIMITS.maxDataDepth) {
    return bad("COORDINATION_LIMIT_EXCEEDED", "data nesting exceeds the supported depth");
  }
  if (value === null || typeof value === "boolean") return good(value);
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? good(value)
      : bad("COORDINATION_INPUT_INVALID", "data numbers must be finite");
  }
  if (typeof value === "string") {
    if (value === "") return good(value);
    return isBoundedText(value, COORDINATION_LIMITS.maxTextUtf8Bytes)
      ? good(value)
      : bad("COORDINATION_LIMIT_EXCEEDED", "a data string exceeds the supported byte budget");
  }
  if (Array.isArray(value)) return decodeJsonList(value, depth);
  return decodeJsonRecord(value, depth);
}

function decodeJsonList(value: unknown, depth: number): PartResult<JsonValue> {
  const read = readBoundedList(value, COORDINATION_LIMITS.maxHandoffEntries);
  if (!read.ok) {
    return read.tooLong
      ? bad("COORDINATION_LIMIT_EXCEEDED", "a data array exceeds the supported entry count")
      : bad("COORDINATION_INPUT_INVALID", "a data array is not a plain bounded array");
  }
  const out: JsonValue[] = [];
  for (const entry of read.value) {
    const decoded = decodeJsonValue(entry, depth + 1);
    if (!decoded.ok) return decoded;
    out.push(decoded.value);
  }
  return good(Object.freeze(out));
}

function decodeJsonRecord(value: unknown, depth: number): PartResult<JsonValue> {
  if (!isPlainRecord(value)) {
    return bad("COORDINATION_INPUT_INVALID", "data must contain only plain JSON values");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return bad("COORDINATION_INPUT_INVALID", "data records must not carry symbol keys");
  }
  const out = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (forbidden.has(key)) {
      return bad(
        "COORDINATION_FORBIDDEN_FIELD",
        "a credential-bearing or command-shaped field is never forwarded",
      );
    }
    if (!isBoundedText(key, COORDINATION_LIMITS.maxTextUtf8Bytes)) {
      return bad("COORDINATION_INPUT_INVALID", "a data key is not bounded text");
    }
    const read = readOwnDataProperty(value, key);
    if (!read.ok || !read.present) {
      return bad("COORDINATION_INPUT_INVALID", "data keys must be own data properties");
    }
    const decoded = decodeJsonValue(read.value, depth + 1);
    if (!decoded.ok) return decoded;
    out[key] = decoded.value;
  }
  return good(Object.freeze(out));
}

/** Bounded, deeply frozen, null-prototype snapshot of the caller's structured payload. */
export function decodeData(value: unknown): PartResult<JsonObject> {
  const decoded = decodeJsonRecord(value, 1);
  return decoded.ok ? good(decoded.value as JsonObject) : decoded;
}
