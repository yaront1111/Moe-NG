import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { dataRecord as record } from "../json-record-shape.js";
import { graphBodyAggregateId, readGraphBody } from "../planning/graph-body-record.js";
import { readWorkClaimLedger } from "../work/work-claim-read-model.js";
import { landingAggregateId } from "../repository/landing-receipt-contracts.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";
import { durableWalkMemoisable, memoisedDurableWalk } from "./durable-walk-memo.js";
import type { DurableWalkMemos } from "./durable-walk-memo.js";

/** Historical authority and legacy execution must be readable before new work is staffed. */
export const COMPILED_NODE_IDENTITY_UNREADABLE = "COMPILED_NODE_IDENTITY_UNREADABLE";
const EXECUTED = new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]);

interface HistoricalGraph extends ActiveCompiledGraph {
  readonly graphContentHash: string;
  readonly planningRunRef: string;
}

/**
 * WHY THIS WALK IS MEMOISED. It decodes EVERY committed decision of the project and parses each
 * historical graph body from its bytes, and `legacyCompiledNodeKeys` runs it for its refusal
 * alone — the result is discarded. Called once per node per delivery pass. Measured on UnAI
 * 2026-09-17, after the active-graphs walk was memoised: 34.5% of the live wrapper's CPU under
 * this one function, passes still taking minutes. Everything it reads is decisions (the ledger
 * marker) plus graph bodies (events on their own aggregates, recorded by version); the freshness
 * proof lives in `durable-walk-memo.ts`. A walk that throws is not remembered.
 */
const historyMemos: DurableWalkMemos<readonly HistoricalGraph[]> = new WeakMap();

function historicalGraphsOf(
  store: SqliteEventStore, projectId: string, folded: DurableLedger | undefined,
): readonly HistoricalGraph[] {
  if (folded !== undefined || !durableWalkMemoisable(store)) {
    return historicalGraphs(store, projectId, folded ?? readDurableLedger(store, projectId), () => undefined);
  }
  return memoisedDurableWalk(store, historyMemos, projectId, (touch) =>
    historicalGraphs(store, projectId, readDurableLedger(store, projectId), touch));
}

/** A terminal goal or a successor run must never erase an earlier execution owner. */
function historicalGraphs(
  store: SqliteEventStore, projectId: string, ledger: DurableLedger,
  touch: (aggregateId: string) => void,
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
    touch(graphBodyAggregateId(projectId, graphContentHash));
    const body = readGraphBody(store, projectId, graphContentHash);
    if (!body.ok) throw new Error(COMPILED_NODE_IDENTITY_UNREADABLE);
    history.set(owner, { content: body.content, goalRef: decision.targetAggregateId, graphContentHash, planningRunRef });
  }
  return Object.freeze([...history.values()]);
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
  historicalGraphsOf(store, projectId, folded);
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
