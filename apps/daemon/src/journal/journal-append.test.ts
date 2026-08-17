import { createDeadEndJournal } from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import { JOURNAL_APPEND_COMMAND_KIND, DAEMON_JOURNAL_APPEND } from "./journal-contracts.js";
import { readCurrentAttemptJournal } from "./journal-reader.js";
import {
  NODE_KEY, entry, journalEventCount, openJournalHarness,
} from "./journal-test-harness.js";

/**
 * The accepted `journal.append` control, driven through the PRODUCTION seam:
 * `handleCommandRequest` over the real registry, the real session authenticator
 * and a real SqliteEventStore holding an activation the production ingress
 * committed.
 *
 * THE DIGEST IS NEVER A LITERAL. Every digest assertion re-derives through
 * `createDeadEndJournal` from `@moe/context` — the same production surface the
 * writer admits entries with — so a hand-written 64-char constant can never stand
 * in for the thing under test, and a digest that quietly stopped covering its
 * entries reddens a named case.
 */

afterEach(cleanupRestoreHarnesses);

const canonicalOf = (entries: readonly DeadEndJournalEntry[]): {
  digest: string; entries: readonly DeadEndJournalEntry[];
} => {
  const admitted = createDeadEndJournal(entries);
  if (admitted.kind !== "ADMITTED") throw new Error(`fixture refused: ${admitted.limit}`);
  return { digest: admitted.journal.digest, entries: admitted.journal.entries };
};

function appended(
  harness: ReturnType<typeof openJournalHarness>, commandId: string,
  entries: readonly DeadEndJournalEntry[],
): ReturnType<typeof harness.send> {
  return harness.send(commandId, JOURNAL_APPEND_COMMAND_KIND, {
    attemptAggregateId: harness.attempt.aggregateId,
    effectId: harness.attempt.record.effectIntent.intentId,
    entries: structuredClone(entries) as unknown as Record<string, unknown>[],
  }, harness.sessionCredential);
}

describe("journal.append — the accepted control", () => {
  it("records two entries and answers the attempt-bound digest from durable bytes", () => {
    const harness = openJournalHarness("accepted");
    const { activationDigest } = harness.attempt.record;
    // EMPTY-CURRENT SEMANTICS, stated as a premise: nothing is durable yet, and
    // the reader says ABSENT rather than handing back an empty journal.
    expect(readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID)).toMatchObject({
      authority: "NONE", code: "JOURNAL_RECORD_ABSENT", layer: DAEMON_JOURNAL_APPEND, ok: false,
    });
    expect(journalEventCount(harness.store, activationDigest)).toBe(0);

    const entries = [
      entry("entry-b", { occurredAt: "2026-08-15T00:00:02.000Z" }),
      entry("entry-a", { occurredAt: "2026-08-15T00:00:01.000Z" }),
    ];
    const accepted = appended(harness, "cmd-journal-1", entries);
    expect(accepted).toMatchObject({
      decision: { disposition: "DECIDED" }, httpStatus: 200, ok: true, outcome: "ACCEPTED",
    });
    expect(journalEventCount(harness.store, activationDigest)).toBe(1);

    const answer = readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID);
    if (!answer.ok) throw new Error(`the durable reader refused: ${answer.code}`);
    const canonical = canonicalOf(entries);
    // The FIRST append on an attempt with no prior journal yields EXACTLY the
    // appended entries — the only place an absent current journal is not fatal.
    expect(answer.entries).toEqual(canonical.entries);
    expect(answer.entries.map((admitted) => admitted.id)).toEqual(["entry-a", "entry-b"]);
    // The digest is the production surface's own, re-derived from the entries the
    // reader actually returned, never a literal.
    expect(answer.journalDigest).toBe(canonicalOf(answer.entries).digest);
    expect(answer.journalDigest).toBe(canonical.digest);
    expect(answer.journalDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect({
      activationDigest: answer.activationDigest, attemptRef: answer.attemptRef,
      authority: answer.authority, effectId: answer.effectId, leaseRef: answer.leaseRef,
      nodeKey: answer.nodeKey, sessionId: answer.sessionId,
    }).toEqual({
      activationDigest,
      attemptRef: harness.attempt.record.attempt.attemptId,
      authority: "DURABLE_JOURNAL",
      effectId: harness.attempt.record.effectIntent.intentId,
      leaseRef: harness.attempt.record.lease.leaseId,
      nodeKey: NODE_KEY,
      sessionId: harness.attempt.sessionId,
    });
  });

  it("appends onto the existing journal instead of replacing it", () => {
    const harness = openJournalHarness("second-append");
    const { activationDigest } = harness.attempt.record;
    const first = [entry("entry-1", { occurredAt: "2026-08-15T00:00:01.000Z" })];
    const second = [entry("entry-2", { occurredAt: "2026-08-15T00:00:02.000Z" })];
    expect(appended(harness, "cmd-journal-a", first).ok).toBe(true);
    expect(appended(harness, "cmd-journal-b", second).ok).toBe(true);
    expect(journalEventCount(harness.store, activationDigest)).toBe(2);

    const answer = readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID);
    if (!answer.ok) throw new Error(`the durable reader refused: ${answer.code}`);
    // Asserted against the PRODUCTION ordering, fed the same union — never against
    // a hand-sorted literal that would agree with a writer that had stopped sorting.
    const canonical = canonicalOf([...first, ...second]);
    expect(answer.entries).toEqual(canonical.entries);
    expect(answer.journalDigest).toBe(canonical.digest);
  });
});
