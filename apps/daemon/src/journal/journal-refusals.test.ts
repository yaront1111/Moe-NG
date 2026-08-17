import { MAX_JOURNAL_ENTRY_COUNT, MAX_JOURNAL_TEXT_CHARACTERS, createDeadEndJournal }
  from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import { DAEMON_JOURNAL_APPEND, JOURNAL_APPEND_COMMAND_KIND } from "./journal-contracts.js";
import { readCurrentAttemptJournal } from "./journal-reader.js";
import {
  EXPIRED_DEADLINE, OTHER_SESSION_ID, activate, entry, journalEventCount, openJournalHarness,
} from "./journal-test-harness.js";
import type { JournalHarness, SeamResult } from "./journal-test-harness.js";

/**
 * THE REFUSAL MATRIX. Every case pins the exact CODE, the exact refusing LAYER,
 * and zero durable residue.
 *
 * WHICH LAYER ANSWERED IS HALF THE ASSERTION. Four layers can refuse this path —
 * the HTTP seam's payload allow-list, the Foundation binding reader, this daemon
 * module, and @moe/context's journal admission — and a refusal answered one layer
 * earlier than the test believes is the classic vacuous assertion. So the
 * structural cases assert stage PAYLOAD_SHAPE (which precedes DISPATCH and
 * therefore proves the writer was never reached), and every domain case asserts
 * the refusing layer by name alongside the code.
 *
 * A CRASH IS NOT A REFUSAL, and the unknown-predicate case is the one that
 * matters: `createDeadEndJournal` throws `Unsupported canonical value type` on a
 * predicate kind it does not know, so a test asserting only "it did not succeed"
 * would pass on a TypeError. These assert the REFUSAL.
 */

afterEach(cleanupRestoreHarnesses);

const OK_ENTRIES = [entry("matrix-1", { occurredAt: "2026-08-15T00:00:01.000Z" })];

const payloadOf = (
  harness: JournalHarness, entries: unknown, overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  attemptAggregateId: harness.attempt.aggregateId,
  effectId: harness.attempt.record.effectIntent.intentId,
  entries,
  ...overrides,
});

const refusalOf = (result: SeamResult): { code: unknown; layer: unknown } => {
  if (!("refusal" in result)) {
    throw new Error(`expected a DISPATCH refusal, received ${JSON.stringify(result)}`);
  }
  return { code: result.refusal.code, layer: result.refusal.layer };
};

function expectNoResidue(harness: JournalHarness): void {
  const { activationDigest } = harness.attempt.record;
  expect(journalEventCount(harness.store, activationDigest)).toBe(0);
  expect(readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID)).toMatchObject({
    authority: "NONE", code: "JOURNAL_RECORD_ABSENT", ok: false,
  });
}

describe("journal.append — the caller has no channel for authority", () => {
  // Each key names something the daemon derives from committed evidence. None is
  // in JOURNAL_APPEND_PAYLOAD_KEYS, so the SEAM refuses it before dispatch.
  const smuggled = [
    { key: "projectId", value: "project-elsewhere" },
    { key: "sessionId", value: "session-elsewhere" },
    { key: "leaseRef", value: "lease-elsewhere" },
    { key: "graphRef", value: "graph-elsewhere" },
    { key: "journalDigest", value: "f".repeat(64) },
    { key: "truthClass", value: "PROVEN" },
    { key: "journal", value: { digest: "f".repeat(64), entries: [], version: "journal.v1" } },
  ] as const;

  it("declares every smuggled key the sweep below drives", () => {
    // A sweep that generated nothing would pass every assertion vacuously.
    expect(smuggled.length).toBe(7);
    expect(new Set(smuggled.map((item) => item.key)).size).toBe(7);
  });

  it.each(smuggled)("refuses a payload carrying $key at PAYLOAD_SHAPE", ({ key, value }) => {
    const harness = openJournalHarness(`smuggle-${key}`);
    const refused = harness.send("cmd-smuggle", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, OK_ENTRIES, { [key]: value }), harness.sessionCredential);
    // stage PAYLOAD_SHAPE is the whole point: it sits strictly BEFORE dispatch,
    // so the writer provably never saw these bytes. A `refusal` field would mean
    // a DISPATCH-stage answer — i.e. the daemon defending a key the seam should
    // have fenced — so its ABSENCE is asserted too.
    expect(refused).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false, outcome: "REFUSED",
      stage: "PAYLOAD_SHAPE",
    });
    expect("refusal" in refused).toBe(false);
    expectNoResidue(harness);

    // THE CONTROL: the SAME payload without the smuggled key is ACCEPTED, so the
    // refusal above is caused by that key alone and not by a broken fixture.
    expect(harness.send("cmd-clean", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, OK_ENTRIES), harness.sessionCredential)).toMatchObject({
      decision: { disposition: "DECIDED" }, ok: true, outcome: "ACCEPTED",
    });
  });
});

