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

import { SEAT_EXIT_KEYS, SEAT_FACT_UNMEASURED, SESSIONS_FRAME_KEYS, SESSION_KEYS, mapSessionsAnswer } from "./live-sessions.js";

const SESSION = {
  agentVersionAtStart: "2.1.263 (Claude Code)",
  capabilities: ["review.write", "work.write"], exit: null, expiresAt: "2026-09-03T11:00:00.000Z",
  holding: ["node.deliver@node-a"], liveness: "LIVE", principalId: "sess-wrap-abc",
  providerAtStart: "claude", sessionId: "sess-wrap-abc", startedAt: "2026-09-03T09:48:00.000Z", status: "OPEN",
};
const EXIT = { at: "2026-09-03T09:58:00.000Z", exitCode: 1, kind: "FAILED", lastLine: "Error: spawn claude ENOENT" };
/** A frame carrying exactly the seats given, so a per-SEAT arm can vary one row at a time. */
const seatFrame = (...rows: readonly unknown[]): Record<string, unknown> => ({
  agentProvider: { configured: "claude", envOverride: false },
  concurrency: { activeSeats: 2, configuredAgentLimit: 3 }, outcome: "SESSIONS",
  readAt: "2026-09-03T10:00:00.000Z", sessions: rows,
  totals: { closed: 0, expired: 1, live: 1 }, unreadable: false,
});
const INVALID = {
  code: "SESSIONS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_SESSIONS", status: "ERROR",
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
    const source = readFileSync(resolve(process.cwd(), "..", "daemon", "src", "http", "sessions-read-contracts.ts"), "utf8");
    const body = /export interface SessionsView \{\r?\n(?<members>[\s\S]*?)\r?\n\}/u.exec(source)?.groups?.["members"];
    if (body === undefined) throw new Error("SessionsView not found in apps/daemon/src/http/sessions-read-contracts.ts");
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

/**
 * THE PER-SEAT MEMBERS, and the guard that did not exist before this row.
 *
 * `SESSIONS_FRAME_KEYS` and the source-text pin above govern TOP-LEVEL frame members only, so
 * `sessionOf`'s roster had NOTHING holding it against the daemon's `SessionView` — silent drift
 * in the one decode whose failure blanks the screen rather than reddening a test. Both halves
 * are pinned here now, and every refusal names its CODE and its LAYER, never merely "not
 * SESSIONS": a frame that failed for some other reason would pass a weaker assertion.
 */
describe("mapSessionsAnswer decodes what each SEAT was started with", () => {
  it("shapes both per-seat members verbatim and adds no interpretation", () => {
    const outcome = mapSessionsAnswer(200, seatFrame(SESSION));
    if (outcome.status !== "SESSIONS") throw new Error(`expected SESSIONS, got ${outcome.code}`);
    expect(outcome.sessions).toHaveLength(1);
    expect(outcome.sessions[0]).toEqual({
      agentVersionAtStart: "2.1.263 (Claude Code)", capabilities: ["review.write", "work.write"],
      exit: null, expiresAt: "2026-09-03T11:00:00.000Z", holding: ["node.deliver@node-a"], liveness: "LIVE",
      principalId: "sess-wrap-abc", providerAtStart: "claude", sessionId: "sess-wrap-abc",
      startedAt: "2026-09-03T09:48:00.000Z", status: "OPEN",
    });
    // Both members MOVE with the frame: a hard-coded "claude"/version could not pass this pair.
    const other = mapSessionsAnswer(200, seatFrame(
      { ...SESSION, agentVersionAtStart: "codex-cli 0.153.4", providerAtStart: "codex" },
    ));
    expect(other.status === "SESSIONS" && other.sessions[0]?.providerAtStart).toBe("codex");
    expect(other.status === "SESSIONS" && other.sessions[0]?.agentVersionAtStart)
      .toBe("codex-cli 0.153.4");
  });

  it("carries the daemon's STATED UNKNOWN through as a value, not as a blank", () => {
    // A seat nobody measured must arrive as the word the daemon chose, so a screen can tell an
    // absence from a reading. Decoding it to "" or dropping it would erase that distinction.
    const outcome = mapSessionsAnswer(200, seatFrame({
      ...SESSION, agentVersionAtStart: SEAT_FACT_UNMEASURED, providerAtStart: SEAT_FACT_UNMEASURED,
    }));
    if (outcome.status !== "SESSIONS") throw new Error(`expected SESSIONS, got ${outcome.code}`);
    expect(outcome.sessions[0]?.providerAtStart).toBe("UNKNOWN");
    expect(outcome.sessions[0]?.agentVersionAtStart).toBe("UNKNOWN");
    expect(SEAT_FACT_UNMEASURED).toBe("UNKNOWN");
  });

  it("REJECTS an EXTRA key on a SESSION, by code and by layer", () => {
    expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, extra: 1 }))).toEqual(INVALID);
  });

  it("REJECTS a DROPPED key on a SESSION rather than defaulting it", () => {
    // Every key, one at a time: an arm that only dropped the two new members would stay green
    // if a later edit loosened the roster for one of the seven that were already there.
    for (const key of SESSION_KEYS) {
      const short: Record<string, unknown> = { ...SESSION };
      delete short[key];
      expect(mapSessionsAnswer(200, seatFrame(short))).toEqual(INVALID);
    }
    expect(SESSION_KEYS.length).toBe(11);
  });

  it("REJECTS a WRONG-TYPED per-seat member, including values a truthiness check accepts", () => {
    // `"false"`, `0`, `[]` and `{}` are the arms that catch `if (x)`: a truthiness guard would
    // accept the first and reject the rest, so an implementation that passed only some of these
    // is exactly the defect. `""` is the one that catches a bare `typeof x === "string"`.
    for (const bad of ["", 0, 1, false, true, null, [], {}, ["claude"], { name: "claude" }]) {
      expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, providerAtStart: bad }))).toEqual(INVALID);
      expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, agentVersionAtStart: bad }))).toEqual(INVALID);
    }
  });

  it("REJECTS the WHOLE frame when ANY seat is bad — one bad row blanks the screen", () => {
    // Not a per-row degrade: `sessionOf` returning null aborts the frame. Stated, so nobody
    // later "improves" this into skipping the row and publishing a shorter list of seats.
    expect(mapSessionsAnswer(200, seatFrame(SESSION, { ...SESSION, providerAtStart: 1 })))
      .toEqual(INVALID);
    expect(mapSessionsAnswer(200, seatFrame(SESSION, null))).toEqual(INVALID);
  });

  it("expects exactly the members the DAEMON's SessionView declares", () => {
    // THE GUARD THIS ROW ADDS. The pin above covers `SessionsView` (the FRAME); this covers
    // `SessionView` (ONE SEAT), whose drift is what actually blanks the Seats screen. Read as
    // source text because the control room must never import apps/daemon.
    const source = readFileSync(resolve(process.cwd(), "..", "daemon", "src", "http", "sessions-read-contracts.ts"), "utf8");
    const body = /export interface SessionView \{\r?\n(?<members>[\s\S]*?)\r?\n\}/u.exec(source)?.groups?.["members"];
    if (body === undefined) throw new Error("SessionView not found in apps/daemon/src/http/sessions-read-contracts.ts");
    const declared = [...body.matchAll(/^ {2}readonly (?<name>[A-Za-z]+)[?]?:/gmu)].map((match) => match.groups?.["name"]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...SESSION_KEYS].sort());
  });

  it("pins the STATED UNKNOWN to the daemon's own constant, not to a retyped literal", () => {
    // Two packages cannot share a module, so they share a checked FACT instead: a rename on
    // the daemon side reddens here rather than silently teaching the browser a dead word.
    const source = readFileSync(resolve(process.cwd(), "..", "daemon", "src", "orchestrator", "seat-start-contracts.ts"), "utf8");
    expect(source).toContain(`export const SEAT_FACT_UNMEASURED = "${SEAT_FACT_UNMEASURED}" as const;`);
  });
});

