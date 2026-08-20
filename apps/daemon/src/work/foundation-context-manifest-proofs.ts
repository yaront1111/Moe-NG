/**
 * The durable proofs a sealed context manifest must satisfy before its bytes
 * may be treated as authority.
 *
 * WHY A SEPARATE MODULE. Reading the event is one concern; proving the store
 * actually committed it exactly once, under the identity the server derived, is
 * another — and together they push the reader past its per-file cap. Splitting
 * here keeps both readable and leaves the reader's own control flow visible.
 *
 * WHAT A PROOF IS FOR. An event on the right aggregate is not evidence that a
 * command decided it: a hand-inserted row, a partially applied commit, or a
 * replay that appended a second effect all produce an event that decodes
 * perfectly. The decision and the receipt are what bind the event to a command
 * that ran once, wrote exactly this event, and emitted nothing else.
 *
 * These functions DIAGNOSE; they never mutate and never decide what the caller
 * does next. Each returns a code or null.
 */

import type { CommandDecisionRecord, CommandReceipt, StoredEvent } from "@moe/store";

import type { FoundationContextManifestRecord } from "./foundation-context-manifest-codec.js";
import { FOUNDATION_CONTEXT_COMMAND_KIND } from "./foundation-context-manifest-identity.js";
import type {
  FoundationContextSelectionIdentity,
  FoundationContextSlotIdentity,
} from "./foundation-context-manifest-identity.js";

/** The version an aggregate is at before its one and only context event. */
const EXPECTED_PREVIOUS_VERSION = 0;
/** And after: exactly one event, so exactly one version step. */
const EXPECTED_CURRENT_VERSION = 1;

/** Byte equality, length first: a prefix must not read as a match. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

export const FOUNDATION_CONTEXT_PROOF_CODES = Object.freeze([
  "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH",
  "FOUNDATION_CONTEXT_READER_DECISION_INVALID",
  "FOUNDATION_CONTEXT_READER_DECISION_MISSING",
  "FOUNDATION_CONTEXT_READER_EVENT_INVALID",
  "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID",
  "FOUNDATION_CONTEXT_READER_RECEIPT_MISSING",
  "FOUNDATION_CONTEXT_READER_STALE",
] as const);

export type FoundationContextProofCode = (typeof FOUNDATION_CONTEXT_PROOF_CODES)[number];

/**
 * The six selection facts the server derives elsewhere and the reader only ever
 * COMPARES: graph revision/hash/epoch from the active-graph projection, the
 * configuration digest from the current project configuration, and the
 * input-manifest digest from the durable attempt record. Nothing here is
 * adopted into an answer — a disagreement is a refusal, never a selection.
 */
export type FoundationContextExpectedBinding =
  Omit<FoundationContextSelectionIdentity, keyof FoundationContextSlotIdentity>;

/**
 * The nine selection fields as the DURABLE record states them.
 *
 * The decision key is derived from THIS, never from a caller's expectation:
 * deriving it from the expectation would make every binding disagreement
 * surface as a missing decision — the record's own decision would simply not be
 * looked for — and the comparison below would become unreachable. These fields
 * are already bound by the record's digest, which the re-encode re-establishes.
 */
export function selectionOf(
  record: FoundationContextManifestRecord,
): FoundationContextSelectionIdentity {
  return {
    attemptRef: record.attemptRef, configurationDigest: record.configurationDigest,
    graphContentHash: record.graphContentHash, graphEpoch: record.graphEpoch,
    graphRevisionRef: record.graphRevisionRef, inputManifestDigest: record.inputManifestDigest,
    nodeKey: record.nodeKey, projectId: record.projectId, sessionId: record.sessionId,
  };
}

/**
 * STALE and BINDING_MISMATCH are two different operator problems and must stay
 * two codes. The slot fields — project, session, attempt — say WHICH selection a
 * record belongs to; if one disagrees the record is another slot's and the
 * answer is a mismatch. The graph moving forward under an otherwise identical
 * slot is staleness: the same selection, sealed earlier. Collapsing them would
 * let a mis-selected node read as "just retry".
 */
export function compareBinding(
  record: FoundationContextManifestRecord,
  identity: FoundationContextSlotIdentity,
  expected: FoundationContextExpectedBinding,
): FoundationContextProofCode | null {
  if (record.projectId !== identity.projectId || record.sessionId !== identity.sessionId
    || record.attemptRef !== identity.attemptRef) {
    return "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH";
  }
  if (record.nodeKey !== expected.nodeKey
    || record.configurationDigest !== expected.configurationDigest
    || record.inputManifestDigest !== expected.inputManifestDigest) {
    return "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH";
  }
  if (record.graphRevisionRef !== expected.graphRevisionRef
    || record.graphContentHash !== expected.graphContentHash
    || record.graphEpoch !== expected.graphEpoch) {
    return "FOUNDATION_CONTEXT_READER_STALE";
  }
  return null;
}

