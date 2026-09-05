import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { legacyCompiledNodeKeys } from "../orchestrator/compiled-node-identity.js";
import { readReviewLedgers } from "../review/review-read-model.js";

/**
 * IS THERE ANYTHING TO PREVIEW YET? A preview shows the operator the product a goal built, so
 * every execution-bearing node of that goal must already be LANDED as a commit. A goal one node
 * short would show a product missing exactly that node's work, and the operator would approve
 * something that was never built.
 *
 * WHY THIS IS NOT `goalHasLandedCommit`. `repository/goal-landing-facts.ts:112` answers
 * "at least ONE node landed" — the right question for offering a PUBLISH, the wrong one for a
 * preview. Its `nodeOwners`/`landedGoals` walk is module-private, so rather than widen a foreign
 * file's exports mid-flight this reads the same two PUBLIC seams it reads: `activeCompiledGraphs`
 * for the goal's own sealed graph (compiled-node-source.ts:89) and `readReviewLedgers` for the
 * landings (review/review-read-model.ts). Same sources, ALL instead of ANY.
 *
 * GOAL SCOPE for the same reason `goal-landing-facts.ts` documents: the review ledger keys
 * landings by BARE node key across the whole project, so a project-wide read would let one
 * goal's commits satisfy another goal's preview. The nodes come from THIS goal's graph.
 *
 * FAILS CLOSED. A REFUSED landing receipt is a landing ATTEMPT, not a landed commit, and does
 * not count. An unreadable ledger answers "not landed": an unreadable store is not evidence a
 * commit exists, and previewing a revision that was never built is the exact mistake this gate
 * exists to prevent.
 */

type Store = Parameters<typeof activeCompiledGraphs>[0];

/** The same lifecycles `goal-landing-facts.ts:25-27` calls landable. */
const LANDABLE_LIFECYCLES: ReadonlySet<string> = Object.freeze(
  new Set(["CLOSING", "COMPLETED", "EXECUTION_ENABLED"]),
);

export interface GoalLandingStatus {
  /** True only when `nodes` is non-empty and every one of them carries a COMMITTED landing. */
  readonly allLanded: boolean;
  /** The node keys of this goal that carry no COMMITTED landing, sorted. */
  readonly missing: readonly string[];
  /** Every execution-bearing node key of this goal's active graph, sorted. */
  readonly nodes: readonly string[];
}

const NOTHING: GoalLandingStatus = Object.freeze({
  allLanded: false, missing: Object.freeze([]), nodes: Object.freeze([]),
});

/** This goal's own execution-bearing node keys, taken from its active compiled graph. */
function goalNodes(
  store: Store, projectId: string, goalId: string, ledger: DurableLedger,
): ReadonlyMap<string, string | null> {
  const keys = new Map<string, string | null>();
  const graphs = activeCompiledGraphs(store, projectId, LANDABLE_LIFECYCLES, ledger);
  const legacy = legacyCompiledNodeKeys(store, projectId, graphs, ledger);
  for (const graph of graphs) {
    if (graph.goalRef !== goalId) continue;
    for (const node of graph.content.snapshot.nodes) {
      if (node.executionBearing) keys.set(node.nodeKey,
        legacy.has(node.nodeKey) ? null : compiledExecutionRef(projectId, graph, node.nodeKey));
    }
  }
  return keys;
}

/**
 * Which of this goal's nodes are landed as commits. A goal with NO execution-bearing node is
 * reported as not landed rather than vacuously landed — there is nothing built to look at, and
 * `allLanded` over an empty set would answer true and start a server for it.
 */
export function readGoalLandingStatus(
  store: Store, projectId: string, goalId: string, folded?: DurableLedger,
): GoalLandingStatus {
  try {
    const ledger = folded ?? readDurableLedger(store, projectId);
    const subjects = goalNodes(store, projectId, goalId, ledger);
    const nodes = [...subjects.keys()].sort();
    if (nodes.length === 0) return NOTHING;
    const { landings } = readReviewLedgers(store, projectId,
      new Set([...subjects.values()].filter((ref): ref is string => ref !== null)));
    const missing = nodes
      .filter((nodeKey) => landings.get(subjects.get(nodeKey) ?? "")?.outcome !== "COMMITTED")
      .sort();
    return Object.freeze({
      allLanded: missing.length === 0,
      missing: Object.freeze(missing),
      nodes: Object.freeze(nodes),
    });
  } catch {
    return NOTHING;
  }
}
