import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createCompatGate } from "@moe/control-room-client";

import { frameOfSurface } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { PlanningRunOutcome } from "../../live/live-planning-run.js";
import { ApprovePlan } from "./approve-plan.js";
import {
  AFTER_COMPILE_FRAME, AFTER_REJECT_FRAME, RECORDED,
} from "./plan-reject-frames.fixture.js";
import { authorizeApproval, createPlanApprovalPort } from "./plan-approval.js";
import type { ApprovalGrant, PlanApprovalWire } from "./plan-approval.js";
import { currentRunOf, planSentBack } from "./plan-run-resolution.js";

/**
 * THE GATE FOLLOWS THE SUCCESSOR RUN, driven off REAL daemon frames.
 *
 * Both frames are the daemon's own `readSurface()` bytes (see the fixture's header for
 * the recording), fed through the REAL decoder `frameOfSurface` - the same call the
 * live board feed makes on `POST /affordances/read`. A hand-written frame would fail
 * at that decoder rather than at an assertion below.
 *
 * THE FAILURE THIS FILE EXISTS TO CATCH is a gate that re-renders its controls while
 * still pointing at the run the operator rejected. The daemon refuses that write
 * (APPROVAL_RUN_NOT_REVIEWABLE @ APPROVAL_RUN_BINDING), so it would reach the operator
 * as a daemon refusal rather than as the UI bug it is. Every arm below therefore
 * asserts the RUN ID that reaches the dispatched payload, never merely that a control
 * came back.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The frames as the browser actually holds them: decoded, never constructed here. */
const AFTER_REJECT: SurfaceFrame = frameOfSurface(AFTER_REJECT_FRAME);
const AFTER_COMPILE: SurfaceFrame = frameOfSurface(AFTER_COMPILE_FRAME);

const SEALED: PlanningRunOutcome = Object.freeze({
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
  runId: RECORDED.successorRunId,
  sealed: true,
  status: "RUN",
  submissionHash: "sub-hash-1",
});

describe("the recorded frames really are the two post-reject states", () => {
  /**
   * THE FIXTURE'S OWN CONTROL. Every arm below rests on these frames saying what the
   * header claims; if the recording were stale or truncated wrong, the assertions
   * would still be readable as "the gate followed the successor" while measuring
   * nothing. The rejected and successor runs are asserted DISTINCT first, or a
   * one-run frame would satisfy the whole file.
   */
  it("decode as SURFACE, name two different runs, and move the offer as the daemon moved it", () => {
    expect(RECORDED.rejectedRunId).not.toBe(RECORDED.successorRunId);
    for (const frame of [AFTER_REJECT, AFTER_COMPILE]) {
      expect(frame.outcome).toBe("SURFACE");
      expect(frame.connection).toBe("CONNECTED");
      // The daemon binds ONLY the successor after a reject; the rejected run is bound
      // to nothing, in BOTH frames.
      expect(frame.planningGoalRefs).toEqual({ [RECORDED.successorRunId]: RECORDED.goalId });
    }
    const intents = (frame: SurfaceFrame): string[] => frame.offers
      .filter((offer) => offer["commandKind"] === "approval.decide_intent")
      .map((offer) => String(offer["targetAggregateId"])).sort();
    // SET-EQUALITY, not toContain: the defect is an offer that should have DISAPPEARED.
    expect(intents(AFTER_REJECT)).toEqual([]);
    expect(intents(AFTER_COMPILE)).toEqual([RECORDED.successorRunId]);
    expect(AFTER_REJECT.offers.some((offer) =>
      offer["commandKind"] === "planning.submit_decomposition"
      && offer["targetAggregateId"] === RECORDED.goalId)).toBe(true);
  });
});

