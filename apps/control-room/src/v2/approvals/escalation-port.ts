import { spendOffer } from "./offer-wire.js";
import type { OfferOutcome, OfferWire } from "./offer-wire.js";

/**
 * ESCALATION: the daemon's own wire for the one decision that unblocks a node whose review
 * is exhausted. The surface offers `escalation.decide` for exactly such a node (three
 * unsuccessful rounds, no decision yet), and this port spends that offer verbatim: the
 * affordance is the daemon's, the target and expected version are the daemon's, and the
 * browser adds the decision fields and optional supported guidance. The `escalationRef` names the
 * decision durably from the node and the ledger version it was taken at, so a repeated
 * click after a version move is a fresh decision, never a replay.
 */

export const ESCALATION_COMMAND_KIND = "escalation.decide" as const;
const ESCALATION_LAYER = "CONTROL_ROOM_ESCALATION" as const;
export const ESCALATION_GUIDANCE_SCHEMA_VERSION = "moe-review-escalation-guidance/1" as const;
export const ESCALATION_GUIDANCE_MAX_LENGTH = 4000;

export function supportsEscalationGuidance(affordance: Readonly<Record<string, unknown>>): boolean {
  return affordance["commandKind"] === ESCALATION_COMMAND_KIND
    && affordance["inputSchemaVersion"] === ESCALATION_GUIDANCE_SCHEMA_VERSION;
}

export function validEscalationGuidance(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= ESCALATION_GUIDANCE_MAX_LENGTH && value.isWellFormed()
    && new TextEncoder().encode(value).byteLength <= 16_000;
}

export type EscalationWire = OfferWire;
export type EscalationOutcome = OfferOutcome;

/** The human's two answers to an exhausted review; the daemon refuses any other word. */
export type EscalationDecision = "ALLOW_MORE_ATTEMPTS" | "REPLAN";

export interface EscalationPort {
  submit(
    affordance: Readonly<Record<string, unknown>>, nodeKey: string, decision: EscalationDecision,
    implementationGuidance?: string,
  ): Promise<EscalationOutcome>;
}

export function createEscalationPort(wire: EscalationWire): EscalationPort {
  return Object.freeze({
    submit: async (
      affordance: Readonly<Record<string, unknown>>, _nodeKey: string, decision: EscalationDecision,
      implementationGuidance?: string,
    ): Promise<EscalationOutcome> => {
      if (implementationGuidance !== undefined) {
        if (decision !== "ALLOW_MORE_ATTEMPTS" || !validEscalationGuidance(implementationGuidance)) {
          return { code: "ESCALATION_GUIDANCE_INVALID", layer: ESCALATION_LAYER, ok: false };
        }
        if (!supportsEscalationGuidance(affordance)) {
          return { code: "ESCALATION_GUIDANCE_UNSUPPORTED", layer: ESCALATION_LAYER, ok: false };
        }
      }
      const version = affordance["expectedVersion"];
      const subjectRef = affordance["targetAggregateId"];
      const payload = {
        decision,
        escalationRef: `ui-escalation-${String(subjectRef)}-v${typeof version === "number" ? String(version) : "unknown"}`,
        subjectRef,
        ...(implementationGuidance === undefined ? {} : { implementationGuidance }),
      };
      return spendOffer(wire, ESCALATION_COMMAND_KIND, affordance, payload, "ui-escalate", ESCALATION_LAYER);
    },
  });
}