/**
 * The decision must say EFFECTS_COMMITTED and must own THIS event.
 *
 * `businessEventIds` is checked as a singleton rather than "contains": a
 * decision that committed a second effect alongside this one is not a decision
 * that sealed exactly this manifest, and a containment check would admit it.
 *
 * THE RESULT IS PROVEN BY BYTES, NOT BY ITS DIGEST. `decision.resultSha256` is
 * the store's own scoped hash (`identifyDecisionResult`, store-digests.ts:97),
 * which `@moe/store` does not export — its package exports are only ".",
 * "./projections/*" and "./subscriptions/*" — so recomputing it here would mean
 * transcribing the store's framing into this module, which is precisely the
 * derivation drift the aggregate id is imported to avoid. Comparing the RESULT
 * BYTES against the appended payload is the stronger claim anyway: it proves
 * the decision committed exactly these bytes rather than a digest of them.
 *
 * The REQUEST digest is proven cross-witness for the same reason: the store's
 * `identifyExpectedVersionRequest` (store-digests.ts:82) is likewise unexported,
 * so the proof is that the decision row and the event's OWN decision trace agree
 * on it. Two durable witnesses; editing one alone is what this catches.
 */
export function proveDecision(
  decision: CommandDecisionRecord | null, event: StoredEvent,
): FoundationContextProofCode | null {
  if (decision === null) return "FOUNDATION_CONTEXT_READER_DECISION_MISSING";
  if (decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return "FOUNDATION_CONTEXT_READER_DECISION_INVALID";
  }
  if (decision.commandKind !== FOUNDATION_CONTEXT_COMMAND_KIND) {
    return "FOUNDATION_CONTEXT_READER_DECISION_INVALID";
  }
  if (decision.targetAggregateId !== event.aggregateId) {
    return "FOUNDATION_CONTEXT_READER_DECISION_INVALID";
  }
  if (decision.businessEventIds.length !== 1) return "FOUNDATION_CONTEXT_READER_DECISION_INVALID";
  if (decision.businessEventIds[0] !== event.eventId) {
    return "FOUNDATION_CONTEXT_READER_DECISION_INVALID";
  }
  if (decision.outboxMessageIds.length !== 0) return "FOUNDATION_CONTEXT_READER_DECISION_INVALID";
  if (decision.expectedVersion !== EXPECTED_PREVIOUS_VERSION) {
    return "FOUNDATION_CONTEXT_READER_DECISION_INVALID";
  }
  if (!sameBytes(decision.resultBytes, event.payload)) {
    return "FOUNDATION_CONTEXT_READER_DECISION_INVALID";
  }
  if (event.decisionTrace?.requestSha256 !== decision.requestSha256) {
    return "FOUNDATION_CONTEXT_READER_DECISION_INVALID";
  }
  return null;
}

/**
 * The receipt must describe the SAME single append, on the SAME aggregate, and
 * must agree with the decision's request identity.
 *
 * The version pair is checked as 0 -> 1 rather than "increased by one": this
 * aggregate exists for exactly one sealed manifest, so any other pair means the
 * event this reader is about to trust is not the first thing written there.
 */
export function proveReceipt(
  receipt: CommandReceipt | null, decision: CommandDecisionRecord, event: StoredEvent,
): FoundationContextProofCode | null {
  if (receipt === null) return "FOUNDATION_CONTEXT_READER_RECEIPT_MISSING";
  if (receipt.aggregateId !== event.aggregateId) {
    return "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID";
  }
  if (receipt.previousVersion !== EXPECTED_PREVIOUS_VERSION) {
    return "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID";
  }
  if (receipt.currentVersion !== EXPECTED_CURRENT_VERSION) {
    return "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID";
  }
  if (receipt.eventIds.length !== 1 || receipt.eventIds[0] !== event.eventId) {
    return "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID";
  }
  if (receipt.outboxMessageIds.length !== 0) return "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID";
  // THE EFFECT DIGEST BINDS THE RECEIPT TO THE DECISION, and the receipt's
  // `requestSha256` deliberately is NOT compared against the decision's.
  // Measured against the real store: the event's `commandId` is an INTERNAL
  // `moe-internal:decision-effect:*` identifier, so this receipt describes the
  // effect application rather than the caller's request — its `requestSha256`
  // is over that internal command and does not equal the decision's. Requiring
  // that match would be a false invariant refusing every honest record.
  if (receipt.effectSha256 !== decision.effectSha256) {
    return "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID";
  }
  // IT IS COMPARED AGAINST THE EVENT INSTEAD, which is the witness that shares
  // that internal command: the receipt and the appended row must agree on both
  // the command that applied the effect and its request digest, or the receipt
  // describes some other append that merely reached the same aggregate.
  if (receipt.commandId !== event.commandId) return "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID";
  if (receipt.requestSha256 !== event.requestSha256) {
    return "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID";
  }
  return null;
}
