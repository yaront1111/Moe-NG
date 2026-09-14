import { buildNextAllowedCommands } from "@moe/contracts";
import { admitByWireProtocol } from "@moe/control-room-client";
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
  it("spends the guidance marker through the shared affordance decoder and real generated builder", async () => {
    const offers = buildNextAllowedCommands({ aggregate: "GOAL", state: "EXECUTION_ENABLED" }, [
      { ...OFFER, inputSchemaVersion: "moe-review-escalation-guidance/1" },
    ]);
    expect(offers).toHaveLength(1);
    const gate = admitByWireProtocol("moe-runtime-command/1+moe-runtime-query/1+moe-runtime-error-registry/1");
    if (!gate.ok) throw new Error("TEST_COMPAT_GATE_REFUSED");
    const { sent, wire } = wireWith({ ok: true });
    const outcome = await createEscalationPort({ ...wire, client: gate.client })
      .submit(offers[0]! as unknown as Readonly<Record<string, unknown>>, "display-only", "ALLOW_MORE_ATTEMPTS", "Keep every check");
    expect(outcome).toEqual({ commandId: OFFER.commandId, ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ commandId: OFFER.commandId, commandKind: "escalation.decide", expectedVersion: 4,
      schemaVersion: "moe-runtime-command/1", targetAggregateId: "node-a", payload: {
        decision: "ALLOW_MORE_ATTEMPTS", escalationRef: "ui-escalation-node-a-v4", subjectRef: "node-a", implementationGuidance: "Keep every check",
      } });
  });

  it("carries exact guidance only with the advertised escalation schema", async () => {
    const { built, sent, wire } = wireWith({ ok: true });
    const supported = { ...OFFER, inputSchemaVersion: "moe-review-escalation-guidance/1" };
    const guidance = "  Use the agreed session policy.\nKeep all approved checks.  ";
    expect(await createEscalationPort(wire).submit(supported, "display-only", "ALLOW_MORE_ATTEMPTS", guidance))
      .toEqual({ ok: true, commandId: OFFER.commandId });
    expect((built[0] as { affordance: unknown }).affordance).toBe(supported);
    expect((built[0] as { input: { payload: unknown } }).input.payload).toEqual({
      decision: "ALLOW_MORE_ATTEMPTS", escalationRef: "ui-escalation-node-a-v4", subjectRef: "node-a", implementationGuidance: guidance,
    });
    expect(sent).toHaveLength(1);
  });

  it.each([undefined, "moe-review-command/1", "moe-review-escalation-guidance/2"])(
    "refuses guidance on unsupported schema %s before building or sending", async (inputSchemaVersion) => {
      const { built, sent, wire } = wireWith({ ok: true });
      expect(await createEscalationPort(wire).submit({ ...OFFER, inputSchemaVersion }, "node-a", "ALLOW_MORE_ATTEMPTS", "Keep checks"))
        .toEqual({ ok: false, code: "ESCALATION_GUIDANCE_UNSUPPORTED", layer: "CONTROL_ROOM_ESCALATION" });
      expect(built).toEqual([]); expect(sent).toEqual([]);
    },
  );

  it.each(["", " \n\t", "x".repeat(4001), "😀".repeat(2001), "\ud800", null])(
    "refuses invalid guidance without spending an approval", async (guidance) => {
      const { built, sent, wire } = wireWith({ ok: true });
      expect(await createEscalationPort(wire).submit({ ...OFFER, inputSchemaVersion: "moe-review-escalation-guidance/1" },
        "node-a", "ALLOW_MORE_ATTEMPTS", guidance as string))
        .toEqual({ ok: false, code: "ESCALATION_GUIDANCE_INVALID", layer: "CONTROL_ROOM_ESCALATION" });
      expect(built).toEqual([]); expect(sent).toEqual([]);
    },
  );

  it("accepts the 4000-unit boundary without truncation and refuses guidance on REPLAN", async () => {
    const supported = { ...OFFER, inputSchemaVersion: "moe-review-escalation-guidance/1" };
    const { built, sent, wire } = wireWith({ ok: true });
    const text = "界".repeat(4000);
    expect(await createEscalationPort(wire).submit(supported, "node-a", "ALLOW_MORE_ATTEMPTS", text)).toMatchObject({ ok: true });
    expect((built[0] as { input: { payload: { implementationGuidance: string } } }).input.payload.implementationGuidance).toBe(text);
    expect(await createEscalationPort(wire).submit(supported, "node-a", "REPLAN", "Instructions"))
      .toEqual({ ok: false, code: "ESCALATION_GUIDANCE_INVALID", layer: "CONTROL_ROOM_ESCALATION" });
    expect(built).toHaveLength(1); expect(sent).toHaveLength(1);
  });

  it("takes the execution subject from the offer even when the display key is shared", async () => {
    const { built, wire } = wireWith({ ok: true });
    await createEscalationPort(wire).submit({ ...OFFER, targetAggregateId: "execution-own" }, "node-a", "REPLAN");
    expect((built[0] as { input: { payload: unknown } }).input.payload)
      .toEqual({ decision: "REPLAN", escalationRef: "ui-escalation-execution-own-v4", subjectRef: "execution-own" });
  });
  it("builds escalation.decide from the daemon's offer with only escalationRef and subjectRef", async () => {
    const { built, sent, wire } = wireWith({ ok: true });
    const outcome = await createEscalationPort(wire).submit(OFFER, "node-a", "ALLOW_MORE_ATTEMPTS");
    expect(outcome).toEqual({ commandId: "cmd-escalate-1", ok: true });
    expect(built).toHaveLength(1);
    const call = built[0] as { affordance: unknown; input: Record<string, unknown> };
    expect(call.affordance).toBe(OFFER);
    expect(call.input["payload"]).toEqual({ decision: "ALLOW_MORE_ATTEMPTS", escalationRef: "ui-escalation-node-a-v4", subjectRef: "node-a" });
    expect(call.input["sessionCredential"]).toBe("cred-live-1");
    expect(String(call.input["correlationId"])).toMatch(/^ui-escalate-[0-9a-f]{16}$/u);
    expect(sent).toHaveLength(1);
  });

  it("carries the daemon's refusal at its own layer, and a transport failure at the transport layer", async () => {
    const refused = wireWith({ ok: false, refusal: { code: "REVIEW_ESCALATION_NOT_REACHED", layer: "DAEMON_PREREQUISITE" } });
    expect(await createEscalationPort(refused.wire).submit(OFFER, "node-a", "REPLAN"))
      .toEqual({ code: "REVIEW_ESCALATION_NOT_REACHED", layer: "DAEMON_PREREQUISITE", ok: false });
    const down = wireWith(null, false);
    expect(await createEscalationPort(down.wire).submit(OFFER, "node-a", "ALLOW_MORE_ATTEMPTS"))
      .toEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_TRANSPORT", ok: false });
  });
});
