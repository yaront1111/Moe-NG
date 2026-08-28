/**
 * THE DURABLE REVALIDATION (task-9e52f850). Every current fact a replacement supersession decides
 * against is re-read HERE, at decision time, from a committed-events reader — never from the
 * request and never from the preparation record's own copy of the world.
 *
 * WHY RE-READING IS THE POINT. A preparation generation certifies which world was prepared; it
 * cannot certify that the world is still that one. The generation is the TOKEN, and the facts are
 * re-derived and compared against it: a preparation whose target is no longer the active graph,
 * whose captured graph epoch has been overtaken by another activation, whose lineage set has moved,
 * whose disposition digest no longer reproduces, or whose funding meter no longer backs the hold is
 * DRIFT — and drift refuses without consuming anything.
 *
 * THE EXACTNESS IS THE DELIVERABLE. `generation` and `expectedPreparationVersion` are compared by
 * EQUALITY against the durable fold. There is no tolerant match, no "close enough" and no
 * highest-wins: a supersession bound to a near-miss generation still commits and still tests green
 * while superseding against a stale or foreign preparation, which is exactly the failure this row
 * exists to prevent.
 *
 * NOTHING HERE APPENDS. Every path is a read or a pure recompute, so a refusal leaves zero residue
 * and the caller can abandon the whole decision.
 */
