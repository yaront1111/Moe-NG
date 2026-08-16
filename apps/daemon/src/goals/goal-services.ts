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
import { GOAL_PREREQUISITE_LAYER } from "./goal-close-prerequisite.js";
import { qualifyGoalClosure } from "./goal-qualification.js";

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
 * BOTH WITNESSES ARE DERIVED, NEVER FORWARDED. `qualifyGoalClosure` reads the exact durable
 * verification receipt, review acceptance, verifier receipt and activation ledger for every
 * approved node and hashes THOSE into the two witnesses the core validates. The request's own
 * `closureWitness` and `zeroAuthorityWitness` are still REQUIRED at ingress — the command
 * registry lists both keys and wire compatibility is not this slice's to change — but their
 * VALUES are inert: they reach neither `reduceGoal` nor any decision here. Proved in both
 * directions by `goal-services.test.ts`: garbage refs still close when the durable records
 * hold, and perfect refs still refuse when they do not.
 *
 * The pair is required because the core's `close` moves a goal carrying only the closure
 * witness to CLOSING, and a goal parked mid-closure would need a fourth human action to leave.
 */
const closeGoal: CommandHandler = (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  const goalId = payloadRef(request.payload, "goalId");
  const declaredClosure = payloadObject(request.payload, "closureWitness");
  const declaredZeroAuthority = payloadObject(request.payload, "zeroAuthorityWitness");
  if (goalId === null || declaredClosure === null || declaredZeroAuthority === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const qualified = qualifyGoalClosure(store, request.projectId, goalId);
  if (!qualified.ok) {
    return refuse(request.kind, qualified.code, GOAL_PREREQUISITE_LAYER);
  }

  const prior = stateOf(ledger, goalId);
  const command = {
    closureWitness: qualified.closureWitness,
    commandId: request.commandId,
    expectedVersion: request.expectedVersion,
    kind: "goal.close",
    zeroAuthorityWitness: qualified.zeroAuthorityWitness,
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
