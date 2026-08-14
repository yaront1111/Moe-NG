import { types } from "node:util";

/**
 * Own-data snapshotting for the `work.claim` authority boundary.
 *
 * Every exported helper returns daemon-owned own data. The sole deliberate
 * exception is `mirror`, whose one-level copy routes outer section values to
 * their owning leg; no routed value is read until that leg calls `mirrorDeep`
 * (or, for live claims, `mirrorList`). Keeping that exception narrow preserves
 * each upstream leg's refusal attribution without retaining caller authority.
 *
 * TWO PROPERTIES are load-bearing.
 *
 * 1. NO CALLER CODE RUNS INSIDE THE BOUNDARY. Values are read from
 *    DESCRIPTORS, never by property access, so a getter is never invoked; and a
 *    Proxy is refused for BEING one, before any trap can answer. Descriptor
 *    reading alone is not enough — a transparent proxy forwards every check to
 *    the real record, so a parser that only defeats lying traps admits the
 *    membrane intact and hands it to the scheduler, ledger and runner.
 *
 * 2. NO CALLER OBJECT IS RETAINED. A one-level copy still points at the
 *    caller's nested records, and those travel through the upstream authorities
 *    onto the published successors — the runner carries the intent's lease
 *    binding through verbatim. The result is then deep-frozen, so a shallow
 *    snapshot silently freezes objects the caller still owns. `detach` copies
 *    the whole subtree, so the graph handed upstream is daemon-owned.
 *
 * Anything that cannot be copied under those rules is refused rather than
 * degraded to a partial read, and its leg maps it to `WORK_PAYLOAD_MALFORMED`.
 */

/**
 * Bounds recursion. A caller record may point back at itself — JSON cannot
 * express that but an in-process caller can — and every claim section is a
 * handful of levels deep, so exceeding this is a hostile shape, not a
 * legitimate one.
 */
const MAX_DEPTH = 24;

/** Distinguishes "refused" from a legitimate `undefined` or `null` value. */
const UNSAFE = Symbol("work.claim/unsafe");

function detachList(value: readonly unknown[], depth: number): unknown[] | typeof UNSAFE {
  if (Object.getPrototypeOf(value) !== Array.prototype) return UNSAFE;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (length === undefined || typeof length.value !== "number") return UNSAFE;
  // Own-key count exactly the indices plus `length` is what rejects a hole or a
  // smuggled key, and it bounds the loop as well.
  if (Reflect.ownKeys(value).length !== length.value + 1) return UNSAFE;
  const copy: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return UNSAFE;
    }
    const item = detach(descriptor.value, depth + 1);
    if (item === UNSAFE) return UNSAFE;
    copy.push(item);
  }
  return copy;
}

/** Deep own-data copy, or `UNSAFE` for anything that cannot be copied safely. */
function detach(value: unknown, depth: number): unknown {
  if (typeof value === "function") return UNSAFE;
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_DEPTH || types.isProxy(value)) return UNSAFE;
  if (Array.isArray(value)) return detachList(value, depth);
  const prototype: unknown = Object.getPrototypeOf(value);
  // A Date, Map, Set or class instance lands here: it carries state this copy
  // cannot reproduce, so it is refused rather than flattened into a bare record.
  if (prototype !== Object.prototype && prototype !== null) return UNSAFE;
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return UNSAFE;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return UNSAFE;
    }
    const item = detach(descriptor.value, depth + 1);
    if (item === UNSAFE) return UNSAFE;
    copy[key] = item;
  }
  return copy;
}

/**
 * Own-data mirror of a caller record, ONE level deep: section values stay
 * untouched so each still reaches its own leg carrying that leg's upstream
 * reason code. `keys === null` mirrors whatever own string keys are present;
 * `exact` also demands every declared key.
 */
export function mirror(
  value: unknown,
  keys: readonly string[] | null,
  exact: boolean,
): Record<string, unknown> | null {
  // Proxy FIRST: `Array.isArray` throws on a revoked proxy, so asking it first
  // escapes as an exception instead of refusing with a stable reason code.
  if (typeof value !== "object" || value === null || types.isProxy(value)) return null;
  if (Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (!own.every((key) => typeof key === "string" && (keys === null || keys.includes(key)))) {
    return null;
  }
  if (exact && keys !== null && own.length !== keys.length) return null;
  const copy: Record<string, unknown> = {};
  for (const key of keys ?? (own as readonly string[])) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!descriptor.enumerable || !("value" in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

/**
 * As `mirror`, but every value is detached too, so the record handed to an
 * upstream authority shares no object with the caller at any depth.
 */
export function mirrorDeep(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  const shallow = mirror(value, keys, false);
  if (shallow === null) return null;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(shallow)) {
    const detached = detach(shallow[key], 1);
    if (detached === UNSAFE) return null;
    copy[key] = detached;
  }
  return copy;
}

/** Deep own-data mirror of a dense array, using the same recursion as sections. */
export function mirrorList(value: unknown): readonly unknown[] | null {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return null;
  if (!Array.isArray(value)) return null;
  const copied = detachList(value, 0);
  return copied === UNSAFE ? null : copied;
}
