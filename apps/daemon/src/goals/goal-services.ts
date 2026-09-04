import { admitGoalBrief } from "@moe/contracts";
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
import { admitDocumentSource } from "../documents/document-source-leg.js";
import {
  GOAL_CLOSE_CRITERIA_UNVERIFIED, GOAL_PREREQUISITE_LAYER,
} from "./goal-close-prerequisite.js";
import { goalCloseReadinessFor } from "./goal-close-readiness.js";
import { createGoalWithSource } from "./goal-create-with-source.js";
import {
  briefBearingFacts,
  goalAggregateIdOf,
  projectReadinessWitness,
  refsOfGoal,
} from "./goal-identity.js";
import { qualifyGoalClosure } from "./goal-qualification.js";
import { publishRepository } from "../repository/publish-services.js";

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
  // The command's entire admitted surface. `admitGoalBrief` owns normalization and the bounds,
  // and its exact-key check is what refuses a payload naming anything else even on a seam that
  // did not already refuse it structurally at PAYLOAD_SHAPE.
  const admitted = admitGoalBrief(request.payload);
  if (!admitted.ok) return refuse(request.kind, admitted.code, "DAEMON_INGRESS");
  const goalId = goalAggregateIdOf(request.commandId);
  const { budgetAccountRef, planningRunRef } = refsOfGoal(goalId);

  // Project readiness comes from this request's own durable project
  // aggregate after the sequence gate has observed project.activate. Requiring the
  // current lifecycle to remain READY also prevents an old activation kind from
  // authorizing new work while the project is quiesced for recovery.
  const witness = projectReadinessWitness(ledger, request.projectId);
  if (witness === null) {
    return refuse(request.kind, "GOAL_CREATE_PROJECT_NOT_READY", "DAEMON_PREREQUISITE");
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
    eventPayload: briefBearingFacts(verdict.events, admitted.brief),
    eventType: "GoalCreated",
    expectedVersion: versionOf(ledger, goalId),
    result: verdict.state as unknown as JsonValue,
  });
};

const GOAL_CREATE_SOURCE_KEYS = Object.freeze([
  "displayPath", "mediaType", "text",
] as const);
const GOAL_CREATE_SOURCE_KEYS_INVALID = "GOAL_CREATE_SOURCE_KEYS_INVALID" as const;
const GOAL_CREATE_SOURCE_LAYER_INVALID = "GOAL_CREATE_SOURCE_LAYER_INVALID" as const;

function hasNoUnboundSourceKeys(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string"
      && GOAL_CREATE_SOURCE_KEYS.some((admitted) => admitted === key),
  );
}

const createGoalWithSourceHandler: CommandHandler = (context): ServiceOutcome => {
  const { request } = context;
  const admittedBrief = admitGoalBrief({
    instructions: request.payload["instructions"],
    title: request.payload["title"],
  });
  if (!admittedBrief.ok) {
    return refuse(request.kind, admittedBrief.code, "DAEMON_INGRESS");
  }

  const source = request.payload["source"];
  if (!hasNoUnboundSourceKeys(source)) {
    return refuse(request.kind, GOAL_CREATE_SOURCE_KEYS_INVALID, "DAEMON_INGRESS");
  }
  const admittedSource = admitDocumentSource(source);
  if ("refusal" in admittedSource) {
    // This admission owns DAEMON_INGRESS; preserve its exact code and layer at the bootstrap edge.
    if (admittedSource.refusal.layer !== "DAEMON_INGRESS") {
      return refuse(request.kind, GOAL_CREATE_SOURCE_LAYER_INVALID, "DAEMON_INGRESS");
    }
    return refuse(request.kind, admittedSource.refusal.code, admittedSource.refusal.layer);
  }
  return createGoalWithSource(context, admittedBrief.brief, admittedSource.value);
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

  // THE GOAL-LEVEL GATE, and it runs BEFORE qualification for two reasons: it is the cheaper
  // read, and a goal whose product is not built must never mint closure witnesses on the way to
  // being refused. FAIL CLOSED BY DEFAULT — only a goal with no approved Product Contract, or
  // one whose every approved criterion the coverage read calls VERIFIED, proceeds. NOT_READY
  // and an UNREADABLE coverage both refuse here, and a kind added to the union later refuses
  // until someone decides it should not. The counts behind the refusal are not restated on the
  // wire: `ServiceRefused` carries only code, layer and a RuntimeError whose code must be one
  // the `@moe/contracts` registry knows, so an unregistered one would surface as UNKNOWN_ERROR
  // with its details stripped — strictly worse than the code itself. The numbers live on
  // `goalCloseReadinessFor`, which is what the coverage screen and the offer ladder read.
  const readiness = goalCloseReadinessFor(store, request.projectId, goalId);
  if (readiness.kind !== "NO_CONTRACT" && readiness.kind !== "READY") {
    return refuse(request.kind, GOAL_CLOSE_CRITERIA_UNVERIFIED, GOAL_PREREQUISITE_LAYER);
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

/** Lifecycles whose goal may be published: the graph was activated, so work may be landed. */
/** Appended, never reordered: existing suites assert against this table's key order. */
export const GOAL_HANDLERS: HandlerTable = Object.freeze({
  "goal.create": createGoal,
  "goal.close": closeGoal,
  "goal.create_with_source": createGoalWithSourceHandler,
  "repository.publish": publishRepository,
});
