import { decodeBoundedJsonBytes } from "@moe/contracts";
import { encodeGraphContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { readGraphBody } from "../planning/graph-body-record.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";

/** Temporary quarantine while durable execution subjects still use a bare graph-local key. */
export const COMPILED_NODE_IDENTITY_UNREADABLE = "COMPILED_NODE_IDENTITY_UNREADABLE";
const EXECUTED = new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]);

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

interface HistoricalGraph extends ActiveCompiledGraph {
  readonly graphContentHash: string;
  readonly planningRunRef: string;
}

/** A terminal goal or a successor run must never erase an earlier execution owner. */
function historicalGraphs(
  store: SqliteEventStore, projectId: string, ledger: DurableLedger,
): readonly HistoricalGraph[] {
  const history = new Map<string, HistoricalGraph>();
  for (const decision of decisionsOf(store, 200)) {
    if (decision.key.projectId !== projectId || decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
    const decoded = decodeBoundedJsonBytes(decision.resultBytes);
    if (!decoded.ok) throw new Error(COMPILED_NODE_IDENTITY_UNREADABLE);
    const goal = record(decoded.value);
    if (goal?.["goalId"] !== decision.targetAggregateId || goal["projectId"] !== projectId
      || !EXECUTED.has(String(goal["lifecycle"]))) continue;
    const planningRunRef = goal["planningRunRef"];
    if (typeof planningRunRef !== "string") throw new Error(COMPILED_NODE_IDENTITY_UNREADABLE);
    const owner = JSON.stringify([decision.targetAggregateId, planningRunRef]);
    if (history.has(owner)) continue;
    const run = record(stateOf(ledger, planningRunRef));
    const state = record(run?.["state"]);
    const graphContentHash = record(state?.["sealedHashes"])?.["graphContentHash"];
    if (state?.["goalRef"] !== decision.targetAggregateId
      || typeof graphContentHash !== "string" || !/^[0-9a-f]{64}$/u.test(graphContentHash)) {
      throw new Error(COMPILED_NODE_IDENTITY_UNREADABLE);
    }
    const body = readGraphBody(store, projectId, graphContentHash);
    if (!body.ok) throw new Error(COMPILED_NODE_IDENTITY_UNREADABLE);
    history.set(owner, { content: body.content, goalRef: decision.targetAggregateId, graphContentHash, planningRunRef });
  }
  return [...history.values()];
}

/**
 * The same key in distinct goal/run pairs has no attributable legacy review subject.
 * Current injected graphs without a run ref are matched to the historical graph bytes;
 * production always supplies the run ref, including when identical bytes are re-approved.
 * An unreadable historical graph throws so callers withhold authority, never forget owners.
 */
export function ambiguousCompiledNodeKeys(
  store: SqliteEventStore, projectId: string, current: readonly ActiveCompiledGraph[], folded?: DurableLedger,
): ReadonlySet<string> {
  const historical = historicalGraphs(store, projectId, folded ?? readDurableLedger(store, projectId));
  const owners = new Map<string, Set<string>>();
  const add = (graph: ActiveCompiledGraph, owner: string): void => {
    for (const node of graph.content.snapshot.nodes) {
      if (!node.executionBearing) continue;
      const subjects = owners.get(node.nodeKey) ?? new Set<string>();
      subjects.add(owner);
      owners.set(node.nodeKey, subjects);
    }
  };
  for (const graph of historical) add(graph, JSON.stringify([graph.goalRef, graph.planningRunRef]));
  for (const graph of current) {
    if (graph.planningRunRef !== undefined) {
      add(graph, JSON.stringify([graph.goalRef, graph.planningRunRef]));
      continue;
    }
    const encoded = encodeGraphContent(graph.content);
    if (!encoded.ok) throw new Error(COMPILED_NODE_IDENTITY_UNREADABLE);
    const known = historical.filter((old) => old.goalRef === graph.goalRef
      && old.graphContentHash === encoded.value.graphContentHash);
    if (known.length === 0) add(graph, JSON.stringify([graph.goalRef, encoded.value.graphContentHash]));
    else for (const old of known) add(graph, JSON.stringify([old.goalRef, old.planningRunRef]));
  }
  return new Set([...owners].filter(([, subjects]) => subjects.size > 1).map(([key]) => key));
}

/** A legacy acceptance of an ambiguous producer cannot make its downstream work staffable. */
export function nodesBlockedByIdentity(
  graphs: readonly ActiveCompiledGraph[], ambiguous: ReadonlySet<string>,
): ReadonlySet<string> {
  const blocked = new Set(ambiguous);
  let changed = true;
  while (changed) {
    changed = false;
    for (const graph of graphs) for (const edge of graph.content.snapshot.edges) {
      if (blocked.has(edge.producerNodeKey) && !blocked.has(edge.consumerNodeKey)) {
        blocked.add(edge.consumerNodeKey);
        changed = true;
      }
    }
  }
  return blocked;
}
