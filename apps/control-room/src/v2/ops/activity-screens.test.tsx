import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ActivityOutcome } from "../../live/live-activity.js";
import type { SessionView, SessionsOutcome } from "../../live/live-sessions.js";
import { ProviderPauseProvider } from "../shell/pause-context.js";
import type { ProviderPause } from "../shell/pause-context.js";
import { ActivityPanel, SessionsPanel } from "./activity-screens.js";
import { agoWords, isSeatRecord, kindWords, principalWords, seatWords } from "./activity-words.js";
import { LiveActivity, LiveSessions } from "./live-ops.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const ACTIVITY: ActivityOutcome = {
  entries: [
    { commandKind: "integration.accept_output", decidedAt: "2026-09-03T09:35:00.000Z", disposition: "COMMITTED", principalId: "operator-local", targetAggregateId: "node-a", verdict: null, version: 4 },
    { commandKind: "work.claim", decidedAt: "2026-09-03T08:00:00.000Z", disposition: "VERSION_CONFLICT", principalId: "sess-wrap-abc", targetAggregateId: "work/node.deliver@node-a", verdict: null, version: null },
    { commandKind: "OPEN_SESSION", decidedAt: "2026-09-03T07:00:00.000Z", disposition: "COMMITTED", principalId: "4be93d1a-902e-41f4-ad1a-89fc588d2ff4", targetAggregateId: "moe.session-authority.v1/session/session-1", verdict: null, version: 1 },
  ],
  refusalsRecorded: false, scope: { goalId: "goal-1", targets: 3 }, status: "ACTIVITY", totalDecisions: 12,
};
const SESSIONS: SessionsOutcome = {
  agentProvider: { configured: "claude", envOverride: false },
  concurrency: { activeSeats: 2, configuredAgentLimit: 2 },
  readAt: "2026-09-03T10:00:00.000Z",
  sessions: [
    { agentVersionAtStart: "2.1.263 (Claude Code)", capabilities: ["review.write", "work.write"], exit: null, expiresAt: "2026-09-03T11:00:00.000Z", holding: ["node.deliver@node-a"], liveness: "LIVE", principalId: "sess-wrap-abc", providerAtStart: "claude", sessionId: "sess-wrap-abc", startedAt: "2026-09-03T09:48:00.000Z", status: "OPEN" },
    // Neither of these is an AGENT seat, so nothing ever measured a provider or a CLI version
    // for them: they carry the daemon's one stated unknown, exactly as a live read would, and
    // no start or exit record speaks for them either (null, as the daemon states it).
    { agentVersionAtStart: "UNKNOWN", capabilities: ["project.admin"], exit: null, expiresAt: "2026-09-03T09:00:00.000Z", holding: [], liveness: "EXPIRED", principalId: "principal-1", providerAtStart: "UNKNOWN", sessionId: "sess-op-1", startedAt: null, status: "OPEN" },
    { agentVersionAtStart: "UNKNOWN", capabilities: ["project.admin"], exit: null, expiresAt: "2026-09-03T11:00:00.000Z", holding: [], liveness: "LIVE", principalId: "operator-local", providerAtStart: "UNKNOWN", sessionId: "4be93d1a-902e-41f4-ad1a-89fc588d2ff4", startedAt: null, status: "OPEN" },
  ],
  status: "SESSIONS", totals: { closed: 0, expired: 1, live: 1 }, unreadable: false,
};
/** An agent seat that failed two minutes ago: the wrapper recorded kind, exit code and last line. */
const EXITED: SessionView = {
  agentVersionAtStart: "2.1.263 (Claude Code)", capabilities: ["work.write"],
  exit: { at: "2026-09-03T09:58:00.000Z", exitCode: 1, kind: "FAILED", lastLine: "Error: spawn claude ENOENT" },
  expiresAt: "2026-09-03T09:59:00.000Z", holding: [], liveness: "CLOSED", principalId: "sess-wrap-dead",
  providerAtStart: "claude", sessionId: "sess-wrap-dead", startedAt: "2026-09-03T09:51:00.000Z", status: "CLOSED",
};

