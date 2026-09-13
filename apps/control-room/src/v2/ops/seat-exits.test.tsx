/**
 * The last few agent seats to exit, and why. Every rendered expectation is SPELLED OUT, never
 * built by calling the production formatters: an expectation that called them would pass for
 * whatever they happen to return. MIDDOT is the one glyph borrowed, so the file stays ASCII.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { SessionView } from "../../live/live-sessions.js";
import { MIDDOT } from "../glyphs.js";
import { SEAT_EXITS_SHOWN, SeatExits, lastExits } from "./seat-exits.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
/** A closed agent seat with no exit record, unless `over` says otherwise. */
const seat = (over: Partial<SessionView> & { readonly sessionId: string }): SessionView => ({
  agentVersionAtStart: "2.1.263 (Claude Code)", capabilities: ["work.write"], exit: null,
  expiresAt: "2026-09-03T09:59:00.000Z", holding: [], liveness: "CLOSED", principalId: over.sessionId,
  providerAtStart: "claude", startedAt: "2026-09-03T09:51:00.000Z", status: "CLOSED", ...over,
});
const ids = (seats: readonly SessionView[]): readonly string[] => seats.map((row) => row.sessionId);

/** Failed two minutes ago: the wrapper recorded kind, exit code and the last line it printed. */
const FAILED = seat({ exit: { at: "2026-09-03T09:58:00.000Z", exitCode: 1, kind: "FAILED", lastLine: "Error: spawn claude ENOENT" }, sessionId: "sess-wrap-dead" });
/** The hung seat from the finding, killed: no exit code (a signal), nothing printed. */
const KILLED = seat({ exit: { at: "2026-09-03T09:50:00.000Z", exitCode: null, kind: "FAILED", lastLine: null }, sessionId: "sess-wrap-killed" });
const DONE = seat({ exit: { at: "2026-09-03T09:30:00.000Z", exitCode: 0, kind: "COMPLETED", lastLine: "done" }, sessionId: "sess-wrap-done" });
/** Expired an hour ago with no exit record: older than the exit ledger, or a wrapper with no gate. */
const OLD = seat({ expiresAt: "2026-09-03T09:00:00.000Z", liveness: "EXPIRED", sessionId: "sess-wrap-old", status: "OPEN" });
const LIVE = seat({ expiresAt: "2026-09-03T11:00:00.000Z", liveness: "LIVE", sessionId: "sess-wrap-live", status: "OPEN" });
/** Expired fifteen minutes ago, no record: the lease lapsed after OLD's did. */
const LAPSED = seat({ expiresAt: "2026-09-03T09:45:00.000Z", liveness: "EXPIRED", sessionId: "sess-wrap-lapsed", status: "OPEN" });
/** Closed with no record; the daemon carries the lease each one held, not the instant it closed. */
const CLOSED_LATE = seat({ expiresAt: "2026-09-03T09:59:00.000Z", sessionId: "sess-wrap-closed-late" });
const CLOSED_EARLY = seat({ expiresAt: "2026-09-03T08:30:00.000Z", sessionId: "sess-wrap-closed-early" });