import type { JsonObject, JsonValue } from "@moe/contracts";
import { encodeGraphContent } from "@moe/scheduler";
import type { GraphRevisionContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import type { BudgetProjectionResult } from "../budget/budget-current-projection.js";
import { graphRevisionAggregateId, readCurrentActiveGraph } from "./active-graph-projection.js";
import type { ActiveGraphAccepted } from "./active-graph-projection.js";
import { readGraphBody } from "./graph-body-record.js";
import { refuseSupersede } from "./graph-supersede-contracts.js";
import type { GraphSupersedeRefusal, GraphSupersedeRequest } from "./graph-supersede-contracts.js";
import {
  fundingAggregateId, planningFenceAggregateId, preparationAggregateId,
} from "./supersession-preparation-contracts.js";
import type { SupersessionPreparationGeneration } from "./supersession-preparation-contracts.js";
import { foldPreparationHistory } from "./supersession-preparation-history.js";
import { lineagesOfActiveGraph, recomputeDispositionFacts } from "./supersession-preparation-lineages.js";

export interface GoalFacts {
  readonly activeGraphRevisionRef: string;
  readonly graphEpoch: number;
  readonly version: number;
}

export interface SupersedeFacts {
  readonly active: ActiveGraphAccepted;
  readonly fundingAggregateId: string;
  readonly generation: SupersessionPreparationGeneration;
  readonly goal: GoalFacts;
  readonly ok: true;
  readonly planningFenceAggregateId: string;
  readonly preparationAggregateId: string;
  readonly preparationVersion: number;
  readonly successorContent: GraphRevisionContent;
}

export type SupersedeFactsResult = SupersedeFacts | GraphSupersedeRefusal;

/**
 * The budget reader, as a PORT with a production default — the same shape
 * `supersession-preparation-ledger.ts:82` gives its activation-evidence reader, and for the same
 * reason: the shrunk-meter world is not reachable through production writers in this tree, so
 * without a seam the guard would be an untested branch. Production never substitutes.
 */
export type SupersedeBudgetPort =
  (store: SqliteEventStore, projectId: string, goalRef: string) => BudgetProjectionResult;

export const SUPERSEDE_BUDGET_EVIDENCE: SupersedeBudgetPort = readCurrentBudgetLedger;

/** The goal's own durable record, as `stateOf(readDurableLedger(...))` returns it. */
function goalFactsOf(goal: JsonValue | undefined): GoalFacts | null {
  if (goal === undefined || goal === null || typeof goal !== "object" || Array.isArray(goal)) {
    return null;
  }
  const record = goal as JsonObject;
  const version = record["version"];
  const graphEpoch = record["graphEpoch"];
  const activeGraphRevisionRef = record["activeGraphRevisionRef"];
  if (!Number.isSafeInteger(version) || (version as number) < 1
    || !Number.isSafeInteger(graphEpoch) || (graphEpoch as number) < 1
    || typeof activeGraphRevisionRef !== "string" || activeGraphRevisionRef.length === 0) {
    return null;
  }
  return Object.freeze({
    activeGraphRevisionRef, graphEpoch: graphEpoch as number, version: version as number,
  });
}

/**
 * RECOMPUTE-EQUALS-NAMED, the same discipline `graph-activation-binding.ts:156` applies to an
 * initial activation. `readGraphBody` proves the stored bytes decode to their own declared digest
 * AND that they are filed under the hash we asked for; re-encoding the decoded CONTENT closes the
 * remaining gap by deriving the digest from the FIELDS. `snapshotIdentity` is never consulted:
 * it is the STRUCTURAL identity and equating it with a content hash is the single easiest way to
 * bind an activation to a hash the kernel never accepted (dec-64b2391c, option A).
 */
function successorContentOf(
  store: SqliteEventStore, projectId: string, graphContentHash: string,
): { readonly content: GraphRevisionContent; readonly ok: true } | GraphSupersedeRefusal {
  const body = readGraphBody(store, projectId, graphContentHash);
  if (!body.ok) {
    return refuseSupersede("GRAPH_SUPERSEDE_SUCCESSOR_CONTENT_UNSEALED",
      { code: body.code, layer: body.layer });
  }
  const encoded = encodeGraphContent(body.content);
  if (!encoded.ok || encoded.value.graphContentHash !== graphContentHash) {
    return refuseSupersede("GRAPH_SUPERSEDE_SUCCESSOR_CONTENT_UNSEALED",
      { code: "GRAPH_SUPERSEDE_CONTENT_RECOMPUTE_DIVERGED", layer: "GRAPH_CONTENT_CODEC" });
  }
  return { content: encoded.value.content, ok: true as const };
}

/** The funding meter must STILL back the hold the preparation took; a shrunk meter is not funding. */
function fundingStillBacks(
  store: SqliteEventStore, projectId: string, generation: SupersessionPreparationGeneration,
  budgetPort: SupersedeBudgetPort,
): boolean {
  const budget = budgetPort(store, projectId, generation.binding.goalRef);
  if (!budget.ok) return false;
  return budget.meters.some((meter) => meter.meter === generation.funding.meter
    && meter.coverage === "COMPLETE" && meter.refundable !== null
    && meter.refundable >= generation.funding.quantity);
}

function sameLineages(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * The preparation half: exact generation, exact version, both members still holding, no drift.
 *
 * THE ORDER IS LOAD-BEARING (task-7eddd612): identity (UNVERIFIABLE/ABSENT/STALE) -> drift (target
 * and epoch, then roster and digest) -> [reserved coverage slot] -> deadline -> funding.
 * The deadline is compared only once the generation is proven to be THIS request's generation and
 * undrifted, so an EXPIRED answer can never mask a stale or drifted preparation — the more
 * actionable fault always wins. It runs BEFORE funding so a world with matching roster/digest and
 * live funding leaves the deadline as the only mechanism that can refuse, which is what makes the
 * EXPIRED arm a divergence fixture rather than a "the system refused" fixture.
 */
function preparationFacts(
  store: SqliteEventStore, request: GraphSupersedeRequest, active: ActiveGraphAccepted,
  budgetPort: SupersedeBudgetPort,
): SupersedeFactsResult | { readonly generation: SupersessionPreparationGeneration;
  readonly preparationVersion: number } {
  const history = foldPreparationHistory(
    store, preparationAggregateId(request.projectId, request.goalRef),
  );
  if (!history.ok) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_UNVERIFIABLE",
      { code: history.code, layer: history.layer });
  }
  if (history.current === null || history.currentGraphEpoch === null) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_ABSENT");
  }
  const generation = history.current;
  if (generation.binding.generation !== request.generation
    || history.version !== request.expectedPreparationVersion) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_STALE");
  }
  // NO "is the pair still HELD/ACTIVE" GUARD HERE, deliberately. `foldPreparationHistory` returns
  // `current` only for a PREPARED event whose record `bindPreparationGeneration` produced, and both
  // terminals clear it — so a released or consumed generation is already `null` above and a guard
  // restating it would be unfalsifiable: deleting it leaves every arm green.
  if (generation.binding.targetRevisionRef !== active.revisionId
    || history.currentGraphEpoch !== active.graphEpoch) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_DRIFT");
  }
  const lineages = lineagesOfActiveGraph(store, request.projectId, active);
  const disposed = recomputeDispositionFacts(lineages);
  if (!sameLineages(lineages, generation.fence.fencedLineages)
    || disposed === null || disposed.digest !== generation.dispositionDigest) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_DRIFT");
  }
  // RESERVED SLOT for GRAPH_SUPERSEDE_DISPOSITION_INCOMPLETE (task-08efb6f0): both the STORED
  // `generation.dispositionCoverage` and `disposed.coverage` recomputed just above must be
  // COMPLETE. Deliberately not wired yet — `lineageFactsFor` hardcodes ADD, so the scheduler set
  // can never answer COMPLETE and the gate would refuse EVERY supersession. The code is landed and
  // pinned so wiring it is a two-line change the day a producer can reach COMPLETE.

  // THE WINDOW, from the command's OWN server-stamped `decidedAt` — no clock. `>` not `>=`: the
  // deadline instant is still inside the window, which the boundary arm pins.
  if (Date.parse(request.decidedAt) > generation.binding.deadlineEpochMs) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_EXPIRED");
  }
  if (!fundingStillBacks(store, request.projectId, generation, budgetPort)) {
    return refuseSupersede("GRAPH_SUPERSEDE_FUNDING_UNAVAILABLE");
  }
  return { generation, preparationVersion: history.version };
}

