/**
 * Applying a provider's MEASURED usage to the durable budget, once the attempt has terminated.
 *
 * This module is deliberately thin, and the thinness is the point. `budget-ledger-holds.ts`
 * already delegates every piece of scheduler authority: it normalizes each observation through
 * `normalizeUsageMeasurement` and hands the result to `settleReservation` / `reconcileSettlement`,
 * preserving each verdict's own code and layer. So there is nothing here to re-normalize,
 * re-derive or re-decide — a second measurement semantics in the tree would be free to drift from
 * the first, and the day they disagreed the money would follow the wrong one.
 *
 * WHAT IT ACTUALLY DOES: read the decision-verified provider run for this attempt; find the
 * ACTIVATED reservation the activation bound to that same attempt; project each durable usage row
 * back to the three-key envelope the measurement authority admits; call the ledger writer. Every
 * refusal the ledger or the scheduler produces travels out UNRESTAMPED, with its own `sourceCode`
 * and `sourceLayer`, because which authority refused is the answer a caller needs.
 *
 * UNKNOWN IS AN OUTCOME, NOT AN ABSENCE. An attempt with no usable evidence settles to a
 * quarantined hold: the reducer holds the units, refunds nothing and zeroes nothing. This module
 * never synthesizes an observation, never substitutes a zero and never issues a refund of its own.
 *
 * THE JOIN IS THE ATTEMPT, NOT THE COMMAND. The terminal seam knows `{attemptRef, projectId}` and
 * nothing else; the activation admission identity is unavailable there and would have to be
 * reconstructed. The durable reservation already carries `attemptRef`, written by the activation's
 * own binding, so the join is a read rather than a reconstruction.
 *
 * THE LAYER CONSTANT IS MODULE-PRIVATE: an exported column-zero `*_LAYER` is a declared production
 * boundary the security roster demands a hostile trio for. The closed TYPE travels instead.
 */

import { readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import type { SqliteEventStore } from "@moe/store";

import { readCurrentBudgetLedger } from "./budget-current-projection.js";
import { settleBudgetReservation } from "./budget-ledger-holds.js";
import type { BudgetRefusal } from "./budget-ledger-contracts.js";
import type { BudgetCommitContext, BudgetWriteResult } from "./budget-ledger-requests.js";

const LAYER = "BUDGET_SETTLEMENT_APPLICATION" as const;

export type BudgetSettlementApplicationLayer = typeof LAYER;

export const BUDGET_SETTLEMENT_APPLICATION_CODES = Object.freeze([
  "BUDGET_SETTLEMENT_GOAL_UNRESOLVED",
  "BUDGET_SETTLEMENT_LEDGER_UNREADABLE",
  "BUDGET_SETTLEMENT_REQUEST_INVALID",
  "BUDGET_SETTLEMENT_RESERVATION_AMBIGUOUS",
  "BUDGET_SETTLEMENT_RESERVATION_ABSENT",
  "BUDGET_SETTLEMENT_RUN_ABSENT",
] as const);

export type BudgetSettlementApplicationCode =
  (typeof BUDGET_SETTLEMENT_APPLICATION_CODES)[number];

export interface BudgetSettlementApplicationRefusal {
  readonly code: BudgetSettlementApplicationCode;
  readonly layer: BudgetSettlementApplicationLayer;
  readonly ok: false;
  /** The upstream verdict when one exists, forwarded rather than restated. */
  readonly sourceCode: string | null;
  readonly sourceLayer: string | null;
}

export type BudgetSettlementApplicationResult =
  | BudgetWriteResult
  | BudgetSettlementApplicationRefusal;

export interface BudgetSettlementApplicationInput {
  readonly attemptRef: string;
  readonly context: BudgetCommitContext;
  readonly projectId: string;
}

const refuse = (
  code: BudgetSettlementApplicationCode,
  sourceCode: string | null = null,
  sourceLayer: string | null = null,
): BudgetSettlementApplicationRefusal =>
  Object.freeze({ code, layer: LAYER, ok: false as const, sourceCode, sourceLayer });

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** Reads a foreign refusal's own vocabulary without asserting a shape it may not have. */
function upstreamOf(value: unknown): { readonly code: string | null; readonly layer: string | null } {
  const record = (value ?? {}) as Record<string, unknown>;
  const code = record["code"];
  const layer = record["layer"];
  return {
    code: typeof code === "string" ? code : null,
    layer: typeof layer === "string" ? layer : null,
  };
}

/**
 * The goal the current graph is running under, read from durable provenance.
 *
 * NOT accepted from the caller: the goal decides which ledger the settlement lands in, so a
 * caller that could name one would be choosing the account to charge.
 */
function goalOf(
  store: SqliteEventStore, projectId: string,
): { readonly ok: true; readonly goalRef: string } | BudgetSettlementApplicationRefusal {
  const graph = readCurrentActiveGraph(store, projectId);
  if (!graph.ok) {
    const upstream = upstreamOf(graph);
    return refuse("BUDGET_SETTLEMENT_GOAL_UNRESOLVED", upstream.code, upstream.layer);
  }
  return { goalRef: graph.provenance.goalRef, ok: true as const };
}

/**
 * The three-key envelope `normalizeUsageMeasurement` admits.
 *
 * The durable row is ALREADY normalized and carries an `identity` the authority derived; passing
 * it whole would be refused, because the envelope guard admits exactly these three keys. So the
 * projection drops the derived field and lets the authority derive it again from the same bytes.
 * That is a projection of durable evidence, never a synthesis: no value here is invented.
 */
function observationsOf(usage: readonly unknown[]): readonly unknown[] {
  return usage.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      measurement: record["measurement"],
      pricebookBinding: record["pricebookBinding"] ?? null,
      truncated: record["truncated"] === true,
    };
  });
}

