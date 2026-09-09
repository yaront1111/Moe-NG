import { describe, expect, it, vi } from "vitest";
import { createRepositoryRecoveryPort } from "./repository-recovery-port.js";
import type { OfferWire } from "../approvals/offer-wire.js";
const offer = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "recover-7", commandKind: "repository.recover",
  expectedVersion: 2, inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "recovery-a" };
const action = { action: "RECONCILE_LANDED" as const, available: true, code: null, offer };
const reservation = { nodeRef: "node-a", phase: "BLOCKED", expectedReservationRevision: 7, actions: [action] };
describe("repository recovery command port", () => {
  it("uses the offer and exact reservation revision without exposing owner authority", async () => {
    const build = vi.fn((_offer: unknown, input: { payload: unknown }) => ({ ok: true,
      envelope: { commandId: "recover-7", payload: input.payload } }));
    const sendCommand = vi.fn(async () => ({ delivered: true, response: { ok: true } }));
    const wire = { client: { commands: { "repository.recover": build } }, sessionCredential: "session", transport: { sendCommand } } as unknown as OfferWire;
    expect(await createRepositoryRecoveryPort(wire).submit(reservation, action, " Checked evidence "))
      .toEqual({ ok: true, commandId: "recover-7" });
    expect(build).toHaveBeenCalledWith(offer, expect.objectContaining({ payload: {
      action: "RECONCILE_LANDED", decision: "APPROVE", nodeRef: "node-a", expectedReservationRevision: 7, reason: "Checked evidence",
    } }));
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
  it("refuses an unavailable or unlisted action before building a command", async () => {
    const wire = { client: { commands: {} }, sessionCredential: "session", transport: {} } as unknown as OfferWire;
    const port = createRepositoryRecoveryPort(wire);
    expect(await port.submit({ ...reservation, actions: [] }, action, "Review"))
      .toEqual({ ok: false, code: "REPOSITORY_RECOVERY_NOT_OFFERED", layer: "CONTROL_ROOM_RECOVERY" });
    expect(await port.submit(reservation, action, " "))
      .toEqual({ ok: false, code: "REPOSITORY_RECOVERY_REASON_REQUIRED", layer: "CONTROL_ROOM_RECOVERY" });
  });
});
