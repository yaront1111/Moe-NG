/**
 * The shape gate the cutover codecs share: every marker and manifest this directory decodes is
 * admitted by an EXACT key roster before a single field is read, so a body carrying an extra key
 * is refused rather than silently narrowed to the keys the reader happens to ask for.
 *
 * READ-ONLY NARROWING, unlike `isRecord` in `../value-primitives.ts`. A decoded manifest is
 * evidence: the cutover readers only read it, and the predicate says so. That modifier is the
 * only difference between the two, and it is why this one stays here.
 *
 * `Object.hasOwn` RATHER THAN A KEY-LIST MEMBERSHIP TEST, because the bodies arrive from
 * `decodeBoundedJsonBytes` with a null prototype: `in` would be fine, but `hasOwn` also refuses
 * an inherited member the day a caller hands over an ordinary object. The size check is what
 * closes the roster; `hasOwn` alone would admit a superset.
 */

/** A non-null, non-array object of any prototype, narrowed for read-only member access. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A CLOSED roster: a record owning exactly these keys, in any order, and nothing else. */
export function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