describe("journal.append — the binding reader is the attempt/session/lease fence", () => {
  it("carries the BINDING READER's expired-lease refusal, not a daemon code", () => {
    const harness = openJournalHarness("lease-expired", { deadlineSeconds: EXPIRED_DEADLINE });
    const refused = harness.send("cmd-expired", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, OK_ENTRIES), harness.sessionCredential);
    // The layer is the discriminator: a DAEMON_JOURNAL_APPEND code here would
    // mean this module had grown a second lease validator of its own.
    expect(refusalOf(refused)).toEqual({
      code: "FOUNDATION_BINDING_LEASE_EXPIRED", layer: "FOUNDATION_ACTIVATION_BINDING",
    });
    expect(refusalOf(refused).layer).not.toBe(DAEMON_JOURNAL_APPEND);
    expectNoResidue(harness);
  });

  it("refuses a session that holds work authority but does not own the lease", () => {
    const harness = openJournalHarness("wrong-session");
    const intruder = harness.openSession(OTHER_SESSION_ID);
    expect(intruder).not.toBe(harness.sessionCredential);
    const refused = harness.send("cmd-intruder", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, OK_ENTRIES), intruder);
    // NOT a capability refusal: the intruder holds work.write and reaches
    // dispatch. What stops it is the committed lease's ownerSessionRef.
    expect(refusalOf(refused)).toEqual({
      code: "FOUNDATION_BINDING_QUERY_MISMATCH", layer: "FOUNDATION_ACTIVATION_BINDING",
    });
    expectNoResidue(harness);
  });

  it("refuses an effect no committed activation names", () => {
    const harness = openJournalHarness("absent-effect");
    const refused = harness.send("cmd-absent", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, OK_ENTRIES, { effectId: "intent-nowhere" }), harness.sessionCredential);
    expect(refusalOf(refused)).toEqual({
      code: "FOUNDATION_BINDING_NOT_FOUND", layer: "FOUNDATION_ACTIVATION_BINDING",
    });
    expectNoResidue(harness);
  });

  it("refuses an attemptAggregateId naming a DIFFERENT live attempt", () => {
    const harness = openJournalHarness("cross-attempt");
    // A SECOND genuinely committed activation in the SAME store, owned by the
    // SAME session, so nothing but the activation-digest equality can refuse it.
    const other = activate(harness.store, "cross-attempt-other");
    expect(other.aggregateId).not.toBe(harness.attempt.aggregateId);
    expect(other.record.activationDigest).not.toBe(harness.attempt.record.activationDigest);
    const refused = harness.send("cmd-cross", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, OK_ENTRIES, { attemptAggregateId: other.aggregateId }),
      harness.sessionCredential);
    // THE POINT OF THIS CASE: the caller's aggregate id only LOCATES a record.
    // The binding still resolved from effectId, and the three equalities against
    // it are what refuse. Nothing off the other attempt reached durable bytes.
    expect(refusalOf(refused)).toEqual({
      code: "JOURNAL_BINDING_MISMATCH", layer: DAEMON_JOURNAL_APPEND,
    });
    expectNoResidue(harness);
    expect(journalEventCount(harness.store, other.record.activationDigest)).toBe(0);
  });
});

