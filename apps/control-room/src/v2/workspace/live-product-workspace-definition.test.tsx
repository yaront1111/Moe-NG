import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import type { Gate1PendingViewV1 } from "../goals/gate1-v1-approval.js";
import { LiveProductWorkspace } from "./live-product-workspace.js";
import { useProductRoute } from "./use-product-route.js";

const state = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, read: vi.fn(), submit: vi.fn(), answer: vi.fn() }));
vi.mock("./use-product-reads.js", () => ({ useProductReads: () => state.reads }));
vi.mock("./use-workspace-surface.js", () => ({ useWorkspaceSurface: () => null }));
vi.mock("../../live/live-goal-catalog.js", () => ({ readGoalCatalog: async () => ({ outcome: "GOALS", goals: [
  { goalId: "goal", planningRunRef: "", brief: { title: "Product" } },
] }) }));
vi.mock("../goals/gate1-v1-approval.js", async original => ({ ...await original<typeof import("../goals/gate1-v1-approval.js")>(),
  readPendingContractV1: state.read, createGate1ApprovalPortV1: () => ({ answer: state.answer, submit: state.submit }) }));
const pending: Gate1PendingViewV1 = { status: "PENDING", contractId: "contract", revisionId: "revision", revisionDigest: "digest",
  approval: { affordance: {}, commandId: "approval", requestDigest: "request" }, clarifications: [],
  criteria: [{ criterionId: "criterion", statement: "Exact criterion" }], requirements: [{ requirementId: "requirement", statement: "Exact requirement" }] };
const reference = { plane: "V1", contractId: "contract", revisionId: "revision", revisionDigest: "digest" } as const;
const setup = { headers: {}, projectId: "project", commandAuthorityPlane: "V1" } as LiveSetup;
const artifactId = `definition:${reference.plane}:${reference.contractId}:${reference.revisionId}:${reference.revisionDigest}`;
function workspace(selected: string | null = null, inspector: "record" | null = null) {
  return <LiveProductWorkspace setup={setup} route={{ kind: "board", goalId: "goal", planningRunRef: "", title: "Product" }}
    query={{ goalId: "goal", artifactId: selected, inspector }} update={vi.fn()} onBack={vi.fn()} onNeedsYou={vi.fn()} onConnection={vi.fn()} />;
}
beforeEach(() => {
  state.read.mockReset().mockResolvedValue(pending);
  state.submit.mockReset().mockReturnValue(new Promise(() => undefined));
  state.answer.mockReset().mockReturnValue(new Promise(() => undefined));
  state.reads = { source: null, design: null, coverage: null, criteria: null, preview: null, release: null,
    definition: null, definitionRef: null, refresh: vi.fn() };
});
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

function RoutedWorkspace() {
  const navigation = useProductRoute(setup, "");
  return navigation.open === null || navigation.query === null ? null : <LiveProductWorkspace
    setup={setup} route={navigation.open} query={navigation.query} update={navigation.update}
    onBack={navigation.back} onNeedsYou={vi.fn()} onConnection={vi.fn()} />;
}

