import { MAX_JOURNAL_ENTRY_COUNT, createDeadEndJournal } from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  DAEMON_JOURNAL_APPEND, JOURNAL_APPEND_COMMAND_KIND, JOURNAL_CODES,
} from "./journal-contracts.js";
import { decodeJournalEntries } from "./journal-entry-codec.js";
import { readCurrentAttemptJournal } from "./journal-reader.js";
import type { AttemptJournalAnswer } from "./journal-reader.js";
import { entry, journalEventCount, openJournalHarness } from "./journal-test-harness.js";
import type { JournalHarness, SeamResult } from "./journal-test-harness.js";

/**
 * Idempotence, conflict, append ordering, and the generated hostile sweep.
 *
 * EVERY COUNT IS READ OUT OF THE STORE, never from a command result: "it did not
 * throw the second time" is also exactly what a double write looks like.
 */

afterEach(cleanupRestoreHarnesses);

const FIRST = [entry("idem-1", { occurredAt: "2026-08-15T00:00:03.000Z" })];
const SECOND = [entry("idem-2", { occurredAt: "2026-08-15T00:00:01.000Z" })];

const payloadOf = (
  harness: JournalHarness, entries: unknown,
): Record<string, unknown> => ({
  attemptAggregateId: harness.attempt.aggregateId,
  effectId: harness.attempt.record.effectIntent.intentId,
  entries,
});

const append = (
  harness: JournalHarness, commandId: string, entries: unknown,
): SeamResult => harness.send(
  commandId, JOURNAL_APPEND_COMMAND_KIND, payloadOf(harness, entries),
  harness.sessionCredential);

function durable(harness: JournalHarness): AttemptJournalAnswer {
  const answer = readCurrentAttemptJournal(
    harness.store, harness.attempt.record.activationDigest, PROJECT_ID);
  if (!answer.ok) throw new Error(`the durable reader refused: ${answer.code}`);
  return answer;
}

const rows = (harness: JournalHarness): number =>
  journalEventCount(harness.store, harness.attempt.record.activationDigest);

const canonical = (entries: readonly DeadEndJournalEntry[]): {
  digest: string; entries: readonly DeadEndJournalEntry[];
} => {
  const admitted = createDeadEndJournal(entries);
  if (admitted.kind !== "ADMITTED") throw new Error(`fixture refused: ${admitted.limit}`);
  return { digest: admitted.journal.digest, entries: admitted.journal.entries };
};

describe("journal.append — replay, conflict and append ordering", () => {
  it("replays the same command bytes without a second durable row", () => {
    const harness = openJournalHarness("replay");
    expect(append(harness, "cmd-replay", FIRST)).toMatchObject({
      decision: { disposition: "DECIDED" }, ok: true,
    });
    const before = durable(harness);
    expect(rows(harness)).toBe(1);

    expect(append(harness, "cmd-replay", FIRST)).toMatchObject({
      decision: { disposition: "REPLAYED" }, ok: true, outcome: "ACCEPTED",
    });
    // The counts come OUT OF THE STORE. A writer that appended a second identical
    // journal would still answer ok here.
    expect(rows(harness)).toBe(1);
    const after = durable(harness);
    expect(after.journalDigest).toBe(before.journalDigest);
    expect(after.entries).toEqual(before.entries);
  });

  it("refuses conflicting bytes under the STORE's own code, before mutating", () => {
    const harness = openJournalHarness("conflict");
    expect(append(harness, "cmd-conflict", FIRST).ok).toBe(true);
    const before = durable(harness);

    const conflicted = append(harness, "cmd-conflict", SECOND);
    if (!("refusal" in conflicted)) throw new Error("expected a refusal");
    // NOT flattened into a journal code: the store's idempotency conflict is the
    // only thing that can say "one command identity, two different requests", and
    // a DAEMON_JOURNAL_APPEND code here would hide that entirely.
    expect({ code: conflicted.refusal.code, layer: conflicted.refusal.layer }).toEqual({
      code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_STORE",
    });
    expect(conflicted.refusal.layer).not.toBe(DAEMON_JOURNAL_APPEND);
    // Refused BEFORE mutating: raw count unchanged and the ORIGINAL still stands.
    expect(rows(harness)).toBe(1);
    const after = durable(harness);
    expect(after.entries).toEqual(before.entries);
    expect(after.journalDigest).toBe(before.journalDigest);
    expect(after.entries.map((admitted) => admitted.id)).toEqual(["idem-1"]);
  });

  it("unions a genuinely new append in the PRODUCTION canonical order", () => {
    const harness = openJournalHarness("ordering");
    expect(append(harness, "cmd-order-1", FIRST).ok).toBe(true);
    expect(append(harness, "cmd-order-2", SECOND).ok).toBe(true);
    expect(rows(harness)).toBe(2);
    const answer = durable(harness);
    const expected = canonical([...FIRST, ...SECOND]);
    // Asserted against `createDeadEndJournal`'s own answer for the same union,
    // never a hand-sorted literal: the ordering rule (occurredAt, then id, then
    // entry digest) belongs to @moe/context and a literal would agree with a
    // writer that had stopped sorting.
    expect(answer.entries).toEqual(expected.entries);
    expect(answer.journalDigest).toBe(expected.digest);
    // And the order really is NOT insertion order, so the case is not vacuous:
    // idem-2 occurred first and must sort first despite being appended second.
    expect(answer.entries.map((admitted) => admitted.id)).toEqual(["idem-2", "idem-1"]);
  });

  it("admits a journal AT the entry-count bound and refuses one past it", () => {
    const harness = openJournalHarness("at-bound");
    const atLimit = Array.from({ length: MAX_JOURNAL_ENTRY_COUNT }, (_, index) =>
      entry(`bound-${index}`, {
        occurredAt: `2026-08-15T00:00:${String(index).padStart(2, "0")}.000Z`,
      }));
    // THE CONTROL: without it, "one over refuses" could equally be caused by the
    // daemon rejecting large lists for some unrelated reason.
    expect(append(harness, "cmd-at-bound", atLimit).ok).toBe(true);
    expect(durable(harness).entries).toHaveLength(MAX_JOURNAL_ENTRY_COUNT);
    const over = append(harness, "cmd-over-bound", [entry("one-too-many")]);
    if (!("refusal" in over)) throw new Error("expected a refusal past the bound");
    expect({ code: over.refusal.code, layer: over.refusal.layer }).toEqual({
      code: "JOURNAL_LIMIT_REACHED", layer: "DEAD_END_JOURNAL",
    });
    expect(rows(harness)).toBe(1);
  });
});

