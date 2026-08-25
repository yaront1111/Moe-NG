/**
 * THE ATOMIC REPLACEMENT SUPERSESSION (task-9e52f850). One durable decision moves a project from
 * "this graph is running" to "that graph is running instead", or nothing moves at all.
 *
 * WHY IT IS A SERVICE AND NOT A COMMAND HANDLER, exactly as its sibling `graph-activation-service`
 * is: the `graph.supersede` transport needs this move and may not reconstruct the authority behind
 * it, so it lives here with its own entry point and the transport composes it (task-efc2ef63).
 * Nothing in this module touches a registry, an ingress or a dispatch table, and `graph.supersede`
 * is deliberately NOT registered here — `buildCommandRegistry` (http-contract.ts:243-245) throws
 * "command kind registered twice" and crashes daemon composition at boot, and task-931f99e8 owns
 * that registration.
 *
 * SIX LEGS, ONE TRANSACTION. legs[0] is the GOAL and moving it would break two things at once:
 * `readDurableLedger` folds only `decision.targetAggregateId`, so a non-goal primary would erase
 * the goal's post-supersession state from every later command's view, and the decision's committed
 * RESULT is the primary's `GoalState`. The predecessor's supersession, the successor's activation
 * and the preparation pair's three consumption legs are SECONDARY, fenced in the same decision.
 * Any one refusing aborts all of them; a concurrent supersession loses on a fence; a crash yields
 * all or none.
 *
 * NOTHING HERE DECIDES ANYTHING. The supersession itself belongs to `decideSupersession`, the two
 * lifecycles to the core reducers, the epoch arithmetic to the goal aggregate and to the
 * predecessor's own bound epoch, the current-world facts to `graph-supersede-facts`, and the
 * refusal vocabulary to whichever of them answered. This module orders them and commits the verdict.
 *
 * REPLAY IS CHECKED FIRST AND MUST BE. The reducers compare `expectedVersion` against current
 * version, so an identical resubmit would be rejected by the core and could never reach the store
 * to be recognised as the decision it already is. Same bytes return the ORIGINAL decision with no
 * new event and no new decision row; different bytes under the same identity refuse.
 */
