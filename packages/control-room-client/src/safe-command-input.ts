import { admitGoalBrief } from "@moe/contracts";
import type { GoalBriefRefused } from "@moe/contracts";

/**
 * The prototype-safety fence every typed command edge crosses before it reads a
 * caller's record.
 *
 * It exists because the admissions downstream are VALUE contracts: they judge
 * what a record holds, not how the record answers. A caller can hand this edge a
 * revoked proxy, an accessor whose getter runs on read, or an object whose
 * prototype supplies keys it never owned - and each of those turns "read the
 * fields and admit them" into running caller code or admitting fields nobody
 * wrote. So the record is reduced to its own DATA properties first, and anything
 * that cannot be reduced is refused without being read at all.
 *
 * This lives in one module rather than beside each helper on purpose: a security
 * fence copied per call site is a fence that drifts, and the copy that stops
 * being updated is the one an attacker reaches.
 */

/**
 * A frozen, null-prototype copy of `input`'s own string-keyed DATA properties,
 * or `null` when the value is not a reducible plain record. Accessors are never
 * invoked - an accessor property makes the whole record irreducible.
 */
export function copyOwnDataInput<T>(
  input: unknown,
): (T & Readonly<Record<string, unknown>>) | null {
  if (typeof input !== "object" || input === null) return null;
  try {
    if (Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input) as object | null;
    if (prototype !== null && prototype !== Object.prototype) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== "string")) return null;
    const copied = Object.create(null) as Record<string, unknown>;
    for (const key of keys as readonly string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      copied[key] = descriptor.value;
    }
    return Object.freeze(copied) as T & Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

/**
 * The refusal for an input that could not even be reduced to a record. It is
 * sourced from the SHARED brief contract rather than authored here, so this edge
 * never mints a refusal vocabulary of its own; the brief is the first gate every
 * goal-creating command passes, so its layer is the truthful one to report.
 */
export function sharedInputRefusal(input: unknown): GoalBriefRefused {
  const result = admitGoalBrief(input);
  if (!result.ok) return result;
  const fallback = admitGoalBrief(null);
  if (!fallback.ok) return fallback;
  throw new Error("goal brief contract accepted its null refusal control");
}
