/**
 * The single durable seam every budget transition commits through.
 *
 * ONE call to the store's existing `commitExpectedVersionDecision`, and no SQLite object of this
 * daemon's own. The durable record IS the event payload, so the decision's own `events` array
 * carries the whole transition and there is no side table to keep in step with it.
 *
 * `commitWithApply` and `commitExpectedVersionDecisionWithApply` are NOT used and are not
 * nameable through `BudgetCommitPort`: `CommitApply` hands the callback a raw `DatabaseSync` for
 * callers that write their own tables, which this family must never do.
 *
 * REPLAY IS RESOLVED BEFORE ANYTHING IS RECOMPUTED. The store's replay identity does not cover
 * the events array, and a second call would in any case fold a DIFFERENT successor because the
 * head has moved — so a replay is answered from the ORIGINAL decision's own result bytes.
 * `requestDigest` inside those bytes is what separates an identical retry from a conflicting
 * command wearing the same identity: this ledger refuses the second one itself, which is why its
 * refusal carries no `sourceLayer`.
 */

import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey,
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
  SqliteEventStore,
} from "@moe/store";

import { canonicalBudgetJson, decodeBudgetLedgerRecord, encodeBudgetLedgerRecord } from "./budget-ledger-codec.js";
import {
  BUDGET_LEDGER_COMMAND_KIND,
  BUDGET_LEDGER_EVENT_TYPE,
  budgetLedgerRefusal,
} from "./budget-ledger-contracts.js";
import type { BudgetLedgerRecord, BudgetLedgerRefusal } from "./budget-ledger-contracts.js";
import { BUDGET_COMMIT_CONTEXT_KEYS, BUDGET_NO_LIST_SHAPE } from "./budget-ledger-requests.js";
import type { BudgetCommitContext, BudgetInputShape, BudgetWriteResult } from "./budget-ledger-requests.js";

import { createHash } from "node:crypto";

/** The exact store surface a writer needs to COMMIT. Every other method is absent by design. */
export interface BudgetCommitPort {
  commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput): CommandDecisionResponse;
}

export interface BudgetTransitionPlan {
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly record: BudgetLedgerRecord;
}

const encoder = new TextEncoder();

export const budgetRequestDigest = (input: unknown): string =>
  createHash("sha256").update(encoder.encode(canonicalBudgetJson(input))).digest("hex");

export const budgetDecisionKey = (
  context: BudgetCommitContext, projectId: string,
): CommandDecisionKey =>
  ({ commandId: context.commandId, principalId: context.principalId, projectId });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Exact-record admission. An UNEXPECTED key is reported before a missing one, so a request that
 * smuggles caller-held budget authority is named as exactly that rather than as generic
 * malformation — that distinction is the whole point of the sweep in the writers' suite.
 *
 * `shapes` pins the array-ness of the declared list fields. A key roster admits by NAME, so
 * without this a declared list arriving as `undefined`, `null` or a string reached a reducer as a
 * non-iterable and threw — an outcome with no stable code and no layer.
 */
export function admitBudgetInput(
  value: unknown, keys: readonly string[], shapes: BudgetInputShape = BUDGET_NO_LIST_SHAPE,
): BudgetLedgerRefusal | null {
  if (!isPlainObject(value)) return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_INPUT_MALFORMED");
  const present = Object.keys(value);
  if (present.some((key) => !keys.includes(key))) {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_INPUT_UNEXPECTED_KEY");
  }
  if (present.length !== keys.length) {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_INPUT_MALFORMED");
  }
  const context = value["context"];
  if (!isPlainObject(context)) return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_INPUT_MALFORMED");
  const contextKeys = Object.keys(context);
  if (contextKeys.length !== BUDGET_COMMIT_CONTEXT_KEYS.length
    || contextKeys.some((key) => !(BUDGET_COMMIT_CONTEXT_KEYS as readonly string[]).includes(key))
    || BUDGET_COMMIT_CONTEXT_KEYS.some((key: string) => typeof context[key] !== "string" || context[key] === "")) {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_INPUT_MALFORMED");
  }
  if (typeof value["projectId"] !== "string" || typeof value["goalRef"] !== "string"
    || value["projectId"] === "" || value["goalRef"] === "") {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_INPUT_MALFORMED");
  }
  for (const [key, shape] of Object.entries(shapes)) {
    const held = value[key];
    if (!Array.isArray(held) && !(shape === "ARRAY_OR_NULL" && held === null)) {
      return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_INPUT_MALFORMED");
    }
  }
  return null;
}

