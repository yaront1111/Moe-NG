import { MAX_JOURNAL_ENTRY_COUNT } from "@moe/context";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION, JOURNAL_CODES,
} from "./journal-contracts.js";
import { runJournalAppendCommand } from "./journal-append.js";
import { decodeJournalEntries } from "./journal-entry-codec.js";
import { DECIDED_AT, entry, openUnactivatedJournalFixture } from "./journal-test-harness.js";
import type { UnactivatedJournalFixture } from "./journal-test-harness.js";

afterEach(cleanupRestoreHarnesses);

const encoder = new TextEncoder();
const FIRST = [entry("idem-1", { occurredAt: "2026-08-15T00:00:03.000Z" })];
const SECOND = [entry("idem-2", { occurredAt: "2026-08-15T00:00:01.000Z" })];

function append(
  fixture: UnactivatedJournalFixture, commandId: string, entries: unknown,
): ReturnType<typeof runJournalAppendCommand> {
  const { identity } = fixture;
  return runJournalAppendCommand(fixture.store, encoder.encode(JSON.stringify({
    commandId, correlationId: `corr-${commandId}`, decidedAt: DECIDED_AT, expectedVersion: 0,
    kind: JOURNAL_APPEND_COMMAND_KIND,
    payload: {
      attemptAggregateId: identity.aggregateId, effectId: identity.effectIntentRef, entries,
    },
    principalId: identity.sessionId, projectId: PROJECT_ID,
    schemaVersion: JOURNAL_APPEND_SCHEMA_VERSION,
  })));
}

function expectFirstFence(
  fixture: UnactivatedJournalFixture, commandId: string, entries: unknown,
): void {
  expect(append(fixture, commandId, entries)).toEqual({
    advisoryOnly: true, authority: "NONE", code: "FOUNDATION_BINDING_NOT_FOUND", error: null,
    kind: JOURNAL_APPEND_COMMAND_KIND, ok: false,
    refusedBy: "FOUNDATION_ACTIVATION_BINDING",
  });
  expect(fixture.store.getCommandDecision({
    commandId, principalId: fixture.identity.sessionId, projectId: PROJECT_ID,
  })).toBeNull();
}

const atLimit = Array.from({ length: MAX_JOURNAL_ENTRY_COUNT }, (_, index) =>
  entry(`bound-${index}`, { occurredAt: DECIDED_AT }));

const RETIRED_WRITER_GROUPS = Object.freeze([
  { calls: [["cmd-replay", FIRST], ["cmd-replay", FIRST]], label: "same-command replay" },
  { calls: [["cmd-first", FIRST], ["cmd-second", SECOND], ["cmd-first", FIRST]],
    label: "replay after tail movement" },
  { calls: [["cmd-conflict", FIRST], ["cmd-conflict", SECOND]], label: "byte conflict" },
  { calls: [["cmd-order-1", FIRST], ["cmd-order-2", SECOND]], label: "append ordering" },
  { calls: [["cmd-at-bound", atLimit], ["cmd-over-bound", [entry("one-too-many")]]],
    label: "journal count boundary" },
] as const);

describe("journal.append — production-unreachable writer journeys stop at the first fence", () => {
  it("names every retired accepted/replay/conflict/ordering/boundary group", () => {
    expect(RETIRED_WRITER_GROUPS.map(({ label }) => label)).toEqual([
      "same-command replay", "replay after tail movement", "byte conflict", "append ordering",
      "journal count boundary",
    ]);
  });

  it.each(RETIRED_WRITER_GROUPS)("replaces $label with exact no-write refusals", ({
    calls, label,
  }) => {
    const fixture = openUnactivatedJournalFixture(`retired-${label}`);
    for (const [commandId, entries] of calls) expectFirstFence(fixture, commandId, entries);
    expect(fixture.store.readEventHorizon()).toBe(0n);
    expect(fixture.store.readEventsAfter(0n, 100).items).toEqual([]);
  });
});