/**
 * Read and revalidate every fact the transition is decided against, or refuse with the exact code
 * and — where a lower reader answered — its own code and layer.
 */
export function readSupersedeFacts(
  store: SqliteEventStore, request: GraphSupersedeRequest, goal: JsonValue | undefined,
  budgetPort: SupersedeBudgetPort = SUPERSEDE_BUDGET_EVIDENCE,
): SupersedeFactsResult {
  const active = readCurrentActiveGraph(store, request.projectId);
  if (!active.ok) {
    return refuseSupersede("GRAPH_SUPERSEDE_CURRENT_GRAPH_UNAVAILABLE",
      { code: active.code, layer: active.layer });
  }
  if (active.revisionId !== request.expectedPredecessorRevisionRef
    || active.provenance.goalRef !== request.goalRef) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH");
  }
  if (request.successorRevisionRef === active.revisionId) {
    return refuseSupersede("GRAPH_SUPERSEDE_SUCCESSOR_INVALID");
  }
  // THE WRITE-SIDE ONE-ACTIVE GUARD. A successor aggregate with ANY history is either already
  // activated or mid-lifecycle, and either way this decision would be its second whole history.
  const successorAggregateId = graphRevisionAggregateId(
    request.projectId, request.successorRevisionRef,
  );
  if (store.readEvents(successorAggregateId).length > 0) {
    return refuseSupersede("GRAPH_SUPERSEDE_SUCCESSOR_ALREADY_RECORDED");
  }
  const goalFacts = goalFactsOf(goal);
  if (goalFacts === null) return refuseSupersede("GRAPH_SUPERSEDE_GOAL_UNREADABLE");
  if (goalFacts.graphEpoch !== active.graphEpoch
    || goalFacts.activeGraphRevisionRef !== active.revisionId) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_DRIFT");
  }
  const successor = successorContentOf(store, request.projectId,
    request.successorGraphContentHash);
  if (!("content" in successor)) return successor;
  const prepared = preparationFacts(store, request, active, budgetPort);
  if ("ok" in prepared) return prepared;
  return Object.freeze({
    active,
    fundingAggregateId: fundingAggregateId(request.projectId, request.goalRef),
    generation: prepared.generation,
    goal: goalFacts,
    ok: true as const,
    planningFenceAggregateId: planningFenceAggregateId(request.projectId, request.goalRef),
    preparationAggregateId: preparationAggregateId(request.projectId, request.goalRef),
    preparationVersion: prepared.preparationVersion,
    successorContent: successor.content,
  });
}
