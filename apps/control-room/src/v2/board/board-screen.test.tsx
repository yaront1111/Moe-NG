import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ActivityOutcome } from "../../live/live-activity.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import { BOARD_COLUMNS } from "./board-columns.js";
import { toneOf } from "./board-feed.js";
import { BoardScreen, LiveBoard } from "./board-screen.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NOW = Date.parse("2026-09-04T08:30:00.000Z");
const GOAL = "goal-1";
const RUN = "run-1";

function node(nodeKey: string, status: RunNodeView["status"], extra: Partial<RunNodeView> = {}): RunNodeView {
  return {
    accepted: null, claim: null, criterionIds: [], dependsOn: [], landing: null, lastActivityAt: null, nodeKey,
    objective: `Objective of ${nodeKey}`, receipt: null,
    review: { escalated: false, findings: [], latestRoute: null, rounds: 0, unreadable: false, unsuccessfulRounds: 0, version: 0 },
    sharedKey: false, status, ...extra,
  };
}

const FINDING = { detail: "the second anchor is dropped on ingest", round: 2, ruleId: "R-anchor", severity: "HIGH", subject: "evidence" };
const NODES: readonly RunNodeView[] = [
  node("n-done", "ACCEPTED", { accepted: { verifierReceiptId: "receipt-done" }, criterionIds: ["crit-1"], landing: { branch: "master", code: null, files: ["a.ts", "b.ts"], outcome: "COMMITTED", sha: "4f2a91cdef00" } }),
  node("n-work", "IN_PROGRESS", { claim: { active: true, claimedBy: "sess-wrap-1", expiresAt: "2026-09-04T08:42:00.000Z", status: "OPEN" }, lastActivityAt: "2026-09-04T08:20:00.000Z" }),
  node("n-queue", "READY", { dependsOn: ["n-work"] }),
  node("n-rework", "READY", { review: { escalated: false, findings: [FINDING], latestRoute: "REJECT_IMPLEMENTATION", rounds: 2, unreadable: false, unsuccessfulRounds: 2, version: 5 } }),
  node("n-review", "DELIVERED", { lastActivityAt: "2026-09-04T08:28:00.000Z" }),
  node("n-stuck", "ESCALATION_REQUIRED", { review: { escalated: false, findings: [FINDING], latestRoute: "REJECT_PLAN", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 9 } }),
];

const RUNS: RunsOutcome = {
  goals: [{ goalId: GOAL, lifecycle: "EXECUTION_ENABLED", nodes: NODES, publish: null, run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: RUN }, title: "Evidence ledger" }],
  status: "RUNS",
  totals: { ACCEPTED: 1, BLOCKED: 0, DELIVERED: 1, ESCALATED: 0, ESCALATION_REQUIRED: 1, IN_PROGRESS: 1, READY: 2, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: 6 },
};

const COVERAGE: DocumentCoverageOutcome = {
  contracts: [{
    contractId: "contract-1", gate1: "APPROVED", plane: "V1", requirements: [{
      criteria: [
        { criterionId: "crit-1", nodeKey: "n-done", statement: "Ingest persists before extraction", status: "VERIFIED" },
        { criterionId: "crit-2", nodeKey: "n-work", statement: "Evidence survives a throwing extractor", status: "PLANNED" },
      ],
      requirementId: "req-1", statement: "The ledger is durable",
    }], revisionDigest: "d".repeat(64), revisionId: "rev-1",
  }],
  document: { byteLength: 120, contentSha256: "c".repeat(64), displayPath: "PRD.md" },
  goals: [{ goalId: GOAL, lastActivityAt: null, lifecycle: "EXECUTION_ENABLED", planningRunRef: RUN, title: "Evidence ledger" }],
  sections: [],
  status: "COVERAGE",
  totals: { contracts: 1, criteria: 2, goals: 1, planned: 1, requirements: 1, unattributable: 0, verified: 1 },
};

const SURFACE: SurfaceFrame = {
  connection: "CONNECTED", detail: "", offers: [], outcome: "SURFACE", planningGoalRef: GOAL, planningGoalRefs: { [RUN]: GOAL },
  steps: [
    { aggregateId: "n-done", claim: null, kind: "node.deliver", missing: [], status: "COMMITTED", version: 3 },
    { aggregateId: "n-work", claim: { claimedBy: "sess-wrap-1", expiresAt: "2026-09-04T08:42:00.000Z" }, kind: "node.deliver", missing: [], status: "READY", version: 1 },
  ],
} as unknown as SurfaceFrame;

