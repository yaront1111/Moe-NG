import { createHash } from "node:crypto";

/**
 * Closed versions for every skill artifact. A consumer that does not recognise
 * one of these strings must refuse the artifact rather than guess.
 */
export const SKILL_MANIFEST_VERSION = "moe-skill-manifest/1";
export const SKILL_SNAPSHOT_VERSION = "moe-skill-snapshot/1";
export const SKILL_RENDERER_INPUT_VERSION = "moe-skill-renderer-input/1";

/**
 * Bounded limits. Worst case at these caps is 64 files x (200 path chars + 64
 * digest chars + overhead), which stays far below MAX_JSON_BODY_BYTES (1 MiB),
 * so a manifest that satisfies these limits can always be decoded.
 */
export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_FILE_BYTES = 262_144;
export const MAX_SKILL_TOTAL_BYTES = 1_048_576;
export const MAX_SKILL_PATH_CHARS = 200;
export const MAX_SKILL_ID_CHARS = 64;
export const MAX_SKILL_REQUESTS = 16;

export const SKILL_ERROR_CODES = Object.freeze([
  "SKILL_MANIFEST_BYTES_INVALID",
  "SKILL_MANIFEST_SCHEMA_INVALID",
  "SKILL_MANIFEST_VERSION_UNSUPPORTED",
  "SKILL_UNICODE_INVALID",
  "SKILL_LIMIT_EXCEEDED",
  "SKILL_IDENTITY_INVALID",
  "SKILL_IDENTITY_DUPLICATE",
  "SKILL_PATH_INVALID",
  "SKILL_PATH_AMBIGUOUS",
  "SKILL_SYMLINK_ESCAPE",
  "SKILL_FILE_MISSING",
  "SKILL_FILE_OVERSIZED",
  "SKILL_DIGEST_MISMATCH",
  "SKILL_REQUEST_UNKNOWN",
  "SKILL_REQUEST_AMBIGUOUS",
  "SKILL_SNAPSHOT_INVALID",
] as const);

export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[number];

/** Closed provenance labels. Legacy material is recorded, never blessed. */
export const SKILL_ORIGINS = Object.freeze(["authored", "legacy-moe-skills"] as const);

export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

export interface SkillFailure {
  readonly ok: false;
  readonly code: SkillErrorCode;
  readonly message: string;
}

/** Every rejection in this package is produced here, so the shape cannot drift. */
export function skillFailure(code: SkillErrorCode, message: string): SkillFailure {
  return Object.freeze({ ok: false as const, code, message });
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function isSafeByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * NFC is required so two paths that render identically cannot hash differently.
 * Also rejects lone surrogates, which normalize() preserves but which are not
 * well-formed text.
 */
export function isNormalizedText(value: string): boolean {
  return value.isWellFormed() && value === value.normalize("NFC");
}

export function isSkillOrigin(value: unknown): value is SkillOrigin {
  return typeof value === "string" && (SKILL_ORIGINS as readonly string[]).includes(value);
}

/**
 * Exact-key check against a closed schema. Uses Object.hasOwn because decoded
 * JSON objects have a null prototype.
 */
export function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== expected.length) {
    return false;
  }
  return expected.every((key) => Object.hasOwn(value, key));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sorted-key JSON with integer-only numbers. Two structurally equal values
 * always produce byte-identical text, which is what makes bundle and snapshot
 * digests replayable.
 *
 * Takes `unknown` because TypeScript interfaces carry no implicit index
 * signature and so cannot satisfy a recursive JSON type. Every unsupported
 * runtime shape throws rather than serialising to `undefined`, so a value that
 * cannot be canonicalised can never silently reach a digest.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("canonical JSON supports safe integers only");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }
  const body = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",");
  return `{${body}}`;
}

export function canonicalDigest(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

/**
 * Recursively freezes plain records and arrays.
 *
 * MUST NOT receive a typed array: Object.freeze on a non-empty Uint8Array
 * throws TypeError because its indexed elements cannot be reconfigured. File
 * content therefore travels as base64 strings, never as bytes, inside any
 * frozen graph.
 */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    return Object.freeze(value) as T;
  }
  return value;
}
