/**
 * The closed vocabulary for what THIS HARNESS could not project.
 *
 * SCOPE, AND THE THREE THINGS IT DELIBERATELY EXCLUDES.
 *
 * 1. NOT WHAT THE RUN DID. `terminal`, `infrastructure`, `upstreamRefusal` and
 *    `usageRefusals` already say that, on the record, in vocabularies owned by
 *    @moe/runner and @moe/scheduler. A code here meaning "the provider refused" would be
 *    a second vocabulary for one condition, and a later reader holding only the durable
 *    bytes could no longer tell which authority answered.
 * 2. NOT WHAT A CAMPAIGN CONCLUDED. There is no code for "this arm scored worse" or
 *    "this claim is unproven". Scoring and claim decisions belong to the campaign that
 *    consumes this harness. A projector entitled to a verdict would be deciding the
 *    claim it exists to measure.
 * 3. NOT A REPLACEMENT FOR UNKNOWN. An unobserved reading is UNKNOWN on the projected
 *    row, carrying the producing authority's own code and layer. It is not a refusal
 *    here, because the harness projected it perfectly well — the run simply had nothing
 *    to observe. These codes fire only when the harness cannot emit the row at all.
 *
 * FOUR LAYERS, EACH WITH A PRODUCER, IN THE ORDER THEY ANSWER. `BENCHMARK_INPUT` before
 * any field is read; `BENCHMARK_VERSION` next, because an unrecognised schema means the
 * harness cannot know which fields to expect; `BENCHMARK_SHAPE` for top-level admission;
 * `BENCHMARK_ROW` for a row that admission accepted in bulk but projection cannot read.
 * A code no layer can emit cannot fail closed, so every member below is produced.
 *
 * FROZEN ARRAYS, NOT A UNION TYPE. A test cannot iterate a type, and a sweep needs every
 * member at runtime to prove it generated a case for each.
 */

export const BENCHMARK_PROJECTION_CODES = Object.freeze([
  "BENCHMARK_RECORD_FIELD_ABSENT",
  "BENCHMARK_RECORD_FIELD_MALFORMED",
  "BENCHMARK_RECORD_NOT_PLAIN_DATA",
  "BENCHMARK_RECORD_VERSION_UNRECOGNISED",
  "BENCHMARK_ROW_BASIS_ABSENT",
] as const);

/** Which layer answered. Ordered as they run, so a test can pin the earliest producer. */
export const BENCHMARK_PROJECTION_LAYERS = Object.freeze([
  "BENCHMARK_INPUT", "BENCHMARK_VERSION", "BENCHMARK_SHAPE", "BENCHMARK_ROW",
] as const);

export type BenchmarkProjectionCode = (typeof BENCHMARK_PROJECTION_CODES)[number];
export type BenchmarkProjectionLayer = (typeof BENCHMARK_PROJECTION_LAYERS)[number];

/**
 * Static per-code messages. Nothing is interpolated: a message quoting the offending
 * field, digest or captured bytes would echo record content back out of a failure path,
 * and every consumer already holds the code and the layer.
 */
export const BENCHMARK_PROJECTION_MESSAGES:
  Readonly<Record<BenchmarkProjectionCode, string>> = Object.freeze({
    BENCHMARK_RECORD_FIELD_ABSENT: "the record omits a field this projection requires",
    BENCHMARK_RECORD_FIELD_MALFORMED: "a required record field is not the shape this projection reads",
    BENCHMARK_RECORD_NOT_PLAIN_DATA: "the input is not a readable plain record",
    BENCHMARK_RECORD_VERSION_UNRECOGNISED: "the record names a schema revision this projection does not read",
    BENCHMARK_ROW_BASIS_ABSENT: "a usage row carries no readable measurement basis",
  });