function answerFrom(resultBytes: Uint8Array, aggregateId: string, requestDigest: string): BudgetWriteResult {
  const decoded = decodeBudgetLedgerRecord(resultBytes);
  if (!decoded.ok) return decoded;
  if (decoded.record.requestDigest !== requestDigest) {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_IDEMPOTENCY_CONFLICT");
  }
  const sealed = encodeBudgetLedgerRecord(decoded.record);
  if (!sealed.ok) return sealed;
  return Object.freeze({
    aggregateId, digest: sealed.digest, disposition: "REPLAYED" as const, ok: true as const,
    record: sealed.record,
  });
}

/**
 * Answers a decision this identity ALREADY made, or null when it made none.
 *
 * A decision recorded under another command kind is not this ledger's to reinterpret: the key
 * space is shared with every other command in the project, so a foreign decision under the same
 * key is a conflicting reuse of an identity, not a replay of this transition.
 */
export function answerBudgetReplay(
  store: SqliteEventStore, key: CommandDecisionKey, requestDigest: string,
): BudgetWriteResult | null {
  let prior;
  try {
    prior = store.getCommandDecision(key);
  } catch (error) {
    return refuseThrownStore(error);
  }
  if (prior === null) return null;
  if (prior.commandKind !== BUDGET_LEDGER_COMMAND_KIND) {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_IDEMPOTENCY_CONFLICT");
  }
  if (prior.effectDisposition !== "EFFECTS_COMMITTED") {
    return budgetLedgerRefusal(
      "REFUSED", "BUDGET_LEDGER_EXPECTED_VERSION_CONFLICT", prior.resultCode, "STORE",
    );
  }
  return answerFrom(prior.resultBytes, prior.targetAggregateId, requestDigest);
}

/**
 * Maps a thrown store error onto this module's vocabulary while preserving the store's own code
 * verbatim. An input fault is OURS and retrying one never succeeds, so it is never folded into
 * an availability code that tells the caller to retry forever.
 */
function refuseThrownStore(error: unknown): BudgetLedgerRefusal {
  if (!(error instanceof DurableStoreError)) {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_STORE_UNAVAILABLE");
  }
  if (error.code === "IDEMPOTENCY_CONFLICT") {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_IDEMPOTENCY_CONFLICT", error.code, "STORE");
  }
  if (error.code === "EXPECTED_VERSION_CONFLICT" || error.code === "DURABLE_ID_CONFLICT") {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_EXPECTED_VERSION_CONFLICT", error.code, "STORE");
  }
  if (error.code === "STORE_INPUT_INVALID" || error.code === "STORE_LIMIT_EXCEEDED") {
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_INPUT_MALFORMED", error.code, "STORE");
  }
  return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_STORE_UNAVAILABLE", error.code, "STORE");
}

/**
 * Commits ONE decision carrying ONE event. The event id is the record's own canonical digest, so
 * two transitions can never share a durable id and identical bytes collide store-wide.
 */
export function commitBudgetTransition(
  commit: BudgetCommitPort, context: BudgetCommitContext, projectId: string, plan: BudgetTransitionPlan,
): BudgetWriteResult {
  const encoded = encodeBudgetLedgerRecord(plan.record);
  if (!encoded.ok) return encoded;
  let response: CommandDecisionResponse;
  try {
    response = commit.commitExpectedVersionDecision({
      commandKind: BUDGET_LEDGER_COMMAND_KIND,
      committedResultBytes: encoded.bytes,
      correlationId: context.correlationId,
      decidedAt: context.decidedAt,
      events: [{
        eventId: `budget:${encoded.digest}`,
        eventType: BUDGET_LEDGER_EVENT_TYPE,
        payload: encoded.bytes,
      }],
      expectedVersion: plan.expectedVersion,
      key: budgetDecisionKey(context, projectId),
      requestBytes: encoder.encode(plan.record.requestDigest),
      targetAggregateId: plan.aggregateId,
    });
  } catch (error) {
    return refuseThrownStore(error);
  }
  // The store does NOT throw on a version mismatch: it writes a NO_BUSINESS_EFFECT audit row and
  // reports the conflict in `resultCode`. Reading "did not throw" as success is exactly how a
  // raced transition would be reported as committed while nothing was written.
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return budgetLedgerRefusal(
      "REFUSED", "BUDGET_LEDGER_EXPECTED_VERSION_CONFLICT", response.decision.resultCode, "STORE",
    );
  }
  if (response.disposition === "REPLAYED") {
    return answerFrom(response.decision.resultBytes, plan.aggregateId, plan.record.requestDigest);
  }
  return Object.freeze({
    aggregateId: plan.aggregateId, digest: encoded.digest, disposition: "COMMITTED" as const,
    ok: true as const, record: encoded.record,
  });
}