/** Every mutation JSON can physically carry, generated per field. */
function wireMutations(): readonly { readonly entries: unknown; readonly label: string }[] {
  const base = entry("sweep");
  const keys = Object.keys(base);
  const cases: { entries: unknown; label: string }[] = [];
  for (const key of keys) {
    const missing: Record<string, unknown> = { ...base };
    delete missing[key];
    cases.push({ entries: [missing], label: `missing ${key}` });
    cases.push({ entries: [{ ...base, [key]: 17 }], label: `numeric ${key}` });
    cases.push({ entries: [{ ...base, [key]: null }], label: `null ${key}` });
    cases.push({ entries: [{ ...base, [key]: [] }], label: `array ${key}` });
  }
  const polluted: Record<string, unknown> = { ...base };
  Object.defineProperty(polluted, "__proto__", {
    configurable: true, enumerable: true, value: { polluted: true }, writable: true,
  });
  cases.push({ entries: [polluted], label: "a __proto__ key" });
  cases.push({ entries: [{ ...base, recipeDigest: "A".repeat(64) }], label: "an uppercase digest" });
  cases.push({ entries: [{ ...base, occurredAt: "2026-08-15T00:00:01.000" }],
    label: "an occurredAt without Z" });
  cases.push({ entries: [{ ...base, text: Number.NaN }], label: "a NaN text" });
  cases.push({ entries: [{ ...base, id: "" }], label: "an empty id" });
  cases.push({ entries: [[base]], label: "a nested list" });
  cases.push({ entries: { 0: base, length: 1 }, label: "an array-like object" });
  return cases;
}

describe("journal.append — the generated wire-hostile sweep", () => {
  const cases = wireMutations();

  it("generates and uniquely names the exact nonzero case set", () => {
    expect(cases.length).toBe(Object.keys(entry("sweep-count")).length * 4 + 7);
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map(({ label }) => label)).size).toBe(cases.length);
  });

  it("proves every candidate is hostile downstream while the activation fence answers first", () => {
    const fixture = openUnactivatedJournalFixture("wire-hostile-sweep");
    const answers = cases.map(({ entries, label }, index) => {
      const decoded = decodeJournalEntries(entries);
      expect(decoded, label).toEqual({ code: "JOURNAL_ENTRY_MALFORMED", ok: false });
      const commandId = `cmd-wire-hostile-${index}`;
      expectFirstFence(fixture, commandId, entries);
      return commandId;
    });
    expect(answers).toHaveLength(cases.length);
    expect(fixture.store.readEventHorizon()).toBe(0n);
  });
});

describe("decodeJournalEntries — reflection-hostile values refuse, never throw", () => {
  function accessorEntry(): unknown {
    const value: Record<string, unknown> = { ...entry("accessor") };
    Object.defineProperty(value, "text", { enumerable: true, get: () => "smuggled" });
    return value;
  }

  function nonEnumerableEntry(): unknown {
    const value: Record<string, unknown> = { ...entry("hidden") };
    Object.defineProperty(value, "id", { enumerable: false, value: "hidden" });
    return value;
  }

  function revokedEntry(): unknown {
    const { proxy, revoke } = Proxy.revocable({ ...entry("revoked") }, {});
    revoke();
    return proxy;
  }

  const hostile: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: "an accessor-bearing entry", value: [accessorEntry()] },
    { label: "a non-enumerable own property", value: [nonEnumerableEntry()] },
    { label: "a revoked proxy entry", value: [revokedEntry()] },
    { label: "a revoked proxy list", value: (() => {
      const { proxy, revoke } = Proxy.revocable([entry("x")], {});
      revoke();
      return proxy;
    })() },
    { label: "a -0 predicate version", value: [{ ...entry("neg-zero"),
      retryPredicate: { expectedVersion: -0, factId: "f", kind: "FACT_VERSION",
        operator: "GREATER_THAN" } }] },
    { label: "a symbol-keyed entry", value: [Object.assign(
      { ...entry("symbol") }, { [Symbol("smuggle")]: true })] },
    { label: "a class-instance entry", value: [Object.assign(
      Object.create({ inherited: true }) as object, entry("inherited"))] },
    { label: "a sparse entry list", value: (() => {
      const list = [entry("sparse")];
      list.length = 2;
      return list;
    })() },
  ];

  it("generates the exact nonzero reflection case set", () => {
    expect(hostile).toHaveLength(8);
    expect(new Set(hostile.map(({ label }) => label)).size).toBe(8);
  });

  it.each(hostile)("refuses $label with the production codec's exact code", ({ label, value }) => {
    let decoded: ReturnType<typeof decodeJournalEntries>;
    try {
      decoded = decodeJournalEntries(value);
    } catch (error) {
      throw new Error(`${label} CRASHED instead of refusing: ${String(error)}`);
    }
    expect(decoded).toEqual({ code: "JOURNAL_ENTRY_MALFORMED", ok: false });
    if (!decoded.ok) expect(JOURNAL_CODES.includes(decoded.code)).toBe(true);
  });

  it("still admits the untouched control entry", () => {
    expect(decodeJournalEntries([entry("control")]).ok).toBe(true);
  });
});
