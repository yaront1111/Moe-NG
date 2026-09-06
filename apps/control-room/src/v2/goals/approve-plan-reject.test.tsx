import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createCompatGate } from "@moe/control-room-client";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { PlanningRunOutcome } from "../../live/live-planning-run.js";
import { ApprovePlan } from "./approve-plan.js";
import {
  APPROVAL_COMMAND_KIND,
  PLAN_APPROVAL_LAYER,
  authorizeApproval,
  createPlanApprovalPort,
} from "./plan-approval.js";
import type { ApprovalGrant, PlanApprovalOutcome, PlanApprovalWire } from "./plan-approval.js";

/**
 * SENDING THE PLAN BACK: the Reject control, its required reason, and the one wire
 * both decisions share.
 *
 * REJECT IS NOT A SECOND WIRE. It spends the SAME `approval.decide_intent` grant the
 * daemon offered for this run, with the same four payload keys; only `decision` and
 * `decisionReason` differ. So every arm below asserts the payload BYTE-EXACT rather
 * than asserting that "something was sent" - a reject that quietly grew a fifth key,
 * or that reached a different command kind, would otherwise stay green.
 *
 * TWO DIFFERENT FENCES REFUSE AN EMPTY REASON and they are kept distinguishable:
 *  - THIS BROWSER disables the control, so nothing is dispatched at all. Asserted by
 *    the submit spy never being called, not merely by the button being disabled.
 *  - THE DAEMON refuses `APPROVAL_REJECT_REASON_REQUIRED` at its own layer
 *    (approval-intent-rejection.ts:40/:182, approval-intent.ts:199). Asserted as the
 *    LITERAL code rendered verbatim, because a paraphrase is how an operator loses
 *    the daemon's actual reason.
 * An arm that only asserted "the reject did not go through" could not tell the two
 * apart, and would stay green if the browser fence vanished.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** DURABLE subjects, read back from this object rather than respelled beside an assertion. */
const DURABLE = Object.freeze({
  otherRunRef: "run-a3f19c0e4b7d",
  reason: "The acceptance criteria do not cover the recovery path",
  runRef: "run-7c1d55ab902e",
});

const SEALED_REVIEWABLE: PlanningRunOutcome = Object.freeze({
  acceptance: null,
  approval: "ABSENT",
  lifecycle: "PLAN_REVIEW",
  plan: {
    affectedCriterionIds: ["crit-1"],
    affectedNodeIds: ["node-1"],
    planHash: "plan-hash-1",
    steps: [{ description: "Write the recovery contract", kind: "node.deliver", stepId: "step-1" }],
  },
  reviewable: true,
  runId: DURABLE.runRef,
  sealed: true,
  status: "RUN",
  submissionHash: "sub-hash-1",
});

/** A daemon `NextAllowedCommand`, shaped exactly as `affordance-planning-offers.ts` mints one. */
function offerFor(
  targetAggregateId: string, commandKind: string = APPROVAL_COMMAND_KIND,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId: `cmd-${targetAggregateId}`,
    commandKind,
    expectedVersion: 4,
    inputSchemaVersion: "moe-bootstrap/1",
    targetAggregateId,
  });
}

function frameWith(
  offers: readonly Readonly<Record<string, unknown>>[],
  overrides: Partial<SurfaceFrame> = {},
): SurfaceFrame {
  return Object.freeze({
    connection: "CONNECTED",
    detail: "",
    offers: Object.freeze([...offers]) as SurfaceFrame["offers"],
    outcome: "SURFACE",
    steps: Object.freeze([]),
    ...overrides,
  });
}

/** The gated wire, built through the REAL generated builders the compat gate admits. */
function admittedWire(
  sendCommand: (envelope: unknown) => Promise<{ code?: string; delivered: boolean; response?: unknown }>,
): PlanApprovalWire {
  const gate = createCompatGate({
    apiCompatibilityRange: {
      commandEnvelopeVersion: "moe-runtime-command/1",
      errorRegistryVersion: "moe-runtime-error-registry/1",
      queryEnvelopeVersion: "moe-runtime-query/1",
    },
    buildToolVersions: { node: "24.16.0" },
    contractSchemaHash: "144d81c9186f9234a3c15ab91eb0814af46b8a06e0185a5c2311ff5e82a72a29",
  });
  if (!gate.ok) throw new Error("the compat gate refused its own matching report");
  return {
    client: gate.client,
    sessionCredential: "credential-under-test",
    transport: { sendCommand } as unknown as PlanApprovalWire["transport"],
  };
}

