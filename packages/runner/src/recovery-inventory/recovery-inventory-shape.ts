import { isCanonicalUtcTimestamp, isHex64, isNormalizedText } from "../canonical.js";
import { exactRecord, isCount, isStrictRecord, oneOf, readList } from "../supervisor/effect-shape.js";
import {
  MAX_RECOVERY_INVENTORY_FACTS,
  MAX_RECOVERY_INVENTORY_ITEMS,
  MAX_RECOVERY_INVENTORY_TEXT_CHARS,
  RECOVERY_INVENTORY_CLASSES,
  RECOVERY_INVENTORY_ITEM_KEYS,
  RECOVERY_INVENTORY_REF_KEYS,
  RECOVERY_INVENTORY_WINDOW_KEYS,
  type RecoveryInventoryFactValue,
  type RecoveryInventoryIdentity,
  type RecoveryInventoryItem,
  type RecoveryInventoryOpaqueRef,
  type RecoveryInventoryPortReading,
  type RecoveryInventoryRefKind,
  type RecoveryInventoryWindow,
} from "./recovery-inventory-contract.js";

/**
 * Hostile-input readers for the recovery-inventory vocabulary.
 *
 * Split out of the contract so neither file drifts toward the per-file cap: the
 * contract declares shapes, this module decides whether an arriving value is
 * one. Nothing here trusts a value it was handed — every read goes through the
 * accessor- and proxy-safe primitives, because a record that computes its own
 * fields can answer one way for a validation and another for the digest.
 */

/** Returned frozen so a caller compares the same bytes the gate validated. */
export function isBoundedInventoryText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RECOVERY_INVENTORY_TEXT_CHARS &&
    isNormalizedText(value)
  );
}

/**
 * Compares by code point rather than `localeCompare`, whose order depends on the
 * host's collation: a digest that changes with the machine's locale is not a
 * digest. Iterating the string yields code points, so an astral character sorts
 * by its scalar value instead of by its surrogate halves.
 */
