import { encodeGraphContent } from "@moe/scheduler";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { decisionsOf, enrollDecisionLedgerMemo } from "../decision-ledger-memo.js";
import { createScopedGoalWorld } from "../goals/goal-scoped-test-fixtures.js";
import { graphBodyAggregateId, readGraphBody } from "../planning/graph-body-record.js";
import { activeCompiledGraphs } from "./compiled-node-source.js";

/**
 * `activeCompiledGraphs` walked the whole decision ledger and parsed every sealed graph body on
 * EVERY call, and the wrapper's delivery pass calls it once per node. Measured on UnAI
 * 2026-09-17: a 25-minute pass with ~70 node trees, nothing staffed, nothing logged. These pin
 * that an enrolled handle walks once per change — and, the part that a ledger-position key would
 * get wrong, that a change made by EVENT alone, with no decision recorded, is still a change.
 */

vi.mock("../planning/graph-body-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../planning/graph-body-record.js")>();
  return { ...actual, readGraphBody: vi.fn(actual.readGraphBody) };
});

const KEYS = ["node-1", "node-2", "node-3"] as const;
const walks = (): number => vi.mocked(readGraphBody).mock.calls.length;

afterEach(() => { vi.clearAllMocks(); closeStores(); });

describe("activeCompiledGraphs", () => {
  it("walks once for an enrolled handle, however many times it is asked", () => {
    const world = createScopedGoalWorld([...KEYS]);
    enrollDecisionLedgerMemo(world.store);
    vi.mocked(readGraphBody).mockClear();

    const first = activeCompiledGraphs(world.store, PROJECT_ID);
    for (let call = 0; call < 5; call += 1) {
      // The same answer, not merely an equal one: nothing was rebuilt.
      expect(activeCompiledGraphs(world.store, PROJECT_ID)).toBe(first);
    }

    expect(first).toHaveLength(1);
    expect(walks()).toBe(1);
  });

  it("keeps the old read pattern for a handle nobody enrolled", () => {
    // `decisionsOf` walks from zero on an unenrolled handle, so a marker there would cost a
    // full walk by itself; a one-shot CLI or a test handle must measure what it measured.
    const world = createScopedGoalWorld([...KEYS]);
    vi.mocked(readGraphBody).mockClear();

    activeCompiledGraphs(world.store, PROJECT_ID);
    activeCompiledGraphs(world.store, PROJECT_ID);
    activeCompiledGraphs(world.store, PROJECT_ID);

    expect(walks()).toBe(3);
  });

  it("walks again when an aggregate it read changes by event alone, with no decision recorded", () => {
    // Graph bodies are written as raw events on a content-addressed aggregate, and the run
    // chain and activation witness are read from events too. None of those moves the decision
    // ledger. A memo keyed on the ledger position alone would keep serving this world after
    // one of them changed underneath it.
    const world = createScopedGoalWorld([...KEYS]);
    enrollDecisionLedgerMemo(world.store);
    const before = activeCompiledGraphs(world.store, PROJECT_ID);
    vi.mocked(readGraphBody).mockClear();
    const decisionsBefore = decisionsOf(world.store, 200).length;

    const encoded = encodeGraphContent(world.graph.content);
    if (!encoded.ok) throw new Error("fixture graph did not encode");
    const bodyAggregate = graphBodyAggregateId(PROJECT_ID, encoded.value.graphContentHash);
    const version = world.store.getAggregateVersion(bodyAggregate);
    world.store.commit({
      aggregateId: bodyAggregate,
      commandBytes: new TextEncoder().encode(JSON.stringify({ eventType: "MemoProbe" })),
      commandId: "memo-probe-1",
      committedAt: new Date().toISOString(),
      events: [{ eventId: "memo-probe-1-e1", eventType: "MemoProbe", payload: new TextEncoder().encode("{}") }],
      expectedVersion: version,
    });

    const after = activeCompiledGraphs(world.store, PROJECT_ID);

    // The decision ledger did not move — this invalidation came from the aggregate's version.
    expect(decisionsOf(world.store, 200).length).toBe(decisionsBefore);
    expect(walks()).toBe(1);
    expect(after).not.toBe(before);
    // And the re-walk still finds the same graph: the body row it reads is unchanged.
    expect(after.map((graph) => graph.goalRef)).toEqual(before.map((graph) => graph.goalRef));
  });

  it("keeps one lifecycle filter's answer out of another's", () => {
    const world = createScopedGoalWorld([...KEYS]);
    enrollDecisionLedgerMemo(world.store);

    const enabled = activeCompiledGraphs(world.store, PROJECT_ID);
    const none = activeCompiledGraphs(world.store, PROJECT_ID, new Set(["ARCHIVED"]));

    expect(enabled).toHaveLength(1);
    expect(none).toHaveLength(0);
    expect(activeCompiledGraphs(world.store, PROJECT_ID)).toBe(enabled);
  });
});
