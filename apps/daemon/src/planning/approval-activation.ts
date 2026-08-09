import type { JsonObject, JsonValue } from "@moe/contracts";
import { reduceGoal } from "@moe/core";
import type { ApprovalDecisionRecord, GoalCommand, GoalState } from "@moe/core";

import {
  commitAccepted,
  refuseFromCore,
  stateOf,
  versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type { HandlerContext, ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";

/**
 * The activation half of J1's second human action (design 299).
 *
 * It lives beside the approval handler rather than inside it because the pair must commit
 * through ONE `commitAccepted` call: the store decides one target aggregate per decision, so
 * the only way the approval and the activation can be all-or-nothing is for both to ride the
 * same durable decision. That decision targets the GOAL — the aggregate whose lifecycle has to
 * advance for J1's third action to be reachable — and carries the decided approval record in
 * its event payload, which is why the committed result is a bare `GoalState` and nothing else:
 * `snapshotGoalState` accepts exactly the twelve state keys, so a wrapper here would make the
 * goal unreadable to the next command.
 *
 * Nothing in this module decides. The witness is assembled from values the core has already
 * produced or will itself validate, and every rejection is the core's own.
 */

export interface ActivationInput {
  /** The caller's `PlanningActivationWitness`; only the core reads its fields. */
  readonly activation: JsonObject;
  readonly approval: ApprovalDecisionRecord;
  readonly goalId: string;
  readonly graphRevisionRef: string;
}

/**
 * `graphApprovalRef` is the core's OWN decided `approvalRef`, never a payload field. A caller
 * therefore cannot present an activation that names some other approval: the only approval an
 * activation can cite is the one this very command just decided.
 */
function activationWitness(input: ActivationInput): JsonObject {
  return {
    activeGraphRevisionRef: input.graphRevisionRef,
    graphApprovalRef: input.approval.approvalRef,
    truthClass: input.activation["truthClass"] ?? null,
  };
}

export function activateInitialGraph(
  context: HandlerContext,
  input: ActivationInput,
): ServiceOutcome {
  const { ledger, request, store } = context;
  const prior = stateOf(ledger, input.goalId);
  const witness = activationWitness(input);
  const command = {
    commandId: request.commandId,
    // The witness declares which goal version the human approved against; the core's
    // `validExpectedVersion` and version check are what judge it.
    expectedVersion: input.activation["expectedGoalVersion"],
    kind: "goal.activate_initial_graph",
    witness,
  } as unknown as GoalCommand;

  const verdict = reduceGoal(
    prior === undefined || prior === null ? undefined : (prior as unknown as GoalState),
    command,
  );
  if (!verdict.ok) return refuseFromCore(request.kind, verdict.error);

  return commitAccepted(store, request, {
    aggregateId: input.goalId,
    eventPayload: {
      activation: witness,
      approval: input.approval,
      events: verdict.events,
    } as unknown as JsonValue,
    eventType: "GoalExecutionEnabled",
    expectedVersion: versionOf(ledger, input.goalId),
    result: verdict.state as unknown as JsonValue,
  });
}
