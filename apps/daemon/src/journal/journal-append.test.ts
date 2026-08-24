import { MAX_JOURNAL_ENTRY_COUNT, createDeadEndJournal } from "@moe/context";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_ID, cleanupRestoreHarnesses, pendingHarnessRoots,
} from "../recovery/restore-test-harness.js";
import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION,
} from "./journal-contracts.js";
import { runJournalAppendCommand } from "./journal-append.js";
import { decodeJournalEntries } from "./journal-entry-codec.js";
import {
  DECIDED_AT, entry, journalBody, journalEventCount, openJournalHarness,
  openUnactivatedJournalFixture, plantJournalEvent,
} from "./journal-test-harness.js";
import type {
  UnactivatedAttemptIdentity, UnactivatedJournalFixture,
} from "./journal-test-harness.js";

afterEach(cleanupRestoreHarnesses);

describe("journal test support — the unactivated world carries no authority", () => {
  it("opens a globally empty file-backed store with a planted positive control", () => {
    const fixture = openUnactivatedJournalFixture("empty:world");

    expect(Object.keys(fixture.identity).sort()).toEqual([
      "activationDigest", "aggregateId", "attemptRef", "effectIntentRef", "sessionId",
    ]);
    expect(Object.isFrozen(fixture.identity)).toBe(true);
    expect(fixture.store.readEventHorizon()).toBe(0n);
    expect(fixture.store.readEventsAfter(0n, 100).items).toEqual([]);
    expect(fixture.store.readEvents(fixture.identity.aggregateId)).toEqual([]);
    expect(journalEventCount(fixture.store, fixture.identity.activationDigest)).toBe(0);
    expect(pendingHarnessRoots()).toContain(fixture.root);

    plantJournalEvent(fixture.store, fixture.identity.activationDigest,
      journalBody(fixture.identity, [entry("empty-world-control")]), 0);

    expect(fixture.store.readEventHorizon()).not.toBe(0n);
    expect(fixture.store.readEventsAfter(0n, 100).items).toHaveLength(1);
  });

  it("authenticates over genesis and session evidence without planting subject authority", () => {
    const harness = openJournalHarness("authenticated:world");
    const eventTypes = harness.store.readEventsAfter(0n, 100).items.map((item) => item.eventType);

    expect(eventTypes).toEqual(["RecoveryIncarnationAnchored", "SessionOpened"]);
    expect(harness.store.readEvents(harness.identity.aggregateId)).toEqual([]);
    expect(eventTypes).not.toContain("PolicyEvaluated");
    expect(eventTypes).not.toContain("ActivationCommitted");
    expect(eventTypes).not.toContain("AttemptJournalAppended");
    expect(eventTypes).not.toContain("StepStarted");
    expect(eventTypes).not.toContain("AttemptReleased");
  });
});

const encoder = new TextEncoder();

function requestBytes(
  identity: UnactivatedAttemptIdentity, commandId: string, entries: unknown,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId, correlationId: `corr-${commandId}`, decidedAt: DECIDED_AT, expectedVersion: 0,
    kind: JOURNAL_APPEND_COMMAND_KIND,
    payload: {
      attemptAggregateId: identity.aggregateId, effectId: identity.effectIntentRef, entries,
    },
    principalId: identity.sessionId, projectId: PROJECT_ID,
    schemaVersion: JOURNAL_APPEND_SCHEMA_VERSION,
  }));
}

function expectFirstFence(
  fixture: UnactivatedJournalFixture, commandId: string, entries: unknown,
): void {
  const outcome = runJournalAppendCommand(
    fixture.store, requestBytes(fixture.identity, commandId, entries));
  expect(outcome).toEqual({
    advisoryOnly: true,
    authority: "NONE",
    code: "FOUNDATION_BINDING_NOT_FOUND",
    error: null,
    kind: JOURNAL_APPEND_COMMAND_KIND,
    ok: false,
    refusedBy: "FOUNDATION_ACTIVATION_BINDING",
  });
  expect(journalEventCount(fixture.store, fixture.identity.activationDigest)).toBe(0);
  expect(fixture.store.getCommandDecision({
    commandId, principalId: fixture.identity.sessionId, projectId: PROJECT_ID,
  })).toBeNull();
}

const overCount = Array.from({ length: MAX_JOURNAL_ENTRY_COUNT + 1 }, (_, index) =>
  entry(`unactivated-bound-${index}`, { occurredAt: DECIDED_AT }));

const CANDIDATES = Object.freeze([
  { entries: [entry("unactivated-valid")], label: "valid" },
  { entries: [], label: "empty" },
  { entries: [null], label: "malformed" },
  { entries: overCount, label: "over journal count" },
] as const);

function downstreamAnswer(entries: unknown): string {
  const decoded = decodeJournalEntries(entries);
  if (!decoded.ok) return decoded.code;
  const admitted = createDeadEndJournal(decoded.entries);
  return admitted.kind === "ADMITTED" ? admitted.kind : `${admitted.code}@${admitted.layer}`;
}

describe("journal.append — the honest unactivated production fence", () => {
  it("declares a nonzero exact candidate matrix with distinct downstream answers", () => {
    expect(CANDIDATES.map(({ label }) => label)).toEqual([
      "valid", "empty", "malformed", "over journal count",
    ]);
    expect(new Set(CANDIDATES.map(({ entries }) => downstreamAnswer(entries)))).toEqual(new Set([
      "ADMITTED", "JOURNAL_ENTRY_LIST_EMPTY", "JOURNAL_ENTRY_MALFORMED",
      "JOURNAL_LIMIT_REACHED@DEAD_END_JOURNAL",
    ]));
  });

  it.each(CANDIDATES)("refuses $label at the binding fence with no row or decision", ({
    entries, label,
  }) => {
    const fixture = openUnactivatedJournalFixture(`first-fence-${label}`);
    expectFirstFence(fixture, `cmd-first-fence-${label}`, entries);
  });
});
