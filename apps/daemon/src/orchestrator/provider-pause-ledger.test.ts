import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, decisionCount, openStore } from "../review/review-test-fixtures.js";
import {
  AGENT_WRAPPER_PRINCIPAL_ID, PROVIDER_PAUSE_COMMAND_KIND, PROVIDER_PAUSE_VERSION,
  SEAT_EXIT_COMMAND_KIND, SEAT_EXIT_VERSION, clearProviderPause, commit, decodeSeatExitBytes,
  providerPauseAggregateId, providerPauseRecordId, readProviderPause, recordProviderPause,
  recordSeatExit, seatExitAggregateId, seatExitRecordId,
} from "./provider-pause-ledger.js";

afterEach(closeStores);

const encoder = new TextEncoder();
const LIMIT_LINE = "You've hit your session limit · resets 12:10am Asia/Jerusalem";
const SINCE = "2026-09-03T18:04:00.000Z";
const RESET_AT = "2026-09-03T21:10:00.000Z";

function pauseInput(overrides: Record<string, unknown> = {}) {
  return {
    cause: { lastLine: LIMIT_LINE, workItemId: "item-7" },
    projectId: PROJECT_ID,
    provider: "claude",
    resetAt: RESET_AT,
    since: SINCE,
    ...overrides,
  };
}

function seatExitInput(overrides: Record<string, unknown> = {}) {
  return {
    decidedAt: SINCE,
    exitCode: 1,
    kind: "PROVIDER_LIMIT",
    lastLine: LIMIT_LINE,
    outputSeen: true,
    projectId: PROJECT_ID,
    provider: "claude",
    resetAt: RESET_AT,
    sessionId: "sess-wrap-ae8048c4",
    terminatedByWrapper: false,
    workItemId: "item-7",
    ...overrides,
  };
}

/**
 * A row exactly as the writer laid it down BEFORE the two flags existed (every seat exit
 * recorded up to 2026-09-13): ten keys, no output flag, no termination flag. Copied from
 * that writer's own test expectation, never re-derived.
 */
const OLDER_ROW = {
  decidedAt: SINCE,
  exitCode: 1,
  kind: "PROVIDER_LIMIT",
  lastLine: LIMIT_LINE,
  projectId: PROJECT_ID,
  provider: "claude",
  resetAt: RESET_AT,
  sessionId: "sess-wrap-ae8048c4",
  version: "moe-seat-exit/1",
  workItemId: "item-7",
};

