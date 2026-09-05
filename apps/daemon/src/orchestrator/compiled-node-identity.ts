import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { readGraphBody } from "../planning/graph-body-record.js";
import { readWorkClaimLedger } from "../work/work-claim-read-model.js";
import { landingAggregateId } from "../repository/landing-receipt-contracts.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";

/** Historical authority and legacy execution must be readable before new work is staffed. */
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
 * A bare-key execution has no sealed owner to migrate. Keep all of its possible
 * owners quarantined, including finished claims and retired children: neither
 * expiry nor cleanup attributes previously edited bytes or accepted output.
 * A shared local key alone is harmless once every execution subject is scoped.
 */
export function legacyCompiledNodeKeys(
  store: SqliteEventStore, projectId: string, current: readonly ActiveCompiledGraph[], folded?: DurableLedger,
): ReadonlySet<string> {
  historicalGraphs(store, projectId, folded ?? readDurableLedger(store, projectId));
  const claims = readWorkClaimLedger(store, projectId);
  if (claims.unreadable) throw new Error(COMPILED_NODE_IDENTITY_UNREADABLE);
  const keys = new Set(current.flatMap((graph) => graph.content.snapshot.nodes.map((node) => node.nodeKey)));
  const legacy = new Set<string>();
  for (const key of keys) {
    const workItemId = `node.deliver@${key}`;
    const staffing = `wrapper-staffing/${createHash("sha256").update(workItemId, "utf8").digest("hex")}`;
    if (store.getAggregateVersion(key) > 0 || store.getAggregateVersion(landingAggregateId(key)) > 0
      || store.getAggregateVersion(staffing) > 0 || claims.claims.has(workItemId)) legacy.add(key);
  }
  return legacy;
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
