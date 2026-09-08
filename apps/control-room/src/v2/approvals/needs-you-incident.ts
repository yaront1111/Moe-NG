import type {
  DeploymentsHealthOutcome, EnvironmentErrorLineView, EnvironmentHealthState,
  EnvironmentRollbackTargetView,
} from "../../live/live-deployments-health.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { NeedsYouItem } from "./needs-you-model.js";

/**
 * THE INCIDENT ITEMS: a deployment environment the daemon says is in an OPEN INCIDENT, listed
 * in the queue an operator already watches. It sits beside `needs-you-escalation.ts` and the
 * other per-kind modules, and its `NeedsYouItem` import is TYPE-ONLY, so there is no runtime
 * cycle with the model that calls it.
 *
 * AN INCIDENT DOES NOT ROUTE TO A GOAL, and that is handled deliberately rather than by
 * accident. An outage belongs to an ENVIRONMENT: there is no goal to open, no plan to read and
 * no run to name. So `goalId` and `planningRunRef` are BOTH the empty string - no id at all,
 * never an environment id wearing a goal's field name. That is not an invention here:
 * `needs-you-escalation.ts:39` already writes `goalId: goal?.goalId ?? ""` for an item whose
 * goal is unknown, so the empty string already means "no goal" in this family. The environment
 * travels in the discriminated `incident` member instead, where a consumer must ask for it by
 * name. The model's comparator (`left.goalId.localeCompare(right.goalId)`) keeps a total order
 * because "" is still a string, and `needs-you.tsx` already suppresses the open-the-goal button
 * for an item whose `planningRunRef` is empty, so no card offers to open a goal that is not there.
 *
 * THE DAEMON OPENS AND CLOSES THE INCIDENT, NOT THIS MODULE. The probe row keeps exactly one
 * open incident per outage, closes it on recovery and opens a NEW one - with a NEW id - at the
 * next failure threshold. So there is no re-raise rule here to get wrong: an item exists exactly
 * while `health.incident` is non-null.
 *
 * DISMISS IS SCOPED TO THE INCIDENT, NOT THE ENVIRONMENT, and that is what makes a dismiss
 * something other than a resolve. The key is `<environment>#<incidentId>`, so dismissing
 * incident 1 says "I have seen THIS outage" and cannot silence incident 2. It also touches
 * nothing the Environments surface reads: that surface renders `state` off its own health read,
 * so a dismissed environment still reads DOWN there. Muting the environment instead would have
 * made the second outage invisible, which is precisely the bug this shape exists to refuse.
 *
 * THE ROLLBACK CONTROL IS THE DAEMON'S OFFER OR IT DOES NOT EXIST. `deployment.rollback` is
 * minted AT MOST ONCE PER PROJECT (`affordance-rollback-offers.ts`: the handler fences the
 * PROJECT aggregate, so N per-environment offers would be N identical tuples), which is why it
 * is matched by kind alone. The PER-ENVIRONMENT authority is `rollbackTarget` on this
 * environment's own health frame, and BOTH must hold: an offer with no target for this
 * environment is a button that could only refuse, and a target with no offer would have to be
 * dispatched from a command envelope the browser minted itself.
 */

const ROLLBACK_COMMAND_KIND = "deployment.rollback";

/** The daemon's offer and THIS environment's receipt-bound target, or the control does not exist. */
export interface IncidentRollbackFacts {
  /** The `deployment.rollback` offer, spent verbatim by `rollback-port.ts`. */
  readonly affordance: Readonly<Record<string, unknown>>;
  /** `toReceiptRef` is the spendable authority; `sha` is what the confirm must name. */
  readonly target: EnvironmentRollbackTargetView;
}

export interface IncidentFacts {
  readonly environment: string;
  readonly incidentId: number;
  /** The deploy tool's own last line, carried VERBATIM. Null when the daemon recorded none. */
  readonly lastError: EnvironmentErrorLineView | null;
  /** When THIS INCIDENT opened - not when the environment was last probed. */
  readonly openedAt: string;
  readonly rollback: IncidentRollbackFacts | null;
  readonly state: EnvironmentHealthState;
}

/** The key one incident's dismissal and one incident's decision result are both kept under. */
export function incidentKeyOf(environment: string, incidentId: number): string {
  return `${environment}#${String(incidentId)}`;
}

function rollbackFor(
  surface: SurfaceFrame | null, target: EnvironmentRollbackTargetView | null,
): IncidentRollbackFacts | null {
  if (target === null || surface === null || surface.outcome !== "SURFACE") return null;
  const affordance = surface.offers.find((offer) => offer["commandKind"] === ROLLBACK_COMMAND_KIND);
  return affordance === undefined ? null : Object.freeze({ affordance, target });
}

export interface IncidentItemsInput {
  /** Keys of incidents the operator has dismissed, from `incidentKeyOf`. */
  readonly dismissed: ReadonlySet<string> | undefined;
  /** One health read per environment, keyed by environment name. */
  readonly health: ReadonlyMap<string, DeploymentsHealthOutcome> | undefined;
  readonly surface: SurfaceFrame | null;
}

/**
 * One item per environment the daemon holds an OPEN INCIDENT for. A refused or still-reading
 * health outcome yields NO item: an incident this browser cannot read is not an incident it may
 * announce, and the Environments surface already renders that refusal at its own code and layer.
 */
export function incidentItems(input: IncidentItemsInput): NeedsYouItem[] {
  const { dismissed, health, surface } = input;
  if (health === undefined) return [];
  const items: NeedsYouItem[] = [];
  for (const outcome of health.values()) {
    if (outcome.status !== "DEPLOYMENTS_HEALTH" || outcome.incident === null) continue;
    const { environment, incident, lastError, rollbackTarget, state } = outcome;
    if (dismissed?.has(incidentKeyOf(environment, incident.id)) === true) continue;
    items.push(Object.freeze({
      actionLabel: "Open the goal",
      detail: "Roll back to the last good deploy, or open the environment to read the probes."
        + " Dismissing this card leaves the environment where it is.",
      goalId: "",
      headline: `${environment} unhealthy since ${incident.openedAt}`,
      incident: Object.freeze({
        environment, incidentId: incident.id, lastError, openedAt: incident.openedAt,
        rollback: rollbackFor(surface, rollbackTarget), state,
      }),
      kind: "INCIDENT",
      planningRunRef: "",
      title: environment,
    }));
  }
  return items;
}
