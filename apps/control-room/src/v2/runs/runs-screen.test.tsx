import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import { RunsScreen, STATUS_WORDS, nodeEvidence } from "./runs-screen.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NOW = Date.parse("2026-09-02T20:00:00.000Z");
const node = (overrides: Partial<RunNodeView> = {}): RunNodeView => ({
  accepted: null, claim: null, criterionIds: ["crit-1"], dependsOn: [], lastActivityAt: null,
  nodeKey: "node-a", objective: "Keep fields.",
  review: { escalated: false, latestRoute: null, rounds: 0, unreadable: false, unsuccessfulRounds: 0, version: 0 },
  status: "READY", ...overrides,
});

describe("nodeEvidence", () => {
  it("speaks only the facts the daemon stated, in a person's words", () => {
    expect(nodeEvidence(node(), NOW)).toEqual([]);
    expect(nodeEvidence(node({
      accepted: { verifierReceiptId: "receipt-9" }, status: "ACCEPTED",
      review: { escalated: false, latestRoute: "ACCEPT", rounds: 2, unreadable: false, unsuccessfulRounds: 1, version: 4 },
      claim: { active: false, claimedBy: "sess-wrap-1", expiresAt: "2026-09-02T19:00:00.000Z", status: "RELEASED" },
      dependsOn: ["node-0"], lastActivityAt: "2026-09-02T19:35:00.000Z",
    }), NOW)).toEqual([
      "accepted by the daemon · receipt receipt-9",
      "2 review rounds · last review passed",
      "1 unsuccessful",
      "last held by sess-wrap-1 (released)",
      "after node-0",
      "last activity 25 min ago",
    ]);
    expect(nodeEvidence(node({
      status: "ESCALATION_REQUIRED",
      review: { escalated: false, latestRoute: "ESCALATE", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 3 },
    }), NOW)[1]).toBe("3 unsuccessful: the daemon refuses more rounds until a human escalates");
    expect(nodeEvidence(node({
      claim: { active: true, claimedBy: "sess-wrap-2", expiresAt: "2026-09-02T21:00:00.000Z", status: "OPEN" }, status: "IN_PROGRESS",
    }), NOW)).toEqual(["held by sess-wrap-2 until 2026-09-02T21:00:00.000Z"]);
  });
});

describe("the runs screen", () => {
  const outcome: RunsOutcome = {
    goals: [
      {
        goalId: "goal-1", lifecycle: "EXECUTION_ENABLED",
        nodes: [node(), node({ nodeKey: "node-b", objective: "Refuse edits.", dependsOn: ["node-a"], status: "IN_PROGRESS",
          claim: { active: true, claimedBy: "sess-wrap-2", expiresAt: "2026-09-02T21:00:00.000Z", status: "OPEN" } })],
        run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-1" }, title: "Build it",
      },
      { goalId: "goal-2", lifecycle: "DRAFT", nodes: [], run: null, title: null },
    ],
    status: "RUNS",
    totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 0, IN_PROGRESS: 1, READY: 1, goals: 2, nodes: 2 },
  };

  it("renders the totals, each goal's run line, and the node ladder with status words", async () => {
    const onOpenBoard = vi.fn();
    render(<RunsScreen nowMs={NOW} onOpenBoard={onOpenBoard} outcome={outcome} />);
    expect(screen.getByTestId("cr.runs.totals").textContent).toBe("2 goals · 2 nodes · 1 in progress · 1 ready for an agent");
    expect(screen.getByTestId("cr.runs.goal.goal-1.run").textContent).toBe("Run run-1 · ACTIVATED · approval bound");
    expect(screen.getByTestId("cr.runs.node.node-a.status").textContent).toBe(STATUS_WORDS.READY);
    expect(screen.getByTestId("cr.runs.node.node-b.status").textContent).toBe(STATUS_WORDS.IN_PROGRESS);
    expect(screen.getByTestId("cr.runs.node.node-b.evidence").textContent).toContain("held by sess-wrap-2");
    expect(screen.getByTestId("cr.runs.goal.goal-2.run").textContent).toBe("No plan has been run for this goal yet.");
    expect(screen.getByTestId("cr.runs.goal.goal-2.empty")).toBeTruthy();
    expect((screen.getByTestId("cr.runs.goal.goal-2.open") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("cr.runs.goal.goal-1.open"));
    expect(onOpenBoard).toHaveBeenCalledWith("goal-1", "run-1", "Build it");
  });

  it("shows loading, a refusal at its layer, and the empty project", () => {
    render(<RunsScreen nowMs={NOW} onOpenBoard={vi.fn()} outcome={null} />);
    expect(screen.getByTestId("cr.runs.loading")).toBeTruthy();
    cleanup();
    render(<RunsScreen nowMs={NOW} onOpenBoard={vi.fn()} outcome={{ code: "LISTENER_RUNS_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER", status: "REFUSED" }} />);
    expect(screen.getByTestId("cr.runs.refusal").textContent).toBe("REFUSED · LISTENER_RUNS_UNAVAILABLE · CONTROL_ROOM_LISTENER");
    cleanup();
    render(<RunsScreen nowMs={NOW} onOpenBoard={vi.fn()} outcome={{ ...outcome, goals: [], totals: { ...outcome.totals, goals: 0, nodes: 0, IN_PROGRESS: 0, READY: 0 } }} />);
    expect(screen.getByTestId("cr.runs.empty").textContent).toContain("No goals to run yet.");
  });
});
