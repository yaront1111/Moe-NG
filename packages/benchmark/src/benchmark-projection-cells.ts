/**
 * The four ways a projected cell comes into existence, and no fifth.
 *
 * Every UNKNOWN in this harness is built here, so there is exactly one place that could
 * ever be edited to make an unobserved reading render as a value. That concentration is
 * the point: the failure this package exists to prevent is a `null` quietly becoming a
 * `0`, and a rule enforced in one function is a rule a single drill can falsify.
 *
 * An unknown cell carries NO `value` key. A reader destructuring `{ value }` off an
 * unknown gets `undefined`, which is loud, rather than a zero, which is a lie.
 */

import type { BenchmarkUnknownBasis, BenchmarkValue } from "./benchmark-projection-vocabulary.js";
import type { ProjectedFactUnknown, ProjectedQuantity, ProjectedText } from "./benchmark-record-contracts.js";

export function knownCell<T>(value: T): BenchmarkValue<T> {
  return { known: true, value };
}

/**
 * An unknown this HARNESS read off the record's shape. `code` and `layer` stay null:
 * no producing authority spoke here, and naming one would be inventing evidence.
 */
export function unknownCell<T>(basis: BenchmarkUnknownBasis): BenchmarkValue<T> {
  return { known: false, basis, code: null, layer: null };
}

/**
 * An unknown a PRODUCER declared, carrying its own code and layer verbatim. `basis`
 * distinguishes a fact the producer reached and could not observe from a whole selection
 * it could not read; both keep the producer's attribution.
 */
export function producerUnknownCell<T>(
  fact: ProjectedFactUnknown,
  basis: BenchmarkUnknownBasis = "PRODUCER_DECLARED_UNKNOWN",
): BenchmarkValue<T> {
  return { known: false, basis, code: fact.code, layer: fact.layer };
}

/** A producer fact projected as-is: observed becomes known, unobserved keeps its code. */
export function factCell(fact: ProjectedQuantity): BenchmarkValue<number>;
export function factCell(fact: ProjectedText): BenchmarkValue<string>;
export function factCell(
  fact: ProjectedQuantity | ProjectedText,
): BenchmarkValue<number> | BenchmarkValue<string> {
  if (!fact.known) return producerUnknownCell<number>(fact);
  // Narrowed on a local binding rather than cast: the two observed arms carry different
  // value types, and a cast here would be the one place a quantity could be published
  // under a text column without the compiler objecting.
  const observed = fact.value;
  if (typeof observed === "number") return knownCell(observed);
  return knownCell(observed);
}

/**
 * A nullable record field. `null` on this contract means UNOBSERVED, never empty and
 * never zero, so it becomes an explicit UNKNOWN rather than a default.
 */
export function nullableCell<T>(value: T | null): BenchmarkValue<T> {
  if (value === null) return unknownCell("OBSERVATION_ABSENT");
  return knownCell(value);
}
