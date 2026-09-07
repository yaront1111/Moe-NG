/**
 * THE SEAT-START LEDGER: the durable note a wrapper leaves about what it spawned a seat with.
 *
 * Every arm here drives the REAL record path over a REAL sqlite file, because the whole claim of
 * this ledger is that a fact measured in the WRAPPER process survives to the DAEMON process. The
 * shaping arms are held against `shapeAgentVersion` itself — the production surface `/sessions/read`
 * publishes through — never against a second copy of its rules written here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_VERSION_MAX_CHARS, SEAT_FACT_UNMEASURED, SEAT_START_COMMAND_KIND, SEAT_START_VERSION,
  decodeSeatStartBytes, seatStartAggregateId, seatStartRecordId, shapeAgentVersion,
} from "./seat-start-contracts.js";
import { SEAT_START_UNKNOWN, readSeatStartLedger, recordSeatStart } from "./seat-start-ledger.js";

const PROJECT = "project-1";
const AT = "2026-09-03T09:30:00.000Z";
const sandboxes: string[] = [];
const opened: SqliteEventStore[] = [];

function storeAt(path: string): SqliteEventStore {
  const store = SqliteEventStore.openForProject(path, PROJECT);
  opened.push(store);
  return store;
}
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "moe-seat-start-ledger-"));
  sandboxes.push(directory);
  return join(directory, "store.db");
}
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  while (sandboxes.length > 0) {
    const directory = sandboxes.pop();
    if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
  }
});
const input = (overrides: Partial<Parameters<typeof recordSeatStart>[1]> = {}) => ({
  agentVersion: "2.1.263 (Claude Code)", projectId: PROJECT, provider: "claude",
  sessionId: "sess-a", startedAt: AT, ...overrides,
});

describe("recordSeatStart writes one durable note per seat", () => {
  it("commits, decodes back, and answers with the record it wrote", () => {
    const store = storeAt(databasePath());
    const result = recordSeatStart(store, input());
    if (!result.ok) throw new Error(`expected a record, got ${result.code}`);
    expect(result.replayed).toBe(false);
    expect(result.record).toEqual({
      agentVersion: "2.1.263 (Claude Code)", projectId: PROJECT, provider: "claude",
      sessionId: "sess-a", startedAt: AT, version: SEAT_START_VERSION,
    });
  });

  it("REPLAYS rather than writing twice when two wrapper processes race one seat", () => {
    // The command id is derived from (project, session, instant), so the second writer sees the
    // first one's decision. Two notes for one seat would let the LATER one lose a race and
    // publish a version the seat is not running.
    const path = databasePath();
    const first = recordSeatStart(storeAt(path), input());
    const second = recordSeatStart(storeAt(path), input());
    if (!first.ok || !second.ok) throw new Error("expected both writes to answer");
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(seatStartRecordId(PROJECT, "sess-a", AT)).toBe(seatStartRecordId(PROJECT, "sess-a", AT));
    // One seat, one row, no matter how many writers.
    expect(readSeatStartLedger(storeAt(path), PROJECT).size).toBe(1);
  });

  it("REFUSES by code, and writes NOTHING, when the note would not read back", () => {
    // Decode BEFORE commit. Raw multi-line stdout is the realistic way this happens: it is
    // exactly what a caller that skipped `shapeAgentVersion` would hand over.
    const store = storeAt(databasePath());
    for (const agentVersion of [
      "2.1.263 (Claude Code)\nUpdate available", "", "not-a-version", "a".repeat(200),
    ]) {
      expect(recordSeatStart(store, input({ agentVersion, sessionId: `sess-${agentVersion.length}` })))
        .toEqual({ code: "SEAT_START_RECORD_INVALID", ok: false });
    }
    // The refusals left no rows behind: a note this module could not read back is never written.
    expect(readSeatStartLedger(store, PROJECT).size).toBe(0);
  });

  it("uses a DAEMON-INTERNAL command kind that no MCP surface can reach", () => {
    // The whole reason this row cost no roster work: it never enters the command registry.
    expect(SEAT_START_COMMAND_KIND).toBe("internal.wrapper.seat_start");
    expect(seatStartAggregateId(PROJECT, "sess-a")).toBe(`seat-start:${PROJECT}:sess-a`);
  });
});

describe("readSeatStartLedger folds only notes that speak for their own seat", () => {
  it("keeps the LATEST note per session and keys it by sessionId", () => {
    const store = storeAt(databasePath());
    expect(recordSeatStart(store, input({ agentVersion: "1.0.0", startedAt: AT })).ok).toBe(true);
    expect(recordSeatStart(store, input({ agentVersion: "2.0.0", startedAt: "2026-09-03T10:30:00.000Z" })).ok).toBe(true);
    expect(recordSeatStart(store, input({ provider: "codex", agentVersion: "codex-cli 0.153.4", sessionId: "sess-b" })).ok).toBe(true);
    const ledger = readSeatStartLedger(store, PROJECT);
    expect(ledger.get("sess-a")).toEqual({ agentVersion: "2.0.0", provider: "claude" });
    expect(ledger.get("sess-b")).toEqual({ agentVersion: "codex-cli 0.153.4", provider: "codex" });
    expect(ledger.size).toBe(2);
  });

  it("answers an EMPTY fold for another project's notes, never that project's values", () => {
    const store = storeAt(databasePath());
    expect(recordSeatStart(store, input()).ok).toBe(true);
    expect(readSeatStartLedger(store, "some-other-project").size).toBe(0);
    expect(readSeatStartLedger(store, PROJECT).get("sess-a")?.provider).toBe("claude");
  });

  it("states the ONE unknown for a seat with no note at all", () => {
    const store = storeAt(databasePath());
    expect(readSeatStartLedger(store, PROJECT).get("sess-never-started")).toBeUndefined();
    // What the read publishes in that case, asserted as the exact token and not as falsiness.
    expect(SEAT_START_UNKNOWN).toEqual({ agentVersion: "UNKNOWN", provider: "UNKNOWN" });
    expect(SEAT_FACT_UNMEASURED).toBe("UNKNOWN");
  });
});

describe("shapeAgentVersion refuses to vouch for output nobody can read as a version", () => {
  it("keeps a single shaped line from each provider this repo actually spawns", () => {
    // The literals are the readings THIS HOST returned from `claude --version` and
    // `codex --version`; a shaping rule that rejected either would be useless in production.
    expect(shapeAgentVersion("2.1.263 (Claude Code)\n")).toBe("2.1.263 (Claude Code)");
    expect(shapeAgentVersion("codex-cli 0.153.4\n")).toBe("codex-cli 0.153.4");
  });

  it("degrades EVERY unreadable answer to the ONE stated unknown, never to a blank", () => {
    for (const raw of [
      null,                                        // the probe never answered
      "",                                          // it answered nothing
      "   \n  \n",                                 // it answered whitespace
      "2.1.263\nUpdate available: 2.2.0",          // extra output: something else answered
      "Claude Code",                               // no dotted number: not a version
      "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF",     // credential-shaped, and refused
      `${"9.9.9 ".repeat(40)}`,                    // longer than a version line can be
      "1.0.0 & whoami",                            // shell metacharacters
      "1.0.0; rm -rf /",                           // ditto
      "1.0.0 <script>",                            // ditto
      "1.0.0\u0000",                               // a NUL byte
    ]) {
      expect(shapeAgentVersion(raw)).toBe(SEAT_FACT_UNMEASURED);
    }
    // The bound is real, and the boundary is inclusive on the short side.
    expect(shapeAgentVersion(`1.0.0${"0".repeat(AGENT_VERSION_MAX_CHARS - 5)}`)).not.toBe(SEAT_FACT_UNMEASURED);
    expect(shapeAgentVersion(`1.0.0${"0".repeat(AGENT_VERSION_MAX_CHARS - 4)}`)).toBe(SEAT_FACT_UNMEASURED);
  });
});

describe("decodeSeatStartBytes is EXACT-KEY, so a future shape is ignored not half-read", () => {
  const encoder = new TextEncoder();
  const bytes = (value: Record<string, unknown>): Uint8Array =>
    encoder.encode(JSON.stringify(value));
  const full = {
    agentVersion: "1.2.3", projectId: PROJECT, provider: "claude", sessionId: "sess-a",
    startedAt: AT, version: SEAT_START_VERSION,
  };

  it("accepts exactly its own six keys", () => {
    const decoded = decodeSeatStartBytes(bytes(full));
    expect(decoded.ok && decoded.record.agentVersion).toBe("1.2.3");
  });

  it("REFUSES an extra key, a missing key, and every wrong-typed member, by code", () => {
    expect(decodeSeatStartBytes(bytes({ ...full, extra: 1 })))
      .toEqual({ code: "SEAT_START_RECORD_INVALID", ok: false });
    for (const key of Object.keys(full)) {
      const short: Record<string, unknown> = { ...full };
      delete short[key];
      expect(decodeSeatStartBytes(bytes(short)))
        .toEqual({ code: "SEAT_START_RECORD_INVALID", ok: false });
    }
    for (const bad of [
      { ...full, version: "moe-seat-start/2" }, { ...full, startedAt: "Sep 3" },
      { ...full, startedAt: 1 }, { ...full, provider: "" }, { ...full, provider: 1 },
      { ...full, sessionId: "" }, { ...full, agentVersion: "" }, { ...full, agentVersion: 0 },
      // Written by a looser build: re-shaped on the way OUT, so it cannot be published now.
      { ...full, agentVersion: "1.2.3 & whoami" }, { ...full, agentVersion: "not-a-version" },
    ]) {
      expect(decodeSeatStartBytes(bytes(bad)))
        .toEqual({ code: "SEAT_START_RECORD_INVALID", ok: false });
    }
    // The stated unknown is the ONE value exempt from the version shape, by design.
    expect(decodeSeatStartBytes(bytes({ ...full, agentVersion: SEAT_FACT_UNMEASURED })).ok).toBe(true);
  });
});
