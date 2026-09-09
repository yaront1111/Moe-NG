import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryRecoveryCard } from "./repository-recovery-card.js";
import { mapRepositoryRecoveryAnswer } from "../../live/live-repository-recovery.js";
import { createRepositoryRecoveryPort } from "./repository-recovery-port.js";
import type { OfferWire } from "../approvals/offer-wire.js";

const offer = { commandEnvelopeVersion: "moe-runtime-command/1", commandId: "recover-7", commandKind: "repository.recover",
  expectedVersion: 2, inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "recovery-a" };
const frame = { version: "moe-repository-recovery/1", projectId: "project-a", code: null, reservations: [{
  nodeRef: "node-a", phase: "BLOCKED", expectedReservationRevision: 7, actions: [
    { action: "RECONCILE_LANDED", available: true, code: null, offer },
    { action: "ABORT_UNEXECUTED", available: false, code: "REPOSITORY_RECOVERY_EXECUTION_STARTED", offer: null },
  ],
}] };
afterEach(cleanup);
describe("repository recovery operator controls", () => {
  it("requires a reason and submits the exact offered revision once", async () => {
    let finish!: (value: { ok: true; commandId: string }) => void;
    const submit = vi.fn(() => new Promise<{ ok: true; commandId: string }>((resolve) => { finish = resolve; }));
    render(<RepositoryRecoveryCard outcome={mapRepositoryRecoveryAnswer(200, frame)} port={{ submit }} />);
    const button = screen.getByRole("button", { name: "Reconcile completed landing" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Recovery reason for node-a"), { target: { value: "Checked the completed landing" } });
    fireEvent.click(button); fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ nodeRef: "node-a", expectedReservationRevision: 7 }),
      expect.objectContaining({ action: "RECONCILE_LANDED", offer }), "Checked the completed landing");
    finish({ ok: true, commandId: "recover-7" });
    await waitFor(() => expect(screen.getByText("Recovery decision recorded. Refreshing repository ownership.").textContent)
      .toBe("Recovery decision recorded. Refreshing repository ownership."));
  });
  it("shows refusal codes and offers no unavailable release action", () => {
    render(<RepositoryRecoveryCard outcome={mapRepositoryRecoveryAnswer(200, frame)} port={{ submit: vi.fn() }} />);
    expect(screen.getByText("REPOSITORY_RECOVERY_EXECUTION_STARTED").textContent).toBe("REPOSITORY_RECOVERY_EXECUTION_STARTED");
    expect(screen.queryByRole("button", { name: "Release unused reservation" })).toBeNull();
  });
  it("keeps a command refusal visible without claiming a release", async () => {
    render(<RepositoryRecoveryCard outcome={mapRepositoryRecoveryAnswer(200, frame)} port={{
      submit: vi.fn(async () => ({ ok: false as const, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT", layer: "REPOSITORY_RECOVERY" })),
    }} />);
    fireEvent.change(screen.getByLabelText("Recovery reason for node-a"), { target: { value: "Review" } });
    fireEvent.click(screen.getByRole("button", { name: "Reconcile completed landing" }));
    await waitFor(() => expect(screen.getByTestId("cr.health.recovery.refusal.node-a").textContent)
      .toContain("REPOSITORY_EXECUTION_REVISION_CONFLICT @ REPOSITORY_RECOVERY"));
    expect(screen.queryByText(/decision recorded/)).toBeNull();
  });
  it("drops an old action when the reservation revision changes", () => {
    const submit = vi.fn();
    const rendered = render(<RepositoryRecoveryCard outcome={mapRepositoryRecoveryAnswer(200, frame)} port={{ submit }} />);
    fireEvent.change(screen.getByLabelText("Recovery reason for node-a"), { target: { value: "Review" } });
    const changed = { ...frame, reservations: [{ ...frame.reservations[0], expectedReservationRevision: 8,
      actions: [{ action: "RECONCILE_LANDED", available: false, code: "HELD", offer: null }] }] };
    rendered.rerender(<RepositoryRecoveryCard outcome={mapRepositoryRecoveryAnswer(200, changed)} port={{ submit }} />);
    expect(screen.queryByRole("button", { name: "Reconcile completed landing" })).toBeNull(); expect(submit).not.toHaveBeenCalled();
  });
  it.each(["rejected request", "undelivered response"])("does not assert ownership after a %s", async (failure) => {
    const sendCommand = vi.fn(async () => {
      if (failure === "rejected request") throw new Error("The response was lost after release");
      return { delivered: false, code: "TRANSPORT_REQUEST_FAILED" };
    });
    const wire = { client: { commands: { "repository.recover": () => ({ ok: true, envelope: { commandId: "recover-7" } }) } },
      sessionCredential: "session", transport: { sendCommand } } as unknown as OfferWire;
    render(<RepositoryRecoveryCard outcome={mapRepositoryRecoveryAnswer(200, frame)} port={createRepositoryRecoveryPort(wire)} />);
    fireEvent.change(screen.getByLabelText("Recovery reason for node-a"), { target: { value: "Review completed landing" } });
    fireEvent.click(screen.getByRole("button", { name: "Reconcile completed landing" }));
    await waitFor(() => expect(screen.getByTestId("cr.health.recovery.refusal.node-a").textContent)
      .toContain("Recovery was not confirmed. Refresh repository ownership to see its current state."));
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cr.health.recovery.refusal.node-a").textContent).toContain(failure === "rejected request"
      ? "TRANSPORT_REQUEST_FAILED @ CONTROL_ROOM_RECOVERY" : "TRANSPORT_REQUEST_FAILED @ CONTROL_ROOM_TRANSPORT");
    expect(screen.queryByText(/repository remains held/)).toBeNull();
    expect(screen.queryByText(/decision recorded/)).toBeNull();
  });
});
