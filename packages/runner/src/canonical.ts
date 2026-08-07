import { createHash } from "node:crypto";

/**
 * Canonical serialization shared by every digest-bound runner record.
 *
 * Two structurally equal values always produce byte-identical text, which is
 * what makes a scope observation or a workspace manifest replayable: the digest
 * depends on the facts, never on the order a caller happened to build them in.
 * Anything that cannot be canonicalised throws rather than serialising to
 * `undefined`, so an unsupported shape can never silently reach a digest.
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

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalDigest(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively freezes plain records and arrays; typed arrays are never passed in. */
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

/**
 * NFC is required so two paths that render identically cannot hash differently.
 * Also rejects lone surrogates, which normalize() preserves but which are not
 * well-formed text.
 */
export function isNormalizedText(value: string): boolean {
  return value.isWellFormed() && value === value.normalize("NFC");
}

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Accepts either object format, because a repository may use sha1 or sha256. */
export function isCommitIdentity(value: unknown): value is string {
  return typeof value === "string" && (SHA1_PATTERN.test(value) || SHA256_PATTERN.test(value));
}

export function isHex64(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function isSafeByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/u;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/**
 * Validates a caller-supplied instant without touching a clock, so the check
 * itself stays deterministic and replayable.
 */
export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}
