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
const PROVIDER = { configured: "claude", envOverride: false };
const frame = (concurrency: unknown, agentProvider: unknown = PROVIDER): Record<string, unknown> => ({
  agentProvider, concurrency, outcome: "SESSIONS", readAt: "2026-09-03T10:00:00.000Z",
  sessions: [SESSION], totals: { closed: 0, expired: 1, live: 1 }, unreadable: false,
});
const CONCURRENCY = { activeSeats: 2, configuredAgentLimit: 3 };

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

/**
 * THE AGENT PROVIDER MEMBER, decoded under the same exact-key rules as everything else.
 * The daemon states which provider this project is CONFIGURED to staff seats with and
 * whether MOE_AGENT_COMMAND overrode the durable setting; the browser shapes it verbatim
 * and REFUSES anything that is not exactly that shape, by stable code and layer.
 */
describe("mapSessionsAnswer decodes the agent provider the daemon states", () => {
  it("shapes the disclosed provider and the override flag verbatim", () => {
    const outcome = mapSessionsAnswer(200, frame(CONCURRENCY, { configured: "codex", envOverride: true }));
    if (outcome.status !== "SESSIONS") throw new Error(`expected SESSIONS, got ${outcome.code}`);
    expect(outcome.agentProvider).toEqual({ configured: "codex", envOverride: true });
    // Both halves of the flag are reachable, so a hard-coded `true` cannot pass.
    const off = mapSessionsAnswer(200, frame(CONCURRENCY, { configured: "claude", envOverride: false }));
    expect(off.status === "SESSIONS" && off.agentProvider).toEqual({ configured: "claude", envOverride: false });
    // The rest of the frame still decodes: the new member displaced nothing.
    expect(off.status === "SESSIONS" && off.concurrency).toEqual(CONCURRENCY);
  });

  it("REJECTS an EXTRA key on the provider member, by code and by layer", () => {
    expect(mapSessionsAnswer(200, frame(CONCURRENCY, { configured: "codex", envOverride: true, extra: 1 })))
      .toEqual({ code: "SESSIONS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_SESSIONS", status: "ERROR" });
  });

  it("REJECTS a MISSING key on the provider member, rather than defaulting it", () => {
    // A browser that quietly filled in `envOverride: false` would tell an operator no
    // override is in force on a daemon that never said so.
    for (const short of [{ configured: "codex" }, { envOverride: true }, {}]) {
      expect(mapSessionsAnswer(200, frame(CONCURRENCY, short)))
        .toEqual({ code: "SESSIONS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_SESSIONS", status: "ERROR" });
    }
  });

  it("REJECTS a WRONG-TYPED member: the flag is a boolean, not a truthy value", () => {
    // `"false"` is the arm that catches a truthiness check — it is a non-empty string, so
    // a `!x` guard would ACCEPT it and render an override the daemon never claimed.
    for (const bad of [
      { configured: "codex", envOverride: "false" }, { configured: "codex", envOverride: "true" },
      { configured: "codex", envOverride: 1 }, { configured: "codex", envOverride: null },
      { configured: 2, envOverride: true }, { configured: "", envOverride: true },
      null, [],
    ]) {
      expect(mapSessionsAnswer(200, frame(CONCURRENCY, bad)))
        .toEqual({ code: "SESSIONS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_SESSIONS", status: "ERROR" });
    }
  });

  it("REJECTS a stale daemon that omits the provider member entirely", () => {
    const stale = frame(CONCURRENCY);
    delete stale["agentProvider"];
    expect(mapSessionsAnswer(200, stale))
      .toEqual({ code: "SESSIONS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_SESSIONS", status: "ERROR" });
  });
});