const ACTIVITY: ActivityOutcome = {
  entries: [
    { commandKind: "review.submit", decidedAt: "2026-09-04T08:25:00.000Z", disposition: "COMMITTED", principalId: "daemon:node-verifier", targetAggregateId: "n-rework", verdict: "REJECT_IMPLEMENTATION", version: 5 },
    { commandKind: "approval.decide_intent", decidedAt: "2026-09-04T08:18:00.000Z", disposition: "COMMITTED", principalId: "operator-local", targetAggregateId: RUN, verdict: null, version: 2 },
    { commandKind: "planning.submit_decomposition", decidedAt: "2026-09-04T08:08:00.000Z", disposition: "COMMITTED", principalId: "sess-wrap-0", targetAggregateId: GOAL, verdict: null, version: 1 },
    { commandKind: "OPEN_SESSION", decidedAt: "2026-09-04T08:00:00.000Z", disposition: "COMMITTED", principalId: "operator-local", targetAggregateId: "moe.session-authority.v1/session/s-1", verdict: null, version: 1 },
  ],
  refusalsRecorded: false, scope: { goalId: GOAL, targets: 8 }, status: "ACTIVITY", totalDecisions: 4,
};

describe("BoardScreen", () => {
  it("folds the goal's nodes into six columns with counts, one line per card, and a finding only where it is the next question", () => {
    render(<BoardScreen activity={ACTIVITY} brief="Make evidence survive." coverage={COVERAGE} goalId={GOAL} nowMs={NOW} runId={RUN} runs={RUNS} surface={SURFACE} title="Evidence ledger" />);
    expect(screen.getByTestId("cr.kanban.count.PLANNED").textContent).toBe("2");
    expect(screen.getByTestId("cr.kanban.count.WORKING").textContent).toBe("1");
    expect(screen.getByTestId("cr.kanban.count.REVIEW").textContent).toBe("2");
    expect(screen.getByTestId("cr.kanban.count.LANDED").textContent).toBe("1");
    expect(screen.getByTestId("cr.kanban.count.VERIFIED").textContent).toBe("0");
    expect(screen.getByTestId("cr.kanban.count.PUBLISHED").textContent).toBe("0");
    expect(BOARD_COLUMNS).toHaveLength(6);
    expect(screen.getByTestId("cr.kanban.line.n-queue").textContent).toBe("waiting on other work");
    expect(screen.getByTestId("cr.kanban.line.n-work").textContent).toBe("an agent seat · lease ends in 12 min");
    expect(screen.getByTestId("cr.kanban.line.n-review").textContent).toBe("delivered 2 min ago · waiting on the verifier");
    expect(screen.getByTestId("cr.kanban.line.n-rework").textContent).toBe("sent back ×2 · rejected: implementation");
    expect(screen.getByTestId("cr.kanban.line.n-done").textContent).toBe("landed on the workspace branch");
    expect(screen.getByTestId("cr.kanban.line.n-stuck").textContent).toBe("every review attempt used; needs your decision");
    expect(screen.getByTestId("cr.kanban.finding.n-rework").textContent).toBe(FINDING.detail);
    expect(screen.getByTestId("cr.kanban.finding.n-stuck").textContent).toBe(FINDING.detail);
    expect(screen.queryByTestId("cr.kanban.finding.n-done")).toBeNull();
    // The card's face is the objective, never the node key; the key waits in the details.
    expect(screen.getByTestId("cr.kanban.card.n-done").querySelector("summary")?.textContent).toContain("Objective of n-done");
    expect(screen.getByTestId("cr.kanban.detail.n-done").textContent).toContain("crit-1: Ingest persists before extraction");
    expect(screen.getByTestId("cr.kanban.detail.n-done").textContent).toContain("2 files, local only");
  });

  it("puts where the goal stands, one progress bar, the nodes line and the one next step in the header", () => {
    render(<BoardScreen activity={ACTIVITY} brief="Make evidence survive." coverage={COVERAGE} goalId={GOAL} nowMs={NOW} runId={RUN} runs={RUNS} surface={SURFACE} title="fallback" />);
    expect(screen.getByTestId("cr.kanban.title").textContent).toBe("Evidence ledger");
    expect(screen.getByTestId("cr.kanban.brief").textContent).toBe("Make evidence survive.");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByTestId("cr.kanban.progress").textContent).toContain("1 of 2 acceptance criteria verified");
    expect(screen.getByTestId("cr.kanban.nodes").textContent).toBe("6 nodes · 1 landed · 1 working · 2 stuck");
    expect(screen.getByTestId("cr.kanban.stage").textContent).toBe("Agents working");
    expect(screen.getByTestId("cr.kanban.next").getAttribute("href")).toBe("#cr-goal-board");
    expect(screen.queryByTestId("cr.kanban.publish")).toBeNull();
  });

  it("lists the decisions latest first in a person's words, resolving targets to names and skipping seat records", () => {
    render(<BoardScreen activity={ACTIVITY} brief={null} coverage={COVERAGE} goalId={GOAL} nowMs={NOW} runId={RUN} runs={RUNS} surface={SURFACE} title="t" />);
    const rows = screen.getAllByTestId(/^cr\.kanban\.feed\.entry\./u);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toBe("5 min agothe daemon's verifier sent the work back: implementation→ Objective of n-rework");
    expect(rows[0]?.getAttribute("data-tone")).toBe("bad");
    expect(rows[1]?.textContent).toBe("12 min agothe operator approved the plan→ the plan");
    expect(rows[1]?.getAttribute("data-tone")).toBe("good");
    expect(rows[2]?.textContent).toBe("22 min agoan agent seat submitted a compiled plan→ this goal");
    expect(rows[2]?.getAttribute("data-tone")).toBe("none");
  });

  it("shows the pending decision in place of the columns while no node exists, and degrades honestly when a read fails", () => {
    const empty: RunsOutcome = { ...RUNS, goals: [{ ...RUNS.goals[0]!, nodes: [] }] };
    const planOffer = { ...SURFACE, offers: [{ commandKind: "approval.decide_intent", targetAggregateId: RUN }], steps: [] } as unknown as SurfaceFrame;
    render(<BoardScreen activity={null} brief={null} coverage={COVERAGE} goalId={GOAL} nowMs={NOW} runId={RUN} runs={empty} surface={planOffer} title="t" />);
    expect(screen.getByTestId("cr.kanban.stage").textContent).toBe("Plan review");
    expect(screen.getByTestId("cr.kanban.empty").textContent).toContain("The plan is waiting for your approval.");
    expect(screen.getByTestId("cr.kanban.next").getAttribute("href")).toBe("#cr-goal-plan");
    expect(screen.getByTestId("cr.kanban.feed.loading")).toBeTruthy();
    cleanup();
    render(<BoardScreen activity={{ code: "ACTIVITY_READ_FAILED", layer: "X", status: "ERROR" }} brief={null} coverage={null} goalId={GOAL} nowMs={NOW} runId={RUN} runs={{ code: "RUNS_READ_FAILED", layer: "X", status: "ERROR" }} surface={null} title="t" />);
    expect(screen.getByTestId("cr.kanban.empty").textContent).toContain("could not be read right now");
    expect(screen.getByTestId("cr.kanban.feed.refusal").textContent).toContain("could not be read right now");
    expect(document.body.textContent).not.toContain("RUNS_READ_FAILED");
  });

  it("colours a feed row by its kind and verdict alone", () => {
    const entry = ACTIVITY.entries[0]!;
    expect(toneOf({ ...entry, verdict: "ACCEPT" })).toBe("good");
    expect(toneOf({ ...entry, verdict: null })).toBe("none");
    expect(toneOf({ ...entry, commandKind: "escalation.decide", verdict: "REPLAN" })).toBe("bad");
    expect(toneOf({ ...entry, commandKind: "escalation.decide", verdict: "ALLOW_MORE_ATTEMPTS" })).toBe("none");
    expect(toneOf({ ...entry, commandKind: "goal.close", verdict: null })).toBe("good");
    expect(toneOf({ ...entry, commandKind: "goal.close", disposition: "VERSION_CONFLICT", verdict: null })).toBe("none");
  });
});