describe("journal.append — entries are decoded before @moe/context sees them", () => {
  const hostile: readonly { readonly entries: unknown; readonly label: string }[] = [
    { entries: [], label: "an empty list" },
    { entries: [{ ...entry("x"), retryPredicate: { factId: "f", kind: "FACT_UNKNOWN" } }],
      label: "an unknown retry predicate kind" },
    { entries: [{ ...entry("x"), kind: "NOT_A_DEAD_END" }], label: "a kind outside DEAD_END_KINDS" },
    { entries: [{ ...entry("x"), recipeDigest: "A".repeat(64) }], label: "an UPPERCASE digest" },
    { entries: [{ ...entry("x"), baseDigest: "zz" }], label: "a non-hex digest" },
    { entries: [{ ...entry("x"), extra: true }], label: "an extra key" },
    { entries: [{ ...entry("x"), occurredAt: "2026-08-15T00:00:01.000" }],
      label: "an occurredAt without Z" },
    { entries: [{ ...entry("x"), retryPredicate: { expectedVersion: 1.5, factId: "f",
      kind: "FACT_VERSION", operator: "GREATER_THAN" } }],
      label: "a fractional predicate version" },
    { entries: [{ ...entry("x"), retryPredicate: { expectedVersion: 2, factId: "f",
      kind: "FACT_VERSION", operator: "NOT_EQUALS" } }],
      label: "an operator the predicate variant does not declare" },
    // Built from CODE POINTS, never a source literal: whether this file happens
    // to be stored composed or decomposed must not decide whether it tests anything.
    { entries: [{ ...entry("x"), text: String.fromCharCode(0x65, 0x301) }],
      label: "non-NFC decomposed text" },
    { entries: "not-a-list", label: "a non-array entries value" },
    { entries: [null], label: "a null entry" },
  ];

  it("declares every hostile entry case the sweep below drives", () => {
    expect(hostile.length).toBe(12);
  });

  it.each(hostile)("refuses $label as a REFUSAL, never a throw", ({ entries, label }) => {
    const harness = openJournalHarness(`hostile-${label.replaceAll(" ", "-")}`);
    let refused: SeamResult;
    // If the strict decoder were removed, `canonicalSha256` would THROW out of
    // the handler rather than answering — which is why this is caught and turned
    // into a NAMED failure instead of being allowed to look like a refusal.
    try {
      refused = harness.send("cmd-hostile", JOURNAL_APPEND_COMMAND_KIND,
        payloadOf(harness, entries), harness.sessionCredential);
    } catch (error) {
      throw new Error(`${label} CRASHED instead of refusing: ${String(error)}`);
    }
    const expected = Array.isArray(entries) && entries.length === 0
      ? "JOURNAL_ENTRY_LIST_EMPTY" : "JOURNAL_ENTRY_MALFORMED";
    expect(refusalOf(refused)).toEqual({ code: expected, layer: DAEMON_JOURNAL_APPEND });
    expectNoResidue(harness);
  });
});

describe("journal.append — the journal limits belong to @moe/context", () => {
  const overCount = Array.from({ length: MAX_JOURNAL_ENTRY_COUNT + 1 }, (_, index) =>
    entry(`over-${index}`, { occurredAt: `2026-08-15T00:00:${String(index).padStart(2, "0")}.000Z` }));
  const overText = [entry("long", { text: "x".repeat(MAX_JOURNAL_TEXT_CHARACTERS + 1) })];

  const limitOf = (entries: readonly DeadEndJournalEntry[]): string => {
    const refused = createDeadEndJournal(entries);
    if (refused.kind !== "REFUSED") throw new Error("the fixture is within both bounds");
    return refused.limit;
  };

  it.each([
    { entries: overCount, label: "entry count" },
    { entries: overText, label: "text characters" },
  ])("carries @moe/context's own limit refusal for $label", ({ entries }) => {
    const harness = openJournalHarness(`limit-${entries.length}`);
    const refused = harness.send("cmd-limit", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, entries), harness.sessionCredential);
    expect(refusalOf(refused)).toEqual({
      code: "JOURNAL_LIMIT_REACHED", layer: "DEAD_END_JOURNAL",
    });
    expectNoResidue(harness);
  });

  it("hits two DIFFERENT bounds, so neither case stands in for the other", () => {
    // The `limit` field is @moe/context's own, asserted against the SAME arrays
    // the two seam cases send: without this the two refusals above would be
    // indistinguishable and one bound could be entirely unexercised.
    expect([limitOf(overCount), limitOf(overText)]).toEqual(["ENTRY_COUNT", "TEXT_CHARACTERS"]);
    // And the daemon's own decoder must NOT answer first: both arrays decode.
    expect(overCount.length).toBeGreaterThan(MAX_JOURNAL_ENTRY_COUNT);
    expect(overText[0]!.text.length).toBeGreaterThan(MAX_JOURNAL_TEXT_CHARACTERS);
  });
});
