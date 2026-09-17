import { encodeGraphContent } from "@moe/scheduler";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { decisionsOf, enrollDecisionLedgerMemo } from "../decision-ledger-memo.js";
import { createScopedGoalWorld } from "../goals/goal-scoped-test-fixtures.js";
import { graphBodyAggregateId, readGraphBody } from "../planning/graph-body-record.js";
import { legacyCompiledNodeKeys } from "./compiled-node-identity.js";
import { activeCompiledGraphs } from "./compiled-node-source.js";

/**
 * `legacyCompiledNodeKeys` walks every committed decision and parses every historical graph
 * body — for the refusal alone; the walk's result is discarded — and the wrapper runs it once
 * per node per delivery pass. Measured on UnAI 2026-09-17: 34.5% of the live wrapper's CPU.
 * These pin that an enrolled handle walks once per change, that a change by event alone still
 * counts, and that a caller who folds its own ledger always gets a fresh walk against it.
 */

vi.mock("../planning/graph-body-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../planning/graph-body-record.js")>();
  return { ...actual, readGraphBody: vi.fn(actual.readGraphBody) };
});

const KEYS = ["node-1", "node-2", "node-3"] as const;
const bodyReads = (): number => vi.mocked(readGraphBody).mock.calls.length;

afterEach(() => { vi.clearAllMocks(); closeStores(); });

describe("legacyCompiledNodeKeys history walk", () => {
  it("walks history once for an enrolled handle, however many nodes ask", () => {
    const world = createScopedGoalWorld([...KEYS]);
    const current = activeCompiledGraphs(world.store, PROJECT_ID);
    enrollDecisionLedgerMemo(world.store);
    vi.mocked(readGraphBody).mockClear();

    const first = legacyCompiledNodeKeys(world.store, PROJECT_ID, current);
    for (let call = 0; call < 5; call += 1) {
      expect(legacyCompiledNodeKeys(world.store, PROJECT_ID, current)).toEqual(first);
    }

    expect(bodyReads()).toBe(1);
  });

  it("walks every time for a handle nobody enrolled", () => {
    const world = createScopedGoalWorld([...KEYS]);
    const current = activeCompiledGraphs(world.store, PROJECT_ID);
    vi.mocked(readGraphBody).mockClear();

    legacyCompiledNodeKeys(world.store, PROJECT_ID, current);
    legacyCompiledNodeKeys(world.store, PROJECT_ID, current);
    legacyCompiledNodeKeys(world.store, PROJECT_ID, current);

    expect(bodyReads()).toBe(3);
  });

  it("walks again when a historical body's aggregate changes by event alone", () => {
    const world = createScopedGoalWorld([...KEYS]);
    const current = activeCompiledGraphs(world.store, PROJECT_ID);
    enrollDecisionLedgerMemo(world.store);
    legacyCompiledNodeKeys(world.store, PROJECT_ID, current);
    vi.mocked(readGraphBody).mockClear();
    const decisionsBefore = decisionsOf(world.store, 200).length;

    const encoded = encodeGraphContent(world.graph.content);
    if (!encoded.ok) throw new Error("fixture graph did not encode");
    const bodyAggregate = graphBodyAggregateId(PROJECT_ID, encoded.value.graphContentHash);
    world.store.commit({
      aggregateId: bodyAggregate,
      commandBytes: new TextEncoder().encode(JSON.stringify({ eventType: "MemoProbe" })),
      commandId: "history-memo-probe-1",
      committedAt: new Date().toISOString(),
      events: [{ eventId: "history-memo-probe-1-e1", eventType: "MemoProbe", payload: new TextEncoder().encode("{}") }],
      expectedVersion: world.store.getAggregateVersion(bodyAggregate),
    });

    legacyCompiledNodeKeys(world.store, PROJECT_ID, current);

    expect(decisionsOf(world.store, 200).length).toBe(decisionsBefore);
    expect(bodyReads()).toBe(1);
  });

  it("always walks against a ledger the caller folded itself", () => {
    // A caller-owned ledger may be older than the store; the answer must be about THAT ledger.
    const world = createScopedGoalWorld([...KEYS]);
    const current = activeCompiledGraphs(world.store, PROJECT_ID);
    enrollDecisionLedgerMemo(world.store);
    const ledger = readDurableLedger(world.store, PROJECT_ID);
    vi.mocked(readGraphBody).mockClear();

    legacyCompiledNodeKeys(world.store, PROJECT_ID, current, ledger);
    legacyCompiledNodeKeys(world.store, PROJECT_ID, current, ledger);

    expect(bodyReads()).toBe(2);
  });
});
