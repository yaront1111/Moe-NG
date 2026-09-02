import { describe, expect, it, vi } from "vitest";

import { createEscalationPort } from "./escalation-port.js";
import type { EscalationWire } from "./escalation-port.js";

/**
 * The escalation port spends the daemon's offer verbatim and adds only the two payload
 * fields the kind admits. The builder and transport are fakes that record what they were
 * handed, so the arms assert the exact affordance, payload and credential that reached them.
 */

const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-escalate-1",
  commandKind: "escalation.decide", expectedVersion: 4,
  inputSchemaVersion: "moe-review-command/1", targetAggregateId: "node-a",
});

function wireWith(answer: unknown, delivered = true): { readonly built: unknown[]; readonly sent: unknown[]; readonly wire: EscalationWire } {
  const built: unknown[] = [];
  const sent: unknown[] = [];
  const wire = {
    client: { commands: { "escalation.decide": (affordance: unknown, input: Record<string, unknown>) => {
      built.push({ affordance, input });
      return { envelope: { commandId: OFFER.commandId, kind: "escalation.decide", payload: input["payload"] }, ok: true };
    } } },
    sessionCredential: "cred-live-1",
    transport: { sendCommand: vi.fn(async (envelope: unknown) => {
      sent.push(envelope);
      return delivered ? { delivered: true as const, response: answer, status: 200 }
        : { code: "TRANSPORT_REQUEST_FAILED", delivered: false as const };
    }) },
  } as unknown as EscalationWire;
  return { built, sent, wire };
}

describe("createEscalationPort", () => {
  it("builds escalation.decide from the daemon's offer with only escalationRef and subjectRef", async () => {
    const { built, sent, wire } = wireWith({ ok: true });
    const outcome = await createEscalationPort(wire).submit(OFFER, "node-a");
    expect(outcome).toEqual({ commandId: "cmd-escalate-1", ok: true });
    expect(built).toHaveLength(1);
    const call = built[0] as { affordance: unknown; input: Record<string, unknown> };
    expect(call.affordance).toBe(OFFER);
    expect(call.input["payload"]).toEqual({ escalationRef: "ui-escalation-node-a-v4", subjectRef: "node-a" });
    expect(call.input["sessionCredential"]).toBe("cred-live-1");
    expect(String(call.input["correlationId"])).toMatch(/^ui-escalate-[0-9a-f]{16}$/u);
    expect(sent).toHaveLength(1);
  });

  it("carries the daemon's refusal at its own layer, and a transport failure at the transport layer", async () => {
    const refused = wireWith({ ok: false, refusal: { code: "REVIEW_ESCALATION_NOT_REACHED", layer: "DAEMON_PREREQUISITE" } });
    expect(await createEscalationPort(refused.wire).submit(OFFER, "node-a"))
      .toEqual({ code: "REVIEW_ESCALATION_NOT_REACHED", layer: "DAEMON_PREREQUISITE", ok: false });
    const down = wireWith(null, false);
    expect(await createEscalationPort(down.wire).submit(OFFER, "node-a"))
      .toEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_TRANSPORT", ok: false });
  });
});
