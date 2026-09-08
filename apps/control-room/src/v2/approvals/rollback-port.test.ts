import { describe, expect, it, vi } from "vitest";

import { TARGET_SHA, TO_RECEIPT_REF, rollbackOffer } from "./incident-frames.fixture.js";
import type { IncidentRollbackFacts } from "./needs-you-incident.js";
import type { OfferWire } from "./offer-wire.js";
import { createRollbackPort } from "./rollback-port.js";

/**
 * The rollback port spends the daemon's `deployment.rollback` offer verbatim and sends exactly
 * the three keys `exactRequest` (rollback-command.ts) admits. The builder and transport are
 * fakes recording what reached them; every refusal arm names the CODE and the LAYER that
 * refused, never merely that the dispatch did not succeed.
 */

const OFFER = Object.freeze(rollbackOffer());

const FACTS: IncidentRollbackFacts = Object.freeze({
  affordance: OFFER,
  target: Object.freeze({
    imageDigest: `sha256:${"a".repeat(64)}`, sha: TARGET_SHA, toReceiptRef: TO_RECEIPT_REF,
  }),
});

function wireWith(
  answer: unknown, delivered = true,
): { readonly built: unknown[]; readonly wire: OfferWire } {
  const built: unknown[] = [];
  const wire = {
    client: { commands: { "deployment.rollback": (
      affordance: unknown, input: Record<string, unknown>,
    ) => {
      built.push({ affordance, input });
      return { envelope: { commandId: OFFER["commandId"], kind: "deployment.rollback",
        payload: input["payload"] }, ok: true };
    } } },
    sessionCredential: "cred-live-1",
    transport: { sendCommand: vi.fn(async () => (delivered
      ? { delivered: true as const, response: answer, status: 200 }
      : { code: "TRANSPORT_REQUEST_FAILED", delivered: false as const })) },
  } as unknown as OfferWire;
  return { built, wire };
}

describe("createRollbackPort", () => {
  it("spends the daemon's offer verbatim with exactly the three admitted keys", async () => {
    const { built, wire } = wireWith({ ok: true });
    expect(await createRollbackPort(wire).submit(FACTS, "production"))
      .toEqual({ commandId: OFFER["commandId"], ok: true });
    const call = built[0] as { affordance: unknown; input: Record<string, unknown> };
    // VERBATIM: the same object identity the surface handed over, not a rebuilt lookalike.
    expect(call.affordance).toBe(OFFER);
    expect(Object.keys(call.input["payload"] as object).sort())
      .toEqual(["environment", "restoreDatabase", "toReceiptRef"]);
    expect(call.input["payload"]).toEqual({
      environment: "production", restoreDatabase: false, toReceiptRef: TO_RECEIPT_REF,
    });
    expect(String(call.input["correlationId"])).toMatch(/^ui-rollback-[0-9a-f]{16}$/u);
  });

  /**
   * THE RECEIPT REF, NEVER THE SHA. `exactRequest` gates `toReceiptRef` on `/^[0-9a-f]{64}$/u`,
   * so a port that sent the 40-char sha the operator was shown would refuse
   * DEPLOY_ROLLBACK_REQUEST_INVALID at ingress every single time - and only during an incident.
   */
  it("sends the receipt ref, not the sha the confirm displayed", async () => {
    const { built, wire } = wireWith({ ok: true });
    await createRollbackPort(wire).submit(FACTS, "production");
    const payload = (built[0] as { input: Record<string, unknown> })
      .input["payload"] as Record<string, unknown>;
    expect(payload["toReceiptRef"]).toBe(TO_RECEIPT_REF);
    expect(payload["toReceiptRef"]).not.toBe(TARGET_SHA);
    expect(String(payload["toReceiptRef"])).toMatch(/^[0-9a-f]{64}$/u);
  });

  /**
   * NEVER A DATABASE RESTORE FROM THIS SURFACE. Restoring discards every write made during the
   * outage, and an incident card is the worst place for that to be implicit. Pinning the literal
   * `false` is what stops a later edit from making it configurable by accident.
   */
  it("never asks for a database restore", async () => {
    const { built, wire } = wireWith({ ok: true });
    await createRollbackPort(wire).submit(FACTS, "production");
    expect(((built[0] as { input: Record<string, unknown> })
      .input["payload"] as Record<string, unknown>)["restoreDatabase"]).toBe(false);
  });

  it("carries the daemon's own refusal at the layer that refused it", async () => {
    const { wire } = wireWith({ ok: false,
      refusal: { code: "DEPLOY_ROLLBACK_IN_PROGRESS", layer: "DAEMON_DEPLOY_ENGINE" } });
    expect(await createRollbackPort(wire).submit(FACTS, "production")).toEqual({
      code: "DEPLOY_ROLLBACK_IN_PROGRESS", layer: "DAEMON_DEPLOY_ENGINE", ok: false,
    });
  });

  it("reports a transport failure at the transport's own layer", async () => {
    const { wire } = wireWith(null, false);
    expect(await createRollbackPort(wire).submit(FACTS, "production")).toEqual({
      code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_TRANSPORT", ok: false,
    });
  });

  it("refuses at this port's own layer when the client cannot build the kind", async () => {
    const { wire } = wireWith({ ok: true });
    const blind = { ...wire, client: { commands: {} } } as unknown as OfferWire;
    expect(await createRollbackPort(blind).submit(FACTS, "production")).toEqual({
      code: "OFFER_KIND_UNBUILDABLE", layer: "CONTROL_ROOM_DEPLOY_ROLLBACK", ok: false,
    });
  });
});
