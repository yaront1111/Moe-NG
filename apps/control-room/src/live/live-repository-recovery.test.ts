import { describe, expect, it, vi } from "vitest";
import { mapRepositoryRecoveryAnswer, readRepositoryRecovery } from "./live-repository-recovery.js";

export const RECOVERY_OFFER = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "recover-7",
  commandKind: "repository.recover", expectedVersion: 2, inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "recovery-goal" };
export const RECOVERY_FRAME = { version: "moe-repository-recovery/1", projectId: "project-a", code: null,
  reservations: [{ nodeRef: "node:v1:abc", phase: "BLOCKED", expectedReservationRevision: 7,
    actions: [{ action: "RECONCILE_LANDED", available: true, code: null, offer: RECOVERY_OFFER },
      { action: "ABORT_UNEXECUTED", available: false, code: "REPOSITORY_RECOVERY_EXECUTION_STARTED", offer: null }] }] };

describe("repository recovery read", () => {
  it("carries the exact reservation revision and daemon action offer", () => {
    expect(mapRepositoryRecoveryAnswer(200, RECOVERY_FRAME)).toEqual({ status: "RECOVERY", view: RECOVERY_FRAME });
  });
  it.each([
    { ...RECOVERY_FRAME, ownershipToken: "hidden" },
    { ...RECOVERY_FRAME, reservations: [{ ...RECOVERY_FRAME.reservations[0], expectedReservationRevision: -1 }] },
    { ...RECOVERY_FRAME, reservations: [{ ...RECOVERY_FRAME.reservations[0], actions: [{ action: "RECONCILE_LANDED", available: true, code: null, offer: null }] }] },
    { ...RECOVERY_FRAME, reservations: [{ ...RECOVERY_FRAME.reservations[0], actions: [{ action: "UNLOCK", available: true, code: null, offer: RECOVERY_OFFER }] }] },
    { ...RECOVERY_FRAME, reservations: [{ ...RECOVERY_FRAME.reservations[0], actions: [{ action: "RECONCILE_LANDED", available: false, code: "HELD", offer: RECOVERY_OFFER }] }] },
    { ...RECOVERY_FRAME, reservations: [{ ...RECOVERY_FRAME.reservations[0], actions: [{ action: "RECONCILE_LANDED", available: true, code: null, offer: { ...RECOVERY_OFFER, commandKind: "repository.publish" } }] }] },
  ])("rejects malformed or contradictory action authority", (body) => {
    expect(mapRepositoryRecoveryAnswer(200, body)).toEqual({ status: "ERROR", code: "REPOSITORY_RECOVERY_RESPONSE_INVALID", layer: "CONTROL_ROOM_RECOVERY" });
  });
  it("does not execute response accessors", () => {
    const access = vi.fn(() => RECOVERY_FRAME.reservations);
    expect(mapRepositoryRecoveryAnswer(200, { ...RECOVERY_FRAME, get reservations() { return access(); } }).status).toBe("ERROR");
    expect(access).not.toHaveBeenCalled();
  });
  it("keeps a refusal at its actual layer", () => {
    expect(mapRepositoryRecoveryAnswer(403, { outcome: "REFUSED", code: "DENIED", layer: "AUTHENTICATION" }))
      .toEqual({ status: "REFUSED", code: "DENIED", layer: "AUTHENTICATION" });
  });
  it("posts exactly an empty selection and refuses a transport failure", async () => {
    const send = vi.fn(async () => new Response(JSON.stringify(RECOVERY_FRAME)));
    expect((await readRepositoryRecovery({}, send)).status).toBe("RECOVERY"); expect(send).toHaveBeenCalledWith("{}");
    expect(await readRepositoryRecovery({}, async () => { throw new Error("offline"); }))
      .toEqual({ status: "ERROR", code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_RECOVERY" });
  });
});
