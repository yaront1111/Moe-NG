/**
 * The primitive shape predicates every container guard is built from.
 *
 * ONE LEVEL, AND THE REASON THAT MATTERS. Each predicate answers whether a single value is
 * the shape this package reads out of it — nothing about whether the value is plausible,
 * in range, or consistent with another field. The daemon's codec already sealed these
 * bytes and is the only authority on what a record is; a predicate here that judged
 * content would be a second authority over the same evidence.
 *
 * `undefined` IS NEVER ADMITTED ANYWHERE BELOW, and that is the whole point of the file.
 * An absent field reads back as `undefined`, and every predicate treats it as a failure
 * rather than as an empty case, because the cell minters downstream cannot tell an absent
 * reading from an observed one: `nullableCell` takes the KNOWN arm on `undefined` (it is
 * not `null`), publishing `{known: true, value: undefined}` — missing evidence wearing an
 * observation's authority. Refusing here is what makes that unreachable.
 *
 * FINITE, NOT `typeof "number"`. `NaN` and the infinities pass a typeof check and would
 * flow into the one place this package subtracts, publishing a value present in no record.
 * A non-finite reading is not a reading, so this stays a question about shape.
 */

export type PlainRecord = Readonly<Record<string, unknown>>;

/**
 * A plain record and nothing else. Arrays, functions and class instances are excluded: the
 * input is meant to be decoded durable data, and anything carrying behaviour did not come
 * from the store.
 */
export function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export const isText = (value: unknown): boolean => typeof value === "string";
export const isTextOrNull = (value: unknown): boolean => value === null || isText(value);
export const isPlainRecordOrNull = (value: unknown): boolean =>
  value === null || isPlainRecord(value);

/**
 * Every named key is a string. Keys are listed rather than derived from the record's own
 * shape, and unlisted keys are ignored on purpose: a producer may carry fields this
 * package does not project — `ClaudeTelemetryLaunchFacts.exit` is one — and demanding an
 * exact key set would refuse every real record over a field never read.
 */
export function hasTextFields(record: PlainRecord, keys: readonly string[]): boolean {
  return keys.every((key) => isText(record[key]));
}

/** Every named key is a string or an explicit `null` — unobserved, never absent. */
export function hasTextOrNullFields(record: PlainRecord, keys: readonly string[]): boolean {
  return keys.every((key) => isTextOrNull(record[key]));
}

/**
 * A fact a PRODUCER declared unobserved, carrying its own code and layer.
 *
 * BOTH ARE REQUIRED STRINGS. The projection copies them verbatim onto the unknown cell, so
 * a producer unknown missing either one publishes `{known: false, code: undefined}` — an
 * unknown attributed to a producer that never spoke, which the cells module calls
 * inventing evidence and the stable-reason-code rail forbids outright.
 */
export function isProducerUnknown(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return value["known"] === false
    && isText(value["code"])
    && isText(value["layer"]);
}

/** A `ProjectedText`: observed with a string value, or a producer's attributed unknown. */
export function isProjectedText(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value["known"] === true) return isText(value["value"]);
  return isProducerUnknown(value);
}

/** A `ProjectedQuantity`: observed with a finite reading, or a producer's unknown. */
export function isProjectedQuantity(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value["known"] === true) return Number.isFinite(value["value"]);
  return isProducerUnknown(value);
}

/**
 * Wall seconds, boot identity and monotonic reading together, or an unobserved null.
 *
 * The three are bound because a monotonic reading is comparable only against another from
 * the same boot, so admitting a reading without its `bootId` would let the projector
 * derive a duration it cannot falsify.
 */
export function isObservationOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainRecord(value)) return false;
  return Number.isFinite(value["serverWallSeconds"])
    && isText(value["bootId"])
    && Number.isFinite(value["monotonicObservation"]);
}
