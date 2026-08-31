import { isProxy } from "node:util/types";

export type PlanningContentHostility = "LIMIT_EXCEEDED" | "MALFORMED" | null;

/** Descriptor-only preflight before snapshotting a graph-independent content draft. */
export function planningContentHostility(
  value: unknown,
  maximumArrayLength: number,
  seen = new WeakSet<object>(),
): PlanningContentHostility {
  if (value === null || typeof value !== "object") return null;
  if (isProxy(value)) return "MALFORMED";
  if (seen.has(value)) return "MALFORMED";
  seen.add(value);
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) return "MALFORMED";
    if (array && value.length > maximumArrayLength) return "LIMIT_EXCEEDED";
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || property === undefined || !("value" in property)) {
        return "MALFORMED";
      }
      const nested = planningContentHostility(property.value, maximumArrayLength, seen);
      if (nested !== null) return nested;
    }
    return null;
  } catch {
    return "MALFORMED";
  } finally {
    seen.delete(value);
  }
}
