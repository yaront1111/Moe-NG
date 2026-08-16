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
