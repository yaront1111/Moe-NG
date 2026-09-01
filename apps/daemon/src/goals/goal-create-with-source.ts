import type { GoalBrief, JsonValue } from "@moe/contracts";
import { reduceGoal } from "@moe/core";
import type { GoalCommand, GoalState } from "@moe/core";

import {
  commitAcceptedLegs,
  refuse,
  refuseFromCore,
  stateOf,
  versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type { HandlerContext, ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import type { AdmittedDocumentSource } from "../documents/document-source-leg.js";
import { goalDocumentBindingLegs } from "./goal-document-binding.js";
import type { GoalDocumentBinding } from "./goal-document-binding.js";
import {
  briefBearingFacts,
  goalAggregateIdOf,
  projectReadinessWitness,
  refsOfGoal,
} from "./goal-identity.js";

/**
 * Goal creation that BINDS its PRD document source in the same durable decision.
 *
 * WHY THIS EXISTS AS ITS OWN SEAM: `goal-services.ts` commits through the single-leg
 * `commitAccepted`, so a goal and its document source could only ever be two separate
 * decisions — leaving no mechanism a consumer could assert "one atomic authority boundary"
 * against. This composes `commitAcceptedLegs` instead, with LEGS[0] built exactly as the
 * single-leg path builds its only leg, which is the discipline `approval-activation.ts:171-176`
 * states verbatim.
 *
 * WHY IT IS LABEL-AGNOSTIC. `HandlerContext.request` is a `BootstrapRequest` whose `kind` is a
 * `BootstrapCommandKind`, and `decodeBootstrapRequestBytes` refuses any other kind. The wire
 * kind `goal.create_with_source` is in `RUNTIME_COMMAND_KINDS` but NOT in
 * `BOOTSTRAP_COMMAND_KINDS`, so nothing can reach this seam until that roster, `PAYLOAD_KEYS`
 * and `GOAL_HANDLERS` are extended — task-0ca390d9's scope. The legs, atomicity, replay and
 * conflict properties proved here do not depend on the kind label, so the suite exercises this
 * under a `goal.create`-kinded request.
 *
 * IT READS NOTHING FROM `request.payload`. Both the brief and the source arrive ALREADY
 * ADMITTED, so `goal.create` keeps its own admission and its own payload roster untouched, and
 * no caller-supplied field can reach a binding: the goal id comes from the authenticated command
 * identity, and every binding field is recomputed by the daemon from the admitted text.
 */

/**
 * The key the GoalCreated payload element carries its binding under.
 *
 * EXPORTED AS A CONSTANT SO NO CONSUMER RE-TYPES IT. The catalog reader
 * (`http/goal-catalog-entry.ts`) validates a source-bound GoalCreated against exactly this key
 * plus the eight legacy keys and `brief`; a producer and a reader that spell it independently
 * are one typo away from a goal no reader can find.
 */
export const GOAL_CREATED_BINDING_KEY = "binding" as const;

/** The exact top-level roster of a source-bound GoalCreated payload element, sorted. */
export const SOURCE_BOUND_GOAL_CREATED_KEYS: readonly string[] = Object.freeze([
  "binding", "brief", "budgetAccountRef", "commandId", "goalId", "kind", "planningRunRef",
  "projectId", "version", "witness",
]);

function boundFacts(facts: JsonValue, binding: GoalDocumentBinding): JsonValue {
  return (facts as readonly Readonly<Record<string, JsonValue>>[]).map(
    (element) => ({ ...element, [GOAL_CREATED_BINDING_KEY]: binding }),
  ) as unknown as JsonValue;
}

export function createGoalWithSource(
  context: HandlerContext,
  brief: GoalBrief,
  source: AdmittedDocumentSource,
): ServiceOutcome {
  const { ledger, request, store } = context;
  const goalId = goalAggregateIdOf(request.commandId);
  const { budgetAccountRef, planningRunRef } = refsOfGoal(goalId);

  const witness = projectReadinessWitness(ledger, request.projectId);
  if (witness === null) {
    return refuse(request.kind, "GOAL_CREATE_PROJECT_NOT_READY", "DAEMON_PREREQUISITE");
  }

  const prior = stateOf(ledger, goalId);
  // The CORE's create vocabulary is the core's, not the wire's: `@moe/core` is untouched by this
  // seam, so the reducer command keeps `kind: "goal.create"` literally, exactly as
  // `goal-services.ts` builds it. The wire kind lives only on the request, and therefore only on
  // the decision trace.
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

  const bound = goalDocumentBindingLegs(store, request.projectId, goalId, source);
  if ("refusal" in bound) return bound.refusal;

  return commitAcceptedLegs(store, request, {
    aggregateId: goalId,
    eventPayload: boundFacts(briefBearingFacts(verdict.events, brief), bound.binding),
    eventType: "GoalCreated",
    expectedVersion: versionOf(ledger, goalId),
    result: verdict.state as unknown as JsonValue,
  }, bound.legs);
}
