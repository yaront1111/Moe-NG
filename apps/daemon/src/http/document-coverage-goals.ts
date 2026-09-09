/**
 * The goal side of PRD coverage: every source-bound goal the catalog carries, and the last
 * moment the daemon decided anything about a goal's own aggregates. Both are ledger walks the
 * shipped reads already make (the catalog decode, the command-decision pages) and neither
 * invents a value: a goal with no decision has no last activity, and a row that does not
 * decode fails the whole walk closed rather than being skipped.
 */
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { GOAL_CREATED_EVENT_TYPE, decodeGoalCatalogEntry } from "./goal-catalog-entry.js";
import { decisionsOf } from "../decision-ledger-memo.js";

const MAX_GOAL_PAGES = 16;
const GOAL_PAGE_SIZE = 256;
const DECISION_PAGE_SIZE = 512;

export interface BoundGoalRow {
  readonly goalId: string;
  readonly lifecycle: string | null;
  readonly planningRunRef: string | null;
  readonly sha: string;
  readonly title: string | null;
}

const dataRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;

/**
 * Every source-bound goal in the catalog, or null when a GoalCreated row does not decode or
 * the catalog is larger than this walk is willing to page (a truncated catalog would report a
 * document as less built than it is, so it is refused instead).
 */
export function catalogBoundGoals(
  store: SqliteEventStore, projectId: string, folded?: DurableLedger,
): BoundGoalRow[] | null {
  const ledger = folded ?? readDurableLedger(store, projectId);
  const goals: BoundGoalRow[] = [];
  let after = 0n;
  for (let page = 0; page < MAX_GOAL_PAGES; page += 1) {
    const events = store.readEventsByTypeAfter(GOAL_CREATED_EVENT_TYPE, after, GOAL_PAGE_SIZE);
    for (const event of events.items) {
      after = event.globalPosition;
      const decoded = decodeGoalCatalogEntry(event, projectId);
      if (!decoded.ok) return null;
      const entry = decoded.entry;
      if (entry.binding === null || entry.binding === undefined) continue;
      const lifecycle = dataRecord(stateOf(ledger, entry.goalId))?.["lifecycle"];
      goals.push(Object.freeze({
        goalId: entry.goalId,
        lifecycle: typeof lifecycle === "string" ? lifecycle : null,
        planningRunRef: typeof entry.planningRunRef === "string" ? entry.planningRunRef : null,
        sha: entry.binding.contentSha256,
        title: entry.brief?.title ?? null,
      }));
    }
    if (!events.hasMore) return goals.sort((left, right) => left.goalId.localeCompare(right.goalId));
  }
  return null;
}

/**
 * The latest `decidedAt` of a COMMITTED decision per named aggregate, for this project only.
 * One page walk over the decision ledger, the same walk `readDurableLedger` makes; aggregates
 * that never received a committed decision are simply absent from the answer.
 */
export function lastDecidedAt(
  store: SqliteEventStore, projectId: string, aggregateIds: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  if (aggregateIds.size === 0) return latest;
  for (const decision of decisionsOf(store, DECISION_PAGE_SIZE)) {
    if (decision.key.projectId !== projectId) continue;
    if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
    if (!aggregateIds.has(decision.targetAggregateId)) continue;
    const seen = latest.get(decision.targetAggregateId);
    if (seen === undefined || decision.decidedAt > seen) {
      latest.set(decision.targetAggregateId, decision.decidedAt);
    }
  }
  return latest;
}
