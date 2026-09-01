import type { GoalBrief, JsonValue } from "@moe/contracts";

import { stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";

/**
 * Goal identity, derived once and shared.
 *
 * WHY THIS IS A LEAF RATHER THAN AN EXPORT ON `goal-services.ts`: the with-source create seam
 * needs the same derivation, and `goal-services.ts` will import that seam to reach it from
 * `GOAL_HANDLERS`. A seam importing `goal-services.ts` back for the derivation would close an
 * import cycle. A leaf both files import has none.
 *
 * RE-DERIVING ANY OF THESE AT A SECOND SITE IS THE FAILURE THIS MODULE EXISTS TO PREVENT: two
 * derivations that agree today drift tomorrow, and a drifted goal id binds a goal to an
 * aggregate no other reader can find.
 */

export const GOAL_AGGREGATE_PREFIX = "goal-";

/**
 * The goal a create command mints, derived from the AUTHENTICATED COMMAND IDENTITY and never
 * from the payload. A caller cannot reach an existing goal through it: the same identity under
 * the same principal and project is answered by the replay lookup before the handler runs, and
 * a colliding id from another principal finds prior state and is refused by the reducer.
 */
export function goalAggregateIdOf(commandId: string): string {
  return `${GOAL_AGGREGATE_PREFIX}${commandId}`;
}

/**
 * The planning run and budget account this goal owns, each a function of the TARGET GOAL, so a
 * goal can neither be pointed at another goal's run nor share a budget account with one.
 */
export function refsOfGoal(goalId: string): { budgetAccountRef: string; planningRunRef: string } {
  const subject = goalId.slice(GOAL_AGGREGATE_PREFIX.length);
  return {
    budgetAccountRef: `budget-account-${subject}`,
    planningRunRef: `run-${subject}`,
  };
}

/**
 * The reducer's own GoalCreated fact, carrying the brief this daemon normalized. The create
 * verdict emits exactly one event, and the catalog reader refuses any GoalCreated payload whose
 * array length is not 1, so a reducer that ever emitted a second event would be refused at the
 * read rather than silently stamped.
 */
export function briefBearingFacts(events: readonly unknown[], brief: GoalBrief): JsonValue {
  return events.map(
    (event) => ({ ...(event as Readonly<Record<string, JsonValue>>), brief }),
  ) as unknown as JsonValue;
}

export interface ProjectReadinessWitness {
  readonly projectReadyRef: string;
  readonly truthClass: "DAEMON_VERIFIED";
}

/**
 * Project readiness read from this request's own durable project aggregate after the sequence
 * gate has observed `project.activate`. Requiring the current lifecycle to remain READY also
 * prevents an old activation kind from authorizing new work while the project is quiesced for
 * recovery.
 *
 * RETURNS NULL, NEVER A REFUSAL. Each caller owns its own
 * `refuse(request.kind, "GOAL_CREATE_PROJECT_NOT_READY", "DAEMON_PREREQUISITE")` so the refusal
 * carries the caller's own command kind rather than a kind this leaf would have to guess.
 */
export function projectReadinessWitness(
  ledger: DurableLedger,
  projectId: string,
): ProjectReadinessWitness | null {
  const project = stateOf(ledger, projectId);
  if (project === null || typeof project !== "object" || Array.isArray(project)) return null;
  const projectRecord = project as Readonly<Record<string, unknown>>;
  const projectVersion = projectRecord["version"];
  if (projectRecord["projectId"] !== projectId
    || projectRecord["lifecycle"] !== "READY"
    || !Number.isSafeInteger(projectVersion) || (projectVersion as number) < 3) {
    return null;
  }
  return Object.freeze({
    projectReadyRef: `${projectId}@${String(projectVersion)}`,
    truthClass: "DAEMON_VERIFIED" as const,
  });
}
