/**
 * Hostile-input primitives shared by both planning aggregates. Cloned from
 * `goal-validation.ts` so the planning modules keep the same fail-closed boundary: accessors,
 * proxies, symbols, cycles, and exotic prototypes are snapshotted into inert data once, and
 * every later check reads only the snapshot.
 */

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

type DataSnapshot = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
const SNAPSHOT_FAILURE = Object.freeze({ ok: false as const });

/** Malformed optional proofs must stay explicitly invalid instead of collapsing to absence. */
const INVALID_SNAPSHOT_VALUE = Symbol("INVALID_SNAPSHOT_VALUE");

function snapshotArray(source: readonly unknown[], seen: WeakSet<object>): DataSnapshot {
  const lengthProperty = Object.getOwnPropertyDescriptor(source, "length");
  const length = lengthProperty !== undefined && "value" in lengthProperty
    ? lengthProperty.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    return SNAPSHOT_FAILURE;
  }
  const keys = Reflect.ownKeys(source).filter((key) => key !== "length");
  if (keys.length !== length) return SNAPSHOT_FAILURE;
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(source, String(index));
    if (property === undefined || !property.enumerable || !("value" in property)) {
      return SNAPSHOT_FAILURE;
    }
    const nested = snapshotData(property.value, seen);
    if (!nested.ok) return nested;
    items.push(nested.value);
  }
  return { ok: true, value: items };
}

export function snapshotData(value: unknown, seen = new WeakSet<object>()): DataSnapshot {
  const kind = typeof value;
  if (value === null || kind === "undefined" || kind === "boolean"
    || kind === "number" || kind === "string") return { ok: true, value };
  if (kind !== "object") return SNAPSHOT_FAILURE;
  const source = value as object;
  if (seen.has(source)) return SNAPSHOT_FAILURE;
  seen.add(source);
  try {
    if (Array.isArray(source)) return snapshotArray(source, seen);
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) return SNAPSHOT_FAILURE;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string") return SNAPSHOT_FAILURE;
      const property = Object.getOwnPropertyDescriptor(source, key);
      if (property === undefined || !property.enumerable || !("value" in property)) {
        return SNAPSHOT_FAILURE;
      }
      const nested = snapshotData(property.value, seen);
      if (!nested.ok) return nested;
      copy[key] = nested.value;
    }
    return { ok: true, value: copy };
  } catch {
    return SNAPSHOT_FAILURE;
  } finally {
    seen.delete(source);
  }
}

/** Copies a command shell, marking malformed members invalid rather than absent. */
export function snapshotCommand(
  value: unknown,
  kinds: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !property.enumerable || !("value" in property)) return undefined;
      const nested = snapshotData(property.value);
      record[key] = nested.ok ? nested.value : INVALID_SNAPSHOT_VALUE;
    }
    return kinds.some((kind) => kind === record["kind"]) ? record : undefined;
  } catch {
    return undefined;
  }
}

export function exact(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  try {
    return Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function validRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Immutable content identity is always a lowercase 64-character hex digest. */
export function validHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

/** Design truth floor for daemon-provable facts: observation alone never authorizes. */
export function strongTruth(value: unknown): boolean {
  return value === "DAEMON_VERIFIED" || value === "HUMAN_APPROVED";
}

export function humanApproved(value: unknown): boolean {
  return value === "HUMAN_APPROVED";
}

export function validExpectedVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
