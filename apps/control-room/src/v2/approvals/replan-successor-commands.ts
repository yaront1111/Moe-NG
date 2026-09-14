import { admitGoalBrief, admitGoalSource, decodeRuntimeCommandEnvelopeBytes } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { buildGoalWithSourceCommand } from "@moe/control-room-client";
import type { CommandAffordance } from "@moe/control-room-client";
import type { LiveSetup } from "../../live/live-config.js";
import { briefOfDraft } from "../goals/live-goal-create.js";
import type { ReplanIntent } from "./replan-successor-journal.js";
import type { OfferOutcome } from "./offer-wire.js";

export const replanRefused = (code: string): Extract<OfferOutcome, { ok: false }> =>
  ({ ok: false, code, layer: "CONTROL_ROOM_REPLAN" });
export function replanEqual(left: unknown, right: unknown): boolean {
  const normalized = (value: unknown): unknown => Array.isArray(value) ? value.map(normalized)
    : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, normalized(child)])) : value;
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}
export async function replanDigest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function replanEnvelope(setup: LiveSetup, intent: ReplanIntent, kind: "decision" | "create"):
Promise<RuntimeCommandEnvelope | Extract<OfferOutcome, { ok: false }>> {
  let envelope: unknown;
  if (kind === "decision") {
    const payload = { decision: "REPLAN", escalationRef: `ui-escalation-${intent.nodeRef}-v${intent.reviewVersion}`, subjectRef: intent.nodeRef };
    const requestDigest = await replanDigest(JSON.stringify(payload));
    const built = setup.client.commands["escalation.decide"](intent.escalationOffer as CommandAffordance<"escalation.decide">,
      { correlationId: `ui-escalate-${requestDigest.slice(0, 16)}`, payload, requestDigest, sessionCredential: setup.sessionCredential });
    if (!built.ok) return replanRefused(built.error.code);
    envelope = built.envelope;
  } else {
    const prd = intent.draft.prd;
    if (prd === undefined) return replanRefused("REPLAN_SOURCE_BINDING_MISMATCH");
    const brief = admitGoalBrief(briefOfDraft(intent.draft));
    const source = admitGoalSource({ displayPath: prd.name, mediaType: prd.mediaType, text: prd.text });
    if (!brief.ok || !source.ok) return replanRefused("REPLAN_PREPARATION_INVALID");
    const requestDigest = await replanDigest(JSON.stringify([brief.brief, source.source]));
    const built = buildGoalWithSourceCommand({ affordance: intent.createOffer as CommandAffordance<"goal.create_with_source">,
      ...brief.brief, source: source.source, requestDigest, correlationId: `ui-goal-create-${requestDigest.slice(0, 16)}`,
      sessionCredential: setup.sessionCredential });
    if (!built.ok) return replanRefused("error" in built ? built.error.code : built.code);
    envelope = built.envelope;
  }
  const decoded = decodeRuntimeCommandEnvelopeBytes(new TextEncoder().encode(JSON.stringify(envelope)));
  return decoded.ok ? decoded.envelope : replanRefused(decoded.error.code);
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** An uncorrelated ok answer never confirms either half of the handoff. */
export async function sendReplanCommand(setup: LiveSetup, envelope: RuntimeCommandEnvelope): Promise<OfferOutcome> {
  try {
    const sent = await setup.transport.sendCommand(envelope);
    if (!sent.delivered) return replanRefused(sent.code);
    const answer: unknown = sent.response;
    if (record(answer) && answer["ok"] === true) {
      const decision = answer["decision"];
      if (record(decision) && decision["commandId"] === envelope.commandId
        && (decision["disposition"] === "DECIDED" || decision["disposition"] === "REPLAYED")
        && decision["resultCode"] === "EFFECTS_COMMITTED" && typeof decision["effectId"] === "string" && decision["effectId"] !== "") {
        return { ok: true, commandId: envelope.commandId };
      }
    }
    if (record(answer)) {
      const refusal = answer["refusal"] ?? answer["error"];
      if (record(refusal) && typeof refusal["code"] === "string" && typeof refusal["layer"] === "string") {
        return { ok: false, code: refusal["code"], layer: refusal["layer"] };
      }
    }
    return replanRefused("REPLAN_COMMAND_OUTCOME_UNCERTAIN");
  } catch { return replanRefused("REPLAN_COMMAND_OUTCOME_UNCERTAIN"); }
}