function grantFor(runRef: string): ApprovalGrant {
  const authorization = authorizeApproval(frameWith([offerFor(runRef)]), runRef);
  if (authorization.status !== "AUTHORIZED") throw new Error("expected an authorized grant");
  return authorization.grant;
}

describe("the approval port sends a REJECT through the one intent wire", () => {
  it("builds exactly the four intent keys with decision REJECT, the operator's reason and this run", async () => {
    const sent: Record<string, unknown>[] = [];
    const wire = admittedWire((envelope) => {
      sent.push(envelope as Record<string, unknown>);
      return Promise.resolve({ delivered: true, response: { ok: true } });
    });
    const grant = grantFor(DURABLE.runRef);
    const outcome = await createPlanApprovalPort(wire).submit(grant, DURABLE.reason);
    expect(outcome.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const envelope = sent[0] ?? {};
    // The wire is the SAME daemon-offered identity an approve spends.
    expect(envelope["commandKind"]).toBe(APPROVAL_COMMAND_KIND);
    expect(envelope["commandId"]).toBe(grant.affordance["commandId"]);
    expect(envelope["targetAggregateId"]).toBe(DURABLE.runRef);
    // BYTE-EXACT payload: the whole object, not a subset. A fifth key reddens this.
    expect(envelope["payload"]).toEqual({
      decision: "REJECT",
      decisionReason: DURABLE.reason,
      dependencyChanges: { additions: [], challenges: [], removals: [] },
      runId: DURABLE.runRef,
    });
  });

  /**
   * THE CONTROL. Same port, same grant, no reason: still APPROVE with a null reason.
   * Without this arm a production change that sent REJECT unconditionally would pass
   * every reject assertion above.
   */
  it("still sends APPROVE with a null reason when no reason is handed in", async () => {
    const sent: Record<string, unknown>[] = [];
    const wire = admittedWire((envelope) => {
      sent.push(envelope as Record<string, unknown>);
      return Promise.resolve({ delivered: true, response: { ok: true } });
    });
    await createPlanApprovalPort(wire).submit(grantFor(DURABLE.runRef), null);
    expect((sent[0] ?? {})["payload"]).toEqual({
      decision: "APPROVE",
      decisionReason: null,
      dependencyChanges: { additions: [], challenges: [], removals: [] },
      runId: DURABLE.runRef,
    });
  });

  it("reports the daemon's REJECT refusal at its own code and layer, never restamped", async () => {
    const refusal = Object.freeze({
      code: "APPROVAL_REJECT_REASON_REQUIRED", layer: "APPROVAL_INTENT_REJECTION",
    });
    const wire = admittedWire(() => Promise.resolve({
      delivered: true, response: { ok: false, refusal },
    }));
    const outcome = await createPlanApprovalPort(wire).submit(grantFor(DURABLE.runRef), " ");
    expect(outcome).toEqual({ code: refusal.code, layer: refusal.layer, ok: false });
  });
});

interface RejectHarness {
  readonly read: ReturnType<typeof vi.fn>;
  readonly submit: ReturnType<typeof vi.fn>;
}

function renderApproval(
  frame: SurfaceFrame | null, outcome: PlanApprovalOutcome, runId: string = DURABLE.runRef,
): RejectHarness {
  const read = vi.fn(() => Promise.resolve(SEALED_REVIEWABLE));
  const submit = vi.fn(() => Promise.resolve(outcome));
  render(
    <ApprovePlan
      approval={{
        authorization: authorizeApproval(frame, runId),
        submit: submit as unknown as (
          grant: ApprovalGrant, decisionReason: string | null,
        ) => Promise<PlanApprovalOutcome>,
      }}
      goalId="goal-live-1"
      onBack={vi.fn()}
      read={read as unknown as (runId: string) => Promise<PlanningRunOutcome>}
      runId={runId}
      title="Recovery goal"
    />,
  );
  return { read, submit };
}

describe("the Reject control beside Approve", () => {
  it("renders Reject and a reason input of its own, distinct from the withheld-reason display", async () => {
    renderApproval(frameWith([offerFor(DURABLE.runRef)]), { commandId: "unreached", ok: true });
    expect(await screen.findByTestId("cr.approve.reject")).toBeTruthy();
    expect(screen.getByTestId("cr.approve.button")).toBeTruthy();
    expect(screen.getByTestId("cr.approve.reason.input")).toBeTruthy();
    // `cr.approve.reason` is the WITHHELD-reason display and stays absent on a granted
    // run; the input must never have reused that id.
    expect(screen.queryByTestId("cr.approve.reason")).toBeNull();
  });

  it("keeps Reject disabled and DISPATCHES NOTHING while the reason is empty or whitespace", async () => {
    const harness = renderApproval(
      frameWith([offerFor(DURABLE.runRef)]), { code: "UNREACHED", layer: "UNREACHED", ok: false },
    );
    const reject = await screen.findByTestId("cr.approve.reject");
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(reject);
    expect(harness.submit).not.toHaveBeenCalled();

    // Whitespace is not a reason: the daemon would refuse it, and this browser does not
    // spend the operator's grant to find that out.
    await userEvent.type(screen.getByTestId("cr.approve.reason.input"), "   ");
    expect((screen.getByTestId("cr.approve.reject") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("cr.approve.reject"));
    expect(harness.submit).not.toHaveBeenCalled();

    // One real character is enough to enable it, so the arm above measured the guard
    // and not a control that is disabled for some other reason.
    await userEvent.type(screen.getByTestId("cr.approve.reason.input"), "x");
    await waitFor(() => {
      expect((screen.getByTestId("cr.approve.reject") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("hands the typed reason and the daemon's own grant to the port, exactly once", async () => {
    const offer = offerFor(DURABLE.runRef);
    const harness = renderApproval(frameWith([offer]), { commandId: "cmd-rejected", ok: true });
    await userEvent.type(await screen.findByTestId("cr.approve.reason.input"), DURABLE.reason);
    await userEvent.click(screen.getByTestId("cr.approve.reject"));
    await waitFor(() => { expect(harness.submit).toHaveBeenCalledTimes(1); });
    const [grant, reason] = harness.submit.mock.calls[0] as [ApprovalGrant, string | null];
    // IDENTITY: the daemon's offer object, never a local mint.
    expect(grant.affordance).toBe(offer);
    expect(grant.runId).toBe(DURABLE.runRef);
    expect(reason).toBe(DURABLE.reason);
  });

  it("still sends a null reason when APPROVE is clicked, so the reason rides only on a reject", async () => {
    const harness = renderApproval(
      frameWith([offerFor(DURABLE.runRef)]), { commandId: "cmd-approved", ok: true },
    );
    await userEvent.type(await screen.findByTestId("cr.approve.reason.input"), DURABLE.reason);
    await userEvent.click(screen.getByTestId("cr.approve.button"));
    await waitFor(() => { expect(harness.submit).toHaveBeenCalledTimes(1); });
    expect((harness.submit.mock.calls[0] as [ApprovalGrant, string | null])[1]).toBeNull();
  });

  it("renders the daemon's APPROVAL_REJECT_REASON_REQUIRED VERBATIM under the dispatch refusal", async () => {
    const harness = renderApproval(frameWith([offerFor(DURABLE.runRef)]), {
      code: "APPROVAL_REJECT_REASON_REQUIRED", layer: "APPROVAL_INTENT_REJECTION", ok: false,
    });
    await userEvent.type(await screen.findByTestId("cr.approve.reason.input"), DURABLE.reason);
    await userEvent.click(screen.getByTestId("cr.approve.reject"));
    await waitFor(() => { expect(harness.submit).toHaveBeenCalledTimes(1); });
    const note = await screen.findByTestId("cr.approve.dispatch-refusal");
    // The LITERAL code, not a paraphrase and not this module's own layer.
    expect(note.textContent).toContain("APPROVAL_REJECT_REASON_REQUIRED");
    expect(note.textContent).toContain("APPROVAL_INTENT_REJECTION");
    expect(note.textContent).not.toContain(PLAN_APPROVAL_LAYER);
  });

  it("disables Reject with the gate's own code when the daemon offered no grant for this run", async () => {
    const harness = renderApproval(
      frameWith([offerFor(DURABLE.otherRunRef)]), { code: "UNREACHED", layer: "UNREACHED", ok: false },
    );
    const reject = await screen.findByTestId("cr.approve.reject");
    await userEvent.type(screen.getByTestId("cr.approve.reason.input"), DURABLE.reason);
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("cr.approve.reason").textContent)
      .toContain("APPROVAL_AFFORDANCE_SUBJECT_MISMATCH");
    await userEvent.click(reject);
    expect(harness.submit).not.toHaveBeenCalled();
  });
});