describe("resolving which run the gate acts on", () => {
  it("resolves the goal's IMMUTABLE ref to the SUCCESSOR in both post-reject frames", () => {
    for (const frame of [AFTER_REJECT, AFTER_COMPILE]) {
      expect(currentRunOf(frame, RECORDED.goalId, RECORDED.rejectedRunId))
        .toBe(RECORDED.successorRunId);
    }
  });

  /**
   * FAIL-OPEN, deliberately, and matching the daemon's own read path. A surface that
   * cannot be read must not blank the screen; the WRITE stays fenced by the daemon.
   * Each case names the ref it must fall back to, so a resolver returning "" would
   * redden rather than look like a legitimate absence.
   */
  it("falls back to the immutable ref when no single run is bound to this goal", () => {
    const cases: readonly { readonly frame: SurfaceFrame | null; readonly why: string }[] =
      Object.freeze([
        { frame: null, why: "unread" },
        { frame: frameOfSurface({ outcome: "REFUSED" }), why: "not a surface" },
        { frame: frameOfSurface({ ...(AFTER_REJECT_FRAME as object), planningGoalRefs: {} }), why: "binds nothing" },
      ]);
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      expect(currentRunOf(entry.frame, RECORDED.goalId, RECORDED.rejectedRunId))
        .toBe(RECORDED.rejectedRunId);
    }
    // And a goal the frame says nothing about resolves to its own ref, not another goal's run.
    expect(currentRunOf(AFTER_REJECT, "goal-someone-else", RECORDED.rejectedRunId))
      .toBe(RECORDED.rejectedRunId);
  });

  /**
   * THE TWO HALVES OF "sent back", asserted as a pair. The second half is what stops
   * the banner outliving the wait it describes: the SAME frame that re-offers the
   * successor for approval turns it off.
   */
  it("says sent-back only while the successor is not yet offered for approval", () => {
    expect(planSentBack(AFTER_REJECT, RECORDED.goalId, RECORDED.rejectedRunId)).toBe(true);
    expect(planSentBack(AFTER_COMPILE, RECORDED.goalId, RECORDED.rejectedRunId)).toBe(false);
    // Never before a reject: a goal whose current run IS its own ref is not sent back.
    expect(planSentBack(AFTER_COMPILE, RECORDED.goalId, RECORDED.successorRunId)).toBe(false);
    expect(planSentBack(null, RECORDED.goalId, RECORDED.rejectedRunId)).toBe(false);
  });
});

/** The gated wire, built through the REAL generated builders the compat gate admits. */
function admittedWire(
  sendCommand: (envelope: unknown) => Promise<{ delivered: boolean; response?: unknown }>,
): PlanApprovalWire {
  const gate = createCompatGate({
    apiCompatibilityRange: {
      commandEnvelopeVersion: "moe-runtime-command/1",
      errorRegistryVersion: "moe-runtime-error-registry/1",
      queryEnvelopeVersion: "moe-runtime-query/1",
    },
    buildToolVersions: { node: "24.16.0" },
    contractSchemaHash: "9f578ae0a875d498cce7b9da03252daaa2655f825263c0963b4899971001e1ca",
  });
  if (!gate.ok) throw new Error("the compat gate refused its own matching report");
  return {
    client: gate.client,
    sessionCredential: "credential-under-test",
    transport: { sendCommand } as unknown as PlanApprovalWire["transport"],
  };
}

/** Exactly what cordum-app.tsx composes for the screen, from one frame. */
function propsFor(
  frame: SurfaceFrame, submit: unknown,
): React.ComponentProps<typeof ApprovePlan> {
  const runId = currentRunOf(frame, RECORDED.goalId, RECORDED.rejectedRunId);
  return {
    approval: {
      authorization: authorizeApproval(frame, runId),
      sentBack: planSentBack(frame, RECORDED.goalId, RECORDED.rejectedRunId),
      submit: submit as never,
    },
    goalId: RECORDED.goalId,
    onBack: vi.fn(),
    read: (): Promise<PlanningRunOutcome> => Promise.resolve(SEALED),
    runId,
    title: "Recovery goal",
  };
}

function renderAgainst(
  frame: SurfaceFrame, submit: (grant: ApprovalGrant, reason: string | null) => Promise<never> | Promise<unknown>,
): void {
  const runId = currentRunOf(frame, RECORDED.goalId, RECORDED.rejectedRunId);
  render(
    <ApprovePlan
      approval={{
        authorization: authorizeApproval(frame, runId),
        sentBack: planSentBack(frame, RECORDED.goalId, RECORDED.rejectedRunId),
        submit: submit as unknown as PlanApprovalWire extends never ? never
          : (grant: ApprovalGrant, reason: string | null) => Promise<{ commandId: string; ok: true }>,
      }}
      goalId={RECORDED.goalId}
      onBack={vi.fn()}
      read={((): Promise<PlanningRunOutcome> => Promise.resolve(SEALED))}
      runId={runId}
      title="Recovery goal"
    />,
  );
}

