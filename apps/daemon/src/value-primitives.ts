/**
 * The two value primitives the daemon's ledger codecs, readers and kernels each used to carry a
 * private copy of: the record predicate that admits a decoded body, and the freeze that makes a
 * result unwritable before it leaves the module that built it.
 *
 * `isRecord` IS PROTOTYPE-AGNOSTIC. `decodeBoundedJsonBytes` yields null-prototype objects and a
 * reader may also hold a literal or a class instance; all three are records here. Arrays, `null`
 * and functions are not — an array reaching a field reader as "a record" is exactly the shape
 * confusion these predicates exist to stop. A caller that must ALSO prove the value came through
 * the bounded decoder wants `isObject` from `json-record-shape.ts`, which checks the prototype.
 *
 * `deepFreeze` FREEZES THE ROOT BEFORE DESCENDING, which is what makes it safe on a cyclic
 * graph: the second visit sees a frozen node and returns. Two consequences are load-bearing and
 * deliberate. An ALREADY-FROZEN root is left alone, children included, so freezing a branch by
 * hand and then handing the parent here does not deep-freeze the rest. And it walks
 * `Object.keys`, so symbol-keyed and non-enumerable members are reachable but not frozen; the
 * codecs that use it build their records from string keys only. `freezeDeep` in
 * `json-record-shape.ts` is the other trade — every own key, and no cycle tolerance.
 */

/** A non-null, non-array object of any prototype, narrowed for member reads. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Freezes the value and, transitively, every own enumerable string-keyed member. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
