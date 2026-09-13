import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import type { PlanningRunOutcome } from "../../live/live-planning-run.js";
import { LiveProductWorkspace } from "./live-product-workspace.js";

const state = vi.hoisted(() => ({ plan: vi.fn(), design: vi.fn(), submit: vi.fn(), refresh: vi.fn() }));
vi.mock("./use-workspace-surface.js", () => ({ useWorkspaceSurface: () => null }));
vi.mock("../../live/live-planning-run.js", () => ({ readPlanningRun: state.plan }));
vi.mock("../../live/live-design.js", () => ({ readDesign: state.design }));
vi.mock("../goals/plan-approval.js", () => ({ createPlanApprovalPort: () => ({ submit: state.submit }),
  PLAN_APPROVAL_LAYER: "CONTROL_ROOM_PLAN_APPROVAL", authorizeApproval: () => ({ status: "AUTHORIZED", grant: {
    runId: "run", affordance: { commandId: "offer", commandKind: "approval.decide_intent", targetAggregateId: "run", expectedVersion: 7 },
  } }) }));
vi.mock("./use-product-reads.js", () => ({ useProductReads: () => ({
  source: { status: "GOAL_SOURCE", text: "PRD", contentSha256: "source", sourceRef: "source", displayPath: "PRD.md" },
  design: null, coverage: null, criteria: null, preview: null, release: null,
  definition: { status: "NONE" }, definitionRef: null, refresh: state.refresh,
}) }));
const ready: PlanningRunOutcome = { status: "RUN", runId: "run", lifecycle: "PLAN_REVIEW", submissionHash: "submission",
  approval: "ABSENT", sealed: true, reviewable: true,
  plan: { planHash: "plan", affectedNodeIds: ["node"], affectedCriterionIds: ["criterion"],
    steps: [{ stepId: "step", kind: "node.deliver", description: "Exact current plan" }] },
  acceptance: { criteriaDigest: "criteria", obligations: [] },
};
beforeEach(() => {
  state.refresh.mockReset(); state.submit.mockReset();
  state.plan.mockReset().mockResolvedValueOnce({ status: "ERROR", code: "PLAN_TRANSIENT", layer: "HTTP" }).mockResolvedValue(ready);
  state.design.mockReset().mockResolvedValueOnce({ status: "ERROR", code: "DESIGN_TRANSIENT", layer: "HTTP" }).mockResolvedValue({
    status: "DESIGN", versions: [1], record: { version: 1, revision: {} },
  });
});
afterEach(cleanup);

it("Refresh recovers retained plan and pinned-design reads without resetting pending decisions or refusal", async () => {
  const setup = { headers: {}, projectId: "project", commandAuthorityPlane: "V1" } as LiveSetup;
  render(<LiveProductWorkspace setup={setup} route={{ kind: "board", goalId: "goal", planningRunRef: "run", title: "Product" }}
    query={{ goalId: "goal", artifactId: "source:source", inspector: "record" }} update={vi.fn()} onBack={vi.fn()} onNeedsYou={vi.fn()} onConnection={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId("cr.approve.refusal").textContent).toContain("PLAN_TRANSIENT"));
  await waitFor(() => expect(screen.getByTestId("cr.approve.design-version").textContent).toContain("DESIGN_TRANSIENT"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh product status" })); });
  await waitFor(() => expect(state.plan).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Exact current plan")).toBeTruthy();
  expect(screen.getByTestId("cr.approve.design-version").textContent).toContain("Design version 1");
  const reason = screen.getByTestId("cr.approve.reason.input") as HTMLInputElement;
  fireEvent.change(reason, { target: { value: "Keep this reason" } });
  let finish!: (outcome: { ok: false; code: string; layer: string }) => void;
  state.submit.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => { fireEvent.click(screen.getByTestId("cr.approve.reject")); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh product status" })); });
  expect(screen.getByTestId("cr.approve.reason.input")).toBe(reason);
  expect(reason.disabled).toBe(true); expect(reason.value).toBe("Keep this reason");
  expect(state.submit).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ ok: false, code: "REJECT_REFUSED", layer: "DAEMON" }); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh product status" })); });
  expect(screen.getByTestId("cr.approve.dispatch-refusal").textContent).toContain("REJECT_REFUSED");
  expect(reason.value).toBe("Keep this reason");
  expect(state.plan).toHaveBeenCalledTimes(4); expect(state.design).toHaveBeenCalledTimes(4);
  expect(state.refresh).toHaveBeenCalledTimes(3);
});
