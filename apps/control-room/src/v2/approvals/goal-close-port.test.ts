import { describe, expect, it, vi } from "vitest";

import { createGoalClosePort } from "./goal-close-port.js";
import type { OfferWire } from "./offer-wire.js";

/**
 * The close port spends the daemon's goal.close offer verbatim and sends exactly the three
 * payload keys the kind admits, with witness objects that claim nothing the browser does not
 * hold. The builder and transport are fakes recording what reached them.
 */

const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-close-1",
  commandKind: "goal.close", expectedVersion: 7,
  inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "goal-1",
});

function wireWith(answer: unknown, delivered = true): { readonly built: unknown[]; readonly wire: OfferWire } {
  const built: unknown[] = [];
  const wire = {
    client: { commands: { "goal.close": (affordance: unknown, input: Record<string, unknown>) => {
      built.push({ affordance, input });
      return { envelope: { commandId: OFFER.commandId, kind: "goal.close", payload: input["payload"] }, ok: true };
    } } },
    sessionCredential: "cred-live-1",
    transport: { sendCommand: vi.fn(async () => (delivered
      ? { delivered: true as const, response: answer, status: 200 }
      : { code: "TRANSPORT_REQUEST_FAILED", delivered: false as const })) },
  } as unknown as OfferWire;
  return { built, wire };
}

describe("createGoalClosePort", () => {
  it("builds goal.close from the daemon's offer with exactly the three admitted keys", async () => {
    const { built, wire } = wireWith({ ok: true });
    expect(await createGoalClosePort(wire).submit(OFFER, "goal-1")).toEqual({ commandId: "cmd-close-1", ok: true });
    const call = built[0] as { affordance: unknown; input: Record<string, unknown> };
    expect(call.affordance).toBe(OFFER);
    expect(Object.keys(call.input["payload"] as object).sort()).toEqual(["closureWitness", "goalId", "zeroAuthorityWitness"]);
    expect(call.input["payload"]).toEqual({
      closureWitness: { declaredBy: "CONTROL_ROOM", truthClass: "HUMAN_APPROVED" },
      goalId: "goal-1",
      zeroAuthorityWitness: { declaredBy: "CONTROL_ROOM" },
    });
    expect(String(call.input["correlationId"])).toMatch(/^ui-close-[0-9a-f]{16}$/u);
  });

  it("carries the daemon's own refusal and a transport failure at their layers", async () => {
    const refused = wireWith({ ok: false, refusal: { code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED", layer: "DAEMON_PREREQUISITE" } });
    expect(await createGoalClosePort(refused.wire).submit(OFFER, "goal-1"))
      .toEqual({ code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED", layer: "DAEMON_PREREQUISITE", ok: false });
    const down = wireWith(null, false);
    expect(await createGoalClosePort(down.wire).submit(OFFER, "goal-1"))
      .toEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_TRANSPORT", ok: false });
  });
});
