/**
 * The SESSIONS decoder. There was no coverage here before this row, and the decode is
 * EXACT-ARITY at every level: a member the daemon adds and the browser does not expect
 * does not degrade the Seats screen, it blanks it. So the round trip is asserted in both
 * directions — a full frame decodes, and a frame missing a member is REJECTED by code
 * rather than silently defaulted, which is the whole point of exact arity.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SESSIONS_FRAME_KEYS, mapSessionsAnswer } from "./live-sessions.js";

const SESSION = {
  capabilities: ["review.write", "work.write"], expiresAt: "2026-09-03T11:00:00.000Z",
  holding: ["node.deliver@node-a"], liveness: "LIVE", principalId: "sess-wrap-abc",
  sessionId: "sess-wrap-abc", status: "OPEN",
};
const frame = (concurrency: unknown): Record<string, unknown> => ({
  concurrency, outcome: "SESSIONS", readAt: "2026-09-03T10:00:00.000Z",
  sessions: [SESSION], totals: { closed: 0, expired: 1, live: 1 }, unreadable: false,
});

describe("mapSessionsAnswer decodes the concurrency the daemon states", () => {
  it("exposes the stated limit and active seats on a full frame", () => {
    const outcome = mapSessionsAnswer(200, frame({ activeSeats: 2, configuredAgentLimit: 3 }));
    if (outcome.status !== "SESSIONS") throw new Error(`expected SESSIONS, got ${outcome.code}`);
    expect(outcome.concurrency).toEqual({ activeSeats: 2, configuredAgentLimit: 3 });
    // The rest of the frame still decodes: the new member did not displace anything.
    expect(outcome.totals).toEqual({ closed: 0, expired: 1, live: 1 });
    expect(outcome.sessions.map((row) => row.sessionId)).toEqual(["sess-wrap-abc"]);
    expect(outcome.readAt).toBe("2026-09-03T10:00:00.000Z");
  });

  it("REJECTS a stale daemon that omits concurrency, rather than defaulting it", () => {
    const stale = frame({ activeSeats: 0, configuredAgentLimit: 2 });
    delete stale.concurrency;
    const outcome = mapSessionsAnswer(200, stale);
    // The stable code, not merely "not SESSIONS": a browser that quietly filled in a 2
    // would show an operator a limit no daemon ever stated.
    expect(outcome).toEqual({ code: "SESSIONS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_SESSIONS", status: "ERROR" });
  });

  it("REJECTS a malformed concurrency member instead of rendering NaN", () => {
    for (const bad of [
      { activeSeats: 2 },                                        // short by a key
      { activeSeats: 0, configuredAgentLimit: 2, extra: 1 },      // long by a key
      { activeSeats: "2", configuredAgentLimit: 2 },              // not a number
      { activeSeats: 0, configuredAgentLimit: -1 },               // negative
      { activeSeats: 0, configuredAgentLimit: 1.5 },              // not an integer
      null,
    ]) {
      expect(mapSessionsAnswer(200, frame(bad))).toMatchObject({ code: "SESSIONS_RESPONSE_INVALID", status: "ERROR" });
    }
  });

  it("still reads a refusal frame as REFUSED, unchanged by the new member", () => {
    expect(mapSessionsAnswer(200, { code: "SESSIONS_READ_CAPABILITY_DENIED", layer: "SESSIONS_READ", outcome: "REFUSED" }))
      .toEqual({ code: "SESSIONS_READ_CAPABILITY_DENIED", layer: "SESSIONS_READ", status: "REFUSED" });
  });

  it("expects exactly the members the DAEMON's SessionsView declares", () => {
    // Both halves of this frame must move together or the screen blanks. Read the daemon's
    // interface as source text — the control room must never IMPORT apps/daemon — and hold
    // it against the decoder's own roster, not against a list retyped here.
    const source = readFileSync(resolve(process.cwd(), "..", "daemon", "src", "http", "sessions-read.ts"), "utf8");
    const body = /export interface SessionsView \{\r?\n(?<members>[\s\S]*?)\r?\n\}/u.exec(source)?.groups?.["members"];
    if (body === undefined) throw new Error("SessionsView not found in apps/daemon/src/http/sessions-read.ts");
    // Two-space indent anchors this to TOP-LEVEL members: `totals` declares its own
    // `readonly closed/expired/live` inline, and those are not frame keys.
    const declared = [...body.matchAll(/^ {2}readonly (?<name>[A-Za-z]+)[?]?:/gmu)].map((match) => match.groups?.["name"]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...SESSIONS_FRAME_KEYS].sort());
  });
});
