/**
 * The server-side bindings every budget transition is bound to.
 *
 * SPLIT FROM the projection when that module crossed the per-file target, and the seam is a real
 * one: this answers "which account, whose, against which graph revision" from durable records
 * alone, and the projection answers "what is in it". Task rail 1 lives HERE — a caller supplies
 * a project and a goal to look up, and nothing else about the budget's identity.
 */

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { ACTIVE_GRAPH_PROJECTION_LAYER, readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import { budgetProjectionRefusal } from "./budget-ledger-contracts.js";
import type { BudgetDurableBinding, BudgetRefusal } from "./budget-ledger-contracts.js";

export type BudgetBindingResult =
  | { readonly ok: true; readonly binding: BudgetDurableBinding }
  | BudgetRefusal;

const GOAL_CREATED_EVENT_TYPE = "GoalCreated";
const decoder = new TextDecoder("utf-8", { fatal: true });

function goalCreatedFact(events: readonly StoredEvent[]): Record<string, unknown> | null {
  const row = events.find((event) => event.eventType === GOAL_CREATED_EVENT_TYPE);
  if (row === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(row.payload)) as unknown;
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const created = list.find((entry) =>
    entry !== null && typeof entry === "object"
    && (entry as Record<string, unknown>)["kind"] === GOAL_CREATED_EVENT_TYPE);
  return created === undefined ? null : (created as Record<string, unknown>);
}

/**
 * The server-side bindings a budget transition is bound to, all read from DURABLE records: the
 * account ref off the goal's own `GoalCreated`, the revision and epoch off the current active
 * graph. No caller supplies any of them, which is exactly task rail 1.
 */
export function readBudgetBinding(
  store: SqliteEventStore, projectId: string, goalRef: string,
): BudgetBindingResult {
  if (projectId.length === 0 || goalRef.length === 0) {
    return budgetProjectionRefusal("BUDGET_PROJECTION_GOAL_ABSENT");
  }
  const created = goalCreatedFact(store.readEvents(goalRef));
  if (created === null) return budgetProjectionRefusal("BUDGET_PROJECTION_GOAL_ABSENT");
  const accountRef = created["budgetAccountRef"];
  if (typeof accountRef !== "string" || accountRef.length === 0) {
    return budgetProjectionRefusal("BUDGET_PROJECTION_GOAL_ABSENT");
  }
  if (created["projectId"] !== projectId || created["goalId"] !== goalRef) {
    return budgetProjectionRefusal("BUDGET_PROJECTION_SCOPE_FOREIGN");
  }
  const graph = readCurrentActiveGraph(store, projectId);
  if (!graph.ok) {
    return budgetProjectionRefusal(
      "BUDGET_PROJECTION_GRAPH_UNAVAILABLE", graph.code, ACTIVE_GRAPH_PROJECTION_LAYER,
    );
  }
  if (graph.provenance.goalRef !== goalRef) {
    return budgetProjectionRefusal("BUDGET_PROJECTION_SCOPE_FOREIGN");
  }
  return Object.freeze({
    binding: Object.freeze({
      budgetAccountRef: accountRef, goalRef, graphEpoch: graph.graphEpoch,
      graphRevisionRef: graph.revisionId, ownerRef: goalRef, projectId,
    }),
    ok: true as const,
  });
}