const PAUSE: ProviderPause = {
  lastLine: "Claude usage limit reached. Your limit will reset at 11:30 (UTC).",
  provider: "claude", resetAt: "2026-09-03T11:30:00.000Z", since: "2026-09-03T10:00:00.000Z",
  workItemId: "node.deliver@n2",
};
// Spelled out, never built by calling `pauseSeatWords`: an expectation that called the
// production formatter would pass for whatever it happens to return.
const PAUSED_LINE = `Agents paused: claude limit, resumes ${new Date("2026-09-03T11:30:00.000Z").toLocaleString()}`
  + " - last line from the seat: Claude usage limit reached. Your limit will reset at 11:30 (UTC).";
const BROWSER_ID = "4be93d1a-902e-41f4-ad1a-89fc588d2ff4";
/**
 * The Seats read as it actually looks while the wrapper is paused: no agent seat, and
 * nothing live at all - the operator's own browser pairing has lapsed too. Both facts
 * matter: a banner gated on "an agent is live" OR on "anything is live" would vanish
 * exactly here, and here is the moment a person most needs to be told the wrapper is
 * waiting rather than broken.
 */
const BROWSER_ONLY: SessionsOutcome = {
  ...SESSIONS,
  sessions: SESSIONS.sessions.filter((session) => session.sessionId === BROWSER_ID)
    .map((session) => ({ ...session, liveness: "EXPIRED" as const })),
  totals: { closed: 0, expired: 1, live: 0 },
};

describe("activity words", () => {
  it("translate known kinds and principals and keep unknown ones as spelled", () => {
    expect(kindWords("integration.accept_output")).toBe("accepted the delivered work");
    expect(kindWords("cutover.activate")).toBe("cutover.activate");
    expect(kindWords("OPEN_SESSION")).toBe("paired a browser seat");
    expect(principalWords("operator-local")).toBe("the operator");
    expect(principalWords("sess-wrap-abc")).toBe("an agent seat");
    expect(principalWords("daemon:node-verifier")).toBe("the daemon's verifier");
    expect(principalWords("someone-else")).toBe("someone-else");
    expect(agoWords("2026-09-03T09:35:00.000Z", NOW)).toBe("25 min ago");
    expect(seatWords("sess-wrap-abc")).toBe("an agent seat");
    expect(seatWords("4be93d1a-902e-41f4-ad1a-89fc588d2ff4")).toBe("a paired browser");
    expect(isSeatRecord("OPEN_SESSION", "moe.session-authority.v1/session/s")).toBe(true);
    expect(isSeatRecord("session.renew", "session/x")).toBe(true);
    expect(isSeatRecord("work.claim", "work/x")).toBe(false);
  });
});

