import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  decisionsOf, enrollDecisionLedgerMemo, isDecisionLedgerMemoized,
} from "./decision-ledger-memo.js";

const PROJECT = "moe-test-project";
const encoder = new TextEncoder();
const opened: SqliteEventStore[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

function openStore(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForTest();
  opened.push(store);
  return store;
}

function commit(store: SqliteEventStore, n: number): void {
  const bytes = encoder.encode(`{"n":${String(n)}}`);
  const result = store.commitExpectedVersionDecision({
    commandKind: "memo.probe",
    committedResultBytes: bytes,
    correlationId: `corr-${String(n)}`,
    decidedAt: "2026-09-05T12:00:00.000Z",
    events: [{ eventId: `evt-memo-${String(n)}`, eventType: "MemoProbed", payload: bytes }],
    expectedVersion: n - 1,
    key: { commandId: `cmd-memo-${String(n)}`, principalId: "p", projectId: PROJECT },
    requestBytes: bytes,
    targetAggregateId: "agg-memo",
  });
  expect(result.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

/** Counts page reads without changing what the store answers. */
function counting(store: SqliteEventStore): { readonly store: SqliteEventStore; pages: () => number } {
  let pages = 0;
  const proxied = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "readCommandDecisionsAfter") {
        return (...args: Parameters<SqliteEventStore["readCommandDecisionsAfter"]>) => {
          pages += 1;
          return target.readCommandDecisionsAfter(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { pages: () => pages, store: proxied };
}

describe("decisionsOf", () => {
  it("walks an unenrolled handle from position 0 with the caller's page size, every call", () => {
    const raw = openStore();
    for (let n = 1; n <= 5; n += 1) commit(raw, n);
    const { pages, store } = counting(raw);
    expect(isDecisionLedgerMemoized(store)).toBe(false);
    const first = decisionsOf(store, 2);
    expect(first.map((d) => d.decisionPosition)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(pages()).toBe(3);
    decisionsOf(store, 2);
    expect(pages()).toBe(6);
  });

  it("tops an enrolled handle up from its last position and answers new commits", () => {
    const raw = openStore();
    for (let n = 1; n <= 5; n += 1) commit(raw, n);
    const { pages, store } = counting(raw);
    enrollDecisionLedgerMemo(store);
    enrollDecisionLedgerMemo(store);
    expect(isDecisionLedgerMemoized(store)).toBe(true);
    const fresh = decisionsOf(openStoreWith(raw), 2);
    const memoized = decisionsOf(store, 2);
    expect(memoized).toEqual(fresh);
    expect(pages()).toBe(3);
    // A hit costs exactly one page: "anything after position 5?"
    expect(decisionsOf(store, 2)).toBe(memoized);
    expect(pages()).toBe(4);
    commit(raw, 6);
    const grown = decisionsOf(store, 2);
    expect(grown.map((d) => d.decisionPosition)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expect(grown.at(-1)?.key.commandId).toBe("cmd-memo-6");
    expect(pages()).toBe(5);
  });

  it("keeps memos per handle: a second handle on the same file is its own reader", () => {
    const raw = openStore();
    commit(raw, 1);
    enrollDecisionLedgerMemo(raw);
    expect(decisionsOf(raw, 200)).toHaveLength(1);
    const other = openStoreWith(raw);
    expect(isDecisionLedgerMemoized(other)).toBe(false);
    expect(decisionsOf(other, 200)).toHaveLength(1);
  });
});

/**
 * A plain second view over the same store bytes, never enrolled. Ephemeral stores are
 * in-memory per handle, so the honest "other handle" is the same object behind a fresh
 * Proxy (methods bound to the target: private fields do not tunnel through a proxy).
 */
function openStoreWith(store: SqliteEventStore): SqliteEventStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
