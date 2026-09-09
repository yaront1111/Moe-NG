/**
 * LANDING FACTS FOR A GOAL: has any node of this goal been landed as a commit?
 *
 * The publish affordance is offered off this answer alone. It is deliberately a FACT — a
 * boolean derived from durable state — rather than a store handle passed into the offer ladder,
 * so `offersForGoal` stays pure over `PlanningOfferInput` and the walk below happens only for a
 * goal that could actually be offered a publish.
 *
 * GOAL SCOPE is the whole point. Landing subjects bind project, goal, run and sealed graph
 * content as well as the local node key. Bare legacy facts never unlock a scoped PUBLISH.
 */
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { legacyCompiledNodeKeys } from "../orchestrator/compiled-node-identity.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { readReviewLedgers } from "../review/review-read-model.js";

/**
 * The lifecycles whose goals can hold a landed commit — the SAME set the offer ladder mints
 * `repository.publish` for. A goal before activation has no sealed graph to walk, and nothing
 * it could have landed.
 */
const LANDABLE_LIFECYCLES: ReadonlySet<string> = Object.freeze(
  new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]),
);

const NONE: ReadonlySet<string> = Object.freeze(new Set<string>());

type Store = Parameters<typeof activeCompiledGraphs>[0];

/**
 * Which goals own each node key, read exactly as the coverage read builds its sealed-node rows
 * (document-coverage-read.ts:90-96): the snapshot's execution-bearing nodes joined with the node
 * authority's definitions. Both rosters are taken because a landing attests the work of a node,
 * and these are the durable statements of which nodes belong to which goal. Execution refs
 * distinguish reused local keys; unresolved bare legacy records credit no goal.
 */
function nodeOwners(store: Store, projectId: string, ledger: DurableLedger): ReadonlyMap<string, string[]> {
  const owners = new Map<string, string[]>();
  const own = (nodeKey: string, goalRef: string): void => {
    const goals = owners.get(nodeKey);
    if (goals === undefined) owners.set(nodeKey, [goalRef]);
    else if (!goals.includes(goalRef)) goals.push(goalRef);
  };
  const graphs = activeCompiledGraphs(store, projectId, LANDABLE_LIFECYCLES, ledger);
  const ambiguous = legacyCompiledNodeKeys(store, projectId, graphs, ledger);
  for (const graph of graphs) {
    for (const node of graph.content.snapshot.nodes) {
      if (node.executionBearing && !ambiguous.has(node.nodeKey)) own(compiledExecutionRef(projectId, graph, node.nodeKey), graph.goalRef);
    }
    for (const definition of graph.content.nodeAuthority.definitions) {
      if (!ambiguous.has(definition.nodeKey)) own(compiledExecutionRef(projectId, graph, definition.nodeKey), graph.goalRef);
    }
  }
  return owners;
}

/** Every goal with at least one COMMITTED landing, in ONE graph walk and ONE ledger walk. */
function landedGoals(store: Store, projectId: string, folded?: DurableLedger): ReadonlySet<string> {
  try {
    const owners = nodeOwners(store, projectId, folded ?? readDurableLedger(store, projectId));
    if (owners.size === 0) return NONE;
    const landed = new Set<string>();
    const { landings } = readReviewLedgers(store, projectId, new Set(owners.keys()));
    for (const [nodeKey, receipt] of landings) {
      if (receipt.outcome !== "COMMITTED") continue;
      for (const goalRef of owners.get(nodeKey) ?? []) landed.add(goalRef);
    }
    return landed;
  } catch {
    // Fail closed. An unreadable ledger is not evidence a commit exists, and offering a publish
    // the workspace has nothing to push is the exact disagreement this gate exists to end.
    return NONE;
  }
}

/** Answers the landing question for many goals at the cost of answering it for one. */
export interface GoalLandingReader {
  /** True when at least one node of this goal carries a COMMITTED landing receipt. */
  readonly hasLandedCommit: (goalId: string) => boolean;
}

/**
 * ONE reader per surface read. The walks are DEFERRED to the first question and then SHARED: a
 * poll with no publishable goal pays nothing, and a poll with twenty pays for one graph walk and
 * one review-ledger walk rather than twenty of each. That matters because `readReviewLedgers`
 * pages the WHOLE decision ledger — measured 97ms per goal against a 176-decision store, so the
 * per-goal shape put a surface read at 477ms there and would have grown with every commit.
 *
 * `folded` is the durable ledger the caller already read, so the reader never re-folds it.
 */
export function createGoalLandingReader(
  store: Store, projectId: string, folded?: DurableLedger,
): GoalLandingReader {
  let landed: ReadonlySet<string> | null = null;
  return Object.freeze({
    hasLandedCommit: (goalId: string): boolean => {
      landed ??= landedGoals(store, projectId, folded);
      return landed.has(goalId);
    },
  });
}

/**
 * True when at least one node of this goal is landed as a commit. A REFUSED receipt is a landing
 * ATTEMPT, not a landed commit, and does not count; an unreadable store answers FALSE.
 *
 * Single-shot. A caller asking about MORE than one goal should hold a `createGoalLandingReader`
 * instead, which shares the two walks across every question.
 */
export function goalHasLandedCommit(
  store: Store, projectId: string, goalId: string, folded?: DurableLedger,
): boolean {
  return createGoalLandingReader(store, projectId, folded).hasLandedCommit(goalId);
}
