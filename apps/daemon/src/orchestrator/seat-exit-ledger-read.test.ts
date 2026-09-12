/**
 * THE READ HALF OF THE SEAT-EXIT LEDGER. `recordSeatExit` has written one durable record per seat
 * exit since the pause gate landed, but nothing folded them back per seat: the Health screen listed
 * past seats as a bare count ("16 closed") and a seat that hung for seven minutes and was killed
 * looked exactly like one that completed. Every arm drives the REAL write path over a real store
 * and reads back through this fold, so the claim under test is "what the wrapper wrote, the daemon
 * can quote" and not the shape of an in-memory fixture.
 */
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import {
  SEAT_EXIT_COMMAND_KIND, SEAT_EXIT_VERSION, commit, recordSeatExit, seatExitAggregateId,
} from "./provider-pause-ledger.js";
import { readSeatExitLedger } from "./seat-exit-ledger-read.js";

afterEach(closeStores);

const AT = "2026-09-03T09:50:00.000Z";
const LATER = "2026-09-03T09:57:00.000Z";
const exitInput = (overrides: Partial<Parameters<typeof recordSeatExit>[1]> = {}) => ({
  decidedAt: AT, exitCode: 1, kind: "FAILED", lastLine: "Error: spawn claude ENOENT",
  projectId: PROJECT_ID, provider: "claude", resetAt: null, sessionId: "sess-wrap-a",
  workItemId: "node.deliver@node-a", ...overrides,
});

describe("readSeatExitLedger folds how each seat ended, keyed by session", () => {
  it("quotes the record's kind, exit code, last line and instant, and nothing else", () => {
    const store = openStore();
    expect(recordSeatExit(store, exitInput()).ok).toBe(true);
    const facts = readSeatExitLedger(store, PROJECT_ID).get("sess-wrap-a");
    expect(facts).toEqual({ at: AT, exitCode: 1, kind: "FAILED", lastLine: "Error: spawn claude ENOENT" });
    // EXACT keys: the browser decodes this object by exact arity, so a member that leaked through
    // here (provider, workItemId, resetAt) would blank the Seats screen rather than enrich it.
    expect(Object.keys(facts as object).sort()).toEqual(["at", "exitCode", "kind", "lastLine"]);
  });

  it("keeps the LATEST record per session and MOVES with it", () => {
    const store = openStore();
    expect(recordSeatExit(store, exitInput()).ok).toBe(true);
    expect(recordSeatExit(store, exitInput({ decidedAt: LATER, exitCode: 0, kind: "COMPLETED", lastLine: "done" })).ok).toBe(true);
    expect(recordSeatExit(store, exitInput({ exitCode: null, kind: "FAILED", lastLine: null, sessionId: "sess-wrap-b" })).ok).toBe(true);
    const ledger = readSeatExitLedger(store, PROJECT_ID);
    expect(ledger.get("sess-wrap-a")).toEqual({ at: LATER, exitCode: 0, kind: "COMPLETED", lastLine: "done" });
    // A seat killed on a signal has NO exit code; the record says null and the fold says null,
    // never 0 and never -1. That is the one fact the finding's hung seat would have carried.
    expect(ledger.get("sess-wrap-b")).toEqual({ at: AT, exitCode: null, kind: "FAILED", lastLine: null });
    expect(ledger.size).toBe(2);
  });

  it("answers an EMPTY fold for another project, and undefined for a seat that never exited", () => {
    const store = openStore();
    expect(recordSeatExit(store, exitInput()).ok).toBe(true);
    expect(readSeatExitLedger(store, "some-other-project").size).toBe(0);
    expect(readSeatExitLedger(store, PROJECT_ID).get("sess-wrap-never")).toBeUndefined();
  });

  it("skips a row whose stream is not its own seat's: only recordSeatExit speaks for a seat", () => {
    // A valid record for sess-wrap-a committed on sess-wrap-other's stream was not written by the
    // ledger's own write path and must not put an exit on either seat.
    const store = openStore();
    const resultBytes = new TextEncoder().encode(JSON.stringify({
      decidedAt: AT, exitCode: 137, kind: "FAILED", lastLine: null, projectId: PROJECT_ID,
      provider: "claude", resetAt: null, sessionId: "sess-wrap-a", version: SEAT_EXIT_VERSION,
      workItemId: "node.deliver@node-a",
    }));
    expect(commit(store, {
      aggregateId: seatExitAggregateId(PROJECT_ID, "sess-wrap-other"), commandId: "seat-exit-forged",
      commandKind: SEAT_EXIT_COMMAND_KIND, correlationId: "test", decidedAt: AT,
      eventType: "SeatExitRecorded", projectId: PROJECT_ID, resultBytes,
    })).toBe(true);
    const ledger = readSeatExitLedger(store, PROJECT_ID);
    expect(ledger.get("sess-wrap-a")).toBeUndefined();
    expect(ledger.get("sess-wrap-other")).toBeUndefined();
    expect(ledger.size).toBe(0);
  });
});
