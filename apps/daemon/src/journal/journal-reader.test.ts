import { createDeadEndJournal } from "@moe/context";
import type { StoredEvent } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import { DAEMON_JOURNAL_APPEND, JOURNAL_CODES } from "./journal-contracts.js";
import { readCurrentAttemptJournal } from "./journal-reader.js";
import type { AttemptJournalResult, JournalEventSource } from "./journal-reader.js";
import {
  NODE_KEY, entry, journalBody, openUnactivatedJournalFixture, plantJournalEvent,
} from "./journal-test-harness.js";

/**
 * The strict CURRENT reader, driven by PLANTED durable rows.
 *
 * Every case below drifts exactly ONE field of a body the positive control proves
 * reads OK, so a refusal is caused by the field under test rather than by a
 * fixture that was already invalid at an earlier layer. Each case pins the exact
 * CODE and the exact refusing LAYER: this reader is the only thing standing
 * between an unverifiable journal and a release handoff that would accept its
 * digest as a content reference. Planted bytes reach those reader guards; they
 * are deliberately not evidence that the production writer can create a row.
 */

afterEach(cleanupRestoreHarnesses);

const ENTRIES = [
  entry("read-a", { occurredAt: "2026-08-15T00:00:01.000Z" }),
  entry("read-b", { occurredAt: "2026-08-15T00:00:02.000Z" }),
];

function refusalOf(answer: AttemptJournalResult): { code: string; layer: string } {
  if (answer.ok) throw new Error("expected a refusal, received a durable journal");
  return { code: answer.code, layer: answer.layer };
}

describe("readCurrentAttemptJournal — the positive control and its cardinality", () => {
  it("reads a planted canonical body and answers every durable field", () => {
    const harness = openUnactivatedJournalFixture("reader-control");
    const { activationDigest } = harness.identity;
    // ABSENT before any row: distinct from UNREADABLE because the two demand
    // opposite repairs — write the journal, versus repair the store.
    expect(refusalOf(readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID)))
      .toEqual({ code: "JOURNAL_RECORD_ABSENT", layer: DAEMON_JOURNAL_APPEND });

    plantJournalEvent(harness.store, activationDigest, journalBody(harness.identity, ENTRIES), 0);
    const answer = readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID);
    if (!answer.ok) throw new Error(`the control body was refused: ${answer.code}`);
    expect(answer.entries).toEqual(
      (createDeadEndJournal(ENTRIES) as { journal: { entries: unknown } }).journal.entries);
    expect(answer.journalDigest).toBe(
      (createDeadEndJournal(answer.entries) as { journal: { digest: string } }).journal.digest);
    expect({
      activationDigest: answer.activationDigest, attemptRef: answer.attemptRef,
      authority: answer.authority, effectId: answer.effectId, leaseRef: answer.leaseRef,
      nodeKey: answer.nodeKey, sessionId: answer.sessionId,
    }).toEqual({
      activationDigest, attemptRef: harness.identity.attemptRef,
      authority: "DURABLE_JOURNAL", effectId: harness.identity.effectIntentRef,
      leaseRef: `lease-${harness.identity.attemptRef}`, nodeKey: NODE_KEY,
      sessionId: harness.identity.sessionId,
    });
  });

  it("refuses an UNREADABLE store separately from an absent row", () => {
    const harness = openUnactivatedJournalFixture("reader-unreadable");
    const { activationDigest } = harness.identity;
    harness.store.close();
    expect(refusalOf(readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID)))
      .toEqual({ code: "JOURNAL_RECORD_UNREADABLE", layer: DAEMON_JOURNAL_APPEND });
  });

  it("refuses two rows claiming one sequence, which no repair can choose between", () => {
    const harness = openUnactivatedJournalFixture("reader-ambiguous");
    const { activationDigest } = harness.identity;
    plantJournalEvent(harness.store, activationDigest, journalBody(harness.identity, ENTRIES), 0);
    plantJournalEvent(
      harness.store, activationDigest, journalBody(harness.identity, [ENTRIES[0]!]), 1);
    // The rows are REAL store rows; only the sequence of the second is drifted,
    // because the store assigns sequences itself and will not mint a duplicate.
    const collided: JournalEventSource = {
      readEvents: (aggregateId: string): readonly StoredEvent[] =>
        harness.store.readEvents(aggregateId).map((event, index) =>
          index === 1 ? { ...event, aggregateSequence: 1 } : event),
    };
    expect(readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID).ok).toBe(true);
    expect(refusalOf(readCurrentAttemptJournal(collided, activationDigest, PROJECT_ID)))
      .toEqual({ code: "JOURNAL_RECORD_AMBIGUOUS", layer: DAEMON_JOURNAL_APPEND });
  });

  it("refuses a foreign event type on the journal aggregate", () => {
    const harness = openUnactivatedJournalFixture("reader-foreign-type");
    const { activationDigest } = harness.identity;
    plantJournalEvent(harness.store, activationDigest, journalBody(harness.identity, ENTRIES), 0);
    const foreign: JournalEventSource = {
      readEvents: (aggregateId: string): readonly StoredEvent[] =>
        harness.store.readEvents(aggregateId).map((event) =>
          ({ ...event, eventType: "SomethingElseHappened" })),
    };
    expect(refusalOf(readCurrentAttemptJournal(foreign, activationDigest, PROJECT_ID)))
      .toEqual({ code: "JOURNAL_RECORD_MALFORMED", layer: DAEMON_JOURNAL_APPEND });
  });
});

