import {
  MAX_JOURNAL_ENTRY_COUNT, MAX_JOURNAL_TEXT_CHARACTERS, createDeadEndJournal,
} from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  DAEMON_JOURNAL_APPEND, JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION,
} from "./journal-contracts.js";
import { runJournalAppendCommand } from "./journal-append.js";
import { decodeJournalEntries } from "./journal-entry-codec.js";
import { readCurrentAttemptJournal } from "./journal-reader.js";
import {
  DECIDED_AT, OTHER_SESSION_ID, entry, journalEventCount, openJournalHarness,
  openUnactivatedJournalFixture,
} from "./journal-test-harness.js";
import type {
  JournalHarness, SeamResult, UnactivatedAttemptIdentity, UnactivatedJournalFixture,
} from "./journal-test-harness.js";

afterEach(cleanupRestoreHarnesses);

const encoder = new TextEncoder();
const OK_ENTRIES = [entry("matrix-1", { occurredAt: "2026-08-15T00:00:01.000Z" })];

const payloadOf = (
  harness: JournalHarness, entries: unknown, overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  attemptAggregateId: harness.identity.aggregateId,
  effectId: harness.identity.effectIntentRef,
  entries,
  ...overrides,
});

const refusalOf = (result: SeamResult): { code: unknown; layer: unknown } => {
  if (!("refusal" in result)) throw new Error(`expected refusal: ${JSON.stringify(result)}`);
  return { code: result.refusal.code, layer: result.refusal.layer };
};

function expectNoJournal(harness: JournalHarness): void {
  const { activationDigest } = harness.identity;
  expect(journalEventCount(harness.store, activationDigest)).toBe(0);
  expect(readCurrentAttemptJournal(harness.store, activationDigest, PROJECT_ID)).toMatchObject({
    authority: "NONE", code: "JOURNAL_RECORD_ABSENT", layer: DAEMON_JOURNAL_APPEND, ok: false,
  });
}

describe("journal.append — payload shape and capability still refuse above the writer", () => {
  const smuggled = Object.freeze([
    { key: "projectId", value: "project-elsewhere" },
    { key: "sessionId", value: "session-elsewhere" },
    { key: "leaseRef", value: "lease-elsewhere" },
    { key: "graphRef", value: "graph-elsewhere" },
    { key: "journalDigest", value: "f".repeat(64) },
    { key: "truthClass", value: "PROVEN" },
    { key: "journal", value: { digest: "f".repeat(64), entries: [], version: "journal.v1" } },
  ] as const);

  it("declares the exact nonzero smuggled-key roster", () => {
    expect(smuggled.map(({ key }) => key)).toEqual([
      "projectId", "sessionId", "leaseRef", "graphRef", "journalDigest", "truthClass", "journal",
    ]);
  });

  it.each(smuggled)("refuses caller authority key $key at PAYLOAD_SHAPE", ({ key, value }) => {
    const harness = openJournalHarness(`smuggle-${key}`);
    const refused = harness.send("cmd-smuggle", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, OK_ENTRIES, { [key]: value }), harness.sessionCredential);
    expect(refused).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false, outcome: "REFUSED",
      stage: "PAYLOAD_SHAPE",
    });
    expect("refusal" in refused).toBe(false);

    const clean = harness.send("cmd-clean", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, OK_ENTRIES), harness.sessionCredential);
    expect(refusalOf(clean)).toEqual({
      code: "FOUNDATION_BINDING_NOT_FOUND", layer: "FOUNDATION_ACTIVATION_BINDING",
    });
    expectNoJournal(harness);
  });

  it("keeps work.write authorization above the activation fence", () => {
    const harness = openJournalHarness("journal-capability");
    const unprivileged = harness.openSession(OTHER_SESSION_ID, ["review.write"]);
    const refused = harness.send("cmd-no-work", JOURNAL_APPEND_COMMAND_KIND,
      payloadOf(harness, OK_ENTRIES), unprivileged);
    expect(refused).toMatchObject({
      error: { code: "CAPABILITY_DENIED" }, httpStatus: 403, ok: false, outcome: "REFUSED",
      stage: "AUTHORIZE",
    });
    expect("refusal" in refused).toBe(false);
    expectNoJournal(harness);
  });
});

function directBytes(
  identity: UnactivatedAttemptIdentity, commandId: string, entries: unknown,
  overrides: Readonly<Record<string, unknown>> = {},
): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId, correlationId: `corr-${commandId}`, decidedAt: DECIDED_AT, expectedVersion: 0,
    kind: JOURNAL_APPEND_COMMAND_KIND,
    payload: {
      attemptAggregateId: identity.aggregateId, effectId: identity.effectIntentRef, entries,
      ...overrides,
    },
    principalId: identity.sessionId, projectId: PROJECT_ID,
    schemaVersion: JOURNAL_APPEND_SCHEMA_VERSION,
  }));
}