describe("ActivityPanel", () => {
  it.each([
    ["APPLIED", "applied the migrations to this environment"],
    ["REFUSED", "could not migrate: read the receipt for what the schema did"],
    ["REVERTED", "reverted the last migration batch"],
    ["PARTIAL", "recorded the migration: PARTIAL"],
    [null, "recorded the migration"],
  ])("renders migration verdict %s in the project-wide activity DOM", (verdict, words) => {
    render(<ActivityPanel nowMs={NOW} scopeLabel="Project" outcome={{
      ...ACTIVITY, scope: { goalId: null, targets: 1 }, entries: [{
        commandKind: "internal.repository.migration_receipt", verdict,
        decidedAt: "2026-09-03T09:35:00.000Z", disposition: "COMMITTED",
        principalId: "daemon:migrations", targetAggregateId: "migration:receipt-1", version: 1,
      }],
    }} />);
    const entry = screen.getByTestId("cr.activity.entry.0");
    expect(entry.querySelector(".cr2-activity-what")?.textContent).toBe(`the daemon ${words}`);
    expect(entry.textContent).toContain("migration:receipt-1");
    expect(entry.getAttribute("data-disposition")).toBe("COMMITTED");
  });

  it("preserves verdicts on folded seat records too", () => {
    render(<ActivityPanel nowMs={NOW} scopeLabel="Project" outcome={{
      ...ACTIVITY, scope: { goalId: null, targets: 1 }, entries: [{
        commandKind: "session.renew", verdict: "UNRECOGNIZED",
        decidedAt: "2026-09-03T09:35:00.000Z", disposition: "COMMITTED",
        principalId: "operator-local", targetAggregateId: "session/seat-1", version: 2,
      }],
    }} />);
    expect(screen.getByTestId("cr.activity.seats").querySelector(".cr2-activity-what")?.textContent)
      .toBe("the operator renewed a seat (UNRECOGNIZED)");
  });

  it("renders each decision as who did what, latest first, and says refusals are not recorded", () => {
    render(<ActivityPanel nowMs={NOW} outcome={ACTIVITY} scopeLabel="Alpha" />);
    expect(screen.getByTestId("cr.activity.count").textContent).toContain("2 work decisions of 12 recorded");
    // Seat and pairing records fold away behind one line instead of crowding the ledger.
    expect(screen.queryByTestId("cr.activity.entry.2")).toBeNull();
    expect(screen.getByTestId("cr.activity.seats").textContent).toContain("1 seat and pairing records");
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
    expect(screen.getByTestId("cr.activity.refusal").textContent).toContain("The ledger could not be read right now.");
    cleanup();
    render(<ActivityPanel nowMs={NOW} outcome={{ ...ACTIVITY, entries: [], totalDecisions: 0 }} scopeLabel="Alpha" />);
    expect(screen.getByTestId("cr.activity.empty").textContent).toContain("Nothing has been decided here yet.");
  });
});

