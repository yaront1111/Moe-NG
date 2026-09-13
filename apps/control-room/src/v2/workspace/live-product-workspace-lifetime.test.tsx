import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import { LiveProductWorkspace } from "./live-product-workspace.js";

const state = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, submit: vi.fn() }));
vi.mock("./use-product-reads.js", () => ({ useProductReads: () => state.reads }));
vi.mock("./use-workspace-surface.js", () => ({ useWorkspaceSurface: () => null }));
vi.mock("../goals/approve-plan.js", () => ({ ApprovePlan: () => null }));
vi.mock("../goals/live-goal-deployments.js", () => ({ LiveGoalDeployments: () => null }));
vi.mock("../goals/goal-environments.js", () => ({ LiveGoalEnvironments: () => null }));
vi.mock("../goals/live-goal-release.js", async () => {
  const { GoalRelease } = await import("../goals/goal-release.js");
  return { LiveGoalRelease: () => <GoalRelease goalId="goal" port={{ submit: state.submit }}
    frame={{ connection: "CONNECTED", detail: "", outcome: "SURFACE", steps: [], offers: [
      { commandId: "release-command", commandKind: "release.decide", targetAggregateId: "release:goal" },
    ] }} evidence={{ ancestryMeasured: true, criteria: [], goalId: "goal", goalTitle: "Product", preview: null,
      receipt: null, reviewRounds: [], sha: "candidate" }} /> };
});

const setup = { headers: {}, projectId: "project", commandAuthorityPlane: "V1" } as LiveSetup;
const props = { setup, route: { kind: "board" as const, goalId: "goal", planningRunRef: "run", title: "Product" },
  update: vi.fn(), onBack: vi.fn(), onNeedsYou: vi.fn(), onConnection: vi.fn() };
const view = { outcome: "CRITERION_EVIDENCE", goalRef: "goal", planningRunRef: "run",
  contractRef: { contractId: "contract", revisionId: "revision", revisionDigest: "digest" },
  graphContentHash: "graph", integratedArtifact: { sha: "candidate", treeSha: "tree" }, criteria: [], run: null, verifyOffer: null };
beforeEach(() => {
  state.submit.mockReset();
  state.reads = { source: { status: "GOAL_SOURCE", text: "PRD", sourceRef: "source", contentSha256: "source", displayPath: "PRD.md" },
    design: null, coverage: null, criteria: { status: "CRITERION_EVIDENCE", view },
    preview: { status: "PREVIEW", preview: { goalId: "goal", receiptId: "preview", sha: "candidate", outcome: "STARTED", code: null,
      decidedAt: "2026-09-13T00:00:00Z", screenshots: [], url: null } },
    release: { status: "ABSENT", goalId: "goal" }, definition: { status: "NONE" }, definitionRef: null, refresh: vi.fn() };
});
afterEach(cleanup);

it.each([
  ["source:source", "criteria"], ["build:run:graph:digest:candidate", "criteria"], ["preview:preview", "preview"],
])("retains pending release on %s through a transient %s read failure", async (artifactId, failingRead) => {
  const user = userEvent.setup(); let finish!: (outcome: OfferOutcome) => void;
  state.submit.mockImplementation(() => new Promise<OfferOutcome>(resolve => { finish = resolve; }));
  const query = { goalId: "goal", artifactId, inspector: "record" as const };
  const rendered = render(<LiveProductWorkspace {...props} query={query} />);
  await user.click(screen.getByRole("button", { name: "Delivery" }));
  await user.clear(screen.getByTestId("cr.release.base"));
  await user.type(screen.getByTestId("cr.release.base"), "release-train");
  await user.click(screen.getByTestId("cr.release.button"));
  await user.click(screen.getByTestId("cr.release.button"));
  expect(state.submit).toHaveBeenCalledOnce();
  const button = screen.getByTestId("cr.release.button");
  const successful = state.reads[failingRead];
  state.reads = { ...state.reads, [failingRead]: { status: "ERROR", code: "TEMPORARY_READ_FAILURE", layer: "HTTP" } };
  rendered.rerender(<LiveProductWorkspace {...props} query={query} />);
  expect(button.isConnected).toBe(true);
  expect(button.closest("[hidden][inert]")).not.toBeNull();
  await user.click(button);
  expect(state.submit).toHaveBeenCalledOnce();
  const settledWhileUnavailable = failingRead === "preview";
  if (settledWhileUnavailable) await act(async () => { finish({ ok: false, code: "EXACT_RELEASE_REFUSAL", layer: "RELEASE_AUTHORITY" }); });
  state.reads = { ...state.reads, [failingRead]: successful };
  rendered.rerender(<LiveProductWorkspace {...props} query={query} />);
  expect(screen.getByTestId("cr.release.button")).toBe(button);
  expect((button as HTMLButtonElement).disabled).toBe(!settledWhileUnavailable);
  expect((screen.getByTestId("cr.release.base") as HTMLInputElement).value).toBe("release-train");
  if (!settledWhileUnavailable) await act(async () => { finish({ ok: false, code: "EXACT_RELEASE_REFUSAL", layer: "RELEASE_AUTHORITY" }); });
  expect(screen.getByTestId("cr.release.answer").textContent).toContain("EXACT_RELEASE_REFUSAL");
  expect(state.submit).toHaveBeenCalledOnce();
});

it("blocks a retained release confirmation while candidate evidence is unreadable", async () => {
  const user = userEvent.setup();
  const query = { goalId: "goal", artifactId: "source:source", inspector: "record" as const };
  const rendered = render(<LiveProductWorkspace {...props} query={query} />);
  await user.click(screen.getByRole("button", { name: "Delivery" }));
  const button = screen.getByTestId("cr.release.button");
  await user.click(button);
  state.reads = { ...state.reads, criteria: { status: "ERROR", code: "TEMPORARY_READ_FAILURE", layer: "HTTP" } };
  rendered.rerender(<LiveProductWorkspace {...props} query={query} />);
  expect(button.isConnected).toBe(true);
  expect(button.closest("fieldset[disabled]")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Approve this release and open its pull request" })).toBeNull();
  await user.click(button);
  expect(state.submit).not.toHaveBeenCalled();
});