/**
 * WHY a projected cell is UNKNOWN. Distinct from the refusal codes above and never
 * interchangeable with them: a refusal means the harness could not emit the row at all,
 * while a basis means the row exists and this cell had nothing to observe.
 *
 * The benchmark requires every measurement to carry an exact source or an explicit
 * UNKNOWN, so an unknown cell that could not say WHY would be the imputation hazard
 * wearing a different hat — indistinguishable, one edit later, from a zero.
 *
 * TWO OF THE FIVE CARRY A PRODUCER'S OWN CODE AND LAYER, and they are not the same case.
 * `PRODUCER_DECLARED_UNKNOWN` is a fact the producer reached and could not observe.
 * `SELECTION_UNREADABLE` is the whole declared selection being unreadable, so the facts
 * inside it were never individually reached at all — a distinction a later reader needs,
 * because the first says the run was measured and this fact was absent, and the second
 * says nothing about the run was asked for in a readable way.
 *
 * The remaining three — `BOOT_IDENTITY_MISMATCH`, `OBSERVATION_ABSENT`, `QUANTITY_ABSENT`
 * — are the harness's own reading of the record's shape and carry no code, because
 * attributing one to a producer that never spoke would be inventing evidence.
 */
export const BENCHMARK_UNKNOWN_BASES = Object.freeze([
  "BOOT_IDENTITY_MISMATCH",
  "OBSERVATION_ABSENT",
  "PRODUCER_DECLARED_UNKNOWN",
  "QUANTITY_ABSENT",
  "SELECTION_UNREADABLE",
] as const);
export type BenchmarkUnknownBasis = (typeof BENCHMARK_UNKNOWN_BASES)[number];

/**
 * What a cost row's price is BOUND to. Never what the run cost: `PRICEBOOK_BINDING` says
 * a derived list price exists against a named pricebook revision, and `NO_BINDING` says
 * no price was bound at all. Neither is an actual-cost claim, and there is deliberately
 * no third member that would let one become a cost.
 */
export const BENCHMARK_COST_BASES = Object.freeze(["NO_BINDING", "PRICEBOOK_BINDING"] as const);
export type BenchmarkCostBasis = (typeof BENCHMARK_COST_BASES)[number];

/**
 * One projected cell, and the two-directional invariant every cell must satisfy.
 *
 * AN UNKNOWN CELL NEVER CARRIES A `value` KEY at all, so a reader cannot accidentally
 * destructure a zero out of an unobserved reading.
 *
 * AND THE MIRROR, which is the half that was once unwritten and therefore unenforced: a
 * KNOWN cell always carries a `value`, and an unknown whose `basis` names a PRODUCER
 * always carries that producer's non-null `code` and `layer`. Stating only the first half
 * left `{known: true, value: undefined}` and `{known: false, code: undefined}` outside the
 * rule — an observation with nothing behind it, and an unknown attributed to a producer
 * that never spoke. Both are missing evidence wearing authority, which is the one thing
 * this vocabulary exists to make impossible, so both directions are asserted by a walker
 * over real projections rather than left to the type alone. The type cannot enforce it:
 * `undefined` inhabits `T`, and no compiler check survives the `unknown` entry point.
 *
 * The invariant is UPHELD BY ADMISSION, not patched at the cell minters. A cell is built
 * from a field that has already been guarded to the depth it is read, so the minters stay
 * the four unconditional shapes they are; adding a re-check there would put a second
 * authority downstream of the first and let the two disagree.
 */
export type BenchmarkValue<T> =
  | { readonly known: true; readonly value: T }
  | {
      readonly known: false;
      readonly basis: BenchmarkUnknownBasis;
      readonly code: string | null;
      readonly layer: string | null;
    };

/** A refusal from this harness, disjoint by construction from every producer vocabulary. */
export interface BenchmarkProjectionRefusal {
  readonly ok: false;
  readonly code: BenchmarkProjectionCode;
  readonly layer: BenchmarkProjectionLayer;
  readonly message: string;
}

/** The one place a refusal is minted, so no call site can invent a message of its own. */
export function benchmarkProjectionRefusal(
  code: BenchmarkProjectionCode,
  layer: BenchmarkProjectionLayer,
): BenchmarkProjectionRefusal {
  return Object.freeze({
    ok: false as const,
    code,
    layer,
    message: BENCHMARK_PROJECTION_MESSAGES[code],
  });
}
