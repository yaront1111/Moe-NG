import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, decisionCount, openStore } from "../review/review-test-fixtures.js";
import {
  AGENT_WRAPPER_PRINCIPAL_ID, PROVIDER_PAUSE_COMMAND_KIND, PROVIDER_PAUSE_VERSION,
  SEAT_EXIT_COMMAND_KIND, SEAT_EXIT_VERSION, clearProviderPause, providerPauseAggregateId,
  providerPauseRecordId, readProviderPause, recordProviderPause, recordSeatExit,
  seatExitAggregateId, seatExitRecordId,
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
    projectId: PROJECT_ID,
    provider: "claude",
    resetAt: RESET_AT,
    sessionId: "sess-wrap-ae8048c4",
    workItemId: "item-7",
    ...overrides,
  };
}

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
      projectId: PROJECT_ID,
      provider: "claude",
      resetAt: RESET_AT,
      sessionId: "sess-wrap-ae8048c4",
      version: SEAT_EXIT_VERSION,
      workItemId: "item-7",
    });
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
});
