import { isProxy } from "node:util/types";

export interface ProductAcceptanceSnapshotBounds {
  readonly maxArrayLength: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export type ProductAcceptanceSnapshot =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false }>;

const failed = Object.freeze({ ok: false as const });

/** One bounded descriptor traversal: proxies, accessors, aliases, and cycles are data-invalid. */
export function snapshotProductAcceptanceData(
  value: unknown,
  bounds: ProductAcceptanceSnapshotBounds,
): ProductAcceptanceSnapshot {
  if (![bounds.maxArrayLength, bounds.maxDepth, bounds.maxNodes].every(
    (limit) => Number.isSafeInteger(limit) && limit >= 0,
  )) return failed;
  const seen = new WeakSet<object>();
  let remaining = bounds.maxNodes;
  const visit = (candidate: unknown, depth: number): ProductAcceptanceSnapshot => {
    remaining -= 1;
    if (remaining < 0 || depth > bounds.maxDepth) return failed;
    const kind = typeof candidate;
    if (candidate === null || kind === "undefined" || kind === "boolean"
      || kind === "number" || kind === "string") return { ok: true, value: candidate };
    if (kind !== "object") return failed;
    const source = candidate as object;
    if (isProxy(source) || seen.has(source)) return failed;
    seen.add(source);
    try {
      if (Array.isArray(source)) {
        const lengthProperty = Object.getOwnPropertyDescriptor(source, "length");
        const length = lengthProperty !== undefined && "value" in lengthProperty
          ? lengthProperty.value : undefined;
        if (!Number.isSafeInteger(length) || (length as number) < 0
          || (length as number) > bounds.maxArrayLength
          || (length as number) > remaining) return failed;
        const keys = Reflect.ownKeys(source).filter((key) => key !== "length");
        if (keys.length !== length) return failed;
        const items: unknown[] = [];
        for (let index = 0; index < (length as number); index += 1) {
          const property = Object.getOwnPropertyDescriptor(source, String(index));
          if (property === undefined || !property.enumerable || !("value" in property)) {
            return failed;
          }
          const nested = visit(property.value, depth + 1);
          if (!nested.ok) return nested;
          items.push(nested.value);
        }
        return { ok: true, value: items };
      }
      const prototype = Object.getPrototypeOf(source);
      if (prototype !== Object.prototype && prototype !== null) return failed;
      const keys = Reflect.ownKeys(source);
      if (keys.length > remaining) return failed;
      const copy = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof key !== "string") return failed;
        const property = Object.getOwnPropertyDescriptor(source, key);
        if (property === undefined || !property.enumerable || !("value" in property)) {
          return failed;
        }
        const nested = visit(property.value, depth + 1);
        if (!nested.ok) return nested;
        copy[key] = nested.value;
      }
      return { ok: true, value: copy };
    } catch { return failed; }
  };
  return visit(value, 0);
}
