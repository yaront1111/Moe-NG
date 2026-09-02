import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type {
  CommandAffordance, ControlRoomClientSurface, ControlRoomTransport,
} from "@moe/control-room-client";

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
const BUILD_LAYER = "CONTROL_ROOM_COMMAND_BUILD";
const TRANSPORT_LAYER = "CONTROL_ROOM_TRANSPORT";

export interface EscalationWire {
  readonly client: Pick<ControlRoomClientSurface, "commands">;
  readonly sessionCredential: string;
  readonly transport: Pick<ControlRoomTransport, "sendCommand">;
}

export type EscalationOutcome =
  | { readonly commandId: string; readonly ok: true }
  | { readonly code: string; readonly layer: string; readonly ok: false };

export interface EscalationPort {
  submit(affordance: Readonly<Record<string, unknown>>, nodeKey: string): Promise<EscalationOutcome>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusalOf(value: unknown): EscalationOutcome | null {
  if (!isRecord(value)) return null;
  const code = value["code"];
  if (typeof code !== "string" || code === "") return null;
  const layer = value["layer"];
  return Object.freeze({ code, layer: typeof layer === "string" && layer !== "" ? layer : "DAEMON", ok: false as const });
}

function answerOf(response: unknown, commandId: string): EscalationOutcome {
  if (!isRecord(response)) return { code: "ESCALATION_ANSWER_UNREADABLE", layer: ESCALATION_LAYER, ok: false };
  if (response["ok"] === true) return { commandId, ok: true };
  return refusalOf(response["refusal"]) ?? refusalOf(response["error"])
    ?? { code: "ESCALATION_REFUSED", layer: "DAEMON", ok: false };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createEscalationPort(wire: EscalationWire): EscalationPort {
  return Object.freeze({
    submit: async (affordance: Readonly<Record<string, unknown>>, nodeKey: string): Promise<EscalationOutcome> => {
      const version = affordance["expectedVersion"];
      const payload = {
        escalationRef: `ui-escalation-${nodeKey}-v${typeof version === "number" ? String(version) : "unknown"}`,
        subjectRef: nodeKey,
      };
      const requestDigest = await sha256Hex(JSON.stringify(payload));
      const built = wire.client.commands[ESCALATION_COMMAND_KIND](
        affordance as unknown as CommandAffordance<typeof ESCALATION_COMMAND_KIND>,
        {
          correlationId: `ui-escalate-${requestDigest.slice(0, 16)}`,
          payload,
          requestDigest,
          sessionCredential: wire.sessionCredential,
        },
      );
      if (!built.ok) return { code: built.error.code, layer: BUILD_LAYER, ok: false };
      const envelope = built.envelope as RuntimeCommandEnvelope;
      const sent = await wire.transport.sendCommand(envelope);
      if (!sent.delivered) return { code: sent.code, layer: TRANSPORT_LAYER, ok: false };
      return answerOf(sent.response, envelope.commandId);
    },
  });
}
