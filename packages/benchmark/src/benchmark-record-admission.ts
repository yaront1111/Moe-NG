/**
 * Shape admission for one durable provider-run record.
 *
 * THIS ANSWERS ONE QUESTION: "is this the schema I project?" It is not a validator of
 * the record's CONTENT. The daemon's codec already sealed these bytes and is the only
 * authority on what a record is; re-judging them here would be a second authority over
 * the same evidence, and the two would eventually disagree about bytes that can no
 * longer be corrected. So nothing below recomputes a digest, checks a digest, re-derives
 * an identity, or forms an opinion about whether a value is plausible.
 *
 * THE GUARD ORDER IS LOAD-BEARING, and each layer answers a strictly earlier question:
 *  1. BENCHMARK_INPUT   — is this a plain record at all, before any field is read?
 *  2. BENCHMARK_VERSION — is it a revision I read? An unrecognised schema means the
 *     harness cannot know which fields to expect, so a field complaint would be noise
 *     about a shape it was never entitled to assume.
 *  3. BENCHMARK_SHAPE   — is each field present, and is it the shape this projection
 *     reads, TO THE DEPTH IT READS IT? The predicates live in `benchmark-container-shapes`
 *     and each guards exactly the members projected out of its container.
 *  4. BENCHMARK_ROW     — is each usage row readable? Admission accepts `usage` in bulk
 *     as an array; the rows themselves are checked here so a single unreadable row is
 *     attributable to the row layer rather than to the record's shape.
 *
 * A NESTED FAILURE IS THE SAME CONDITION AS A TOP-LEVEL ONE, so it carries the same code.
 * `launch: 42` and `launch: {}` are both "a required field is not the shape this
 * projection reads"; splitting them into two codes would be a second vocabulary for one
 * condition and would leave a member of the frozen list without a distinct producer.
 */

import {
  isConcurrency, isDeclaredSelection, isLaunchFacts, isObservedModel, isReadableUsageRow,
  isRunRef, isStepObservations, isTokenObservations, isUpstreamRefusalOrNull,
  isUsageRefusalList,
} from "./benchmark-container-shapes.js";
import {
  isObservationOrNull, isPlainRecord, isProjectedQuantity, isProjectedText, isText,
} from "./benchmark-field-primitives.js";
import { benchmarkProjectionRefusal } from "./benchmark-projection-vocabulary.js";
import type { BenchmarkProjectionRefusal } from "./benchmark-projection-vocabulary.js";
import { PROJECTED_RECORD_KEYS, PROJECTED_RECORD_VERSION } from "./benchmark-record-contracts.js";
import type { ProjectedRunRecord } from "./benchmark-record-contracts.js";

export type BenchmarkAdmission =
  | { readonly ok: true; readonly record: ProjectedRunRecord }
  | BenchmarkProjectionRefusal;

/**
 * The shape each top-level field must be. Every entry whose container the projector reads
 * INTO carries a nested predicate rather than a bare kind check; the two that do not —
 * `terminal` and `infrastructure` — are closed vocabularies owned elsewhere and are
 * carried through as opaque strings this package has no standing to re-list.
 *
 * `recordVersion` is absent by design: the version seam above already settled it, and
 * listing it here would let a shape complaint answer for a schema move.
 */
const RECORD_SHAPE: Readonly<Record<string, (value: unknown) => boolean>> = Object.freeze({
  providerRunRef: isRunRef,
  launch: isLaunchFacts,
  declared: isDeclaredSelection,
  observedModel: isObservedModel,
  terminal: isText,
  infrastructure: isText,
  tokens: isTokenObservations,
  steps: isStepObservations,
  sequence: isProjectedQuantity,
  concurrency: isConcurrency,
  observedStart: isObservationOrNull,
  observedEnd: isObservationOrNull,
  usage: Array.isArray,
  usageRefusals: isUsageRefusalList,
  upstreamRefusal: isUpstreamRefusalOrNull,
  stdoutReceiptDigest: isProjectedText,
  stderrReceiptDigest: isProjectedText,
  recordDigest: isText,
});

/**
 * Admits one record, or refuses with the exact code and layer of whichever guard
 * answered. The cast on the success arm is the documented boundary of this module: every
 * field the projection reads has been checked to be present and of its projected kind, at
 * every depth the projection reads it, and nothing deeper is asserted, because nothing
 * deeper is this package's to assert.
 *
 * NOTHING PAST THIS POINT MAY THROW ON A MALFORMED RECORD. `projectBenchmarkRun` takes
 * `unknown`, so a crash escaping it would be a failure carrying no code and no layer —
 * nothing a caller could pin, and not a refusal at all.
 */
export function admitRunRecord(input: unknown): BenchmarkAdmission {
  if (!isPlainRecord(input)) {
    return benchmarkProjectionRefusal("BENCHMARK_RECORD_NOT_PLAIN_DATA", "BENCHMARK_INPUT");
  }
  if (input["recordVersion"] !== PROJECTED_RECORD_VERSION) {
    return benchmarkProjectionRefusal("BENCHMARK_RECORD_VERSION_UNRECOGNISED", "BENCHMARK_VERSION");
  }
  for (const key of PROJECTED_RECORD_KEYS) {
    if (!Object.hasOwn(input, key)) {
      return benchmarkProjectionRefusal("BENCHMARK_RECORD_FIELD_ABSENT", "BENCHMARK_SHAPE");
    }
  }
  for (const [key, accepts] of Object.entries(RECORD_SHAPE)) {
    if (!accepts(input[key])) {
      return benchmarkProjectionRefusal("BENCHMARK_RECORD_FIELD_MALFORMED", "BENCHMARK_SHAPE");
    }
  }
  for (const row of input["usage"] as readonly unknown[]) {
    if (!isReadableUsageRow(row)) {
      return benchmarkProjectionRefusal("BENCHMARK_ROW_BASIS_ABSENT", "BENCHMARK_ROW");
    }
  }
  return { ok: true, record: input as unknown as ProjectedRunRecord };
}
