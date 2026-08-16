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
 *  3. BENCHMARK_SHAPE   — are the top-level fields present, and of the kind I project?
 *  4. BENCHMARK_ROW     — is each usage row readable? Admission accepts `usage` in bulk
 *     as an array; the rows themselves are checked here so a single unreadable row is
 *     attributable to the row layer rather than to the record's shape.
 */

import { benchmarkProjectionRefusal } from "./benchmark-projection-vocabulary.js";
import type { BenchmarkProjectionRefusal } from "./benchmark-projection-vocabulary.js";
import { PROJECTED_RECORD_KEYS, PROJECTED_RECORD_VERSION } from "./benchmark-record-contracts.js";
import type { ProjectedRunRecord } from "./benchmark-record-contracts.js";

export type BenchmarkAdmission =
  | { readonly ok: true; readonly record: ProjectedRunRecord }
  | BenchmarkProjectionRefusal;

type PlainRecord = Readonly<Record<string, unknown>>;

/**
 * A plain record and nothing else. Arrays, functions and class instances are excluded:
 * the input is meant to be decoded durable data, and anything carrying behaviour did not
 * come from the store.
 */
function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

const isString = (value: unknown): boolean => typeof value === "string";
const isRecordOrNull = (value: unknown): boolean => value === null || isPlainRecord(value);

/** Wall seconds, boot identity and monotonic reading together, or an unobserved null. */
function isObservationOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainRecord(value)) return false;
  return typeof value["serverWallSeconds"] === "number"
    && typeof value["bootId"] === "string"
    && typeof value["monotonicObservation"] === "number";
}

/**
 * The kind each top-level field must be. `recordVersion` is absent by design: the
 * version seam above already settled it, and listing it here would let a shape complaint
 * answer for a schema move.
 */
const RECORD_SHAPE: Readonly<Record<string, (value: unknown) => boolean>> = Object.freeze({
  providerRunRef: isPlainRecord,
  launch: isPlainRecord,
  declared: isPlainRecord,
  observedModel: isPlainRecord,
  terminal: isString,
  infrastructure: isString,
  tokens: isPlainRecord,
  steps: isPlainRecord,
  sequence: isPlainRecord,
  concurrency: isPlainRecord,
  observedStart: isObservationOrNull,
  observedEnd: isObservationOrNull,
  usage: Array.isArray,
  usageRefusals: Array.isArray,
  upstreamRefusal: isRecordOrNull,
  stdoutReceiptDigest: isPlainRecord,
  stderrReceiptDigest: isPlainRecord,
  recordDigest: isString,
});

/** The measurement fields a cost row is projected from. A row short of these has no basis. */
function hasMeasurementBasis(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const quantity = value["quantity"];
  return typeof value["meter"] === "string"
    && (quantity === null || typeof quantity === "number")
    && typeof value["coverage"] === "string"
    && typeof value["source"] === "string"
    && typeof value["sequence"] === "number";
}

function isReadableUsageRow(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return hasMeasurementBasis(value["measurement"])
    && isRecordOrNull(value["pricebookBinding"])
    && typeof value["truncated"] === "boolean"
    && typeof value["identity"] === "string";
}

/**
 * Admits one record, or refuses with the exact code and layer of whichever guard
 * answered. The cast on the success arm is the documented boundary of this module: every
 * field has been checked to be present and of its projected kind, and nothing deeper is
 * asserted, because nothing deeper is this package's to assert.
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
