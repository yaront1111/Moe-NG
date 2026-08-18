/**
 * The provider-run telemetry family's closed refusal vocabulary.
 *
 * Split out of `provider-run-contracts.ts` because the two together overran the
 * 250-line target. The seam is a real one rather than a convenience: this module
 * is what every later slice IMPORTS AND CANNOT RENEGOTIATE, while the record
 * beside it is what they populate. Nothing here knows the record's shape.
 *
 * Both vocabularies are disjoint from the store's `DurableStoreErrorCode` and
 * from the runner's `ProviderTelemetryCode` / `ProviderTelemetryLayer` on
 * purpose: a consumer that sees one of these codes knows THIS family refused,
 * not a producer underneath it. Where a store call is what refused, its upstream
 * code is preserved verbatim in `storeCode` rather than flattened into ours.
 */

import type { DurableStoreErrorCode } from "@moe/store";

/**
 * WHICH layer of this family refused. Four, not one, because four distinct
 * stages can decline the same run and a test pinning only the code would stay
 * green once a different stage started answering first: the composition before
 * any record exists, the codec over bytes, the ledger at commit, the reader on
 * the way back out.
 */
export const PROVIDER_RUN_LEDGER_LAYERS = Object.freeze([
  "PROVIDER_RUN_COMPOSITION",
  "PROVIDER_RUN_CODEC",
  "PROVIDER_RUN_LEDGER",
  "PROVIDER_RUN_READER",
] as const);

export type ProviderRunLayer = (typeof PROVIDER_RUN_LEDGER_LAYERS)[number];

/**
 * Closed refusal vocabulary, ordered by the stage that raises it: shape,
 * composition, bytes, evidence, read-back, then commit. Nothing outside this
 * module may add a code, so a refusal cannot be invented at a call site.
 *
 * PROVIDER_RUN_RECORD_UNREADABLE IS FORWARD-DECLARED. This slice ships no
 * reader, but the codec and the ledger reader both refuse with it; leaving it
 * out would force each of them to mint a local code and the family would then
 * hold two answers to one question, which is the duplicate-authority defect the
 * whole split exists to avoid.
 *
 * PROVIDER_RUN_REPLAY_DIVERGED is the commit stage's own cross-check and is
 * deliberately NOT folded into IDEMPOTENCY_CONFLICT. The store's replay identity
 * hashes the request bytes, not the events, so a second call under the same key
 * with the same request bytes but a DIFFERENT record replays cleanly at the
 * store while describing a run nobody committed. That is this ledger refusing,
 * not the store, and it must be separately assertable.
 *
 * THE THREE EVIDENCE_* CODES BESIDE ABSENT AND AMBIGUOUS ANSWER THREE DIFFERENT
 * QUESTIONS and are deliberately not merged. EVIDENCE_UNREADABLE means the store
 * or the page could not be read at all — the STORE is the authority there, so
 * its own code rides along verbatim in `storeCode`. EVIDENCE_MALFORMED means the
 * bytes arrived intact and the indexed evidence does not parse — THIS module is
 * the authority, so `storeCode` is null. BINDING_MISMATCH means everything
 * parsed and the receipt / decision / activation bindings disagree with one
 * another — the comparison is ours, so `storeCode` is null there too. Collapsing
 * any pair would send an operator to retry a store that answered fine, or to
 * hunt corruption in a page that read back byte-perfect.
 */
export const PROVIDER_RUN_LEDGER_CODES = Object.freeze([
  "PROVIDER_RUN_RECORD_MALFORMED",
  "PROVIDER_RUN_FIELD_INVALID",
  "PROVIDER_RUN_VERSION_UNSUPPORTED",
  "PROVIDER_RUN_HANDOFF_MALFORMED",
  "PROVIDER_RUN_USAGE_SEQUENCE_INVALID",
  "PROVIDER_RUN_MEASUREMENT_REFUSED",
  "PROVIDER_RUN_BYTES_MALFORMED",
  "PROVIDER_RUN_DIGEST_MISMATCH",
  "PROVIDER_RUN_RECORD_UNREADABLE",
  "PROVIDER_RUN_EVIDENCE_ABSENT",
  "PROVIDER_RUN_EVIDENCE_AMBIGUOUS",
  "PROVIDER_RUN_EVIDENCE_UNREADABLE",
  "PROVIDER_RUN_EVIDENCE_MALFORMED",
  "PROVIDER_RUN_BINDING_MISMATCH",
  "PROVIDER_RUN_EVENT_TYPE_UNEXPECTED",
  "PROVIDER_RUN_AGGREGATE_MISMATCH",
  "PROVIDER_RUN_REPLAY_DIVERGED",
  "PROVIDER_RUN_EXPECTED_VERSION_CONFLICT",
  "PROVIDER_RUN_IDEMPOTENCY_CONFLICT",
  "PROVIDER_RUN_STORE_UNAVAILABLE",
] as const);

export type ProviderRunCode = (typeof PROVIDER_RUN_LEDGER_CODES)[number];

/**
 * A refusal. `UNKNOWN` is the answer to evidence that cannot be verified — epic
 * rail 4's "missing or unverifiable evidence stays UNKNOWN and never gains
 * authority" — while `REFUSED` is an operation that was declined. `storeCode`
 * carries the store's own code verbatim when a store call is what refused, and
 * is null otherwise; it is never flattened into `code`.
 */
export interface ProviderRunRefusal {
  readonly ok: false;
  readonly outcome: "UNKNOWN" | "REFUSED";
  readonly code: ProviderRunCode;
  readonly layer: ProviderRunLayer;
  readonly storeCode: DurableStoreErrorCode | null;
}

export function providerRunRefusal(
  outcome: ProviderRunRefusal["outcome"],
  code: ProviderRunCode,
  layer: ProviderRunLayer,
  storeCode: DurableStoreErrorCode | null = null,
): ProviderRunRefusal {
  return Object.freeze({ code, layer, ok: false as const, outcome, storeCode });
}

/**
 * Reader refusals are always UNKNOWN: unverifiable evidence confers nothing.
 *
 * `storeCode` is the same optional pass-through `providerRunRefusal` takes, and
 * exists so an UNKNOWN raised because a STORE call refused — EVIDENCE_UNREADABLE
 * above — keeps the store's own code beside ours instead of losing it. Widening
 * this constructor rather than adding a second UNKNOWN one is deliberate: two
 * doors to the same outcome is how one of them quietly starts flattening the
 * upstream code into `code`, which this family's shape forbids.
 */
export function providerRunUnknown(
  code: ProviderRunCode,
  layer: ProviderRunLayer,
  storeCode: DurableStoreErrorCode | null = null,
): ProviderRunRefusal {
  return providerRunRefusal("UNKNOWN", code, layer, storeCode);
}
