import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type { ControlRoomClientSurface, ControlRoomTransport } from "@moe/control-room-client";

/**
 * SPENDING A DAEMON OFFER: the one way a Needs-you card acts. The affordance is the daemon's
 * (kind, target, expected version, schema), the browser supplies only the payload fields
 * the kind admits, and the answer comes back at the refusing authority's OWN code and
 * layer, never summarised. Shared by every inline decision so a new decision is one payload
 * and one prefix, not a second copy of the wire.
 */

const BUILD_LAYER = "CONTROL_ROOM_COMMAND_BUILD";
const TRANSPORT_LAYER = "CONTROL_ROOM_TRANSPORT";

export interface OfferWire {
  readonly client: Pick<ControlRoomClientSurface, "commands">;
  readonly sessionCredential: string;
  readonly transport: Pick<ControlRoomTransport, "sendCommand">;
}

export type OfferOutcome =
  | { readonly commandId: string; readonly ok: true }
  | { readonly code: string; readonly layer: string; readonly ok: false };

type BuildResult =
  | { readonly envelope: unknown; readonly ok: true }
  | { readonly error: { readonly code: string }; readonly ok: false };
type Builder = (
  affordance: unknown,
  input: {
    readonly correlationId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly requestDigest: string;
    readonly sessionCredential: string;
  },
) => BuildResult;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusalOf(value: unknown): OfferOutcome | null {
  if (!isRecord(value)) return null;
  const code = value["code"];
  if (typeof code !== "string" || code === "") return null;
  const layer = value["layer"];
  return Object.freeze({ code, layer: typeof layer === "string" && layer !== "" ? layer : "DAEMON", ok: false as const });
}

function answerOf(response: unknown, commandId: string, layer: string): OfferOutcome {
  if (!isRecord(response)) return { code: "OFFER_ANSWER_UNREADABLE", layer, ok: false };
  if (response["ok"] === true) return { commandId, ok: true };
  return refusalOf(response["refusal"]) ?? refusalOf(response["error"])
    ?? { code: "OFFER_REFUSED", layer: "DAEMON", ok: false };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function spendOffer(
  wire: OfferWire,
  kind: keyof ControlRoomClientSurface["commands"],
  affordance: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
  correlationPrefix: string,
  layer: string,
): Promise<OfferOutcome> {
  const requestDigest = await sha256Hex(JSON.stringify(payload));
  const builder = wire.client.commands[kind] as unknown as Builder | undefined;
  if (builder === undefined) return { code: "OFFER_KIND_UNBUILDABLE", layer, ok: false };
  const built = builder(affordance, {
    correlationId: `${correlationPrefix}-${requestDigest.slice(0, 16)}`,
    payload,
    requestDigest,
    sessionCredential: wire.sessionCredential,
  });
  if (!built.ok) return { code: built.error.code, layer: BUILD_LAYER, ok: false };
  const envelope = built.envelope as RuntimeCommandEnvelope;
  const sent = await wire.transport.sendCommand(envelope);
  if (!sent.delivered) return { code: sent.code, layer: TRANSPORT_LAYER, ok: false };
  return answerOf(sent.response, envelope.commandId, layer);
}
