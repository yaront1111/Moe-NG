import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { RunGoalView } from "../../live/live-runs.js";
import { GoalPublish, publishLine, publishOffer } from "./goal-publish.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-pub", commandKind: "repository.publish",
  expectedVersion: 0, inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "publish:goal-1",
});
const FRAME = { connection: "LIVE", offers: [OFFER], outcome: "SURFACE", steps: [] } as unknown as SurfaceFrame;
const goal = (overrides: Partial<RunGoalView> = {}): RunGoalView => ({
  goalId: "goal-1", lifecycle: "EXECUTION_ENABLED",
  nodes: [{
    accepted: { verifierReceiptId: "r" }, claim: null, criterionIds: [], dependsOn: [],
    landing: { branch: "main", code: null, files: ["src/a.ts"], outcome: "COMMITTED", sha: "a".repeat(40) },
    lastActivityAt: null, nodeKey: "node-a", objective: "o", receipt: null,
    review: { escalated: false, findings: [], latestRoute: "ACCEPT", rounds: 1, unreadable: false, unsuccessfulRounds: 0, version: 2 },
    sharedKey: false, status: "ACCEPTED",
  }],
  publish: null, run: null, title: "Alpha", ...overrides,
});

describe("publishOffer and publishLine", () => {
  it("finds the goal's own publish offer and words every publish state", () => {
    expect(publishOffer(FRAME, "goal-1")).toBe(OFFER);
    expect(publishOffer(FRAME, "goal-2")).toBeNull();
    expect(publishOffer(null, "goal-1")).toBeNull();
    expect(publishLine(null)).toContain("Not published yet");
    expect(publishLine({ branch: null, code: null, decisionId: "d", outcome: "PENDING", remoteUrl: "https://x/y.git", requestedAt: "t", sha: null, url: null }))
      .toBe("Publishing to https://x/y.git · waiting for the wrapper to push");
    expect(publishLine({ branch: "main", code: null, decisionId: "d", outcome: "PUSHED", remoteUrl: "https://x/y.git", requestedAt: "t", sha: "0123456789abcdef", url: null }))
      .toBe("Pushed 0123456789 on main to https://x/y.git");
    expect(publishLine({ branch: null, code: "GIT_PUSH_FAILED", decisionId: "d", outcome: "REFUSED", remoteUrl: "https://x/y.git", requestedAt: "t", sha: null, url: null }))
      .toBe("Publish refused · GIT_PUSH_FAILED · decide again to retry");
  });
});

describe("GoalPublish", () => {
  it("counts the landed nodes, takes a remote, asks twice, and spends the daemon's offer with it", async () => {
    const submit = vi.fn(async () => ({ commandId: "cmd-pub", ok: true as const }));
    render(<GoalPublish frame={FRAME} goal={goal()} goalId="goal-1" port={{ submit }} />);
    expect(screen.getByTestId("cr.publish.landed").textContent).toBe("1 node landed as local commits on the workspace's branch.");
    expect(screen.getByTestId("cr.publish.state").textContent).toContain("Not published yet");
    const button = screen.getByTestId("cr.publish.button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.type(screen.getByTestId("cr.publish.remote"), "https://github.com/o/r.git");
    expect(button.disabled).toBe(false);
    await userEvent.click(button);
    expect(submit).not.toHaveBeenCalled();
    expect(button.textContent).toBe("Confirm: push to this remote");
    await userEvent.click(button);
    await waitFor(() => { expect(screen.getByTestId("cr.publish.answer").textContent).toContain("Recorded."); });
    expect(submit).toHaveBeenCalledWith(OFFER, "goal-1", "https://github.com/o/r.git");
  });

  it("shows the pushed link and says so when the daemon is not offering to publish", () => {
    const pushed = goal({ publish: {
      branch: "main", code: null, decisionId: "d", outcome: "PUSHED", remoteUrl: "https://github.com/o/r.git",
      requestedAt: "t", sha: "b".repeat(40), url: "https://github.com/o/r/tree/main",
    } });
    render(<GoalPublish frame={null} goal={pushed} goalId="goal-1" port={null} />);
    expect(screen.getByTestId("cr.publish.state").textContent).toBe(`Pushed ${"b".repeat(10)} on main to https://github.com/o/r.git`);
    expect((screen.getByTestId("cr.publish.link") as HTMLAnchorElement).href).toBe("https://github.com/o/r/tree/main");
    expect(screen.getByTestId("cr.publish.unoffered").textContent).toContain("not offering");
  });

  it("reports the daemon's refusal at its own code and layer", async () => {
    const submit = vi.fn(async () => ({ code: "BOOTSTRAP_EXPECTED_VERSION_STALE", layer: "DAEMON_PREREQUISITE", ok: false as const }));
    render(<GoalPublish frame={FRAME} goal={goal()} goalId="goal-1" port={{ submit }} />);
    await userEvent.type(screen.getByTestId("cr.publish.remote"), "git@github.com:o/r.git");
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    await userEvent.click(screen.getByTestId("cr.publish.button"));
    await waitFor(() => {
      expect(screen.getByTestId("cr.publish.answer").textContent).toBe("REFUSED · BOOTSTRAP_EXPECTED_VERSION_STALE · DAEMON_PREREQUISITE");
    });
  });
});