describe("lastExits", () => {
  it("lists recorded exits latest first, then seats no record speaks for", () => {
    expect(ids(lastExits([OLD, DONE, FAILED, KILLED]))).toEqual(["sess-wrap-dead", "sess-wrap-killed", "sess-wrap-done", "sess-wrap-old"]);
  });

  it("ranks the unrecorded tail itself - expired seats latest lapse first, then closed seats latest lease first - whatever order they arrived in", () => {
    // Neither the arrival order nor its reverse is the answer, so a passthrough and a
    // `.reverse()` both fail here; the daemon lists past seats EXPIRED before CLOSED, expiry
    // descending (sessions-read.ts), and the same input in that order must come back as it is.
    const expected = ["sess-wrap-lapsed", "sess-wrap-old", "sess-wrap-closed-late", "sess-wrap-closed-early"];
    expect(ids(lastExits([OLD, CLOSED_EARLY, LAPSED, CLOSED_LATE]))).toEqual(expected);
    expect(ids(lastExits([LAPSED, OLD, CLOSED_LATE, CLOSED_EARLY]))).toEqual(expected);
    // The recorded exits still lead the whole list, whatever their own arrival order.
    expect(ids(lastExits([CLOSED_LATE, DONE, OLD, FAILED]))).toEqual(["sess-wrap-dead", "sess-wrap-done", "sess-wrap-old", "sess-wrap-closed-late"]);
  });

  it("with fewer recorded exits than SEAT_EXITS_SHOWN, drops the OLDEST unrecorded seats, not the latest", () => {
    // Six lapsed leases listed oldest first beside one recorded exit: the heading says
    // "the last 5 to exit", so the two earliest lapses are the ones left out.
    const lapsed = Array.from({ length: 6 }, (_, index) => seat({
      expiresAt: `2026-09-03T09:${String(10 + index)}:00.000Z`, liveness: "EXPIRED", sessionId: `sess-wrap-${String(index)}`, status: "OPEN",
    }));
    expect(ids(lastExits([...lapsed, FAILED]))).toEqual(["sess-wrap-dead", "sess-wrap-5", "sess-wrap-4", "sess-wrap-3", "sess-wrap-2"]);
  });

  it("leaves out a LIVE seat with no record - it has not exited - and keeps one whose exit IS recorded", () => {
    expect(ids(lastExits([LIVE, OLD]))).toEqual(["sess-wrap-old"]);
    // `liveness` and `exit` are independent folds on the daemon (session ledger vs exit
    // ledger), so a seat whose wrapper recorded the exit still reads LIVE until its lease
    // lapses. Listing it is the point: its live row says nothing about the exit.
    const deadButLeased = { ...FAILED, expiresAt: "2026-09-03T11:00:00.000Z", liveness: "LIVE" as const, status: "OPEN" as const };
    expect(ids(lastExits([LIVE, deadButLeased]))).toEqual(["sess-wrap-dead"]);
  });

  it("shows at most SEAT_EXITS_SHOWN, dropping the oldest recorded exits", () => {
    const many = Array.from({ length: 7 }, (_, index) => seat({
      exit: { at: `2026-09-03T09:${String(10 + index)}:00.000Z`, exitCode: 0, kind: "COMPLETED", lastLine: null },
      sessionId: `sess-wrap-${String(index)}`,
    }));
    expect(SEAT_EXITS_SHOWN).toBe(5);
    expect(ids(lastExits(many))).toEqual(["sess-wrap-6", "sess-wrap-5", "sess-wrap-4", "sess-wrap-3", "sess-wrap-2"]);
  });

  it("ranks an unparseable exit instant last among the recorded rather than NaN-poisoning the sort", () => {
    const bad = seat({ exit: { at: "not-an-instant", exitCode: 1, kind: "FAILED", lastLine: null }, sessionId: "sess-wrap-bad" });
    expect(ids(lastExits([bad, DONE, FAILED]))).toEqual(["sess-wrap-dead", "sess-wrap-done", "sess-wrap-bad"]);
    // Same rule for an expiry the unrecorded tail ranks by.
    const badLease = seat({ expiresAt: "not-an-instant", liveness: "EXPIRED", sessionId: "sess-wrap-badlease", status: "OPEN" });
    expect(ids(lastExits([badLease, OLD]))).toEqual(["sess-wrap-old", "sess-wrap-badlease"]);
  });
});

describe("SeatExits", () => {
  it("renders nothing at all when no agent seat has exited", () => {
    const { container } = render(<SeatExits nowMs={NOW} seats={[LIVE]} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("cr.sessions.exits")).toBeNull();
  });

  it("says when each seat exited, the reason the wrapper recorded, and the last line it printed", () => {
    render(<SeatExits nowMs={NOW} seats={[OLD, FAILED, KILLED]} />);
    expect(screen.getByTestId("cr.sessions.exits.heading").textContent)
      .toBe(`The last 3 agent seats to exit ${MIDDOT} why each one ended`);
    const failed = screen.getByTestId("cr.sessions.exit.sess-wrap-dead");
    expect(failed.querySelector(".cr2-activity-when")?.textContent).toBe("exited 2 min ago");
    expect(failed.querySelector(".cr2-activity-what")?.textContent).toBe("failed, exit code 1");
    expect(failed.querySelector(".cr2-activity-target")?.textContent)
      .toBe(`sess-wrap-dead ${MIDDOT} last line: Error: spawn claude ENOENT`);
    // Signal death: no exit code and no output, both stated as such, neither coerced to 0 or "".
    const killed = screen.getByTestId("cr.sessions.exit.sess-wrap-killed");
    expect(killed.querySelector(".cr2-activity-when")?.textContent).toBe("exited 10 min ago");
    expect(killed.querySelector(".cr2-activity-what")?.textContent).toBe("failed, no exit code (ended on a signal)");
    expect(killed.querySelector(".cr2-activity-target")?.textContent).toBe(`sess-wrap-killed ${MIDDOT} last line: (no output)`);
    // No record: the absence is NAMED, the lease is what dates the row, and no last line is claimed.
    const old = screen.getByTestId("cr.sessions.exit.sess-wrap-old");
    expect(old.querySelector(".cr2-activity-when")?.textContent).toBe("expired 1 h ago");
    expect(old.querySelector(".cr2-activity-what")?.textContent).toBe("reason not recorded");
    expect(old.querySelector(".cr2-activity-target")?.textContent).toBe("sess-wrap-old");
    // The recorded exit leads even though the daemon listed the unrecorded seat first.
    const rows = [...screen.getByTestId("cr.sessions.exits").querySelectorAll("li")].map((row) => row.getAttribute("data-testid"));
    expect(rows).toEqual(["cr.sessions.exit.sess-wrap-dead", "cr.sessions.exit.sess-wrap-killed", "cr.sessions.exit.sess-wrap-old"]);
  });

  it("reads as one seat for one, and says closed for a closed seat with no record", () => {
    render(<SeatExits nowMs={NOW} seats={[seat({ sessionId: "sess-wrap-x" })]} />);
    expect(screen.getByTestId("cr.sessions.exits.heading").textContent).toBe(`The last agent seat to exit ${MIDDOT} why it ended`);
    expect(screen.getByTestId("cr.sessions.exit.sess-wrap-x").querySelector(".cr2-activity-when")?.textContent).toBe("closed");
  });
});
