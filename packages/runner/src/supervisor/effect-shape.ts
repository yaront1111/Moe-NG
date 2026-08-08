import { types } from "node:util";
import { isHex64, isNormalizedText } from "../canonical.js";

/**
 * Hostile-input shape guards plus the structurally mirrored lease vocabulary.
 *
 * `@moe/runner` depends only on `@moe/contracts`, so the scheduler's lease shape
 * cannot be imported. It is cloned here field-for-field with pinned literals so a
 * drift test can compare the two by value. Nothing in this module trusts a shape:
 * a mirrored record arriving from another process is a claim, and a claim that
 * only *looks* like a lease must not be able to fence anything.
 *
 * The strict readers below defeat prototype and accessor smuggling — a getter
 * that returns a valid token on the first read and a hostile one on the second
 * would otherwise pass a fence check and then bind something else.
 */

/** Pinned verbatim from `@moe/scheduler` `MAX_AUTHORITY_COUNT`. */
export const MAX_SUPERVISOR_COUNT = Number.MAX_SAFE_INTEGER - 1_000_000;
export const MAX_SUPERVISOR_TEXT_CHARS = 400;

/** String-identical to `@moe/scheduler` `LEASE_KINDS`. */
export const MIRRORED_LEASE_KINDS = Object.freeze(["ASSIGNMENT", "WORKSPACE", "RESOURCE"] as const);
/** String-identical to `@moe/scheduler` `LEASE_STATES`. */
export const MIRRORED_LEASE_STATES = Object.freeze([
  "ACTIVE",
  "SUSPECT",
  "DRAINING",
  "RELEASED",
  "REVOKED",
] as const);

export type MirroredLeaseKind = (typeof MIRRORED_LEASE_KINDS)[number];
export type MirroredLeaseState = (typeof MIRRORED_LEASE_STATES)[number];

/** Structural mirror of `@moe/scheduler` `LeaseRecord`; it carries no schema version of its own. */
export interface MirroredLeaseRecord {
  readonly leaseId: string;
  readonly kind: MirroredLeaseKind;
  readonly ownerSessionRef: string;
  readonly leaseToken: string;
  readonly epoch: number;
  readonly state: MirroredLeaseState;
  readonly serverWallDeadline: number;
  readonly bootId: string;
  readonly monotonicObservation: number;
  readonly authorityHashRef: string;
  readonly version: number;
}

/** Structural mirror of `@moe/scheduler` `AuthorityProof`. */
export interface MirroredLeaseProof {
  readonly leaseToken: string;
  readonly epoch: number;
  readonly authorityHashRef: string;
  readonly ownerSessionRef: string;
  readonly expectedVersion: number;
}

export const MIRRORED_LEASE_KEYS = [
  "leaseId",
  "kind",
  "ownerSessionRef",
  "leaseToken",
  "epoch",
  "state",
  "serverWallDeadline",
  "bootId",
  "monotonicObservation",
  "authorityHashRef",
  "version",
] as const;

export const MIRRORED_PROOF_KEYS = [
  "leaseToken",
  "epoch",
  "authorityHashRef",
  "ownerSessionRef",
  "expectedVersion",
] as const;

export type DataPropertyRead =
  | { readonly ok: false }
  | { readonly ok: true; readonly present: false }
  | { readonly ok: true; readonly present: true; readonly value: unknown };

function isProxy(value: object): boolean {
  try {
    return types.isProxy(value);
  } catch {
    return true;
  }
}

export function isStrictRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isProxy(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/** Reads a value only when it is an own *data* property, so an accessor never answers. */
export function readOwnDataProperty(value: object, key: string): DataPropertyRead {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return { ok: true, present: false };
    }
    if (!("value" in descriptor)) {
      return { ok: false };
    }
    return { ok: true, present: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

export function hasOnlyOwnStringKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  try {
    return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
  } catch {
    return false;
  }
}

/** Accepts only a plain record carrying exactly `keys` as own data properties. */
export function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!isStrictRecord(value) || !hasOnlyOwnStringKeys(value, keys)) {
    return null;
  }
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const read = readOwnDataProperty(value, key);
    if (!read.ok || !read.present) {
      return null;
    }
    output[key] = read.value;
  }
  return output;
}

export function isPlainArray(value: unknown): value is unknown[] {
  if (typeof value !== "object" || value === null || isProxy(value)) {
    return false;
  }
  try {
    return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    return false;
  }
}

/**
 * Reads a bounded list without invoking an iterator. `Array.isArray` is true for
 * a subclass whose `Symbol.iterator` answers something other than its elements,
 * so `for...of` would validate one list and hand back another.
 */
export function readList(value: unknown, maximum: number): readonly unknown[] | null {
  if (!isPlainArray(value)) {
    return null;
  }
  const length = readOwnDataProperty(value, "length");
  if (!length.ok || !length.present || !isCount(length.value) || length.value > maximum) {
    return null;
  }
  const output: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const read = readOwnDataProperty(value, String(index));
    if (!read.ok || !read.present) {
      return null;
    }
    output.push(read.value);
  }
  return output;
}

export function isRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SUPERVISOR_TEXT_CHARS &&
    isNormalizedText(value)
  );
}

export function isDigest(value: unknown): value is string {
  return isHex64(value);
}

/**
 * Counter semantics cloned from `@moe/scheduler` `isCount`: safe integer, never
 * negative, never `-0` (which `String(-0) === "0"` would erase from a digest),
 * and never above the ceiling that leaves headroom for the `+1` successors this
 * subtree emits.
 */
export function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_SUPERVISOR_COUNT &&
    !Object.is(value, -0)
  );
}

export function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function parseMirroredLease(value: unknown): MirroredLeaseRecord | null {
  const parsed = exactRecord(value, MIRRORED_LEASE_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["leaseId"]) || !oneOf(parsed["kind"], MIRRORED_LEASE_KINDS)) return null;
  if (!isRef(parsed["ownerSessionRef"]) || !isRef(parsed["leaseToken"])) return null;
  if (!isCount(parsed["epoch"]) || !oneOf(parsed["state"], MIRRORED_LEASE_STATES)) return null;
  if (!isCount(parsed["serverWallDeadline"]) || !isRef(parsed["bootId"])) return null;
  if (!isCount(parsed["monotonicObservation"]) || !isCount(parsed["version"])) return null;
  if (!isDigest(parsed["authorityHashRef"])) return null;
  return parsed as unknown as MirroredLeaseRecord;
}

export function parseMirroredProof(value: unknown): MirroredLeaseProof | null {
  const parsed = exactRecord(value, MIRRORED_PROOF_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["leaseToken"]) || !isCount(parsed["epoch"])) return null;
  if (!isRef(parsed["ownerSessionRef"]) || !isCount(parsed["expectedVersion"])) return null;
  if (!isDigest(parsed["authorityHashRef"])) return null;
  return parsed as unknown as MirroredLeaseProof;
}