export function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const one = a[index]?.codePointAt(0) ?? 0;
    const two = b[index]?.codePointAt(0) ?? 0;
    if (one !== two) {
      return one < two ? -1 : 1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Collapses a canonical UTC instant to a fixed-width comparable key. Plain string
 * comparison is wrong here: `...:00Z` and `...:00.000Z` are the same instant, but
 * `.` sorts below `Z`, so a lexicographic window check would exclude an edge.
 */
export function utcSortKey(value: string): string {
  const digits = value.replace(/[-:TZ.]/gu, "");
  return digits.length === 14 ? `${digits}000` : digits;
}

export function readOpaqueRef(
  value: unknown,
  kind: RecoveryInventoryRefKind,
): RecoveryInventoryOpaqueRef | null {
  const record = exactRecord(value, RECOVERY_INVENTORY_REF_KEYS);
  if (record === null || record["kind"] !== kind) {
    return null;
  }
  if (!isBoundedInventoryText(record["ref"]) || !isHex64(record["digest"])) {
    return null;
  }
  return Object.freeze({ kind, ref: record["ref"], digest: record["digest"] });
}

export function readWindow(value: unknown): RecoveryInventoryWindow | null {
  const record = exactRecord(value, RECOVERY_INVENTORY_WINDOW_KEYS);
  if (record === null) {
    return null;
  }
  const start = record["startInclusive"];
  const end = record["endInclusive"];
  if (!isCanonicalUtcTimestamp(start) || !isCanonicalUtcTimestamp(end)) {
    return null;
  }
  if (utcSortKey(start) > utcSortKey(end)) {
    return null;
  }
  return Object.freeze({ startInclusive: start, endInclusive: end });
}

/**
 * PATH separators are normalized before comparison, because `a\b` and `a/b` name
 * one thing. OPAQUE bytes are left alone: a provider id is not a path, and
 * rewriting a separator inside one would merge two genuinely distinct records.
 */
export function readIdentity(value: unknown): RecoveryInventoryIdentity | null {
  const tagged = exactRecord(value, ["kind", "path"]);
  if (tagged !== null && tagged["kind"] === "PATH") {
    const path = tagged["path"];
    if (!isBoundedInventoryText(path)) return null;
    return Object.freeze({ kind: "PATH" as const, path: path.replace(/\\/gu, "/") });
  }
  const opaque = exactRecord(value, ["kind", "id"]);
  if (opaque !== null && opaque["kind"] === "OPAQUE" && isBoundedInventoryText(opaque["id"])) {
    return Object.freeze({ kind: "OPAQUE" as const, id: opaque["id"] });
  }
  return null;
}

/** The normalized key two items are compared on for aliasing. */
export function identityKey(identity: RecoveryInventoryIdentity): string {
  return identity.kind === "PATH" ? `PATH ${identity.path}` : `OPAQUE ${identity.id}`;
}

/**
 * Facts are the one OPEN key set in this contract, and that is what makes them
 * dangerous. `JSON.parse` produces an own `__proto__` DATA property, which
 * `Object.keys` reports — but assigning it onto a plain `{}` accumulator is
 * swallowed by the inherited setter, so a reader that validates a fact and then
 * copies it into `{}` loses it and admits the item anyway. The accumulator here
 * is therefore null-prototype, and each key is lifted out of its own property
 * DESCRIPTOR so no accessor is ever invoked.
 *
 * The shared `exactRecord` helper cannot be used for this one case: it is built
 * for FIXED key lists and accumulates into `{}`, which has the same blind spot.
 * With a fixed list the blind spot is unreachable, so this is a note about
 * scope, not a defect in that helper.
 */
function readFacts(value: unknown): Readonly<Record<string, RecoveryInventoryFactValue>> | null {
  if (!isStrictRecord(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_RECOVERY_INVENTORY_FACTS) {
    return null;
  }
  const facts = Object.create(null) as Record<string, RecoveryInventoryFactValue>;
  for (const key of keys) {
    if (!isBoundedInventoryText(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return null;
    }
    const fact: unknown = descriptor.value;
    if (typeof fact === "boolean" || isCount(fact) || isBoundedInventoryText(fact)) {
      facts[key] = fact;
      continue;
    }
    return null;
  }
  return Object.freeze(facts);
}

export function readInventoryItem(value: unknown): RecoveryInventoryItem | null {
  const record = exactRecord(value, RECOVERY_INVENTORY_ITEM_KEYS);
  if (record === null) {
    return null;
  }
  if (!oneOf(record["class"], RECOVERY_INVENTORY_CLASSES)) return null;
  if (!isBoundedInventoryText(record["projectTag"])) return null;
  if (!isCanonicalUtcTimestamp(record["observedAt"])) return null;
  if (!isHex64(record["sourceProofDigest"])) return null;
  const identity = readIdentity(record["identity"]);
  const facts = readFacts(record["facts"]);
  if (identity === null || facts === null) {
    return null;
  }
  return Object.freeze({
    class: record["class"],
    projectTag: record["projectTag"],
    identity,
    observedAt: record["observedAt"],
    facts,
    sourceProofDigest: record["sourceProofDigest"],
  });
}

const ENUMERATED_KEYS = Object.freeze([
  "status",
  "items",
  "complete",
  "negativeProofDigest",
] as const);

/**
 * Reduces whatever a port returned to one of the three admitted shapes. Returns
 * null for everything else, which the aggregate turns into RESULT_MALFORMED — an
 * unreadable answer is never an empty answer. The list is read one index at a
 * time rather than iterated, so a subclass whose iterator yields something other
 * than its elements cannot have one list validated and another recorded.
 */
export function readPortResult(value: unknown): RecoveryInventoryPortReading | null {
  const refusal = exactRecord(value, ["status"]);
  if (refusal !== null) {
    if (refusal["status"] === "UNAVAILABLE") return { status: "UNAVAILABLE" };
    if (refusal["status"] === "UNSUPPORTED") return { status: "UNSUPPORTED" };
    return null;
  }
  const record = exactRecord(value, ENUMERATED_KEYS);
  if (record === null || record["status"] !== "ENUMERATED") {
    return null;
  }
  const items = readList(record["items"], MAX_RECOVERY_INVENTORY_ITEMS + 1);
  const complete = record["complete"];
  const negativeProofDigest = record["negativeProofDigest"];
  if (items === null || typeof complete !== "boolean") {
    return null;
  }
  if (negativeProofDigest !== null && !isHex64(negativeProofDigest)) {
    return null;
  }
  return { status: "ENUMERATED", items, complete, negativeProofDigest };
}
