import type { JsonValue } from "@moe/contracts";
import { reduceGoal } from "@moe/core";
import type { GoalCommand, GoalState } from "@moe/core";

import {
  commitAccepted,
  payloadObject,
  payloadRef,
  refuse,
  refuseFromCore,
  stateOf,
  versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type { CommandHandler, HandlerTable, ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";

/**
 * Goal creation.
 *
 * The ingress gate, the replay lookup and the durable-sequence check are not restated here —
 * they belong to `runBootstrapCommand`, and a second copy of the ingress rule would be a second
 * thing to drift. This module contributes one handler and nothing else.
 *
 * A goal against a project that is not durably ACTIVE never reaches the reducer: `goal.create`
 * declares `project.activate` as its prerequisite, so the daemon's sequence gate refuses first
 * and commits nothing.
 */

const createGoal: CommandHandler = (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  const goalId = payloadRef(request.payload, "goalId");
  const budgetAccountRef = payloadRef(request.payload, "budgetAccountRef");
  const planningRunRef = payloadRef(request.payload, "planningRunRef");
  const witness = payloadObject(request.payload, "witness");
  if (goalId === null || budgetAccountRef === null || planningRunRef === null
    || witness === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }

  const prior = stateOf(ledger, goalId);
  const command = {
    budgetAccountRef,
    commandId: request.commandId,
    expectedVersion: request.expectedVersion,
    goalId,
    kind: "goal.create",
    planningRunRef,
    projectId: request.projectId,
    witness,
  } as unknown as GoalCommand;

  const verdict = reduceGoal(
    prior === undefined || prior === null ? undefined : (prior as unknown as GoalState),
    command,
  );
  if (!verdict.ok) return refuseFromCore(request.kind, verdict.error);

  return commitAccepted(store, request, {
    aggregateId: goalId,
    eventPayload: verdict.events as unknown as JsonValue,
    eventType: "GoalCreated",
    expectedVersion: versionOf(ledger, goalId),
    result: verdict.state as unknown as JsonValue,
  });
};

/**
 * Final acceptance — J1's third human action (design 1095): the human accepts the verified,
 * reviewed result and the goal reaches its accepted terminal state.
 *
 * Acceptance is evidence-bound BY CONSTRUCTION. BOTH witnesses are required here, not because
 * the daemon judges evidence — `validClosure` and `validZeroAuthority` own that — but because
 * the core's `close` moves a goal carrying only the closure witness to CLOSING, and a goal
 * parked mid-closure would need a fourth human action to leave. Requiring the pair is what
 * makes acceptance ONE action; the core is still the layer that decides whether either witness
 * actually holds, and its reason code is surfaced unchanged.
 */
const closeGoal: CommandHandler = (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  const goalId = payloadRef(request.payload, "goalId");
  const closureWitness = payloadObject(request.payload, "closureWitness");
  const zeroAuthorityWitness = payloadObject(request.payload, "zeroAuthorityWitness");
  if (goalId === null || closureWitness === null || zeroAuthorityWitness === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }

  const prior = stateOf(ledger, goalId);
  const command = {
    closureWitness,
    commandId: request.commandId,
    expectedVersion: request.expectedVersion,
    kind: "goal.close",
    zeroAuthorityWitness,
  } as unknown as GoalCommand;

  const verdict = reduceGoal(
    prior === undefined || prior === null ? undefined : (prior as unknown as GoalState),
    command,
  );
  if (!verdict.ok) return refuseFromCore(request.kind, verdict.error);

  return commitAccepted(store, request, {
    aggregateId: goalId,
    eventPayload: verdict.events as unknown as JsonValue,
    eventType: "GoalCompleted",
    expectedVersion: versionOf(ledger, goalId),
    result: verdict.state as unknown as JsonValue,
  });
};

/** Appended, never reordered: existing suites assert against this table's key order. */
export const GOAL_HANDLERS: HandlerTable = Object.freeze({
  "goal.create": createGoal,
  "goal.close": closeGoal,
});
