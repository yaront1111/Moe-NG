/**
 * THE WIRE IDENTITY OF A PROVIDER RUN — one format, owned here, used from both ends.
 *
 * The runner ENCODES every measurement's `providerRunRef` through `encodeProviderRunRef`, and the
 * settlement reducer DECODES the attempt segment back out with `decodeProviderRunRefAttempt` to
 * correlate a reading against the reservation's `attemptRef`. Before task-763c24cf those two ends
 * were built in different shapes — a composite on the producer side, a bare attemptId on the
 * reservation side — so every production settlement and reconcile refused
 * BUDGET_SETTLEMENT_UNCORRELATED_MEASUREMENT. Nothing was red only because no production caller
 * had wired settlement yet.
 *
 * IT LIVES IN THE SCHEDULER BECAUSE THE DEPENDENCY RUNS THAT WAY. `@moe/runner` already declares
 * `@moe/scheduler`; the reverse would be a cycle. So the reducer's consumer and the runner's
 * producer can share ONE implementation instead of two that agree today and drift tomorrow.
 *
 * CHANGING THIS FORMAT ORPHANS DURABLE RECORDS. Every `ProviderRunTelemetryCommitted` measurement
 * already committed carries the current spelling, and nothing rewrites them. That is why the
 * companion suite pins a byte-exact golden string rather than only a round-trip: a round-trip
 * follows a format change happily, and would let a rename silently detach settlement from every
 * measurement ever recorded.
 *
 * THE LENGTH PREFIXES ARE LOAD-BEARING, NOT DECORATION. A ref may contain ":" — run refs are
 * arbitrary bounded strings — so `split(":")` and any whole-string regex are both wrong. The
 * decoder walks the declared lengths and accepts ONLY when every delimiter lands exactly where
 * those lengths say it must.
 */

/**
 * The identity a provider run is known by, structurally.
 *
 * Deliberately NOT the runner's `ProviderRunRef` type: the scheduler cannot import the runner.
 * The runner's value carries an extra `effectIntentId`, which is IGNORED here exactly as the
 * runner's own flattener has always ignored it — it is not part of the wire identity, and adding
 * it would change the durable format.
 */
export interface ProviderRunIdentity {
  readonly attemptRef: string;
  readonly epoch: number;
  readonly provider: string;
  readonly runRef: string;
}

const isNonNegativeInteger = (value: string): boolean =>
  value.length > 0 && /^[0-9]+$/.test(value);

/** Flattens the identity, length-prefixing each variable segment so the result stays injective. */
export function encodeProviderRunRef(ref: ProviderRunIdentity): string {
  return `${ref.provider}:${ref.runRef.length}:${ref.runRef}:`
    + `${ref.attemptRef.length}:${ref.attemptRef}:${ref.epoch}`;
}

/** A cursor over the composite, so each segment reads at an exact offset rather than by search. */
interface Cursor {
  readonly composite: string;
  offset: number;
}

/** Reads `<digits>:` at the cursor and returns the declared length, or null if it is not there. */
function readDeclaredLength(cursor: Cursor): number | null {
  const end = cursor.composite.indexOf(":", cursor.offset);
  if (end < 0) return null;
  const digits = cursor.composite.slice(cursor.offset, end);
  if (!isNonNegativeInteger(digits)) return null;
  cursor.offset = end + 1;
  return Number(digits);
}

/**
 * Reads exactly `length` characters and requires the NEXT character to be the delimiter.
 *
 * Requiring the delimiter is what makes a wrong declared length a refusal rather than a truncated
 * answer: `attempt-1` declared as 4 would otherwise yield "atte", and a correlation check handed a
 * truncated attempt would compare two things that were never the same fact.
 */
function readSegment(cursor: Cursor, length: number): string | null {
  const end = cursor.offset + length;
  if (end >= cursor.composite.length || cursor.composite[end] !== ":") return null;
  const segment = cursor.composite.slice(cursor.offset, end);
  cursor.offset = end + 1;
  return segment;
}

/**
 * The attempt this measurement belongs to, or NULL when the string is not a well-formed composite.
 *
 * NULL IS THE FAIL-CLOSED ANSWER. A bare attemptId, a truncated composite or a mismatched length
 * all decode to null, so a caller comparing against a reservation's `attemptRef` refuses rather
 * than correlating by accident — which is exactly how the pre-existing fixtures passed while the
 * production shapes had never once been compared.
 */
export function decodeProviderRunRefAttempt(composite: string): string | null {
  const providerEnd = composite.indexOf(":");
  if (providerEnd < 0) return null;
  const cursor: Cursor = { composite, offset: providerEnd + 1 };
  const runLength = readDeclaredLength(cursor);
  if (runLength === null || readSegment(cursor, runLength) === null) return null;
  const attemptLength = readDeclaredLength(cursor);
  if (attemptLength === null) return null;
  const attemptRef = readSegment(cursor, attemptLength);
  if (attemptRef === null) return null;
  return isNonNegativeInteger(composite.slice(cursor.offset)) ? attemptRef : null;
}
