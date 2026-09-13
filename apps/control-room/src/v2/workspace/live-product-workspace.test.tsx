import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import type { CriterionEvidenceView } from "../../live/live-criterion-evidence-contracts.js";
import type { CriterionEvidenceOutcome } from "../../live/live-criterion-evidence-contracts.js";
import type { ProductWorkspaceInput } from "./product-model-contracts.js";
import { LiveProductWorkspace } from "./live-product-workspace.js";

const state = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock("./use-product-reads.js", () => ({ useProductReads: () => state.reads }));
vi.mock("./use-workspace-surface.js", () => ({ useWorkspaceSurface: () => null }));
vi.mock("../goals/approve-plan.js", () => ({ ApprovePlan: () => <button>Approve current plan</button> }));
vi.mock("../goals/plan-approval.js", () => ({ authorizeApproval: () => ({ status: "WITHHELD", code: "APPROVAL_SURFACE_UNREAD", layer: "CONTROL_ROOM_PLAN_APPROVAL" }), createPlanApprovalPort: () => ({ submit: vi.fn() }) }));
vi.mock("../goals/criterion-evidence-port.js", () => ({ createCriterionEvidencePort: () => null }));
vi.mock("../goals/publish-port.js", () => ({ createPublishPort: () => null }));
vi.mock("../goals/contract-gates.js", () => ({ useContractGates: () => null }));
vi.mock("../goals/contract-dossier.js", () => ({ ContractDossier: () => <p>Contract dossier</p> }));
vi.mock("../goals/design-version-note.js", () => ({ LiveDesignVersionNote: () => null }));
vi.mock("../goals/criterion-evidence-card.js", () => ({ CriterionEvidenceCard: ({ outcome }: { outcome: CriterionEvidenceOutcome | null }) =>
  outcome?.status === "CRITERION_EVIDENCE" ? <button>Run current checks</button> : <p>{outcome?.code ?? "Checks unavailable"}</p> }));
vi.mock("../goals/live-goal-release.js", () => ({ LiveGoalRelease: () => {
  const [submitted, setSubmitted] = useState(false);
  return submitted ? <p>Release submitted</p> : <button onClick={() => setSubmitted(true)}>Release current candidate</button>;
} }));
vi.mock("../goals/live-goal-deployments.js", () => ({ LiveGoalDeployments: () => <button>Deploy current candidate</button> }));
vi.mock("../goals/goal-environments.js", () => ({ LiveGoalEnvironments: () => null }));
vi.mock("../board/board-screen.js", () => ({ LiveBoard: () => <button>Publish current graph</button> }));
vi.mock("../goals/live-work-board.js", () => ({ LiveWorkBoard: () => null }));
vi.mock("./live-product-definition.js", () => ({ LiveProductDefinition: ({ expectedRef }: {
  expectedRef?: { revisionDigest: string } | null;
}) => <p>Definition review: {expectedRef?.revisionDigest ?? "current"}</p> }));

const contractRef = { contractId: "contract", revisionId: "revision", revisionDigest: "digest" };
const view: CriterionEvidenceView = { outcome: "CRITERION_EVIDENCE", goalRef: "goal", planningRunRef: "run",
  contractRef, graphContentHash: "graph", integratedArtifact: { sha: "candidate", treeSha: "tree" }, criteria: [], run: null, verifyOffer: null };
const source = { status: "GOAL_SOURCE", sourceRef: "source", text: "PRD", contentSha256: "source-digest",
  displayPath: "PRD.md", byteLength: 3, mediaType: "text/markdown" } as const;
const release = { status: "PRESENT", evidence: { goalId: "goal", goalTitle: "Product", ancestryMeasured: true, criteria: [],
  preview: null, reviewRounds: [], sha: "candidate", receipt: { dossierSha256: "dossier", outcome: "RELEASED",
    prUrl: null, receiptId: "old-release", refusalCode: null, sha: "old-candidate" } } } as const;
const setup = { headers: {}, projectId: "project", commandAuthorityPlane: "V1" } as LiveSetup;
function show(artifactId: string) {
  const update = vi.fn();
  render(<LiveProductWorkspace setup={setup} route={{ kind: "board", goalId: "goal", planningRunRef: "run", title: "Product" }}
    query={{ goalId: "goal", artifactId, inspector: "record" }} update={update} onBack={vi.fn()} onNeedsYou={vi.fn()} onConnection={vi.fn()} />);
  return update;
}
beforeEach(() => { state.reads = { source, release, criteria: { status: "CRITERION_EVIDENCE", view }, design: null,
  preview: null, coverage: null, definition: { status: "NONE" }, definitionRef: null, refresh: vi.fn() }; });
afterEach(cleanup);

