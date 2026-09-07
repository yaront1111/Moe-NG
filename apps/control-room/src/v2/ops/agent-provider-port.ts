import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";
import { payloadFor } from "../../live/live-dispatch.js";

/**
 * CHOOSING WHICH AGENT CLI STAFFS THIS PROJECT'S SEATS, from the browser.
 *
 * The daemon owns the setting: `project.set_agent_provider` is ADMIN, OPERATOR_ONLY and
 * MCP-excluded, so a person at a paired browser is the only caller that can write it. This
 * port spends the daemon's own offer for that kind and reports its answer verbatim; the
 * caller half is the roster's (`live-dispatch-payloads.ts`), so nothing here spells a
 * payload literal.
 *
 * THE OPERATOR'S CHOICE IS THE ONLY FIELD THIS MODULE SUPPLIES. `base` and the
 * project-default `goalId` sentinel stay in the payload roster where every other caller
 * half lives, and are overlaid rather than retyped, for the reason that roster's header
 * gives: a literal at a call site is a second, stale source of truth.
 */

export const AGENT_PROVIDER_COMMAND_KIND = "project.set_agent_provider" as const;
const AGENT_PROVIDER_LAYER = "CONTROL_ROOM_AGENT_PROVIDER" as const;

/**
 * A TRANSCRIPTION of the daemon's `KNOWN_PROVIDERS` (apps/daemon/src/http/health-read.ts),
 * in the daemon's order, which is load-bearing: its docblock says claude is named first so
 * a tie is decided there rather than in the browser.
 *
 * The control room cannot IMPORT apps/daemon - there is no workspace edge and a deep
 * relative import is TS6059 - so this copy exists by necessity, and it is PINNED against
 * the daemon's source text in this module's test the way live-sessions.test.ts:63-75 pins
 * the sessions frame. A third provider therefore cannot appear on one side alone.
 */
export const KNOWN_PROVIDERS = Object.freeze(["claude", "codex"] as const);
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** The daemon refuses any other value with AGENT_PROVIDER_UNKNOWN; the browser offers none. */
export function isKnownProvider(value: string): value is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

/** The board answers itself when the payload roster carries no body for this kind. */
export const AGENT_PROVIDER_PAYLOAD_ABSENT = "AGENT_PROVIDER_PAYLOAD_ABSENT";

export type AgentProviderWire = OfferWire;
export type AgentProviderOutcome = OfferOutcome;

export interface AgentProviderPort {
  submit(
    affordance: Readonly<Record<string, unknown>>, provider: KnownProvider,
  ): Promise<AgentProviderOutcome>;
}

/** `readPayload` is injectable so the fail-closed arm below is reachable without mutating
 * the frozen roster; production always reads the roster itself. */
export function createAgentProviderPort(
  wire: AgentProviderWire,
  readPayload: (kind: string) => Readonly<Record<string, unknown>> | null =
    (kind) => payloadFor(kind, null),
): AgentProviderPort {
  return Object.freeze({
    submit: async (
      affordance: Readonly<Record<string, unknown>>, provider: KnownProvider,
    ): Promise<AgentProviderOutcome> => {
      const base = readPayload(AGENT_PROVIDER_COMMAND_KIND);
      // Fail CLOSED rather than minting a payload here: the daemon's exact-arity payload
      // gate admits ["base","goalId","provider"] and nothing else, so a body assembled at
      // this call site would be the second source of truth the roster exists to prevent.
      if (base === null) {
        return { code: AGENT_PROVIDER_PAYLOAD_ABSENT, layer: AGENT_PROVIDER_LAYER, ok: false };
      }
      return spendOffer(
        wire, AGENT_PROVIDER_COMMAND_KIND, affordance, { ...base, provider },
        "ui-agent-provider", AGENT_PROVIDER_LAYER,
      );
    },
  });
}
