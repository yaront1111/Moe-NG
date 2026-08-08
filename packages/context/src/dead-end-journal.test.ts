import { describe, expect, it } from "vitest";

import {
  MAX_JOURNAL_ENTRY_COUNT,
  MAX_JOURNAL_TEXT_CHARACTERS,
  type FactPredicate,
} from "./context-contract.js";
import {
  createDeadEndJournal,
  evaluateRetryUnlock,
  type DeadEndJournalEntry,
} from "./dead-end-journal.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function entry(
  id: string,
  overrides: Partial<DeadEndJournalEntry> = {},
): DeadEndJournalEntry {
  return {
    id,
    kind: "FAILED_APPROACH",
    failureCode: "VERIFY_FAILED",
    primaryScope: "packages/context",
    recipeDigest: DIGEST_A,
    baseDigest: DIGEST_A,
    environmentDigest: DIGEST_B,
    retryPredicate: {
      kind: "FACT_VERSION",
      factId: "fact:test-suite",
      operator: "GREATER_THAN",
      expectedVersion: 1,
    },
    text: "failed for a stable reason",
    actorId: "worker:test",
    occurredAt: "2026-08-08T10:00:00.000Z",
    ...overrides,
  };
}

describe("dead-end journal bounds", () => {
  it("admits exactly the entry-count limit and refuses one over it", () => {
    const atLimit = Array.from({ length: MAX_JOURNAL_ENTRY_COUNT }, (_, index) =>
      entry(`entry-${index}`, { text: "" }),
    );

    const admitted = createDeadEndJournal(atLimit);
    expect(admitted.kind).toBe("ADMITTED");
    if (admitted.kind !== "ADMITTED") throw new Error("expected admission");
    expect(admitted.journal.entries).toHaveLength(MAX_JOURNAL_ENTRY_COUNT);

    expect(createDeadEndJournal([...atLimit, entry("entry-over", { text: "" })])).toEqual({
      kind: "REFUSED",
      code: "JOURNAL_LIMIT_REACHED",
      layer: "DEAD_END_JOURNAL",
      limit: "ENTRY_COUNT",
      actual: MAX_JOURNAL_ENTRY_COUNT + 1,
      maximum: MAX_JOURNAL_ENTRY_COUNT,
    });
  });

  it("admits exactly the text-character limit and refuses one over it", () => {
    const admitted = createDeadEndJournal([
      entry("entry-at-text-limit", { text: "x".repeat(MAX_JOURNAL_TEXT_CHARACTERS) }),
    ]);
    expect(admitted.kind).toBe("ADMITTED");

    expect(
      createDeadEndJournal([
        entry("entry-over-text-limit", {
          text: "x".repeat(MAX_JOURNAL_TEXT_CHARACTERS + 1),
        }),
      ]),
    ).toEqual({
      kind: "REFUSED",
      code: "JOURNAL_LIMIT_REACHED",
      layer: "DEAD_END_JOURNAL",
      limit: "TEXT_CHARACTERS",
      actual: MAX_JOURNAL_TEXT_CHARACTERS + 1,
      maximum: MAX_JOURNAL_TEXT_CHARACTERS,
    });
  });
});

describe("typed retry predicates", () => {
  it("keeps a reworded dead end locked when its typed predicate is unchanged", () => {
    const prior = entry("prior");
    const reworded = entry("reworded", {
      text: "the prose is different but the durable fact condition is identical",
    });

    expect(evaluateRetryUnlock(prior, reworded.retryPredicate)).toEqual({
      kind: "REFUSED",
      code: "RETRY_PREDICATE_UNCHANGED",
      layer: "RETRY_PREDICATE",
    });
  });

  it("unlocks when the typed fact predicate changes", () => {
    const changedPredicate: FactPredicate = {
      kind: "FACT_VERSION",
      factId: "fact:test-suite",
      operator: "GREATER_THAN",
      expectedVersion: 2,
    };

    expect(evaluateRetryUnlock(entry("prior"), changedPredicate)).toEqual({
      kind: "UNLOCKED",
      predicate: changedPredicate,
    });
  });
});

describe("journal determinism", () => {
  const earlier = entry("z-id", { occurredAt: "2026-08-08T09:00:00.000Z" });
  const laterA = entry("a-id", { occurredAt: "2026-08-08T11:00:00.000Z" });
  const laterB = entry("b-id", { occurredAt: "2026-08-08T11:00:00.000Z" });

  it("uses occurredAt then id as its explicit total order", () => {
    const result = createDeadEndJournal([laterB, laterA, earlier]);
    expect(result.kind).toBe("ADMITTED");
    if (result.kind !== "ADMITTED") throw new Error("expected admission");
    expect(result.journal.entries.map(({ id }) => id)).toEqual([
      "z-id",
      "a-id",
      "b-id",
    ]);
  });

  it("produces one digest for the same entry set in different insertion orders", () => {
    const forward = createDeadEndJournal([earlier, laterA, laterB]);
    const reverse = createDeadEndJournal([laterB, laterA, earlier]);
    expect(forward.kind).toBe("ADMITTED");
    expect(reverse.kind).toBe("ADMITTED");
    if (forward.kind !== "ADMITTED" || reverse.kind !== "ADMITTED") {
      throw new Error("expected both journals to admit");
    }
    expect(reverse.journal.entries).toEqual(forward.journal.entries);
    expect(reverse.journal.digest).toBe(forward.journal.digest);
  });

  it("freezes detached journal entries and their typed predicates", () => {
    const source = {
      ...entry("immutable"),
      retryPredicate: { ...entry("immutable").retryPredicate },
    };
    const result = createDeadEndJournal([source]);
    expect(result.kind).toBe("ADMITTED");
    if (result.kind !== "ADMITTED") throw new Error("expected admission");

    source.text = "mutated after admission";
    expect(result.journal.entries[0]?.text).toBe("failed for a stable reason");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.journal)).toBe(true);
    expect(Object.isFrozen(result.journal.entries)).toBe(true);
    expect(Object.isFrozen(result.journal.entries[0]?.retryPredicate)).toBe(true);
  });
});
