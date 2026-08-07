import { types } from "node:util";

const HEX_64 = /^[0-9a-f]{64}$/;

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Lowercase SHA-256 hex only; uppercase or short digests are refused. */
export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

/** Safe nonnegative integer: versions, epochs, and binding counters. */
export function isSafeCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  );
}

/**
 * Own-data-property records only: no proxies, exotic prototypes, symbols, or accessors.
 * The proxy check runs first because `Array.isArray` throws on a revoked proxy.
 */
export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== null && prototype !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.getOwnPropertyNames(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

/** A real array, never a proxy: `Array.isArray` throws on a revoked proxy. */
export function isSafeArray(value: unknown): value is readonly unknown[] {
  return !types.isProxy(value) && Array.isArray(value);
}

/** Exact own-key set: every required key present and no key outside required+optional. */
export function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.getOwnPropertyNames(record);
  if (keys.length < required.length || keys.length > required.length + optional.length) {
    return false;
  }
  const allowed = new Set<string>([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

export interface RuntimeLeaseAuthority {
  readonly attemptBindingVersion: number;
  readonly authorityHash: string;
  readonly epoch: number;
  readonly graphEpoch: number;
  readonly leaseToken: string;
}

const LEASE_KEYS = Object.freeze([
  "attemptBindingVersion", "authorityHash", "epoch", "graphEpoch", "leaseToken",
] as const);

/** All-or-none: a partially bound lease grants no authority at all. */
export function parseLeaseAuthority(value: unknown): RuntimeLeaseAuthority | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, LEASE_KEYS, [])) return undefined;
  if (!isNonEmptyString(value["leaseToken"]) || !isHex64(value["authorityHash"])) return undefined;
  if (!isSafeCount(value["epoch"]) || !isSafeCount(value["graphEpoch"])) return undefined;
  if (!isSafeCount(value["attemptBindingVersion"])) return undefined;
  return Object.freeze({
    attemptBindingVersion: value["attemptBindingVersion"],
    authorityHash: value["authorityHash"],
    epoch: value["epoch"],
    graphEpoch: value["graphEpoch"],
    leaseToken: value["leaseToken"],
  });
}
