import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { RunsOutcome } from "../../live/live-runs.js";
import { LiveRuns } from "./live-runs.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const RUNS: RunsOutcome = {
  goals: [{
    goalId: "goal-1", lifecycle: "EXECUTION_ENABLED",
    nodes: [{
      accepted: null, claim: null, criterionIds: [], dependsOn: [], lastActivityAt: null, nodeKey: "node-a",
      objective: "Keep fields.", review: { escalated: false, latestRoute: null, rounds: 0, unreadable: false, unsuccessfulRounds: 0, version: 0 },
      status: "READY",
    }],
    run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-1" }, title: "Build it",
  }],
  status: "RUNS",
  totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 0, IN_PROGRESS: 0, READY: 1, goals: 1, nodes: 1 },
};

describe("LiveRuns", () => {
  it("reads on mount through the injected reader and re-reads on its cadence", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => RUNS);
      const view = render(<LiveRuns headers={{}} onOpenBoard={vi.fn()} pollMs={1_000} read={read} />);
      expect(read).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId("cr.runs.node.node-a")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(read).toHaveBeenCalledTimes(2);
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a rejected read as an ERROR at the screen's own layer", async () => {
    render(<LiveRuns headers={{}} onOpenBoard={vi.fn()} pollMs={60_000} read={() => Promise.reject(new Error("x"))} />);
    expect((await screen.findByTestId("cr.runs.refusal")).textContent).toContain("RUNS_READ_FAILED");
  });
});