describe("SessionsPanel", () => {
  it("lists live seats first with what they hold, and the totals", () => {
    render(<SessionsPanel nowMs={NOW} outcome={SESSIONS} />);
    expect(screen.getByTestId("cr.sessions.count").textContent).toBe("1 live · 1 expired · 0 closed");
    // A paired browser is folded away; agent seats stay in the open list.
    expect(screen.getByTestId("cr.sessions.browsers").textContent).toContain("1 paired browsers live · 1 in all");
    expect(screen.getByTestId("cr.sessions.list").textContent).not.toContain("4be93d1a");
    const live = screen.getByTestId("cr.sessions.row.sess-wrap-abc");
    expect(live.getAttribute("data-liveness")).toBe("LIVE");
    expect(live.textContent).toContain("live until 2026-09-03T11:00:00.000Z");
    expect(live.textContent).toContain("an agent seat · working on node.deliver@node-a");
    // Past seats fold away; the row is still there to read.
    expect(screen.getByTestId("cr.sessions.past").textContent).toContain("1 past agent seats");
    expect(screen.getByTestId("cr.sessions.row.sess-op-1").textContent).toContain("expired 1 h ago");
    expect(screen.getByTestId("cr.sessions.list").textContent).not.toContain("sess-op-1");
  });

  it("says the agents are paused, with the reset and the seat's own last line", () => {
    render(<SessionsPanel nowMs={NOW} outcome={SESSIONS} paused={PAUSE} />);
    expect(screen.getByTestId("cr.sessions.paused").textContent).toBe(PAUSED_LINE);
    // The seats themselves are still listed; the banner is a note above them, not a takeover.
    expect(screen.getByTestId("cr.sessions.row.sess-wrap-abc")).toBeTruthy();
  });

  it("says it even when no agent seat is left to look at - that is when a person most needs it", () => {
    // Guard the fixture: a filter that silently yielded zero sessions would make this vacuous.
    expect(BROWSER_ONLY.sessions).toHaveLength(1);
    render(<SessionsPanel nowMs={NOW} outcome={BROWSER_ONLY} paused={PAUSE} />);
    expect(screen.getByTestId("cr.sessions.paused").textContent).toBe(PAUSED_LINE);
    expect(screen.getByTestId("cr.sessions.noagents").textContent).toContain("No agent seat is open right now.");
  });

  it("says nothing at all when no pause is known, whether the prop is null or absent", () => {
    render(<SessionsPanel nowMs={NOW} outcome={SESSIONS} paused={null} />);
    expect(screen.queryByTestId("cr.sessions.paused")).toBeNull();
    cleanup();
    render(<SessionsPanel nowMs={NOW} outcome={SESSIONS} />);
    expect(screen.queryByTestId("cr.sessions.paused")).toBeNull();
  });

  /**
   * The two readings an operator actually sees. Spelled out here, never built by calling
   * `seatLimitWords`: an expectation that called the production formatter would pass for
   * whatever it happens to return.
   */
  it("says why only two nodes are moving when every seat is busy", () => {
    expect(SESSIONS.status === "SESSIONS" && SESSIONS.concurrency).toEqual({ activeSeats: 2, configuredAgentLimit: 2 });
    render(<SessionsPanel nowMs={NOW} outcome={SESSIONS} />);
    expect(screen.getByTestId("cr.sessions.limit").textContent)
      .toBe("This daemon is set to run 2 agents at once. Every seat is busy, so the next ready node waits for one to finish.");
  });

  it("still states the limit when nothing is working, so the number is not a busy-only banner", () => {
    render(<SessionsPanel nowMs={NOW} outcome={{ ...SESSIONS, concurrency: { activeSeats: 0, configuredAgentLimit: 2 } }} />);
    expect(screen.getByTestId("cr.sessions.limit").textContent)
      .toBe("This daemon is set to run 2 agents at once. No agent is working right now.");
  });

  it("renders the daemon's number, not a 2 baked into the screen", () => {
    render(<SessionsPanel nowMs={NOW} outcome={{ ...SESSIONS, concurrency: { activeSeats: 1, configuredAgentLimit: 5 } }} />);
    expect(screen.getByTestId("cr.sessions.limit").textContent)
      .toBe("This daemon is set to run 5 agents at once. 1 of them is working.");
    cleanup();
    // One seat: the sentence must not read "1 agents".
    render(<SessionsPanel nowMs={NOW} outcome={{ ...SESSIONS, concurrency: { activeSeats: 0, configuredAgentLimit: 1 } }} />);
    expect(screen.getByTestId("cr.sessions.limit").textContent)
      .toBe("This daemon is set to run 1 agent at once. No agent is working right now.");
  });

  it("says nothing about seats when the read REFUSES, and never NaN or undefined", () => {
    render(<SessionsPanel nowMs={NOW} outcome={{ code: "SESSIONS_READ_UNREADABLE", layer: "SESSIONS_READ", status: "REFUSED" }} />);
    // The panel is still on screen with its refusal note - it does not vanish.
    const root = screen.getByTestId("cr.sessions.root");
    expect(screen.getByTestId("cr.sessions.refusal").textContent).toContain("SESSIONS_READ_UNREADABLE");
    expect(screen.queryByTestId("cr.sessions.limit")).toBeNull();
    expect(root.textContent).not.toContain("NaN");
    expect(root.textContent).not.toContain("undefined");
  });

  it("says (no output) rather than trailing off when the seat died without printing a line", () => {
    render(<SessionsPanel nowMs={NOW} outcome={SESSIONS} paused={{ ...PAUSE, lastLine: "   " }} />);
    expect(screen.getByTestId("cr.sessions.paused").textContent)
      .toBe(`Agents paused: claude limit, resumes ${new Date("2026-09-03T11:30:00.000Z").toLocaleString()} - last line from the seat: (no output)`);
  });

  /**
   * The finding: a seat that hung for seven minutes with zero network read "live until
   * <expiry>" exactly like a working seat. The start age is the difference an operator can see.
   * Spelled out, never built by calling `seatStartWords`.
   */
  it("says how long ago each live seat started, before the lease it holds", () => {
    render(<SessionsPanel nowMs={NOW} outcome={SESSIONS} />);
    expect(screen.getByTestId("cr.sessions.row.sess-wrap-abc").querySelector(".cr2-activity-when")?.textContent)
      .toBe("started 12 min ago · live until 2026-09-03T11:00:00.000Z");
    // No start record - a paired browser, or any seat older than the start ledger - NAMES the
    // absence; it is never dated to the browser's clock as "started just now".
    expect(screen.getByTestId(`cr.sessions.row.${BROWSER_ID}`).querySelector(".cr2-activity-when")?.textContent)
      .toBe("start not recorded · live until 2026-09-03T11:00:00.000Z");
    // A past seat's row is unchanged: its exit is the exits list's business, below.
    expect(screen.getByTestId("cr.sessions.row.sess-op-1").querySelector(".cr2-activity-when")?.textContent).toBe("expired 1 h ago");
  });

  it("lists the last exited agent seats with the recorded reason, and names the absence for the rest", () => {
    render(<SessionsPanel nowMs={NOW} outcome={{ ...SESSIONS, sessions: [...SESSIONS.sessions, EXITED] }} />);
    // In the open, not inside the past-seats fold, and the recorded exit leads.
    expect(screen.getByTestId("cr.sessions.past").contains(screen.getByTestId("cr.sessions.exits"))).toBe(false);
    expect(screen.getByTestId("cr.sessions.exits.heading").textContent).toBe("The last 2 agent seats to exit · why each one ended");
    const dead = screen.getByTestId("cr.sessions.exit.sess-wrap-dead");
    expect(dead.querySelector(".cr2-activity-when")?.textContent).toBe("exited 2 min ago");
    expect(dead.querySelector(".cr2-activity-what")?.textContent).toBe("failed, exit code 1");
    expect(dead.querySelector(".cr2-activity-target")?.textContent).toBe("sess-wrap-dead · last line: Error: spawn claude ENOENT");
    // sess-op-1 expired with no exit record: the count said "1 expired"; this row says why not.
    const unrecorded = screen.getByTestId("cr.sessions.exit.sess-op-1");
    expect(unrecorded.querySelector(".cr2-activity-when")?.textContent).toBe("expired 1 h ago");
    expect(unrecorded.querySelector(".cr2-activity-what")?.textContent).toBe("reason not recorded");
    expect(unrecorded.querySelector(".cr2-activity-target")?.textContent).toBe("sess-op-1");
    // The paired browser is not an agent seat and never appears here.
    expect(screen.getByTestId("cr.sessions.exits").textContent).not.toContain(BROWSER_ID);
  });

  it("renders no exits list while no agent seat has exited", () => {
    render(<SessionsPanel nowMs={NOW} outcome={{
      ...SESSIONS, sessions: SESSIONS.sessions.filter((session) => session.liveness === "LIVE"), totals: { closed: 0, expired: 0, live: 1 },
    }} />);
    expect(screen.getByTestId("cr.sessions.row.sess-wrap-abc")).toBeTruthy();
    expect(screen.queryByTestId("cr.sessions.exits")).toBeNull();
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

  it("takes the pause from the shell's context, not from a second health poll of its own", async () => {
    render(
      <ProviderPauseProvider value={PAUSE}>
        <LiveSessions headers={{}} pollMs={60_000} read={async () => SESSIONS} />
      </ProviderPauseProvider>,
    );
    expect((await screen.findByTestId("cr.sessions.paused")).textContent).toBe(PAUSED_LINE);
    cleanup();
    // No provider above it (a stray mount, a unit test) reads null and says nothing.
    render(<LiveSessions headers={{}} pollMs={60_000} read={async () => SESSIONS} />);
    expect(await screen.findByTestId("cr.sessions.count")).toBeTruthy();
    expect(screen.queryByTestId("cr.sessions.paused")).toBeNull();
  });
});
