import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ActivityOutcome } from "../../live/live-activity.js";
import type { SessionsOutcome } from "../../live/live-sessions.js";
import { ActivityPanel, SessionsPanel } from "./activity-screens.js";
import { agoWords, kindWords, principalWords } from "./activity-words.js";
import { LiveActivity, LiveSessions } from "./live-ops.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const ACTIVITY: ActivityOutcome = {
  entries: [
    { commandKind: "integration.accept_output", decidedAt: "2026-09-03T09:35:00.000Z", disposition: "COMMITTED", principalId: "operator-local", targetAggregateId: "node-a", version: 4 },
    { commandKind: "work.claim", decidedAt: "2026-09-03T08:00:00.000Z", disposition: "VERSION_CONFLICT", principalId: "sess-wrap-abc", targetAggregateId: "work/node.deliver@node-a", version: null },
  ],
  refusalsRecorded: false, scope: { goalId: "goal-1", targets: 3 }, status: "ACTIVITY", totalDecisions: 12,
};
const SESSIONS: SessionsOutcome = {
  readAt: "2026-09-03T10:00:00.000Z",
  sessions: [
    { capabilities: ["review.write", "work.write"], expiresAt: "2026-09-03T11:00:00.000Z", holding: ["node.deliver@node-a"], liveness: "LIVE", principalId: "sess-wrap-abc", sessionId: "sess-wrap-abc", status: "OPEN" },
    { capabilities: ["project.admin"], expiresAt: "2026-09-03T09:00:00.000Z", holding: [], liveness: "EXPIRED", principalId: "principal-1", sessionId: "sess-op-1", status: "OPEN" },
  ],
  status: "SESSIONS", totals: { closed: 0, expired: 1, live: 1 }, unreadable: false,
};

describe("activity words", () => {
  it("translate known kinds and principals and keep unknown ones as spelled", () => {
    expect(kindWords("integration.accept_output")).toBe("accepted the delivered work");
    expect(kindWords("cutover.activate")).toBe("cutover.activate");
    expect(principalWords("operator-local")).toBe("the operator");
    expect(principalWords("sess-wrap-abc")).toBe("an agent seat");
    expect(principalWords("daemon:node-verifier")).toBe("the daemon's verifier");
    expect(principalWords("someone-else")).toBe("someone-else");
    expect(agoWords("2026-09-03T09:35:00.000Z", NOW)).toBe("25 min ago");
  });
});

describe("ActivityPanel", () => {
  it("renders each decision as who did what, latest first, and says refusals are not recorded", () => {
    render(<ActivityPanel nowMs={NOW} outcome={ACTIVITY} scopeLabel="Alpha" />);
    expect(screen.getByTestId("cr.activity.count").textContent).toContain("2 of 12 decisions");
    expect(screen.getByTestId("cr.activity.count").textContent).toContain("Refused commands are not recorded");
    expect(screen.getByTestId("cr.activity.entry.0").textContent).toContain("25 min ago");
    expect(screen.getByTestId("cr.activity.entry.0").textContent).toContain("the operator accepted the delivered work");
    expect(screen.getByTestId("cr.activity.entry.0").textContent).toContain("node-a · v4");
    expect(screen.getByTestId("cr.activity.entry.1").textContent).toContain("an agent seat took a work item (version conflict, nothing changed)");
    expect(screen.getByTestId("cr.activity.entry.1").getAttribute("data-disposition")).toBe("VERSION_CONFLICT");
  });

  it("shows loading, a refusal and an empty ledger", () => {
    render(<ActivityPanel nowMs={NOW} outcome={null} scopeLabel="Alpha" />);
    expect(screen.getByTestId("cr.activity.loading")).toBeTruthy();
    cleanup();
    render(<ActivityPanel nowMs={NOW} outcome={{ code: "ACTIVITY_READ_GOAL_UNKNOWN", layer: "ACTIVITY_READ", status: "REFUSED" }} scopeLabel="Alpha" />);
    expect(screen.getByTestId("cr.activity.refusal").textContent).toBe("REFUSED · ACTIVITY_READ_GOAL_UNKNOWN · ACTIVITY_READ");
    cleanup();
    render(<ActivityPanel nowMs={NOW} outcome={{ ...ACTIVITY, entries: [], totalDecisions: 0 }} scopeLabel="Alpha" />);
    expect(screen.getByTestId("cr.activity.empty").textContent).toContain("Nothing has been decided here yet.");
  });
});

describe("SessionsPanel", () => {
  it("lists live seats first with what they hold, and the totals", () => {
    render(<SessionsPanel nowMs={NOW} outcome={SESSIONS} />);
    expect(screen.getByTestId("cr.sessions.count").textContent).toBe("1 live · 1 expired · 0 closed");
    const live = screen.getByTestId("cr.sessions.row.sess-wrap-abc");
    expect(live.getAttribute("data-liveness")).toBe("LIVE");
    expect(live.textContent).toContain("live until 2026-09-03T11:00:00.000Z");
    expect(live.textContent).toContain("an agent seat · working on node.deliver@node-a");
    expect(screen.getByTestId("cr.sessions.row.sess-op-1").textContent).toContain("expired 1 h ago");
  });
});

describe("LiveActivity / LiveSessions", () => {
  it("read through the injected readers on mount", async () => {
    const readActivity = vi.fn(async () => ACTIVITY);
    render(<LiveActivity goalRef="goal-1" headers={{}} pollMs={60_000} read={readActivity} scopeLabel="Alpha" />);
    expect(await screen.findByTestId("cr.activity.list")).toBeTruthy();
    expect(readActivity).toHaveBeenCalledTimes(1);
    cleanup();
    render(<LiveSessions headers={{}} pollMs={60_000} read={() => Promise.reject(new Error("x"))} />);
    expect((await screen.findByTestId("cr.sessions.refusal")).textContent).toContain("SESSIONS_READ_FAILED");
  });
});
