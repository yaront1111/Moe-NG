import type { JsonObject, JsonValue } from "@moe/contracts";
import { reduceGoal } from "@moe/core";
import type {
  ApprovalDecisionRecord,
  ApprovalPolicy,
  GoalCommand,
  GoalState,
  HumanAuthorityGrant,
} from "@moe/core";

import {
  commitAcceptedLegs,
  refuse,
  refuseFromCore,
  replayOf,
  stateOf,
  versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type { CommitPlan, HandlerContext, ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import { resolveApprovalBudgetRoot } from "../budget/budget-genesis-leg.js";
import type { ApprovalBudgetRoot } from "../budget/budget-genesis-leg.js";
import { buildActiveGraphSlotLeg, observeActiveGraphSlot } from "./active-graph-slot.js";
import type { ApprovedRunBinding } from "./approval-run-binding.js";
import { composeGraphTransition } from "./graph-transition-legs.js";

/**
 * THE ATOMIC ACTIVE-GRAPH TRANSITION. One durable decision moves a project from "a plan was
 * approved" to "this graph is the one that is running", or nothing moves at all.
 *
 * WHY IT IS A SERVICE AND NOT A COMMAND HANDLER. `graph.approve` and `graph.supersede` transport
 * both need this move and neither may reconstruct the authority behind it, so it lives here with
 * its own entry point and the transport composes it (task-efc2ef63). Nothing in this module
 * touches a registry, an ingress or a dispatch table.
 *
 * THREE REDUCER RESULTS, ONE TRANSACTION — the shape `graph-revision-reducer.ts:11-15` specifies
 * in its own header. The goal's `goal.activate_initial_graph`, the revision's compound
 * `graph.approve`, and (on a project with no budget root yet) the genesis budget authorization
 * ride a single `commitExpectedVersionDecisionLegs`. Any one of them refusing aborts all of them;
 * a concurrent activation loses on a fence; a crash yields all or none.
 *
 * LEGS[0] IS THE GOAL AND MOVING IT WOULD BREAK TWO THINGS AT ONCE, both measured rather than
 * argued. `readDurableLedger` folds only `decision.targetAggregateId`, so a non-goal primary
 * would erase the goal's post-activation state from every later command's view of the ledger;
 * and the decision's committed RESULT is the primary's, which is the `GoalState` the next command
 * reads. The revision and the budget root are therefore SECONDARY legs, fenced in the same
 * decision — which is also why `graph-decision-evidence.ts` had to learn that a decision record
 * carries the PRIMARY leg's numbers and no other leg's.
 *
 * NOTHING HERE DECIDES ANYTHING. Every judgement belongs to a named authority: the lifecycle to
 * the two core reducers, the budget root to `budget-genesis-leg`, the five-member binding to
 * `graph-activation-binding`, and the refusal vocabulary to whichever of them answered. This
 * module orders them and commits their verdict.
 */

export interface GraphActivationInput {
  /** The caller's activation witness. Every member is COMPARED; none is adopted. */
  readonly activation: JsonObject;
  /** The core's DECIDED approval record, not a request payload. */
  readonly approval: ApprovalDecisionRecord;
  /** The core's decided wait. A satisfied human gate proceeds at 0. */
  readonly authorityDelayMs: number;
  /** The verified approved-run identity. */
  readonly binding: ApprovedRunBinding;
  readonly goalId: string;
  readonly grant: HumanAuthorityGrant | null;
  readonly graphRevisionRef: string;
  /** The daemon's own approval settings. No payload branch can reach this. */
  readonly policy: ApprovalPolicy;
  /**
   * The run's durable record, as `stateOf(readDurableLedger(...), runId)` returns it.
   *
   * A COMPOSITION CONTRACT, and the sharpest one on this interface. The binding's content and
   * quality hashes are read off this record's `sealedHashes`, so handing in a REQUEST payload
   * shaped like a run would let a caller name any body already durable in the store and have the
   * server bind it. The transport must read it from the ledger and must have already run
   * `verifyApprovedRunBinding`, which compares the caller's `graphRevisionRef` against the run's
   * own durable one. Nothing downstream can recover this distinction.
   */
  readonly run: JsonValue;
}

/**
 * The core's activation witness is EXACTLY THREE KEYS (`goal-validation.ts:154` is
 * `exact(value, ACTIVATION_KEYS)`), so a fourth here does not extend the command — it makes the
 * whole thing illegal at the reducer. `graphApprovalRef` is the core's OWN decided `approvalRef`,
 * so an activation cannot cite an approval this command did not just take.
 */
function goalActivationWitness(input: GraphActivationInput): JsonObject {
  return {
    activeGraphRevisionRef: input.graphRevisionRef,
    graphApprovalRef: input.approval.approvalRef,
    truthClass: input.activation["truthClass"] ?? null,
  };
}

/**
 * The DAEMON-OWNED durable copy: the core's three keys, the verified run identity, and the
 * complete five-member binding the revision was activated under. The core never reads
 * `eventPayload` back, so extending this copy is additive where extending the command witness is
 * fatal — and every added value was read out of a durable record, never copied from the request.
 */
function durableWitness(
  input: GraphActivationInput,
  witness: JsonObject,
  budgetHash: string,
  graphActivationBinding: JsonValue,
): JsonObject {
  return {
    ...witness,
    authorityRef: input.binding.authorityRef,
    bodiesDigest: input.binding.bodiesDigest,
    budgetHash,
    envelopeDigest: input.binding.envelopeDigest,
    graphActivationBinding,
    runId: input.binding.runId,
  };
}

function budgetRootFor(
  context: HandlerContext,
  input: GraphActivationInput,
): ApprovalBudgetRoot {
  const { request, store } = context;
  return resolveApprovalBudgetRoot(store, {
    approvedRun: {
      runBinding: input.binding,
      verifiedGraphRevisionRef: input.graphRevisionRef,
    },
    context: {
      commandId: request.commandId,
      correlationId: request.correlationId,
      decidedAt: request.decidedAt,
      principalId: request.principalId,
    },
    goalRef: input.goalId,
    projectId: request.projectId,
  });
}

/**
 * Activate the approved graph, or refuse with the exact code and layer of whatever answered.
 *
 * REPLAY IS CHECKED FIRST AND MUST BE. The reducers compare `expectedVersion` against current
 * version, so an identical resubmit would be rejected by the core and could never reach the store
 * to be recognised as the decision it already is. Same bytes return the ORIGINAL decision with no
 * new event and no new decision row; different bytes under the same identity refuse.
 */
export function activateApprovedGraph(
  context: HandlerContext,
  input: GraphActivationInput,
): ServiceOutcome {
  const { ledger, request, store } = context;
  const replayed = replayOf(store, request);
  if (replayed !== null) return replayed;

  const prior = stateOf(ledger, input.goalId);
  const witness = goalActivationWitness(input);
  const command = {
    commandId: request.commandId,
    expectedVersion: input.activation["expectedGoalVersion"],
    kind: "goal.activate_initial_graph",
    witness,
  } as unknown as GoalCommand;
  const verdict = reduceGoal(
    prior === undefined || prior === null ? undefined : (prior as unknown as GoalState),
    command,
  );
  if (!verdict.ok) return refuseFromCore(request.kind, verdict.error);

  // CAPTURED, NOT COMMITTED. A root that has to be minted is bytes until the decision lands, so
  // an approval refusing past this point leaves no spend authority behind.
  const root = budgetRootFor(context, input);
  if (!root.ok) return refuse(request.kind, root.code, root.layer);
  const claimedBudgetHash = input.activation["budgetHash"];
  if (claimedBudgetHash !== undefined && claimedBudgetHash !== root.digest) {
    return refuse(request.kind, "BOOTSTRAP_BUDGET_HASH_MISMATCH", "DAEMON_PREREQUISITE");
  }

  const slot = observeActiveGraphSlot(store, request.projectId);
  const transition = composeGraphTransition({
    approval: input.approval,
    authorityDelayMs: input.authorityDelayMs,
    budgetHash: root.digest,
    claimed: input.activation,
    goal: prior,
    goalId: input.goalId,
    grant: input.grant,
    graphRevisionRef: input.graphRevisionRef,
    policy: input.policy,
    principalId: request.principalId,
    projectId: request.projectId,
    requestCommandId: request.commandId,
    run: input.run,
    runId: input.binding.runId,
    store,
  });
  if (!transition.ok) {
    return refuse(request.kind, transition.code, transition.layer, transition.error);
  }
  const slotLeg = buildActiveGraphSlotLeg({
    commandId: request.commandId,
    graphEpoch: transition.state.graphEpoch,
    observed: slot,
    projectId: request.projectId,
    reason: "ACTIVATE",
    revisionId: input.graphRevisionRef,
  });

  const plan: CommitPlan = {
    aggregateId: input.goalId,
    eventPayload: {
      activation: durableWitness(
        input, witness, root.digest, transition.binding as unknown as JsonValue,
      ),
      approval: input.approval,
      events: verdict.events,
    } as unknown as JsonValue,
    eventType: "GoalExecutionEnabled",
    expectedVersion: versionOf(ledger, input.goalId),
    result: verdict.state as unknown as JsonValue,
  };
  // The revision leg is ALWAYS present — an activation that activates no graph is not a state
  // this surface can express — while the budget leg appears only when a root must be minted.
  const extraLegs = root.source === "GENESIS"
    ? [transition.leg, root.leg, slotLeg]
    : [transition.leg, slotLeg];
  return commitAcceptedLegs(store, request, plan, extraLegs);
}
