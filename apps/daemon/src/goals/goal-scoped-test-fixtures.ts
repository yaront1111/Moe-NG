import type { ProductContractRevisionRef } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";
import { GOAL_ID, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import {
  approveGate1, approvePlan, boundWorld, committedRevision, nodeOf, structureOf, submit,
} from "../planning/plan-reject-test-fixtures.js";

export interface ScopedGoalWorld {
  readonly store: SqliteEventStore;
  readonly graph: ActiveCompiledGraph;
  readonly contractRef: ProductContractRevisionRef;
  readonly nodeRefs: readonly string[];
  readonly nodeRef: (localKey: string) => string;
}

/** Real source, contract, Gate 1, compiler and approval writers; no execution evidence seeded. */
export function createScopedGoalWorld(localKeys: readonly string[] = ["node-1"]): ScopedGoalWorld {
  if (localKeys.length < 1 || localKeys.length > 3 || new Set(localKeys).size !== localKeys.length) {
    throw new Error("scoped closure fixture requires one to three distinct local keys");
  }
  const store = boundWorld();
  const contractRef = committedRevision(store, localKeys.length === 3);
  approveGate1(store, contractRef);
  const criteria = localKeys.length === 3 ? ["crit-api", "crit-ui", "crit-worker"] : ["crit-api", "crit-ui"];
  const nodes = localKeys.map((key, index) => nodeOf(key,
    localKeys.length === 1 ? criteria : [criteria[index]!], index === 0 ? [] : [localKeys[index - 1]!]));
  const sealed = submit(store, contractRef, { structure: structureOf(nodes, localKeys.at(-1)!) });
  if (!sealed.ok) throw new Error(`scoped closure compile refused: ${sealed.code}@${sealed.layer}`);
  approvePlan(store, sealed.runId);
  const graphs = activeCompiledGraphs(store, PROJECT_ID).filter((graph) => graph.goalRef === GOAL_ID);
  if (graphs.length !== 1) throw new Error("scoped closure fixture did not activate exactly one graph");
  const graph = graphs[0]!;
  const refs = new Map(localKeys.map((key) => [key, compiledExecutionRef(PROJECT_ID, graph, key)]));
  return { store, graph, contractRef, nodeRefs: [...refs.values()], nodeRef: (key) => {
    const ref = refs.get(key); if (ref === undefined) throw new Error(`unapproved fixture key: ${key}`);
    return ref;
  } };
}