function expectFirstFence(
  fixture: UnactivatedJournalFixture, commandId: string, entries: unknown,
  overrides: Readonly<Record<string, unknown>> = {},
): void {
  expect(runJournalAppendCommand(
    fixture.store, directBytes(fixture.identity, commandId, entries, overrides))).toEqual({
    advisoryOnly: true, authority: "NONE", code: "FOUNDATION_BINDING_NOT_FOUND", error: null,
    kind: JOURNAL_APPEND_COMMAND_KIND, ok: false,
    refusedBy: "FOUNDATION_ACTIVATION_BINDING",
  });
  expect(journalEventCount(fixture.store, fixture.identity.activationDigest)).toBe(0);
}

describe("journal.append — identity variants cannot move the empty-activation fence", () => {
  const variants = Object.freeze([
    { label: "default identity", overrides: {} },
    { label: "foreign effect", overrides: { effectId: "intent-nowhere" } },
    { label: "foreign attempt", overrides: { attemptAggregateId: "activation-elsewhere" } },
  ] as const);

  it("declares every identity variant", () => {
    expect(variants.map(({ label }) => label)).toEqual([
      "default identity", "foreign effect", "foreign attempt",
    ]);
  });

  it.each(variants)("refuses $label under the binding reader's exact code/layer", ({
    label, overrides,
  }) => {
    const fixture = openUnactivatedJournalFixture(`identity-${label}`);
    expectFirstFence(fixture, `cmd-identity-${label}`, OK_ENTRIES, overrides);
    expect(fixture.store.readEventHorizon()).toBe(0n);
  });
});

describe("journal.append — downstream-hostile entries still meet the activation fence first", () => {
  const hostile: readonly { readonly entries: unknown; readonly label: string }[] = [
    { entries: [], label: "an empty list" },
    { entries: [{ ...entry("x"), retryPredicate: { factId: "f", kind: "FACT_UNKNOWN" } }],
      label: "an unknown retry predicate kind" },
    { entries: [{ ...entry("x"), kind: "NOT_A_DEAD_END" }], label: "a foreign dead-end kind" },
    { entries: [{ ...entry("x"), recipeDigest: "A".repeat(64) }], label: "an uppercase digest" },
    { entries: [{ ...entry("x"), baseDigest: "zz" }], label: "a non-hex digest" },
    { entries: [{ ...entry("x"), extra: true }], label: "an extra key" },
    { entries: [{ ...entry("x"), occurredAt: "2026-08-15T00:00:01.000" }],
      label: "an instant without Z" },
    { entries: [{ ...entry("x"), retryPredicate: { expectedVersion: 1.5, factId: "f",
      kind: "FACT_VERSION", operator: "GREATER_THAN" } }], label: "a fractional version" },
    { entries: [{ ...entry("x"), retryPredicate: { expectedVersion: 2, factId: "f",
      kind: "FACT_VERSION", operator: "NOT_EQUALS" } }], label: "a foreign operator" },
    { entries: [{ ...entry("x"), text: String.fromCharCode(0x65, 0x301) }],
      label: "non-NFC text" },
    { entries: "not-a-list", label: "a non-array list" },
    { entries: [null], label: "a null entry" },
  ];

  it("declares an exact nonzero matrix with two downstream production answers", () => {
    expect(hostile).toHaveLength(12);
    expect(new Set(hostile.map(({ label }) => label)).size).toBe(12);
    const downstream = hostile.map(({ entries }) => {
      const decoded = decodeJournalEntries(entries);
      return decoded.ok ? "ADMITTED" : decoded.code;
    });
    expect(new Set(downstream)).toEqual(new Set([
      "JOURNAL_ENTRY_LIST_EMPTY", "JOURNAL_ENTRY_MALFORMED",
    ]));
  });

  it.each(hostile)("refuses $label at binding with zero journal rows", ({ entries, label }) => {
    const fixture = openUnactivatedJournalFixture(`hostile-${label}`);
    expectFirstFence(fixture, `cmd-hostile-${label}`, entries);
  });
});

describe("journal.append — both context limits remain distinguishable downstream", () => {
  const overCount = Array.from({ length: MAX_JOURNAL_ENTRY_COUNT + 1 }, (_, index) =>
    entry(`over-${index}`, { occurredAt: DECIDED_AT }));
  const overText = [entry("long", { text: "x".repeat(MAX_JOURNAL_TEXT_CHARACTERS + 1) })];
  const cases: readonly { readonly entries: readonly DeadEndJournalEntry[];
    readonly label: string; readonly limit: string }[] = [
    { entries: overCount, label: "entry count", limit: "ENTRY_COUNT" },
    { entries: overText, label: "text characters", limit: "TEXT_CHARACTERS" },
  ];

  it("declares both exact limit cases", () => {
    expect(cases.map(({ label, limit }) => [label, limit])).toEqual([
      ["entry count", "ENTRY_COUNT"], ["text characters", "TEXT_CHARACTERS"],
    ]);
  });

  it.each(cases)("refuses before the downstream $label limit with no residue", ({
    entries, label, limit,
  }) => {
    const downstream = createDeadEndJournal(entries);
    expect(downstream).toMatchObject({
      code: "JOURNAL_LIMIT_REACHED", kind: "REFUSED", layer: "DEAD_END_JOURNAL", limit,
    });
    const fixture = openUnactivatedJournalFixture(`limit-${label}`);
    expectFirstFence(fixture, `cmd-limit-${label}`, entries);
  });
});
