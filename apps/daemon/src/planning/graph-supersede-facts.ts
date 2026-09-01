/**
 * THE DURABLE REVALIDATION (task-9e52f850). Every current fact is re-read at decision time from
 * committed events — never from the request or the preparation record's copy of the world.
 *
 * A generation certifies which world was prepared, not that it is still current. Target, epoch,
 * lineage digest, disposition coverage and funding are re-derived; any mismatch is DRIFT.
 *
 * Generation and expectedPreparationVersion compare exactly; no tolerant or highest-wins match.
 *
 * Nothing here appends, so every refusal leaves zero residue.
 */
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SupersessionDisposition } from "@moe/core";
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
import { deriveCoveredSupersessionDispositions } from "./graph-supersede-dispositions.js";
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
  readonly dispositionCoverage: "COMPLETE";
  readonly dispositions: readonly SupersessionDisposition[];
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
 * Budget reader port with a production default. Tests substitute only for the otherwise-unreachable
 * shrunk-meter world; production never substitutes.
 */
export type SupersedeBudgetPort =
  (store: SqliteEventStore, projectId: string, goalRef: string) => BudgetProjectionResult;

type Authorities = GraphRevisionContent["nodeAuthority"]["authorities"];
export type SupersedeDispositionPort = (
  fencedLineages: readonly string[], predecessor: Authorities, successor: Authorities,
) => readonly SupersessionDisposition[] | null;

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
  successorContent: GraphRevisionContent, budgetPort: SupersedeBudgetPort,
  dispositionPort: SupersedeDispositionPort,
): SupersedeFactsResult | { readonly generation: SupersessionPreparationGeneration;
  readonly dispositions: readonly SupersessionDisposition[]; readonly preparationVersion: number } {
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
    || disposed.digest !== generation.dispositionDigest) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_DRIFT");
  }
  // COMPLETE is measured HERE, where both authenticated contents expose their authority hashes.
  // Preparation stays PARTIAL because it has no successor; an underivable real pair fails closed.
  const dispositions = dispositionPort(
    generation.fence.fencedLineages,
    active.content.nodeAuthority.authorities, successorContent.nodeAuthority.authorities,
  );
  if (dispositions === null) {
    return refuseSupersede("GRAPH_SUPERSEDE_DISPOSITION_INCOMPLETE");
  }

  // THE WINDOW, from the command's OWN server-stamped `decidedAt` — no clock. `>` not `>=`: the
  // deadline instant is still inside the window, which the boundary arm pins.
  if (Date.parse(request.decidedAt) > generation.binding.deadlineEpochMs) {
    return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_EXPIRED");
  }
  if (!fundingStillBacks(store, request.projectId, generation, budgetPort)) {
    return refuseSupersede("GRAPH_SUPERSEDE_FUNDING_UNAVAILABLE");
  }
  return { dispositions, generation, preparationVersion: history.version };
}

/**
 * Read and revalidate every fact the transition is decided against, or refuse with the exact code
 * and — where a lower reader answered — its own code and layer.
 */
export function readSupersedeFacts(
  store: SqliteEventStore, request: GraphSupersedeRequest, goal: JsonValue | undefined,
  budgetPort: SupersedeBudgetPort = SUPERSEDE_BUDGET_EVIDENCE,
  dispositionPort: SupersedeDispositionPort = deriveCoveredSupersessionDispositions,
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
  const prepared = preparationFacts(
    store, request, active, successor.content, budgetPort, dispositionPort,
  );
  if ("ok" in prepared) return prepared;
  return Object.freeze({
    active,
    dispositionCoverage: "COMPLETE" as const,
    dispositions: prepared.dispositions,
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
