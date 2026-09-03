import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { RunsOutcome } from "../../live/live-runs.js";
import { GoalNodesPanel, LiveGoalNodes } from "./goal-nodes.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const RUNS: RunsOutcome = {
  goals: [{
    goalId: "goal-1", lifecycle: "EXECUTION_ENABLED",
    nodes: [{
      accepted: { verifierReceiptId: "receipt-1" }, claim: null, criterionIds: ["crit-1"], dependsOn: [], lastActivityAt: "2026-09-03T09:00:00.000Z",
      nodeKey: "node-a", objective: "Build the ledger", landing: null, receipt: null,
      review: { escalated: false, findings: [], latestRoute: "ACCEPT", rounds: 1, unreadable: false, unsuccessfulRounds: 0, version: 3 },
      sharedKey: false, status: "ACCEPTED",
    }],
    run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-1" }, title: "Alpha",
  }],
  status: "RUNS",
  totals: { ACCEPTED: 1, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 0, IN_PROGRESS: 0, READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: 1 },
};

describe("GoalNodesPanel", () => {
  it("renders this goal's node ladder without the Runs screen's title link, and the empty and refusal states", () => {
    render(<GoalNodesPanel goalId="goal-1" nowMs={NOW} outcome={RUNS} />);
    expect(screen.getByTestId("cr.runs.node.node-a.status").textContent).toBe("Accepted");
    expect(screen.queryByTestId("cr.runs.goal.goal-1.open")).toBeNull();
    cleanup();
    render(<GoalNodesPanel goalId="goal-other" nowMs={NOW} outcome={RUNS} />);
    expect(screen.getByTestId("cr.goalnodes.empty").textContent).toContain("No run is recorded");
    cleanup();
    render(<GoalNodesPanel goalId="goal-1" nowMs={NOW} outcome={{ code: "RUNS_READ_UNREADABLE", layer: "RUNS_READ", status: "REFUSED" }} />);
    expect(screen.getByTestId("cr.goalnodes.refusal").textContent).toBe("REFUSED · RUNS_READ_UNREADABLE · RUNS_READ");
  });
});

describe("LiveGoalNodes", () => {
  it("reads the runs scoped to the goal through the injected reader", async () => {
    const read = vi.fn(async (_goalId: string) => RUNS);
    render(<LiveGoalNodes goalId="goal-1" headers={{}} pollMs={60_000} read={read} />);
    expect((await screen.findByTestId("cr.runs.node.node-a.status")).textContent).toBe("Accepted");
    expect(read).toHaveBeenCalledWith("goal-1");
  });
});