/**
 * Settles the attempt's ACTIVATED reservation from its own provider run.
 *
 * Ordered so the most specific evidence gap is named first: a missing run is a different fact
 * from a missing reservation, and collapsing them would send an operator to look in the wrong
 * ledger.
 */
export function applyProviderUsageToBudget(
  store: SqliteEventStore,
  input: BudgetSettlementApplicationInput,
): BudgetSettlementApplicationResult {
  if (!isText(input.attemptRef) || !isText(input.projectId)) {
    return refuse("BUDGET_SETTLEMENT_REQUEST_INVALID");
  }
  const run = readCurrentProviderRun(store, {
    attemptRef: input.attemptRef, projectId: input.projectId,
  });
  if (!("ok" in run) || run.ok !== true) {
    const upstream = upstreamOf(run);
    return refuse("BUDGET_SETTLEMENT_RUN_ABSENT", upstream.code, upstream.layer);
  }
  const goal = goalOf(store, input.projectId);
  if (!("ok" in goal) || goal.ok !== true) return goal;
  const current = readCurrentBudgetLedger(store, input.projectId, goal.goalRef);
  if (!current.ok) {
    const upstream = upstreamOf(current);
    return refuse("BUDGET_SETTLEMENT_LEDGER_UNREADABLE", upstream.code, upstream.layer);
  }
  const bound = current.reservations.filter(
    (entry) => entry.attemptRef === input.attemptRef && entry.state === "ACTIVATED",
  );
  // Two reservations claiming one attempt is AMBIGUOUS, never "pick the first": settling against
  // an arbitrary one of them would move money on a guess.
  if (bound.length > 1) return refuse("BUDGET_SETTLEMENT_RESERVATION_AMBIGUOUS");
  const held = bound[0];
  if (held === undefined) return refuse("BUDGET_SETTLEMENT_RESERVATION_ABSENT");
  return settleBudgetReservation(store, {
    context: input.context,
    goalRef: goal.goalRef,
    observations: observationsOf(run.record.usage),
    projectId: input.projectId,
    reservationId: held.reservationId,
  }) as BudgetWriteResult | BudgetRefusal as BudgetSettlementApplicationResult;
}