import type { JsonValue } from "@moe/contracts";
import { reduceGoal } from "@moe/core";
import type { ApprovalDecisionRecord, GoalCommand, GoalState } from "@moe/core";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import { commitAcceptedLegs, replayOf, stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { CommitPlan, HandlerContext } from "../bootstrap/bootstrap-ledger.js";
import { buildPreparationConsumptionLegs, priorConsumption } from "./graph-supersede-consumption.js";
import { decodeSupersedeRequest, refuseFromAggregate, refuseSupersede } from "./graph-supersede-contracts.js";
import type { GraphSupersedeRefusal, GraphSupersedeRequest } from "./graph-supersede-contracts.js";
import { deriveSupersessionDispositions } from "./graph-supersede-dispositions.js";
import { SUPERSEDE_BUDGET_EVIDENCE, readSupersedeFacts } from "./graph-supersede-facts.js";
import type { SupersedeBudgetPort, SupersedeFacts } from "./graph-supersede-facts.js";
import { buildSupersessionRevisionLegs } from "./graph-supersede-legs.js";
import { preparationAggregateId } from "./supersession-preparation-contracts.js";
import type { SupersessionPreparationGeneration } from "./supersession-preparation-contracts.js";

export interface GraphSupersedeInput {
  /**
   * The core's DECIDED approval record for the successor, not a request payload. Its `approvalRef`
   * is the only approval identity the successor's `graph.approve` may cite, and its `actorKind` —
   * never a caller string — decides whether the truth class is HUMAN_APPROVED or DAEMON_VERIFIED.
   */
  readonly approval: ApprovalDecisionRecord;
}

export interface GraphSupersedeAccepted {
  readonly consumed: SupersessionPreparationGeneration;
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly predecessorRevisionId: string;
  readonly successorGraphEpoch: number;
  readonly successorRevisionId: string;
}

export type GraphSupersedeResult = GraphSupersedeAccepted | GraphSupersedeRefusal;

/**
 * The goal is the ONLY authority that advances an epoch, and `goal.advance_graph_epoch` re-checks
 * every part of the move against its own state: the named predecessor must BE the goal's active
 * revision, the successor must differ from it, and the epoch must be exactly the goal's own next
 * one. So the arithmetic is asserted twice against two independent durable facts — the
 * predecessor's bound epoch here, the goal's epoch there — and a private counter cannot satisfy
 * both.
 */
function advanceCommand(
  request: GraphSupersedeRequest, facts: SupersedeFacts, successorGraphEpoch: number,
): GoalCommand {
  return {
    commandId: request.commandId,
    expectedVersion: facts.goal.version,
    graphEpoch: successorGraphEpoch,
    kind: "goal.advance_graph_epoch",
    predecessorGraphRevisionRef: facts.active.revisionId,
    successorGraphRevisionRef: request.successorRevisionRef,
  } as unknown as GoalCommand;
}

/** The one place a decoded request and a durable world become a set of fenced legs. */
function composeAndCommit(
  context: HandlerContext, input: GraphSupersedeInput, request: GraphSupersedeRequest,
  facts: SupersedeFacts,
): GraphSupersedeResult {
  const { ledger, request: envelope, store } = context;
  const dispositions = deriveSupersessionDispositions(
    facts.active.content.nodeAuthority.authorities,
    facts.successorContent.nodeAuthority.authorities,
  );
  if (dispositions === null) return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_DRIFT");

  const revisions = buildSupersessionRevisionLegs({
    actorKind: input.approval.actorKind,
    approvalRef: input.approval.approvalRef,
    commandId: envelope.commandId,
    dispositions,
    expectedGoalVersion: facts.goal.version,
    goalRef: request.goalRef,
    predecessorRevisionId: facts.active.revisionId,
    projectId: envelope.projectId,
    store,
    successorGraphContentHash: request.successorGraphContentHash,
    successorRevisionId: request.successorRevisionRef,
  });
  if (!revisions.ok) return revisions;

  const goalVerdict = reduceGoal(
    stateOf(ledger, request.goalRef) as unknown as GoalState,
    advanceCommand(request, facts, revisions.successorGraphEpoch),
  );
  if (!goalVerdict.ok) return refuseFromAggregate(goalVerdict.error, goalVerdict.layer, "GOAL");

  const consumption = buildPreparationConsumptionLegs({
    commandId: envelope.commandId,
    fundingAggregateId: facts.fundingAggregateId,
    generation: facts.generation,
    planningFenceAggregateId: facts.planningFenceAggregateId,
    preparationAggregateId: facts.preparationAggregateId,
    preparationVersion: facts.preparationVersion,
    store,
    successorGraphEpoch: revisions.successorGraphEpoch,
  });

  const plan: CommitPlan = {
    aggregateId: request.goalRef,
    eventPayload: {
      consumedPreparation: consumption.consumed,
      events: goalVerdict.events,
      successor: revisions.successorState,
    } as unknown as JsonValue,
    eventType: "GoalGraphEpochAdvanced",
    expectedVersion: versionOf(ledger, request.goalRef),
    result: goalVerdict.state as unknown as JsonValue,
  };
  const outcome = commitAcceptedLegs(store, envelope, plan, [
    revisions.predecessor, revisions.successor, ...consumption.legs,
  ]);
  if (!outcome.ok) {
    return refuseSupersede("GRAPH_SUPERSEDE_CONCURRENT_ACTIVATION",
      { code: outcome.code, layer: outcome.refusedBy }, "DURABLE_STORE");
  }
  return Object.freeze({
    consumed: consumption.consumed,
    decision: outcome.decision,
    disposition: outcome.disposition,
    ok: true as const,
    predecessorRevisionId: facts.active.revisionId,
    successorGraphEpoch: revisions.successorGraphEpoch,
    successorRevisionId: request.successorRevisionRef,
  });
}

/**
 * The ORIGINAL immutable record, read off the committed consumption event. A replay whose
 * generation left no consumption event is a SPLIT pair — the decision exists but its business
 * effect does not — and that refuses rather than being answered from the request's own numbers.
 */
function replayAnswer(
  store: SqliteEventStore, request: GraphSupersedeRequest, decision: CommandDecisionRecord,
): GraphSupersedeResult {
  const prior = priorConsumption(
    store, preparationAggregateId(request.projectId, request.goalRef), request.generation,
  );
  if (prior === null) return refuseSupersede("GRAPH_SUPERSEDE_PREPARATION_ABSENT");
  return Object.freeze({
    consumed: prior.consumed,
    decision,
    disposition: "REPLAYED" as const,
    ok: true as const,
    predecessorRevisionId: request.expectedPredecessorRevisionRef,
    successorGraphEpoch: prior.successorGraphEpoch,
    successorRevisionId: request.successorRevisionRef,
  });
}

/** Supersede the active graph, or refuse with the exact code, layer and refusing authority. */
export function supersedeActiveGraph(
  context: HandlerContext, input: GraphSupersedeInput,
  budgetEvidence: SupersedeBudgetPort = SUPERSEDE_BUDGET_EVIDENCE,
): GraphSupersedeResult {
  const { ledger, request, store } = context;
  const replayed = replayOf(store, request);
  if (replayed !== null && !replayed.ok) {
    return refuseSupersede("GRAPH_SUPERSEDE_BYTES_CONFLICT",
      { code: replayed.code, layer: replayed.refusedBy });
  }
  const decoded = decodeSupersedeRequest(request.payload);
  if (!decoded.ok) return decoded;
  const { request: supersede } = decoded;
  // THE ENVELOPE OWNS THE PROJECT. The payload names one too, and every current fact is read under
  // the payload's while the legs are written under the envelope's — so a payload naming a FOREIGN
  // project would read that project's graph and preparation and write against THIS one.
  if (supersede.projectId !== request.projectId) {
    return refuseSupersede("GRAPH_SUPERSEDE_TARGET_FOREIGN");
  }
  // SAME BYTES, ALREADY DECIDED — answered BEFORE any current-fact read, because a committed
  // supersession has CONSUMED the generation those reads would look for, so a fact-first order
  // would answer an honest replay with PREPARATION_ABSENT and hand a caller a refusal for a
  // command that succeeded.
  if (replayed !== null) return replayAnswer(store, supersede, replayed.decision);
  const facts = readSupersedeFacts(
    store, supersede, stateOf(ledger, supersede.goalRef), budgetEvidence,
  );
  if (!facts.ok) return facts;
  return composeAndCommit(context, input, supersede, facts);
}
