import { spendOffer } from "./offer-wire.js";
import type { OfferOutcome, OfferWire } from "./offer-wire.js";

/**
 * ESCALATION: the daemon's own wire for the one decision that unblocks a node whose review
 * is exhausted. The surface offers `escalation.decide` for exactly such a node (three
 * unsuccessful rounds, no decision yet), and this port spends that offer verbatim: the
 * affordance is the daemon's, the target and expected version are the daemon's, and the
 * browser adds only the two payload fields the kind admits. The `escalationRef` names the
 * decision durably from the node and the ledger version it was taken at, so a repeated
 * click after a version move is a fresh decision, never a replay.
 */

export const ESCALATION_COMMAND_KIND = "escalation.decide" as const;
const ESCALATION_LAYER = "CONTROL_ROOM_ESCALATION" as const;

export type EscalationWire = OfferWire;
export type EscalationOutcome = OfferOutcome;

export interface EscalationPort {
  submit(affordance: Readonly<Record<string, unknown>>, nodeKey: string): Promise<EscalationOutcome>;
}

export function createEscalationPort(wire: EscalationWire): EscalationPort {
  return Object.freeze({
    submit: (affordance: Readonly<Record<string, unknown>>, nodeKey: string): Promise<EscalationOutcome> => {
      const version = affordance["expectedVersion"];
      const payload = {
        escalationRef: `ui-escalation-${nodeKey}-v${typeof version === "number" ? String(version) : "unknown"}`,
        subjectRef: nodeKey,
      };
      return spendOffer(wire, ESCALATION_COMMAND_KIND, affordance, payload, "ui-escalate", ESCALATION_LAYER);
    },
  });
}