describe("LiveBoard", () => {
  it("reads runs, coverage and activity for the opened goal and the catalog once for its brief, through the injected readers", async () => {
    const catalog: GoalCatalogFrame = {
      connection: "CONNECTED", detail: "", outcome: "GOALS",
      goals: [{ binding: null, brief: { instructions: "Keep every anchor.", title: "Evidence ledger" }, goalId: GOAL, planningRunRef: RUN, truthClass: "DAEMON_VERIFIED" }],
    };
    const readRuns = vi.fn(async (_goalId: string) => RUNS);
    const readCoverage = vi.fn(async (_goalId: string) => COVERAGE);
    const readActivity = vi.fn(async (_goalId: string) => ACTIVITY);
    const readCatalog = vi.fn(async () => catalog);
    render(<LiveBoard goalId={GOAL} headers={{}} pollMs={60_000} readActivity={readActivity} readCatalog={readCatalog} readCoverage={readCoverage} readRuns={readRuns} runId={RUN} surface={SURFACE} title="t" />);
    expect((await screen.findByTestId("cr.kanban.brief")).textContent).toBe("Keep every anchor.");
    expect((await screen.findByTestId("cr.kanban.count.LANDED")).textContent).toBe("1");
    expect(await screen.findByTestId("cr.kanban.feed.list")).toBeTruthy();
    expect(readRuns).toHaveBeenCalledWith(GOAL);
    expect(readCoverage).toHaveBeenCalledWith(GOAL);
    expect(readActivity).toHaveBeenCalledWith(GOAL);
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });
});