describe("the plan gate across a reject and the re-plan that follows", () => {
  it("reads 'Plan sent back' and offers NO decision while the successor is being compiled", async () => {
    const submit = vi.fn(() => Promise.resolve({ commandId: "unreached", ok: true as const }));
    renderAgainst(AFTER_REJECT, submit);
    const note = await screen.findByTestId("cr.approve.sent-back");
    expect(note.textContent).toBe("Plan sent back - waiting for a new plan");
    // No decision is being asked of the operator, so no control is rendered at all -
    // not a disabled one, which reads as a decision being refused.
    expect(screen.queryByTestId("cr.approve.button")).toBeNull();
    expect(screen.queryByTestId("cr.approve.reject")).toBeNull();
    expect(screen.queryByTestId("cr.approve.reason.input")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns the controls bound to the SUCCESSOR run once its offer appears, and dispatches THAT run", async () => {
    const sent: Record<string, unknown>[] = [];
    const wire = admittedWire((envelope) => {
      sent.push(envelope as Record<string, unknown>);
      return Promise.resolve({ delivered: true, response: { ok: true } });
    });
    const port = createPlanApprovalPort(wire);
    renderAgainst(AFTER_COMPILE, port.submit);
    // The banner is gone and the decision is back on the same frame.
    expect(await screen.findByTestId("cr.approve.button")).toBeTruthy();
    expect(screen.queryByTestId("cr.approve.sent-back")).toBeNull();
    await userEvent.type(screen.getByTestId("cr.approve.reason.input"), "still one node short");
    await userEvent.click(screen.getByTestId("cr.approve.reject"));
    await waitFor(() => { expect(sent).toHaveLength(1); });
    const envelope = sent[0] ?? {};
    // THE ASSERTION THIS STEP EXISTS FOR: the dispatch names the SUCCESSOR, not the
    // run the operator already rejected. Both are asserted, so a resolver that
    // returned the old run cannot pass by the payload merely being well-shaped.
    expect((envelope["payload"] as Record<string, unknown>)["runId"])
      .toBe(RECORDED.successorRunId);
    expect((envelope["payload"] as Record<string, unknown>)["runId"])
      .not.toBe(RECORDED.rejectedRunId);
    expect(envelope["targetAggregateId"]).toBe(RECORDED.successorRunId);
  });

  /**
   * THE REASON BOX MUST NOT OUTLIVE ITS RUN. Rejecting run A and then being offered its
   * successor B must not return the controls with A's reason still typed in and Reject
   * already enabled - that is one stray click from sending B back for a reason nobody
   * wrote about it. Asserted on the input's VALUE and on Reject being disabled, because
   * either alone would pass while the other half of the hazard remained.
   */
  it("clears the reason when the gate re-binds to a different run", async () => {
    const submit = vi.fn(() => Promise.resolve({ commandId: "unreached", ok: true as const }));
    const { rerender } = render(<ApprovePlan {...propsFor(AFTER_COMPILE, submit)} />);
    const input = await screen.findByTestId("cr.approve.reason.input");
    await userEvent.type(input, "typed against the first run");
    expect((screen.getByTestId("cr.approve.reason.input") as HTMLInputElement).value)
      .toBe("typed against the first run");
    expect((screen.getByTestId("cr.approve.reject") as HTMLButtonElement).disabled).toBe(false);
    // The same screen, now bound to a DIFFERENT run: an offer for another run id.
    rerender(<ApprovePlan {...propsFor(AFTER_COMPILE, submit)} runId={RECORDED.rejectedRunId} />);
    await waitFor(() => {
      expect((screen.getByTestId("cr.approve.reason.input") as HTMLInputElement).value).toBe("");
    });
    expect((screen.getByTestId("cr.approve.reject") as HTMLButtonElement).disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("approves the SUCCESSOR too, so the reject path did not strand the approve path", async () => {
    const sent: Record<string, unknown>[] = [];
    const wire = admittedWire((envelope) => {
      sent.push(envelope as Record<string, unknown>);
      return Promise.resolve({ delivered: true, response: { ok: true } });
    });
    renderAgainst(AFTER_COMPILE, createPlanApprovalPort(wire).submit);
    await userEvent.click(await screen.findByTestId("cr.approve.button"));
    await waitFor(() => { expect(sent).toHaveLength(1); });
    expect((sent[0] ?? {})["payload"]).toEqual({
      decision: "APPROVE",
      decisionReason: null,
      dependencyChanges: { additions: [], challenges: [], removals: [] },
      runId: RECORDED.successorRunId,
    });
  });
});