describe("definition observation before actionable canvas", () => {
  it("workspace Refresh reaches the already-mounted exact definition reader", async () => {
    state.reads.definition = pending; state.reads.definitionRef = reference;
    state.read.mockResolvedValueOnce({ status: "ERROR", code: "DEFINITION_TRANSIENT", layer: "HTTP" });
    render(workspace(artifactId));
    expect((await screen.findByTestId("cr.gate1.refusal")).textContent).toContain("DEFINITION_TRANSIENT");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh product status" })); });
    await screen.findByTestId("cr.gate1.approve");
    expect(state.read).toHaveBeenCalledTimes(2);
  });

  it.each(["approve", "clarification"] as const)("pins a default definition on %s before slow unrelated reads and preserves its pending outcome", async decision => {
    let finish!: (outcome: { ok: false; code: string; layer: string }) => void;
    const dispatch = decision === "approve" ? state.submit : state.answer;
    dispatch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const decisionPending = decision === "approve" ? pending : { ...pending, approval: null, clarifications: [{
      clarificationId: "question", question: "Which option?", answered: false, answerAffordance: {},
      options: [{ optionId: "option", label: "Choose option" }], optionDigests: [{ optionId: "option", projectionDigest: "projection" }],
    }] };
    state.read.mockResolvedValue(decisionPending);
    state.reads.definition = decisionPending; state.reads.definitionRef = reference;
    state.reads.source = { status: "GOAL_SOURCE", text: "PRD", contentSha256: "source", sourceRef: "source", displayPath: "PRD.md" };
    window.history.replaceState(null, "", "/?product=goal");
    const view = render(<RoutedWorkspace />);
    const approval = await screen.findByTestId(decision === "approve" ? "cr.gate1.approve" : "cr.gate1.answer.question.option");
    expect(new URLSearchParams(window.location.search).get("artifact")).toBeNull();
    await act(async () => { fireEvent.click(approval); });
    state.reads.definition = { status: "NONE" }; state.reads.definitionRef = null;
    view.rerender(<RoutedWorkspace />);
    expect(approval.isConnected).toBe(true);
    expect(approval.matches(":disabled")).toBe(true);
    expect(new URLSearchParams(window.location.search).get("artifact")).toBe(artifactId);
    await act(async () => { finish({ ok: false, code: "EXACT_LATE_REFUSAL", layer: "DAEMON" }); });
    await waitFor(() => expect(screen.getByTestId("cr.gate1.dispatchrefusal").textContent).toContain("EXACT_LATE_REFUSAL"));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([null, { status: "NONE" }, { status: "ERROR", code: "READ_FAILED", layer: "READ" }])(
    "does not expose an independently read approval before a coordinator binding: %j", async (definition) => {
      state.reads.definition = definition;
      await act(async () => { render(workspace()); });
      expect(state.read).not.toHaveBeenCalled();
      expect(screen.queryByTestId("cr.gate1.approve")).toBeNull();
      expect(state.submit).not.toHaveBeenCalled();
    });
  it("starts the exact bound card once and keeps its pending decision through later read arrivals", async () => {
    const view = render(workspace());
    state.reads.definition = pending; state.reads.definitionRef = reference;
    await act(async () => { view.rerender(workspace()); });
    const approval = await screen.findByTestId("cr.gate1.approve");
    await act(async () => { fireEvent.click(approval); });
    expect((approval as HTMLButtonElement).disabled).toBe(true);
    state.reads.definitionRef = { ...reference };
    state.reads.source = { status: "GOAL_SOURCE", text: "PRD", contentSha256: "source", sourceRef: "source",
      displayPath: "PRD.md", byteLength: 3, mediaType: "text/markdown" };
    await act(async () => { view.rerender(workspace()); });
    expect(screen.getByTestId("cr.gate1.approve")).toBe(approval);
    expect((approval as HTMLButtonElement).disabled).toBe(true);
    expect(state.read).toHaveBeenCalledTimes(1);
    expect(state.submit).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("keeps the exact decision result when pending disappears before dispatch settles: accepted=%s", async accepted => {
    let finish!: (outcome: { ok: boolean; code?: string; layer?: string }) => void;
    state.submit.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    state.reads.definition = pending; state.reads.definitionRef = reference;
    const view = render(workspace(artifactId));
    const approval = await screen.findByTestId("cr.gate1.approve");
    await act(async () => { fireEvent.click(approval); });
    state.read.mockResolvedValue({ status: "NONE" });
    state.reads.definition = { status: "NONE" }; state.reads.definitionRef = null;
    await act(async () => { view.rerender(workspace(artifactId)); });
    expect(screen.getByTestId("cr.gate1.approve")).toBe(approval);
    expect(approval.matches(":disabled")).toBe(true);
    expect(document.body.textContent).toContain("Current checks and actions do not apply");
    await act(async () => { finish(accepted ? { ok: true } : { ok: false, code: "APPROVAL_REFUSED", layer: "DAEMON" }); });
    if (accepted) {
      expect(screen.getByTestId("cr.gate1.approved")).toBeTruthy();
      expect(screen.queryByTestId("cr.gate1.approve")).toBeNull();
      expect(document.body.textContent).not.toContain("VIEWED_DEFINITION_CHANGED");
    } else {
      expect(screen.getByTestId("cr.gate1.dispatchrefusal").textContent).toContain("APPROVAL_REFUSED");
      expect(screen.getByTestId("cr.gate1.approve").matches(":disabled")).toBe(true);
      await act(async () => { fireEvent.click(screen.getByTestId("cr.gate1.approve")); });
    }
    expect(state.submit).toHaveBeenCalledTimes(1);
  });

  it("preserves the same approval handoff in the source artifact's Definition record", async () => {
    let finish!: (outcome: { ok: true }) => void;
    state.submit.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    state.reads.source = { status: "GOAL_SOURCE", text: "PRD", contentSha256: "source", sourceRef: "source",
      displayPath: "PRD.md", byteLength: 3, mediaType: "text/markdown" };
    state.reads.definition = pending; state.reads.definitionRef = reference;
    const view = render(workspace("source:source", "record"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Definition$/ })); });
    const approval = await screen.findByTestId("cr.gate1.approve");
    await act(async () => { fireEvent.click(approval); });
    state.read.mockResolvedValue({ status: "NONE" });
    state.reads.definition = { status: "NONE" }; state.reads.definitionRef = null;
    await act(async () => { view.rerender(workspace("source:source", "record")); });
    expect(screen.getByTestId("cr.gate1.approve")).toBe(approval);
    expect(approval.matches(":disabled")).toBe(true);
    await act(async () => { finish({ ok: true }); });
    expect(screen.getByTestId("cr.gate1.approved")).toBeTruthy();
    expect(state.submit).toHaveBeenCalledTimes(1);
  });
});