/**
 * WHEN A SEAT STARTED AND HOW IT ENDED — the two per-seat members the Health screen could not
 * show. Measured on a live drive: a seat that hung for seven minutes read "live until <expiry>"
 * like a working one, and its exit was one more "closed" in a count. Both arrive from the daemon
 * as VALUES OR NULL and are shaped verbatim; the decode refuses every other shape by code and
 * layer, because a browser that defaulted "started just now" or "completed" would put a fact on
 * screen the daemon never stated.
 */
describe("mapSessionsAnswer decodes when a seat started and how it ended", () => {
  it("shapes the start instant verbatim, and carries the daemon's null through as null", () => {
    const outcome = mapSessionsAnswer(200, seatFrame(SESSION));
    if (outcome.status !== "SESSIONS") throw new Error(`expected SESSIONS, got ${outcome.code}`);
    expect(outcome.sessions[0]?.startedAt).toBe("2026-09-03T09:48:00.000Z");
    // It MOVES with the frame, and null is a value here, not a blank: a paired browser and every
    // seat older than the start ledger arrive as null and must render as "not recorded".
    const other = mapSessionsAnswer(200, seatFrame({ ...SESSION, startedAt: "2026-09-03T09:55:00.000Z" }));
    expect(other.status === "SESSIONS" && other.sessions[0]?.startedAt).toBe("2026-09-03T09:55:00.000Z");
    const none = mapSessionsAnswer(200, seatFrame({ ...SESSION, startedAt: null }));
    expect(none.status === "SESSIONS" && none.sessions[0]?.startedAt).toBeNull();
  });

  it("REJECTS a start instant that is neither a non-empty string nor null", () => {
    // `""` catches a bare typeof check; `0`, `false`, `[]`, `{}` catch a truthiness one; and
    // `undefined` (the key present, the value missing) must not read as "null".
    for (const bad of ["", 0, 1, false, true, [], {}, undefined]) {
      expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, startedAt: bad }))).toEqual(INVALID);
    }
  });

  it("shapes a recorded exit verbatim: kind, exit code, last line and instant", () => {
    const outcome = mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: EXIT, liveness: "CLOSED", status: "CLOSED" }));
    if (outcome.status !== "SESSIONS") throw new Error(`expected SESSIONS, got ${outcome.code}`);
    expect(outcome.sessions[0]?.exit).toEqual(EXIT);
    // A seat killed on a signal has NO exit code and no last line: both nulls are VALUES the
    // screen renders as such, never coerced to 0 or "".
    const killed = mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: { ...EXIT, exitCode: null, lastLine: null } }));
    expect(killed.status === "SESSIONS" && killed.sessions[0]?.exit).toEqual({ at: EXIT.at, exitCode: null, kind: "FAILED", lastLine: null });
    const done = mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: { ...EXIT, exitCode: 0, kind: "COMPLETED" } }));
    expect(done.status === "SESSIONS" && done.sessions[0]?.exit?.kind).toBe("COMPLETED");
    expect(done.status === "SESSIONS" && done.sessions[0]?.exit?.exitCode).toBe(0);
  });

  it("REJECTS an exit object with an EXTRA or a DROPPED key, by code and by layer", () => {
    expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: { ...EXIT, signal: "SIGKILL" } }))).toEqual(INVALID);
    for (const key of SEAT_EXIT_KEYS) {
      const short: Record<string, unknown> = { ...EXIT };
      delete short[key];
      expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: short }))).toEqual(INVALID);
    }
    expect(SEAT_EXIT_KEYS.length).toBe(4);
  });

  it("REJECTS a WRONG-TYPED exit member, including values a truthiness check accepts", () => {
    // `"1"` is the arm that catches an exit code read as text; `1.5` catches a non-integer; `""`
    // catches a bare typeof on the instant and the kind; `0` on lastLine catches truthiness.
    for (const exitCode of ["1", 1.5, "", false, [], {}, undefined]) {
      expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: { ...EXIT, exitCode } }))).toEqual(INVALID);
    }
    for (const lastLine of [0, 1, false, true, [], {}, undefined]) {
      expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: { ...EXIT, lastLine } }))).toEqual(INVALID);
    }
    for (const bad of ["", 0, null, false, [], {}, undefined]) {
      expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: { ...EXIT, at: bad } }))).toEqual(INVALID);
      expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: { ...EXIT, kind: bad } }))).toEqual(INVALID);
    }
    // The exit member itself: anything but null or an exact record.
    for (const bad of ["", 0, 1, false, true, [], "FAILED", undefined]) {
      expect(mapSessionsAnswer(200, seatFrame({ ...SESSION, exit: bad }))).toEqual(INVALID);
    }
  });

  it("expects exactly the members the DAEMON's SeatExitView declares", () => {
    // The same guard the SessionView pin gives the seat: this nested decode is exact-arity too,
    // so a member the daemon adds to the exit (a signal, say) blanks the screen unless it lands
    // here in the same change. Read as source text; the control room never imports apps/daemon.
    const source = readFileSync(resolve(process.cwd(), "..", "daemon", "src", "http", "sessions-read-contracts.ts"), "utf8");
    const body = /export interface SeatExitView \{\r?\n(?<members>[\s\S]*?)\r?\n\}/u.exec(source)?.groups?.["members"];
    if (body === undefined) throw new Error("SeatExitView not found in apps/daemon/src/http/sessions-read-contracts.ts");
    const declared = [...body.matchAll(/^ {2}readonly (?<name>[A-Za-z]+)[?]?:/gmu)].map((match) => match.groups?.["name"]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...SEAT_EXIT_KEYS].sort());
  });
});
