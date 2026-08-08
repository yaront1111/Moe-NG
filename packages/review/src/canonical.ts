import { createHash } from "node:crypto";

/**
 * Canonical serialization for this package's digest-bound records.
 *
 * Mirrored locally rather than imported: determinism helpers live per package in this repo
 * (`packages/runner/src/canonical.ts` is the precedent), and this task takes @moe/core as its
 * only dependency. Two structurally equal values always produce byte-identical text, so a
 * package digest or a lineage digest depends on the facts and never on the order a caller
 * happened to build them in. Anything that cannot be canonicalised throws rather than
 * serialising to `undefined`, so an unsupported shape can never silently reach a digest.
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
  return createHash("sha256").update(new TextEncoder().encode(canonicalJson(value))).digest("hex");
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** Shape-only check on a supplied content-addressed reference; this package never hashes bytes. */
export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

/** Recursively freezes plain records and arrays so a held reference cannot alter what a
 * digest already attested. */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value) as T;
  }
  return value;
}

/** Stable total order over canonicalisable values; used to make list digests order-insensitive. */
export function byCanonicalOrder(left: unknown, right: unknown): number {
  const leftText = canonicalJson(left);
  const rightText = canonicalJson(right);
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}
