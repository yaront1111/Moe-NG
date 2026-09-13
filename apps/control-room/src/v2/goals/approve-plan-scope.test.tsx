import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanningRunOutcome } from "../../live/live-planning-run.js";
import type { PlanApprovalSurface } from "./approve-plan-gate.js";
import { ApprovePlan } from "./approve-plan.js";

afterEach(cleanup);
type Run = Extract<PlanningRunOutcome, { status: "RUN" }>;
const run = (runId: string, patch: Partial<Run> = {}): Run => ({
  status: "RUN", runId, lifecycle: "PLAN_REVIEW", submissionHash: `submission-${runId}`,
  approval: "ABSENT", sealed: true, reviewable: true,
  plan: { planHash: `plan-${runId}`, affectedNodeIds: ["node"], affectedCriterionIds: ["criterion"],
    steps: [{ stepId: runId, kind: "node.deliver", description: `Plan for ${runId}` }] },
  acceptance: { criteriaDigest: "criteria", obligations: [] }, ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function view(runId: string, read: (runId: string) => Promise<PlanningRunOutcome>, submit: PlanApprovalSurface["submit"], grantId: string | null = runId,
  commandId = `command-${grantId}`) {
  return <ApprovePlan runId={runId} goalId="goal" title="Appointments" onBack={vi.fn()} read={read}
    approval={{ submit, authorization: grantId === null ? { status: "WITHHELD", code: "APPROVAL_SURFACE_UNREAD", layer: "CONTROL_ROOM_PLAN_APPROVAL" }
      : { status: "AUTHORIZED", grant: { runId: grantId, affordance: {
      commandEnvelopeVersion: "moe-runtime-command/1", commandId, commandKind: "approval.decide_intent",
      inputSchemaVersion: "moe-bootstrap/1", targetAggregateId: grantId, expectedVersion: 1,
    } } } }} />;
}
const button = () => screen.getByTestId("cr.approve.button") as HTMLButtonElement;

describe("plan approval requires the displayed run body", () => {
  it("refreshes a retained draft when the same run is offered without resetting on equivalent frames", async () => {
    const compiled = deferred<PlanningRunOutcome>();
    const read = vi.fn().mockResolvedValueOnce(run("A", { lifecycle: "DRAFT", sealed: false, reviewable: false, plan: null, acceptance: null }))
      .mockReturnValueOnce(compiled.promise);
    const command = deferred<Awaited<ReturnType<PlanApprovalSurface["submit"]>>>();
    const submit = vi.fn(() => command.promise);
    const mounted = render(view("A", read, submit, null));
    await waitFor(() => expect(screen.queryByTestId("cr.approve.loading")).toBeNull());
    expect(screen.queryByTestId("cr.approve.button")).toBeNull();
    mounted.rerender(view("A", read, submit, "A", "first-offer"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(button().disabled).toBe(true);
    await act(async () => { compiled.resolve(run("A")); });
    expect(button().disabled).toBe(false);
    await userEvent.type(screen.getByTestId("cr.approve.reason.input"), "Keep this reason");
    mounted.rerender(view("A", read, submit, "A", "equivalent-poll"));
    expect(read).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId("cr.approve.reason.input") as HTMLInputElement).value).toBe("Keep this reason");
    await userEvent.click(screen.getByTestId("cr.approve.reject"));
    mounted.rerender(view("A", read, submit, "A", "poll-during-dispatch"));
    expect(button().disabled).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { command.resolve({ ok: false, code: "DECISION_REFUSED", layer: "DAEMON" }); });
    mounted.rerender(view("A", read, submit, "A", "poll-after-refusal"));
    expect(screen.getByTestId("cr.approve.dispatch-refusal").textContent).toContain("DECISION_REFUSED");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("blocks an offered successor until its exact body is displayed", async () => {
    const pending = deferred<PlanningRunOutcome>();
    const read = vi.fn((id: string) => id === "A" ? Promise.resolve(run(id)) : pending.promise);
    const submit = vi.fn<PlanApprovalSurface["submit"]>(async () => ({ ok: true as const, commandId: "approved" }));
    const mounted = render(view("A", read, submit));
    await screen.findByText("Plan for A");
    expect(button().disabled).toBe(false);
    mounted.rerender(view("B", read, submit));
    expect(button().disabled).toBe(true);
    expect(screen.queryByText("Plan for A")).toBeNull();
    expect(screen.getByTestId("cr.approve.review-unavailable").textContent).toContain("PLAN_REVIEW_BODY_UNAVAILABLE");
    expect(screen.getByTestId("cr.approve.review-unavailable").textContent).toContain("CONTROL_ROOM_PLAN_REVIEW");
    await userEvent.click(button());
    expect(submit).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(run("B")); });
    expect(screen.getByText("Plan for B")).toBeTruthy();
    expect(button().disabled).toBe(false);
    await userEvent.click(button());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ runId: "B" });
  });
  it.each([
    run("other"), run("A", { sealed: false }), run("A", { reviewable: false }),
    run("A", { plan: null }), run("A", { acceptance: null }), run("A", { approval: "BOUND" }),
    { status: "ERROR", code: "READ_FAILED", layer: "HTTP" } as const,
    { status: "REFUSED", code: "REFUSED", layer: "DAEMON" } as const,
  ])("keeps dispatch behind the body fence for %j", async (outcome) => {
    const read = vi.fn(async () => outcome);
    const submit = vi.fn(async () => ({ ok: true as const, commandId: "unreached" }));
    render(view("A", read, submit));
    await waitFor(() => { expect(screen.queryByTestId("cr.approve.loading")).toBeNull(); });
    expect(button().disabled).toBe(true);
    await userEvent.click(button());
    expect(submit).not.toHaveBeenCalled();
  });
  it("rejects a mismatched grant even when the current body is reviewable", async () => {
    const submit = vi.fn(async () => ({ ok: true as const, commandId: "unreached" }));
    render(view("A", async () => run("A"), submit, "B"));
    await screen.findByText("Plan for A");
    expect(button().disabled).toBe(true);
    await userEvent.click(button());
    expect(submit).not.toHaveBeenCalled();
  });
  it("handles a rejected body read without leaving approval enabled", async () => {
    const submit = vi.fn(async () => ({ ok: true as const, commandId: "unreached" }));
    render(view("A", async () => { throw new Error("read unavailable"); }, submit));
    expect((await screen.findByTestId("cr.approve.refusal")).textContent).toContain("PLAN_REVIEW_READ_FAILED");
    expect(button().disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("plan read and dispatch session scope", () => {
  it.each(["accepted", "refused"] as const)("discards an old session's delayed %s result", async (result) => {
    const pending = deferred<Awaited<ReturnType<PlanApprovalSurface["submit"]>>>();
    const oldSubmit = vi.fn(() => pending.promise);
    const oldRead = vi.fn(async () => run("A"));
    const mounted = render(view("A", oldRead, oldSubmit));
    await screen.findByText("Plan for A");
    await userEvent.click(button());
    const newRead = vi.fn(async () => run("A"));
    const newSubmit = vi.fn(async () => ({ ok: true as const, commandId: "new" }));
    mounted.rerender(view("A", newRead, newSubmit));
    await screen.findByText("Plan for A");
    expect(button().disabled).toBe(false);
    await act(async () => { pending.resolve(result === "accepted" ? { ok: true, commandId: "old" }
      : { ok: false, code: "OLD_SESSION_REFUSAL", layer: "DAEMON" }); });
    expect(screen.queryByTestId("cr.approve.applied")).toBeNull();
    expect(screen.queryByTestId("cr.approve.dispatch-refusal")).toBeNull();
    expect(newRead).toHaveBeenCalledTimes(1);
    expect(newSubmit).not.toHaveBeenCalled();
  });
  it("clears a rejection reason when the session changes for the same run", async () => {
    const submit = vi.fn(async () => ({ ok: true as const, commandId: "unreached" }));
    const mounted = render(view("A", async () => run("A"), submit));
    await screen.findByText("Plan for A");
    await userEvent.type(screen.getByTestId("cr.approve.reason.input"), "Reason from the previous session");
    mounted.rerender(view("A", async () => run("A"), submit));
    await screen.findByText("Plan for A");
    expect((screen.getByTestId("cr.approve.reason.input") as HTMLInputElement).value).toBe("");
  });
});