/** Every mutation JSON can actually carry, generated per field. */
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
  cases.push({ entries: [{ ...base, __proto__: { polluted: true } }], label: "a __proto__ key" });
  cases.push({ entries: [{ ...base, recipeDigest: "A".repeat(64) }], label: "an uppercase digest" });
  cases.push({ entries: [{ ...base, occurredAt: "2026-08-15T00:00:01.000" }],
    label: "an occurredAt without Z" });
  cases.push({ entries: [{ ...base, text: Number.NaN }], label: "a NaN text" });
  cases.push({ entries: [{ ...base, id: "" }], label: "an empty id" });
  cases.push({ entries: [[base]], label: "a nested list" });
  cases.push({ entries: { 0: base, length: 1 }, label: "an array-like object" });
  return cases;
}

describe("journal.append — the generated hostile sweep", () => {
  const cases = wireMutations();

  it("generates a nonzero number of cases", () => {
    // A sweep that silently produced zero cases would pass every assertion below.
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.length).toBe(Object.keys(entry("sweep")).length * 4 + 7);
    expect(new Set(cases.map((item) => item.label)).size).toBe(cases.length);
  });

  it("refuses every generated case with a frozen code, never a throw", () => {
    const harness = openJournalHarness("sweep");
    const answers = cases.map((item, index) => {
      let result: SeamResult;
      try {
        result = append(harness, `cmd-sweep-${index}`, item.entries);
      } catch (error) {
        throw new Error(`${item.label} CRASHED instead of refusing: ${String(error)}`);
      }
      if (!("refusal" in result)) {
        throw new Error(`${item.label} was ACCEPTED: ${JSON.stringify(result)}`);
      }
      return { code: result.refusal.code, label: item.label, layer: result.refusal.layer };
    });
    expect(answers).toHaveLength(cases.length);
    for (const answer of answers) {
      expect(JOURNAL_CODES.includes(answer.code as never), answer.label).toBe(true);
      expect(answer.layer, answer.label).toBe(DAEMON_JOURNAL_APPEND);
    }
    // Not one of them left a durable row behind.
    expect(rows(harness)).toBe(0);
  });
});

/**
 * Values JSON physically cannot carry, driven against the PRODUCTION decoder
 * rather than through the seam. `JSON.stringify` invokes a getter, serialises -0
 * as 0 and throws on a revoked proxy, so none of these can reach the writer over
 * the wire — asserting them at the seam would test the encoder, not the fence.
 */
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

  it("generates a nonzero number of reflection cases", () => {
    expect(hostile.length).toBeGreaterThan(0);
    expect(hostile.length).toBe(8);
  });

  it.each(hostile)("refuses $label with a frozen code", ({ label, value }) => {
    let decoded: ReturnType<typeof decodeJournalEntries>;
    try {
      decoded = decodeJournalEntries(value);
    } catch (error) {
      throw new Error(`${label} CRASHED instead of refusing: ${String(error)}`);
    }
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error(`${label} was admitted`);
    expect(JOURNAL_CODES.includes(decoded.code)).toBe(true);
    expect(decoded.code).toBe("JOURNAL_ENTRY_MALFORMED");
  });

  it("still admits the untouched control entry", () => {
    // Without this, every assertion above would pass on a decoder that refused
    // absolutely everything.
    const admitted = decodeJournalEntries([entry("control")]);
    expect(admitted.ok).toBe(true);
  });
});
