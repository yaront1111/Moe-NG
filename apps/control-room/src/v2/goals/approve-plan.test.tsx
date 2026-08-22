import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { PlanningRunOutcome } from "../../live/live-planning-run.js";
import { ApprovePlan } from "./approve-plan.js";

/**
 * The PLAN-REVIEW screen (UI-6). It READS through an injected `read` and RENDERS;
 * it must never dispatch (it imports nothing that authors state), and the Approve
 * control must stay disabled with an honest backend-gap note. The read is a plain
 * stub here, so a stubbed global fetch proves the screen makes no request of its
 * own beyond the injected read.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SEALED_REVIEWABLE: PlanningRunOutcome = Object.freeze({
  acceptance: {
    criteriaDigest: "cd-1",
    obligations: [{
      criterionId: "crit-1",
      evidenceRequirements: [{ evidenceRef: "ev-1", kind: "TEST", requirementId: "req-1" }],
      statement: "The store recovers from a fresh genesis",
      verificationRecipeRefs: ["recipe-1"],
    }],
  },
  lifecycle: "PLAN_REVIEW",
  plan: {
    affectedCriterionIds: ["crit-1"],
    affectedNodeIds: ["node-1"],
    planHash: "plan-hash-1",
    steps: [{ description: "Write the recovery contract", kind: "node.deliver", stepId: "step-1" }],
  },
  reviewable: true,
  runId: "run-live-1",
  sealed: true,
  status: "RUN",
  submissionHash: "sub-hash-1",
});

const UNSEALED: PlanningRunOutcome = Object.freeze({
  acceptance: null,
  lifecycle: "PLANNING",
  plan: null,
  reviewable: false,
  runId: "run-live-1",
  sealed: false,
  status: "RUN",
  submissionHash: "sub-hash-1",
});

const REFUSED: PlanningRunOutcome = Object.freeze({
  code: "PLANNING_RUN_READ_CAPABILITY_DENIED",
  layer: "PLANNING_RUN_READ",
  status: "REFUSED",
});

function renderScreen(outcome: PlanningRunOutcome): (runId: string) => Promise<PlanningRunOutcome> {
  const read = vi.fn((_runId: string) => Promise.resolve(outcome));
  render(<ApprovePlan goalId="goal-live-1" onBack={vi.fn()} read={read} runId="run-live-1" title="Recovery goal" />);
  return read;
}

describe("the plan-review screen renders the run it read", () => {
  it("renders the plan steps, an obligation, and the ready banner for a sealed reviewable run", async () => {
    renderScreen(SEALED_REVIEWABLE);
    expect(await screen.findByTestId("cr.approve.step.step-1")).toBeTruthy();
    expect(screen.getByTestId("cr.approve.step.step-1").textContent).toContain("Write the recovery contract");
    expect(screen.getByTestId("cr.approve.obligation.crit-1").textContent)
      .toContain("The store recovers from a fresh genesis");
    expect(screen.getByTestId("cr.approve.banner").textContent).toBe("Ready for your approval");
  });

  it("renders the honest not-sealed empty when the bodies do not verify", async () => {
    renderScreen(UNSEALED);
    expect(await screen.findByTestId("cr.approve.empty")).toBeTruthy();
    expect(screen.getByTestId("cr.approve.empty").textContent)
      .toContain("The plan is not sealed yet; nothing to review.");
    expect(screen.queryByTestId("cr.approve.plan")).toBeNull();
  });

  it("names the refusal code plainly, never a blank surface", async () => {
    renderScreen(REFUSED);
    const line = await screen.findByTestId("cr.approve.refusal");
    expect(line.textContent).toContain("PLANNING_RUN_READ_CAPABILITY_DENIED");
    expect(line.textContent).toContain("PLANNING_RUN_READ");
  });
});

describe("the Approve control is present but disabled and never dispatches", () => {
  it("renders Approve DISABLED with the backend-gap honesty note", async () => {
    renderScreen(SEALED_REVIEWABLE);
    const button = await screen.findByTestId("cr.approve.button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("cr.approve.note").textContent)
      .toContain("no fabricated decision is posted");
  });

  it("makes no request of its own beyond the injected read", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("the screen must not fetch")));
    vi.stubGlobal("fetch", fetchMock);
    const read = renderScreen(SEALED_REVIEWABLE);
    await screen.findByTestId("cr.approve.step.step-1");
    await waitFor(() => { expect(read).toHaveBeenCalledTimes(1); });
    // The screen reads through the injected fn ONLY; it authors nothing and calls
    // no transport of its own (it imports no dispatch).
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
