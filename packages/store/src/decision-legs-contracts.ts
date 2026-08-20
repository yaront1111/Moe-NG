import type { CommandDecisionKey, EventDraft } from "./store-contracts.js";

/**
 * Upper bound on the aggregates one decision may fence and append to. Kept small
 * on purpose: every leg costs one more version probe and one more receipt inside
 * the single write transaction, so an unbounded list would hold the write lock
 * for an unbounded time.
 */
export const MAX_DECISION_LEGS = 8 as const;

/** One aggregate's fence and appended events within a multi-leg decision. */
export interface ExpectedVersionDecisionLeg {
  readonly aggregateId: string;
  readonly events: readonly EventDraft[];
  readonly expectedVersion: number;
}

/**
 * A single expected-version decision that fences and appends to several
 * aggregates at once. The legs are ordered; `legs[0]` is the PRIMARY leg and is
 * the one the durable decision record describes, exactly as a single-aggregate
 * decision describes its only aggregate.
 */
export interface CommitExpectedVersionDecisionLegsInput {
  readonly commandKind: string;
  readonly committedResultBytes: Uint8Array;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly key: CommandDecisionKey;
  readonly legs: readonly ExpectedVersionDecisionLeg[];
  readonly requestBytes: Uint8Array;
}