describe("recordProviderPause / readProviderPause", () => {
  it("reads back the pause with exact keys while the reset is still ahead", () => {
    const store = openStore();
    const written = recordProviderPause(store, pauseInput());
    expect(written.ok).toBe(true);
    const pause = readProviderPause(store, PROJECT_ID, "claude", "2026-09-03T19:00:00.000Z");
    expect(pause).toEqual({
      cause: { lastLine: LIMIT_LINE, workItemId: "item-7" },
      projectId: PROJECT_ID,
      provider: "claude",
      resetAt: RESET_AT,
      since: SINCE,
      version: PROVIDER_PAUSE_VERSION,
    });
    expect(Object.keys(pause as object).sort()).toEqual([
      "cause", "projectId", "provider", "resetAt", "since", "version",
    ]);
  });

  it("stops answering AT the reset instant, not after it", () => {
    const store = openStore();
    expect(recordProviderPause(store, pauseInput()).ok).toBe(true);
    // Strictly-greater is the rule: at resetAt the limit is over, so the pause is already spent.
    expect(readProviderPause(store, PROJECT_ID, "claude", RESET_AT)).toBeNull();
    expect(readProviderPause(store, PROJECT_ID, "claude", "2026-09-03T21:10:00.001Z")).toBeNull();
    expect(readProviderPause(store, PROJECT_ID, "claude", "2026-09-04T00:00:00.000Z")).toBeNull();
  });

  it("answers null for a provider that was never paused", () => {
    const store = openStore();
    expect(recordProviderPause(store, pauseInput()).ok).toBe(true);
    expect(readProviderPause(store, PROJECT_ID, "codex", "2026-09-03T19:00:00.000Z")).toBeNull();
    expect(readProviderPause(store, "project-other", "claude", "2026-09-03T19:00:00.000Z")).toBeNull();
  });

  it("lets the LATEST pause win, not the first", () => {
    const store = openStore();
    expect(recordProviderPause(store, pauseInput()).ok).toBe(true);
    const later = recordProviderPause(store, pauseInput({
      resetAt: "2026-09-04T21:10:00.000Z", since: "2026-09-03T20:00:00.000Z",
    }));
    expect(later.ok).toBe(true);
    const pause = readProviderPause(store, PROJECT_ID, "claude", "2026-09-04T00:00:00.000Z");
    expect(pause?.resetAt).toBe("2026-09-04T21:10:00.000Z");
    expect(pause?.since).toBe("2026-09-03T20:00:00.000Z");
  });

  it("is cleared by a record whose reset is now, with the same event type", () => {
    const store = openStore();
    expect(recordProviderPause(store, pauseInput()).ok).toBe(true);
    const now = "2026-09-03T19:30:00.000Z";
    const cleared = clearProviderPause(store, { now, projectId: PROJECT_ID, provider: "claude" });
    expect(cleared.ok).toBe(true);
    expect(readProviderPause(store, PROJECT_ID, "claude", now)).toBeNull();
    // A clear is an ordinary pause record: same kind, same aggregate, resetAt = now, no cause.
    expect(cleared.ok && cleared.record).toEqual({
      cause: null,
      projectId: PROJECT_ID,
      provider: "claude",
      resetAt: now,
      since: now,
      version: PROVIDER_PAUSE_VERSION,
    });
  });

  it("lands on the provider's own aggregate under the wrapper principal", () => {
    const store = openStore();
    expect(recordProviderPause(store, pauseInput()).ok).toBe(true);
    const commandId = providerPauseRecordId(PROJECT_ID, "claude", SINCE);
    const decision = store.getCommandDecision({
      commandId, principalId: AGENT_WRAPPER_PRINCIPAL_ID, projectId: PROJECT_ID,
    });
    expect(decision).not.toBeNull();
    expect(decision?.commandKind).toBe(PROVIDER_PAUSE_COMMAND_KIND);
    expect(decision?.key.principalId).toBe(AGENT_WRAPPER_PRINCIPAL_ID);
    expect(decision?.targetAggregateId).toBe(providerPauseAggregateId(PROJECT_ID, "claude"));
    expect(providerPauseAggregateId(PROJECT_ID, "claude")).toBe(`provider-pause:${PROJECT_ID}:claude`);
    expect(store.readEvents(providerPauseAggregateId(PROJECT_ID, "claude")).length).toBe(1);
  });

  it("replays the same commandId instead of writing a second decision", () => {
    const store = openStore();
    expect(recordProviderPause(store, pauseInput()).ok).toBe(true);
    const before = decisionCount(store);
    const again = recordProviderPause(store, pauseInput());
    expect(again.ok && again.replayed).toBe(true);
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses a record it could not decode back, and never writes it", () => {
    const store = openStore();
    const before = decisionCount(store);
    const bad = recordProviderPause(store, pauseInput({ resetAt: "" }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.code).toBe("PROVIDER_PAUSE_RECORD_INVALID");
    expect(decisionCount(store)).toBe(before);
  });

  it("ignores a pause decision whose result bytes do not decode to the exact record", () => {
    const store = openStore();
    const aggregateId = providerPauseAggregateId(PROJECT_ID, "claude");
    // Planted through the SAME seam the ledger writes through — an internal-kind decision on the
    // provider's aggregate under the wrapper principal, carrying junk where the record should be.
    const response = store.commitExpectedVersionDecision({
      commandKind: PROVIDER_PAUSE_COMMAND_KIND,
      committedResultBytes: encoder.encode("{\"version\":\"moe-provider-pause/1\",\"junk\":true}"),
      correlationId: "planted-corruption",
      decidedAt: SINCE,
      events: [{
        eventId: "planted-ProviderPaused", eventType: "ProviderPaused", payload: encoder.encode("{}"),
      }],
      expectedVersion: store.getAggregateVersion(aggregateId),
      key: { commandId: "planted-1", principalId: AGENT_WRAPPER_PRINCIPAL_ID, projectId: PROJECT_ID },
      requestBytes: encoder.encode("{}"),
      targetAggregateId: aggregateId,
    });
    expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
    expect(readProviderPause(store, PROJECT_ID, "claude", "2026-09-03T19:00:00.000Z")).toBeNull();
    // And a good record written afterwards is still readable: one bad row poisons nothing else.
    expect(recordProviderPause(store, pauseInput()).ok).toBe(true);
    expect(readProviderPause(store, PROJECT_ID, "claude", "2026-09-03T19:00:00.000Z")?.resetAt)
      .toBe(RESET_AT);
  });
});

describe("provider strings the roster has never seen", () => {
  it("pauses a provider the classifier does not know — the wrapper keys the aggregate", () => {
    const store = openStore();
    // No roster gate on the LEDGER: a new provider must be pausable the day it is added, before
    // anyone has captured a refusal line for it.
    expect(recordProviderPause(store, pauseInput({ provider: "gemini" })).ok).toBe(true);
    const pause = readProviderPause(store, PROJECT_ID, "gemini", "2026-09-03T19:00:00.000Z");
    expect(pause?.provider).toBe("gemini");
    expect(providerPauseAggregateId(PROJECT_ID, "gemini"))
      .toBe(`provider-pause:${PROJECT_ID}:gemini`);
    // ...and it does not leak into another provider's answer.
    expect(readProviderPause(store, PROJECT_ID, "claude", "2026-09-03T19:00:00.000Z")).toBeNull();
  });

  it("refuses an empty provider rather than writing to a headless aggregate", () => {
    const store = openStore();
    const before = decisionCount(store);
    const bad = recordProviderPause(store, pauseInput({ provider: "" }));
    expect(!bad.ok && bad.code).toBe("PROVIDER_PAUSE_RECORD_INVALID");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses a timestamp Date.parse would coerce but no one could compare", () => {
    const store = openStore();
    const before = decisionCount(store);
    for (const resetAt of ["123", "Sep 8", "2026-09-08", "tomorrow"]) {
      const bad = recordProviderPause(store, pauseInput({ resetAt }));
      expect(!bad.ok && bad.code).toBe("PROVIDER_PAUSE_RECORD_INVALID");
    }
    expect(decisionCount(store)).toBe(before);
  });
});

describe("recordSeatExit", () => {
  it("writes an exact-key moe-seat-exit/1 decision under the wrapper principal", () => {
    const store = openStore();
    const written = recordSeatExit(store, seatExitInput());
    expect(written.ok).toBe(true);
    expect(written.ok && written.record).toEqual({
      decidedAt: SINCE,
      exitCode: 1,
      kind: "PROVIDER_LIMIT",
      lastLine: LIMIT_LINE,
      outputSeen: true,
      projectId: PROJECT_ID,
      provider: "claude",
      resetAt: RESET_AT,
      sessionId: "sess-wrap-ae8048c4",
      terminatedByWrapper: false,
      version: SEAT_EXIT_VERSION,
      workItemId: "item-7",
    });
    // The two flags are ADDITIVE under the same version: another reader of this record
    // (the /sessions/read fold) keys on this exact string and must keep decoding new rows.
    expect(SEAT_EXIT_VERSION).toBe("moe-seat-exit/1");
    const commandId = seatExitRecordId(PROJECT_ID, "sess-wrap-ae8048c4", SINCE);
    const decision = store.getCommandDecision({
      commandId, principalId: AGENT_WRAPPER_PRINCIPAL_ID, projectId: PROJECT_ID,
    });
    expect(decision?.commandKind).toBe(SEAT_EXIT_COMMAND_KIND);
    expect(decision?.key.principalId).toBe(AGENT_WRAPPER_PRINCIPAL_ID);
    expect(decision?.targetAggregateId)
      .toBe(seatExitAggregateId(PROJECT_ID, "sess-wrap-ae8048c4"));
    expect(seatExitAggregateId(PROJECT_ID, "sess-wrap-ae8048c4"))
      .toBe(`seat-exit:${PROJECT_ID}:sess-wrap-ae8048c4`);
    expect(store.readEvents(seatExitAggregateId(PROJECT_ID, "sess-wrap-ae8048c4")).length).toBe(1);
  });

  it("records an ordinary FAILED exit with no reset", () => {
    const store = openStore();
    const written = recordSeatExit(store, seatExitInput({
      kind: "FAILED", lastLine: "Error: spawn claude ENOENT", resetAt: null,
    }));
    expect(written.ok && written.record.kind).toBe("FAILED");
    expect(written.ok && written.record.resetAt).toBeNull();
  });

  it("truncates an over-long last line to 512 characters", () => {
    const store = openStore();
    const written = recordSeatExit(store, seatExitInput({ lastLine: "z".repeat(4000) }));
    expect(written.ok && written.record.lastLine?.length).toBe(512);
  });

  it("refuses a kind outside the classifier's roster, and never writes it", () => {
    const store = openStore();
    const before = decisionCount(store);
    const bad = recordSeatExit(store, seatExitInput({ kind: "PROBABLY_A_LIMIT" }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.code).toBe("SEAT_EXIT_RECORD_INVALID");
    expect(decisionCount(store)).toBe(before);
  });

  it("replays a retried seat exit instead of writing a second decision", () => {
    const store = openStore();
    expect(recordSeatExit(store, seatExitInput()).ok).toBe(true);
    const before = decisionCount(store);
    const again = recordSeatExit(store, seatExitInput());
    expect(again.ok && again.replayed).toBe(true);
    expect(decisionCount(store)).toBe(before);
  });

  it("keeps each session on its own aggregate", () => {
    const store = openStore();
    expect(recordSeatExit(store, seatExitInput()).ok).toBe(true);
    expect(recordSeatExit(store, seatExitInput({ sessionId: "sess-wrap-other" })).ok).toBe(true);
    expect(store.readEvents(seatExitAggregateId(PROJECT_ID, "sess-wrap-ae8048c4")).length).toBe(1);
    expect(store.readEvents(seatExitAggregateId(PROJECT_ID, "sess-wrap-other")).length).toBe(1);
  });

  // The exit facts the live hang (seat pid 88288, 2026-09-12 21:55Z) left NO trace of: the
  // seat was killed at its 30-minute timeout (taskkill: exit 1, no signal) having printed
  // nothing, and its record was indistinguishable from any seat that failed on its own.
  it("records the output-seen flag and the wrapper-termination flag of a killed seat", () => {
    const store = openStore();
    const written = recordSeatExit(store, seatExitInput({
      exitCode: 1, kind: "FAILED", lastLine: null, outputSeen: false, resetAt: null,
      terminatedByWrapper: true,
    }));
    expect(written.ok && written.record).toMatchObject({
      exitCode: 1, lastLine: null, outputSeen: false, terminatedByWrapper: true,
    });
  });

  it("writes both flags as null for a caller that never measured them", () => {
    const store = openStore();
    const { outputSeen: _o, terminatedByWrapper: _t, ...unmeasured } = seatExitInput();
    const written = recordSeatExit(store, unmeasured);
    expect(written.ok && written.record).toMatchObject({ outputSeen: null, terminatedByWrapper: null });
    const commandId = seatExitRecordId(PROJECT_ID, "sess-wrap-ae8048c4", SINCE);
    const decision = store.getCommandDecision({
      commandId, principalId: AGENT_WRAPPER_PRINCIPAL_ID, projectId: PROJECT_ID,
    });
    // On the ledger too, never omitted: one row shape per writer.
    expect(Object.keys(JSON.parse(new TextDecoder().decode(decision?.resultBytes)) as object))
      .toContain("terminatedByWrapper");
  });

  it("keeps a fact nobody measured as null on both flags", () => {
    const store = openStore();
    const written = recordSeatExit(store, seatExitInput({
      outputSeen: null, terminatedByWrapper: null,
    }));
    expect(written.ok && written.record).toMatchObject({ outputSeen: null, terminatedByWrapper: null });
  });

  it("still decodes a row written before the flags existed, reading both as null", () => {
    const decoded = decodeSeatExitBytes(encoder.encode(JSON.stringify(OLDER_ROW)));
    expect(decoded.ok && decoded.record).toEqual({
      ...OLDER_ROW, outputSeen: null, terminatedByWrapper: null,
    });
  });

  it("replays an older row already on the ledger instead of rewriting it with the flags", () => {
    const store = openStore();
    const commandId = seatExitRecordId(PROJECT_ID, "sess-wrap-ae8048c4", SINCE);
    expect(commit(store, {
      aggregateId: seatExitAggregateId(PROJECT_ID, "sess-wrap-ae8048c4"),
      commandId, commandKind: SEAT_EXIT_COMMAND_KIND, correlationId: "agent-wrapper-seat-exit",
      decidedAt: SINCE, eventType: "SeatExitRecorded", projectId: PROJECT_ID,
      resultBytes: encoder.encode(JSON.stringify(OLDER_ROW)),
    })).toBe(true);
    const before = decisionCount(store);
    const again = recordSeatExit(store, seatExitInput());
    expect(again.ok && again.replayed).toBe(true);
    // The older row's facts answer, not the new input's: nothing measured that seat's output.
    expect(again.ok && again.record.outputSeen).toBeNull();
    expect(decisionCount(store)).toBe(before);
  });

  it.each([
    ["a non-boolean output flag", { outputSeen: "yes" }],
    ["a non-boolean termination flag", { terminatedByWrapper: 1 }],
  ] as const)("refuses %s, and never writes it", (_label, overrides) => {
    const store = openStore();
    const before = decisionCount(store);
    const bad = recordSeatExit(store, seatExitInput(overrides as Record<string, unknown>));
    expect(!bad.ok && bad.code).toBe("SEAT_EXIT_RECORD_INVALID");
    expect(decisionCount(store)).toBe(before);
  });

  it("still refuses a key outside the roster, with the flags present or absent", () => {
    for (const row of [
      { ...OLDER_ROW, signal: null },
      { ...OLDER_ROW, outputSeen: true, signal: null, terminatedByWrapper: false },
    ]) {
      expect(decodeSeatExitBytes(encoder.encode(JSON.stringify(row))).ok).toBe(false);
    }
  });

  it("refuses a row missing a required key even when both flags are present", () => {
    const { lastLine: _dropped, ...short } = { ...OLDER_ROW, outputSeen: true, terminatedByWrapper: false };
    expect(decodeSeatExitBytes(encoder.encode(JSON.stringify(short))).ok).toBe(false);
  });
});