describe("selected version action context", () => {
  it("keeps a still-live old release inspectable without mounting current candidate controls", async () => {
    const user = userEvent.setup(); const update = show("release:old-release");
    expect(screen.getByRole("heading", { name: "A version ready for delivery" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve current plan" })).toBeNull();
    for (const tab of ["Checks", "Delivery", "Technical detail"]) {
      await user.click(screen.getByRole("button", { name: tab }));
      for (const name of ["Run current checks", "Release current candidate", "Deploy current candidate", "Publish current graph"])
        expect(screen.queryByRole("button", { name })).toBeNull();
    }
    await user.click(screen.getByRole("button", { name: "Review current work" }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "build:run:graph:digest:candidate" }));
  });
  it("keeps source review's current product workflow and names its current plan context", () => {
    show("source:source-digest");
    expect(screen.getByRole("button", { name: "Approve current plan" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Current product work" }).textContent).toContain("run");
  });
  it("does not block normal source review while candidate evidence is loading", () => {
    state.reads.criteria = null; show("source:source-digest");
    expect(screen.getByRole("button", { name: "Approve current plan" })).toBeTruthy();
  });
  it("keeps a matching current candidate's own controls available", async () => {
    const user = userEvent.setup(); show("build:run:graph:digest:candidate");
    expect(screen.getByRole("button", { name: "Approve current plan" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delivery" }));
    expect(screen.getByRole("button", { name: "Release current candidate" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Current product work" }).textContent).toContain("candidate");
  });
  it("keeps checks unavailable when a live preview has no established current candidate", () => {
    state.reads.criteria = null;
    state.reads.preview = { status: "PREVIEW", preview: { goalId: "goal", receiptId: "preview", sha: "old-candidate",
      outcome: "STARTED", code: null, decidedAt: "2026-09-13T00:00:00Z", screenshots: [], url: null } };
    show("preview:preview"); expect(screen.queryByRole("button", { name: "Approve current plan" })).toBeNull();
  });
  it.each([false, true])("binds the current run design exactly (mismatch=%s)", (mismatch) => {
    state.reads.design = { status: "DESIGN", versions: [1], record: { contractRef: mismatch ? { ...contractRef, revisionId: "old" } : contractRef,
      goalRef: "goal", projectId: "project", version: 1, profile: "web", schemaVersion: "design/1",
      submittedAt: "2026-09-13T00:00:00Z", revision: { skipped: true, reason: "API only" } } } satisfies ProductWorkspaceInput["design"];
    show("design:1:digest");
    expect(screen.queryByRole("button", { name: "Approve current plan" }) !== null).toBe(!mismatch);
  });
  it("keeps the viewed definition bound in the production record before compilation", async () => {
    const user = userEvent.setup(); state.reads.criteria = null;
    state.reads.definitionRef = { ...contractRef, plane: "V1" };
    const update = show("definition:V1:contract:revision:digest");
    const canvasReview = screen.getByText("Definition review: digest");
    expect(screen.getByRole("button", { name: "Approve current plan" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Definition" }));
    expect(screen.getByText("Definition review: digest")).toBe(canvasReview);
    await user.click(screen.getByRole("button", { name: "Review definition" }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ inspector: null }));
  });
  it("binds the definition record to the selected candidate contract", async () => {
    const user = userEvent.setup(); show("build:run:graph:digest:candidate");
    await user.click(screen.getByRole("button", { name: "Definition" }));
    expect(screen.getByText("Definition review: digest")).toBeTruthy();
  });
  it.each(["session", "version", "run", "candidate", "contract"] as const)("drops held release state on a %s transition", async (transition) => {
    const user = userEvent.setup();
    const props = { setup, route: { kind: "board" as const, goalId: "goal", planningRunRef: "run", title: "Product" },
      query: { goalId: "goal", artifactId: "source:source-digest", inspector: "record" as const },
      update: vi.fn(), onBack: vi.fn(), onNeedsYou: vi.fn(), onConnection: vi.fn() };
    const rendered = render(<LiveProductWorkspace {...props} />);
    await user.click(screen.getByRole("button", { name: "Delivery" }));
    await user.click(screen.getByRole("button", { name: "Release current candidate" }));
    expect(screen.getByText("Release submitted")).toBeTruthy();
    if (transition === "run") state.reads.criteria = { status: "CRITERION_EVIDENCE", view: { ...view, planningRunRef: "next-run" } };
    if (transition === "candidate") state.reads.criteria = { status: "CRITERION_EVIDENCE", view: { ...view, integratedArtifact: { sha: "next-candidate", treeSha: "next-tree" } } };
    if (transition === "contract") state.reads.criteria = { status: "CRITERION_EVIDENCE", view: { ...view, contractRef: { ...contractRef, revisionId: "next-revision" } } };
    rendered.rerender(<LiveProductWorkspace {...props}
      setup={transition === "session" ? { ...setup, headers: { session: "replacement" } } : setup}
      route={transition === "run" ? { ...props.route, planningRunRef: "next-run" } : props.route}
      query={transition === "version" ? { ...props.query, artifactId: "build:run:graph:digest:candidate" } : props.query} />);
    expect(screen.queryByText("Release submitted")).toBeNull();
    expect(screen.getByRole("button", { name: "Release current candidate" })).toBeTruthy();
  });
  it.each([{ goalRef: "other-goal" }, { planningRunRef: "other-run" }])("cuts off mismatched criterion offers even during source review: %j", async (patch) => {
    const user = userEvent.setup(); state.reads.criteria = { status: "CRITERION_EVIDENCE", view: { ...view, ...patch } };
    show("source:source-digest");
    await user.click(screen.getByRole("button", { name: "Checks" }));
    expect(screen.queryByRole("button", { name: "Run current checks" })).toBeNull();
    expect(screen.getByText("PRODUCT_CRITERIA_SUBJECT_MISMATCH")).toBeTruthy();
  });
});
