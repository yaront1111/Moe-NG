import { admitGoalBrief } from "@moe/contracts";
import type { JsonValue } from "@moe/contracts";
import { reduceGoal } from "@moe/core";
import type { GoalCommand, GoalState } from "@moe/core";

import {
  commitAccepted,
  commitAcceptedLegs,
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
import { prepareGoalPrd } from "./goal-document-binding.js";
import {
  goalPlanningRunBindingLeg,
  readGoalPlanningRunBinding,
} from "./goal-planning-run-binding.js";

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
  const declaredWitness = payloadObject(request.payload, "witness");
  if (goalId === null || budgetAccountRef === null || planningRunRef === null
    || declaredWitness === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }

  const brief = admitGoalBrief(request.payload["brief"]);
  if (!brief.ok) return refuse(request.kind, brief.code, "DAEMON_INGRESS");
  const prd = prepareGoalPrd(request.projectId, goalId, request.payload["prd"]);
  if (!prd.ok) return refuse(request.kind, prd.code, "DAEMON_INGRESS");

  // A planning run is one goal's lifecycle authority. The precheck gives a
  // stable domain refusal from the independently addressed suffix aggregate,
  // including when the primary-only decision projection is stale. The shared
  // binding leg below remains the concurrency fence when both reads see absence.
  const durableBinding = readGoalPlanningRunBinding(store, request.projectId, planningRunRef);
  if (durableBinding.kind === "UNREADABLE") {
    return refuse(
      request.kind, "GOAL_PLANNING_RUN_BINDING_UNREADABLE", "DAEMON_PREREQUISITE",
    );
  }
  if (durableBinding.kind === "BOUND" && durableBinding.goalId !== goalId) {
    return refuse(
      request.kind, "GOAL_PLANNING_RUN_ALREADY_BOUND", "DAEMON_PREREQUISITE",
    );
  }

  // Retain the projection check for durable history predating the binding leg.
  for (const [aggregateId, aggregate] of ledger.aggregates) {
    const value = aggregate.result;
    if (aggregateId === goalId || value === null || typeof value !== "object"
      || Array.isArray(value)) continue;
    const candidate = value as Readonly<Record<string, JsonValue>>;
    if (candidate["goalId"] === aggregateId
      && candidate["projectId"] === request.projectId
      && candidate["planningRunRef"] === planningRunRef) {
      return refuse(
        request.kind, "GOAL_PLANNING_RUN_ALREADY_BOUND", "DAEMON_PREREQUISITE",
      );
    }
  }

  const project = stateOf(ledger, request.projectId);
  if (project === null || project === undefined || typeof project !== "object"
    || Array.isArray(project)) {
    return refuse(request.kind, "GOAL_PROJECT_NOT_READY", "DAEMON_PREREQUISITE");
  }
  const projectRecord = project as Readonly<Record<string, JsonValue>>;
  const projectVersion = projectRecord["version"];
  if (projectRecord["projectId"] !== request.projectId
    || projectRecord["lifecycle"] !== "READY"
    || typeof projectVersion !== "number" || !Number.isSafeInteger(projectVersion)
    || projectVersion < 1) {
    return refuse(request.kind, "GOAL_PROJECT_NOT_READY", "DAEMON_PREREQUISITE");
  }
  const witness = Object.freeze({
    projectReadyRef: `${request.projectId}@${String(projectVersion)}`,
    truthClass: "DAEMON_VERIFIED" as const,
  });

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

  const eventPayload = verdict.events.map((event) => event.kind === "GoalCreated"
    ? Object.freeze({ ...event, brief: brief.brief, prd: prd.binding, witness })
    : event) as unknown as JsonValue;
  const plan = {
    aggregateId: goalId,
    eventPayload,
    eventType: "GoalCreated",
    expectedVersion: versionOf(ledger, goalId),
    result: verdict.state as unknown as JsonValue,
  };
  const bindingLeg = goalPlanningRunBindingLeg(request.projectId, goalId, planningRunRef);
  return commitAcceptedLegs(
    store, request, plan, prd.leg === null ? [bindingLeg] : [bindingLeg, prd.leg],
  );
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
