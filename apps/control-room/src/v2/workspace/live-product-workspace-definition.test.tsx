import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import type { Gate1PendingViewV1 } from "../goals/gate1-v1-approval.js";
import { LiveProductWorkspace } from "./live-product-workspace.js";

const state = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, read: vi.fn(), submit: vi.fn() }));
vi.mock("./use-product-reads.js", () => ({ useProductReads: () => state.reads }));
vi.mock("./use-workspace-surface.js", () => ({ useWorkspaceSurface: () => null }));
vi.mock("../goals/gate1-v1-approval.js", async original => ({ ...await original<typeof import("../goals/gate1-v1-approval.js")>(),
  readPendingContractV1: state.read, createGate1ApprovalPortV1: () => ({ answer: vi.fn(), submit: state.submit }) }));
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
  state.reads = { source: null, design: null, coverage: null, criteria: null, preview: null, release: null,
    definition: null, definitionRef: null, refresh: vi.fn() };
});
afterEach(cleanup);

describe("definition observation before actionable canvas", () => {
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