describe("readCurrentAttemptJournal — one drifted field at a time", () => {
  const cases = [
    { code: "JOURNAL_PROJECT_MISMATCH", label: "a foreign project",
      overrides: { projectId: "project-elsewhere" } },
    { code: "JOURNAL_RECORD_MALFORMED", label: "a stale record version",
      overrides: { recordVersion: "moe-attempt-journal/0" } },
    { code: "JOURNAL_RECORD_MALFORMED", label: "a downgraded truth class",
      overrides: { truthClass: "SUSPECT" } },
    { code: "JOURNAL_RECORD_MALFORMED", label: "an activation digest naming another attempt",
      overrides: { activationDigest: "f".repeat(64) } },
    { code: "JOURNAL_RECORD_MALFORMED", label: "an entry the strict decoder rejects",
      overrides: { entries: [{ ...entry("bad"), retryPredicate: { kind: "FACT_UNKNOWN" } }] } },
    { code: "JOURNAL_RECORD_MALFORMED", label: "entries stored out of canonical order",
      overrides: {
        entries: [
          entry("order-b", { occurredAt: "2026-08-15T00:00:09.000Z" }),
          entry("order-a", { occurredAt: "2026-08-15T00:00:08.000Z" }),
        ],
      } },
  ] as const;

  // A swept table that generated nothing passes every assertion below vacuously.
  it("drives every drifted-field case the table declares", () => {
    expect(cases.length).toBe(6);
    expect(cases.every((item) => JOURNAL_CODES.includes(item.code))).toBe(true);
  });

  it.each(cases)("refuses $label with $code", ({ code, label, overrides }) => {
    const harness = openUnactivatedJournalFixture(`drift-${label.replaceAll(" ", "-")}`);
    const { activationDigest } = harness.identity;
    // POSITIVE CONTROL on the SAME body without the drift, so the refusal below
    // cannot be caused by a fixture that was invalid before the field under test.
    plantJournalEvent(harness.store, activationDigest, journalBody(harness.identity, ENTRIES), 0);
    expect(readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID).ok).toBe(true);

    const drifted = openUnactivatedJournalFixture(`drifted-${label.replaceAll(" ", "-")}`);
    const digest = drifted.identity.activationDigest;
    plantJournalEvent(
      drifted.store, digest, journalBody(drifted.identity, ENTRIES, overrides), 0);
    expect(refusalOf(readCurrentAttemptJournal(drifted.store, digest, PROJECT_ID)))
      .toEqual({ code, layer: DAEMON_JOURNAL_APPEND });
  });

  it("refuses a digest that has quietly stopped covering its entries", () => {
    const harness = openUnactivatedJournalFixture("reader-digest-mismatch");
    const { activationDigest } = harness.identity;
    // The body stores BOTH entries but a digest computed over only the first —
    // canonical bytes, every other field durable and agreeing, so ONLY the
    // re-derivation can catch it. This is the guard the DoD's mutation drill aims at.
    const partial = createDeadEndJournal([ENTRIES[0]!]);
    if (partial.kind !== "ADMITTED") throw new Error("fixture refused");
    const body = journalBody(harness.identity, ENTRIES, {
      journalDigest: partial.journal.digest,
    });
    expect(body["journalDigest"]).not.toBe(
      (createDeadEndJournal(ENTRIES) as { journal: { digest: string } }).journal.digest);
    plantJournalEvent(harness.store, activationDigest, body, 0);
    expect(refusalOf(readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID)))
      .toEqual({ code: "JOURNAL_DIGEST_MISMATCH", layer: DAEMON_JOURNAL_APPEND });
  });

  it("refuses stored bytes that no longer re-encode", () => {
    const harness = openUnactivatedJournalFixture("reader-drift");
    const { activationDigest } = harness.identity;
    plantJournalEvent(harness.store, activationDigest, journalBody(harness.identity, ENTRIES), 0);
    // Canonical encoding sorts keys, so a payload whose keys are stored out of
    // order decodes cleanly and fails only the byte compare.
    const scrambled: JournalEventSource = {
      readEvents: (aggregateId: string): readonly StoredEvent[] =>
        harness.store.readEvents(aggregateId).map((event) => ({
          ...event, payload: new TextEncoder().encode('{"b":1,"a":2}'),
        })),
    };
    expect(refusalOf(readCurrentAttemptJournal(scrambled, activationDigest, PROJECT_ID)))
      .toEqual({ code: "JOURNAL_RECORD_MALFORMED", layer: DAEMON_JOURNAL_APPEND });
  });
});
