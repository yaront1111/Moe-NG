export type Gate1DataRow = Readonly<Record<string, unknown>>;

export interface Gate1SnapshotBounds {
  readonly maxArrayLength: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringBytes: number;
}

export type Gate1SnapshotResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false }>;

export const GATE1_SNAPSHOT_BOUNDS: Gate1SnapshotBounds = Object.freeze({
  maxArrayLength: 8_192,
  maxDepth: 8,
  maxNodes: 100_000,
  maxStringBytes: 32_768,
});

const INVALID = Object.freeze({ ok: false as const });
const encoder = new TextEncoder();

/**
 * Captures JSON-shaped input through own data descriptors only. Accessor bodies,
 * `toJSON`, inherited values and Proxy `get` traps are never consulted.
 */
export function snapshotGate1Data(
  value: unknown,
  bounds: Gate1SnapshotBounds = GATE1_SNAPSHOT_BOUNDS,
): Gate1SnapshotResult {
  if ([bounds.maxArrayLength, bounds.maxDepth, bounds.maxNodes, bounds.maxStringBytes].some(
    (limit) => !Number.isSafeInteger(limit) || limit < 0,
  )) return INVALID;
  const seen = new WeakSet<object>();
  let remaining = bounds.maxNodes;

  const visit = (candidate: unknown, depth: number): Gate1SnapshotResult => {
    remaining -= 1;
    if (remaining < 0 || depth > bounds.maxDepth) return INVALID;
    if (candidate === null || typeof candidate === "boolean") {
      return Object.freeze({ ok: true, value: candidate });
    }
    if (typeof candidate === "string") {
      if (candidate.length > bounds.maxStringBytes
        || encoder.encode(candidate).byteLength > bounds.maxStringBytes) return INVALID;
      return Object.freeze({ ok: true, value: candidate });
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Object.freeze({ ok: true, value: candidate });
    }
    if (typeof candidate !== "object") return INVALID;
    if (seen.has(candidate)) return INVALID;
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
          || lengthDescriptor.value > bounds.maxArrayLength) return INVALID;
        const keys = Reflect.ownKeys(candidate).filter((key) => key !== "length");
        if (keys.length !== lengthDescriptor.value || keys.length > remaining) return INVALID;
        const copy: unknown[] = [];
        for (let index = 0; index < lengthDescriptor.value; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            return INVALID;
          }
          const child = visit(descriptor.value, depth + 1);
          if (!child.ok) return child;
          copy.push(child.value);
        }
        return Object.freeze({ ok: true, value: Object.freeze(copy) });
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return INVALID;
      const keys = Reflect.ownKeys(candidate);
      if (keys.length > remaining) return INVALID;
      const copy = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof key !== "string") return INVALID;
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          return INVALID;
        }
        const child = visit(descriptor.value, depth + 1);
        if (!child.ok) return child;
        copy[key] = child.value;
      }
      return Object.freeze({ ok: true, value: Object.freeze(copy) });
    } catch {
      return INVALID;
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, 0);
}

export function exactGate1Row(value: unknown, keys: readonly string[]): Gate1DataRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const actual = Reflect.ownKeys(value);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== "string")) return null;
    const expected = new Set(keys);
    for (const key of actual) {
      if (typeof key !== "string" || !expected.has(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    }
    return value as Gate1DataRow;
  } catch {
    return null;
  }
}

export const gate1Text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const gate1Digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
