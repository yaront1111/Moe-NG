import type { ReviewFinding } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";

import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";

/**
 * Whether every attributed finding names work that ANOTHER node of the reporter's own sealed
 * plan owns (addendum 2026-09-15). `@moe/review` admits the shape and stops the finding from
 * charging the reporter; only the daemon holds the plan, so only it can say who owns what.
 *
 * The rule, which keeps a node from laundering its own failure onto a sibling:
 * - the named node is in the reporter's approved graph and is not the reporter;
 * - every cited criterion is bound to the named node, so none of them is the reporter's own;
 * - the finding is not about the reporter itself: not its node, and a criterion subject must be
 *   one the named node owns.
 * A clean round is still only a request for the daemon's independent verifier, which reruns the
 * reporter's own verification command before anything can be accepted.
 */
interface PlanOwnership {
  readonly nodeKey: string;
  readonly nodeKeys: ReadonlySet<string>;
  readonly owners: ReadonlyMap<string, string>;
}

/** The reporter's sealed plan as criterion owners, or null when no approved plan binds it. */
export function readPlanOwnership(store: SqliteEventStore, projectId: string, subjectRef: string): PlanOwnership | null {
  for (const graph of activeCompiledGraphs(store, projectId)) {
    const definitions = graph.content.nodeAuthority.definitions;
    const self = definitions.find((definition) => compiledExecutionRef(projectId, graph, definition.nodeKey) === subjectRef);
    if (self === undefined) continue;
    const owners = new Map<string, string>();
    for (const definition of definitions) {
      for (const binding of definition.criterionBindings) {
        // An ambiguous owner attributes nothing; the compiler refuses such a graph anyway.
        if (owners.has(binding.criterionId)) return null;
        owners.set(binding.criterionId, definition.nodeKey);
      }
    }
    return Object.freeze({ nodeKey: self.nodeKey, owners,
      nodeKeys: new Set(definitions.map((definition) => definition.nodeKey)) });
  }
  return null;
}

export function findingAttributionsValid(
  store: SqliteEventStore, projectId: string, subjectRef: string, findings: readonly ReviewFinding[],
): boolean {
  const attributed = findings.filter((finding) => finding.attributedTo !== undefined);
  if (attributed.length === 0) return true;
  let plan: PlanOwnership | null;
  try { plan = readPlanOwnership(store, projectId, subjectRef); } catch { return false; }
  if (plan === null) return false;
  const { nodeKey: reporter, nodeKeys, owners } = plan;
  return attributed.every(({ attributedTo, subject }) => {
    const { criterionIds, nodeKey } = attributedTo!;
    if (nodeKey === reporter || !nodeKeys.has(nodeKey)) return false;
    if (criterionIds.some((criterionId) => owners.get(criterionId) !== nodeKey)) return false;
    if (subject.kind === "NODE" && subject.locator === subjectRef) return false;
    return subject.kind !== "CRITERION" || owners.get(subject.locator) === nodeKey;
  });
}
