/**
 * Deterministic value primitives shared by the scheduler kernels: output
 * freezing, locale-independent ordering, vocabulary and count guards, the strict
 * exact-record reader, and length framing.
 *
 * Hoisted out of the budget, dependency, admission, authority, node-authority and
 * graph-identity modules, which each carried a byte-identical private copy. They
 * are generic over every issue vocabulary — nothing here names a code union — so
 * no closed union owned by another module constrains them, which is what keeps
 * the typed makeIssue/sortIssues helpers local to each kernel instead.
 *
 * Imports only the package's hardened input kernel.
 */
import { hasOnlyOwnStringKeys, isPlainRecord, readOwnDataProperty } from "./runtime-shape.js";

/** Freezes a plain data tree in place. An already-frozen value is returned as-is, unvisited. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Code-unit comparison, never `localeCompare`: collation is locale-dependent. */
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** A non-empty string. Deliberately unbounded; a kernel that caps ref length keeps its own guard. */
export function isRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Safe nonnegative integer. Rejects NaN, Infinity, fractions, -0, and unsafe
 * magnitudes. Unlike the authority kernel's `isCount` it reserves no headroom
 * below `Number.MAX_SAFE_INTEGER`.
 */
export function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

/** Accepts only a plain record carrying exactly `keys` as own data properties. */
export function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, keys)) return null;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const read = readOwnDataProperty(value, key);
    if (!read.ok || !read.present) return null;
    output[key] = read.value;
  }
  return output;
}

/** Length-frame a token so concatenation is collision-free (no forged boundary). */
export function frame(token: string): string {
  return `${token.length}:${token}`;
}
