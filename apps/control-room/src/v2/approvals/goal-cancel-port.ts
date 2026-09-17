import { spendOffer } from "./offer-wire.js";
import type { OfferOutcome, OfferWire } from "./offer-wire.js";

/**
 * ABANDONING A GOAL: the owner's decision to stop a product that will not be finished, spent from
 * the daemon's own `goal.cancel` offer. Unlike `goal.close`, cancel carries NO witnesses on the
 * wire — the daemon derives the cancellation authority from the operator's authenticated command
 * (goal-services.ts, `cancelGoal`) — so the browser sends the smallest honest payload: the goal
 * id alone. The surface offers cancel on any enabled or closing goal, verified criteria or not,
 * because a dead product is exactly the one whose criteria will never verify.
 */

export const GOAL_CANCEL_COMMAND_KIND = "goal.cancel" as const;
const GOAL_CANCEL_LAYER = "CONTROL_ROOM_GOAL_CANCEL" as const;

export type GoalCancelOutcome = OfferOutcome;

export interface GoalCancelPort {
  submit(affordance: Readonly<Record<string, unknown>>, goalId: string): Promise<GoalCancelOutcome>;
}

export function createGoalCancelPort(wire: OfferWire): GoalCancelPort {
  return Object.freeze({
    submit: (affordance: Readonly<Record<string, unknown>>, goalId: string): Promise<GoalCancelOutcome> =>
      spendOffer(wire, GOAL_CANCEL_COMMAND_KIND, affordance, { goalId }, "ui-cancel", GOAL_CANCEL_LAYER),
  });
}
