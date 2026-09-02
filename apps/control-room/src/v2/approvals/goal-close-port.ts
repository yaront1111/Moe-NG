import { spendOffer } from "./offer-wire.js";
import type { OfferOutcome, OfferWire } from "./offer-wire.js";

/**
 * CLOSING A GOAL: the third human action of the journey, spent from the daemon's own
 * `goal.close` offer. The surface offers it only for an enabled goal whose run is in review,
 * and the daemon DERIVES both closure witnesses from its durable records (verification
 * receipts, review acceptances, activation ledger) when it handles the command: the two
 * witness objects the wire requires at ingress are inert placeholders whose values reach no
 * decision (goal-services.ts, `closeGoal`). The browser therefore sends the smallest honest
 * objects: who declared them, and nothing that claims a proof it does not hold. A goal whose
 * records do not qualify is refused at the daemon's own code, and the card shows that code.
 */

export const GOAL_CLOSE_COMMAND_KIND = "goal.close" as const;
const GOAL_CLOSE_LAYER = "CONTROL_ROOM_GOAL_CLOSE" as const;

export type GoalCloseOutcome = OfferOutcome;

export interface GoalClosePort {
  submit(affordance: Readonly<Record<string, unknown>>, goalId: string): Promise<GoalCloseOutcome>;
}

export function createGoalClosePort(wire: OfferWire): GoalClosePort {
  return Object.freeze({
    submit: (affordance: Readonly<Record<string, unknown>>, goalId: string): Promise<GoalCloseOutcome> => {
      const payload = {
        closureWitness: { declaredBy: "CONTROL_ROOM", truthClass: "HUMAN_APPROVED" },
        goalId,
        zeroAuthorityWitness: { declaredBy: "CONTROL_ROOM" },
      };
      return spendOffer(wire, GOAL_CLOSE_COMMAND_KIND, affordance, payload, "ui-close", GOAL_CLOSE_LAYER);
    },
  });
}
