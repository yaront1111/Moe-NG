/**
 * The ACCEPTED CONTROL for the atomic replacement supersession (task-9e52f850), plus the replay and
 * concurrency semantics DoD 2 and DoD 3 name.
 *
 * WHY THE ACCEPTED CONTROL IS THE ARM MOST WORTH DISTRUSTING. It is trivial to make one green by
 * seeding two graph revisions and a preparation record by hand. Every fact read back here is
 * produced by a PRODUCTION writer: the predecessor by `activateApprovedGraph` (task-eacea969), the
 * preparation pair by `commitPreparation` (task-32c1ba45), the successor's sealed bytes by the
 * shipped journey producer through `putGraphBody`, and the answers by `readCurrentActiveGraph` and
 * `foldPreparationHistory` — the same readers any consumer will use.
 */
import { afterEach, describe, expect, it } from "vitest";

import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import { decisionCount } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import { closeStores } from "./graph-activation-test-fixtures.js";
import { supersedeActiveGraph } from "./graph-supersede-service.js";
import type { GraphSupersedeResult } from "./graph-supersede-service.js";
import {
  GOAL_ID, GRAPH_REVISION_REF, PROJECT_ID, SUCCESSOR_GRAPH_CONTENT_HASH,
  SUCCESSOR_NODE_KEY, SUCCESSOR_REVISION_REF,
  currentPreparationFence, supersedableStore, supersedeContext, supersedeInput, supersedeRequest,
} from "./graph-supersede-test-fixtures.js";
import {
  fundingAggregateId, planningFenceAggregateId, preparationAggregateId,
} from "./supersession-preparation-contracts.js";
import {
  PREPARATION_EVENT_TYPES, foldPreparationHistory,
} from "./supersession-preparation-history.js";
import { releasePreparation } from "./supersession-preparation-ledger.js";

afterEach(() => {
  closeStores();
});

const PREDECESSOR = `graph-revision:${PROJECT_ID}:${GRAPH_REVISION_REF}`;
const SUCCESSOR = `graph-revision:${PROJECT_ID}:${SUCCESSOR_REVISION_REF}`;
const PREPARATION = preparationAggregateId(PROJECT_ID, GOAL_ID);
const FUNDING = fundingAggregateId(PROJECT_ID, GOAL_ID);
const FENCE = planningFenceAggregateId(PROJECT_ID, GOAL_ID);

/**
 * The SIX aggregates one supersession decision moves, named once as an immutable constant so no arm
 * can silently drop a member. An exact count, not `length > 0`: a one-member roster satisfies that.
 */
const SUPERSESSION_AGGREGATES = Object.freeze([
  GOAL_ID, PREDECESSOR, SUCCESSOR, PREPARATION, FUNDING, FENCE,
] as const);

/** The four lifecycle events a successor's whole history is, in the order the reducer emits them. */
const SUCCESSOR_EVENT_TYPES = Object.freeze([
  "GraphRevisionCreated", "GraphRevisionSubmitted", "GraphRevisionApproved",
  "GraphRevisionActivated",
] as const);

function accept(result: GraphSupersedeResult): Extract<GraphSupersedeResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected an accepted supersession, got ${result.code}/${result.refusedBy}`);
  }
  return result;
}

function counts(store: { readEvents: (id: string) => readonly unknown[] }): readonly number[] {
  return SUPERSESSION_AGGREGATES.map((aggregateId) => store.readEvents(aggregateId).length);
}

describe("the supersession decision's aggregate roster is pinned (task-9e52f850)", () => {
  it("names exactly six distinct aggregates", () => {
    expect(SUPERSESSION_AGGREGATES).toHaveLength(6);
    expect(new Set(SUPERSESSION_AGGREGATES).size).toBe(6);
    expect(SUCCESSOR_EVENT_TYPES).toHaveLength(4);
  });
});

describe("supersedeActiveGraph moves predecessor, successor and pair in ONE decision", () => {
  it("ACCEPTED CONTROL: the projection answers with the successor at predecessor epoch + 1", () => {
    const store = supersedableStore();
    const before = readCurrentActiveGraph(store, PROJECT_ID);
    if (!before.ok) throw new Error("fixture has no active graph");
    expect(before.revisionId).toBe(GRAPH_REVISION_REF);
    expect(before.graphEpoch).toBe(1);
    expect(store.readEvents(SUCCESSOR)).toHaveLength(0);
    const decisionsBefore = decisionCount(store);

    const outcome = accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1"), supersedeInput(),
    ));

    expect(outcome.disposition).toBe("DECIDED");
    expect(outcome.predecessorRevisionId).toBe(GRAPH_REVISION_REF);
    expect(outcome.successorRevisionId).toBe(SUCCESSOR_REVISION_REF);
    // EPOCH + 1 RELATIVE TO THE PREDECESSOR, asserted as arithmetic on the predecessor's own epoch.
    expect(outcome.successorGraphEpoch).toBe(before.graphEpoch + 1);
    expect(decisionCount(store)).toBe(decisionsBefore + 1);

    // THE CONSUMER'S OWN READ, not a re-derivation.
    const after = readCurrentActiveGraph(store, PROJECT_ID);
    if (!after.ok) throw new Error(`expected an active successor: ${after.code}`);
    expect(after.revisionId).toBe(SUCCESSOR_REVISION_REF);
    expect(after.graphEpoch).toBe(2);
    expect(after.graphContentHash).toBe(SUCCESSOR_GRAPH_CONTENT_HASH);
    expect(after.content.snapshot.nodes.map((node) => node.nodeKey))
      .toStrictEqual([SUCCESSOR_NODE_KEY]);
  });

  it("writes the successor's whole history and the predecessor's supersession together", () => {
    const store = supersedableStore();
    expect(counts(store)).toEqual([2, 4, 0, 1, 1, 1]);

    accept(supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1"), supersedeInput()));

    expect(counts(store)).toEqual([3, 5, 4, 2, 2, 2]);
    expect(store.readEvents(SUCCESSOR).map((event) => event.eventType))
      .toStrictEqual([...SUCCESSOR_EVENT_TYPES]);
    expect(store.readEvents(PREDECESSOR).at(-1)?.eventType).toBe("GraphRevisionSuperseded");
    expect(store.readEvents(GOAL_ID).at(-1)?.eventType).toBe("GoalGraphEpochAdvanced");
  });

  it("marks the paired preparation records CONSUMED, not released, in the same decision", () => {
    const store = supersedableStore();

    const outcome = accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1"), supersedeInput(),
    ));

    expect(outcome.consumed.funding.lifecycle).toBe("CONSUMED");
    expect(outcome.consumed.fence.lifecycle).toBe("CONSUMED");
    // A consumed hold was SPENT: refunding it would hand back authority already used.
    expect(outcome.consumed.funding.refunded).toBe(0);
    expect(store.readEvents(PREPARATION).at(-1)?.eventType).toBe(PREPARATION_EVENT_TYPES.CONSUMED);
    expect(store.readEvents(FUNDING).at(-1)?.eventType)
      .toBe(PREPARATION_EVENT_TYPES.FUNDING_CONSUMED);
    expect(store.readEvents(FENCE).at(-1)?.eventType)
      .toBe(PREPARATION_EVENT_TYPES.FENCE_CONSUMED);
    const history = foldPreparationHistory(store, PREPARATION);
    if (!history.ok) throw new Error(`fold refused: ${history.code}`);
    expect(history.current).toBeNull();
  });

  it("derives the dispositions from the two contents: node-a REMOVE, node-b ADD", () => {
    const store = supersedableStore();
    accept(supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1"), supersedeInput()));

    const superseded = store.readEvents(PREDECESSOR).at(-1);
    if (superseded === undefined) throw new Error("no supersession event");
    const payload = JSON.parse(new TextDecoder().decode(superseded.payload)) as {
      authorityHash: string;
      successor: { graphContentHash: string; graphEpoch: number; revisionId: string };
    };
    expect(payload.successor.revisionId).toBe(SUCCESSOR_REVISION_REF);
    expect(payload.successor.graphEpoch).toBe(2);
    // RECOMPUTED CONTENT HASH, never the structural snapshotIdentity (dec-64b2391c option A).
    expect(payload.successor.graphContentHash).toBe(SUCCESSOR_GRAPH_CONTENT_HASH);
    expect(payload.authorityHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("leaves the released path with nothing to release once the pair is consumed", () => {
    const store = supersedableStore();
    const fence = currentPreparationFence(store);
    accept(supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1"), supersedeInput()));

    const released = releasePreparation(supersedeContext(store, "cmd-release-1", {
      commandId: "cmd-release-1", correlationId: "corr-release",
      decidedAt: "2026-08-26T00:20:00.000Z",
      expectedPreparationVersion: fence.expectedPreparationVersion + 1,
      generation: fence.generation, goalRef: GOAL_ID, principalId: "principal-1",
      projectId: PROJECT_ID,
    }));

    expect(released.ok).toBe(false);
    if (released.ok) throw new Error("expected the release to refuse");
    expect(released.code).toBe("SUPERSESSION_RELEASE_GENERATION_ABSENT");
    expect(released.refusedBy).toBe("SUPERSESSION_PREPARATION_LEDGER");
  });
});

describe("the consequences a committed supersession leaves behind, measured not assumed", () => {
  it("PINS the stale budget binding a supersession creates, so the gap cannot go silent", () => {
    // Every committed budget-ledger record carries the graphRevisionRef and graphEpoch it was
    // authorized at, and `budget-current-projection.ts:113` refuses when they disagree with the
    // CURRENT binding — which this move has just advanced. Nothing in this tree re-authorizes a
    // budget root at a new epoch, so the goal's budget projection is unreadable afterwards and a
    // SECOND preparation is unreachable. Not a defect this row introduces and not one it owns:
    // pinned here so the day budget re-authorization lands, this arm goes red and someone revisits.
    const store = supersedableStore();
    expect(readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID).ok).toBe(true);

    accept(supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1"), supersedeInput()));

    const budget = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
    expect(budget.ok).toBe(false);
    if (budget.ok) throw new Error("expected the budget projection to refuse");
    expect(budget.code).toBe("BUDGET_PROJECTION_STALE_BINDING");
  });
});

describe("replay and concurrency leave the durable record exactly where it was", () => {
  it("SAME BYTES replay: the original decision, and NO new event or decision row", () => {
    const store = supersedableStore();
    const payload = supersedeRequest(store, { commandId: "cmd-supersede-1" });
    const first = accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", payload), supersedeInput(),
    ));
    const horizonAfterFirst = store.readEventHorizon();
    const decisionsAfterFirst = decisionCount(store);

    const replayed = accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", payload), supersedeInput(),
    ));

    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.decision.decisionId).toBe(first.decision.decisionId);
    expect(replayed.successorGraphEpoch).toBe(2);
    expect(replayed.consumed.funding.lifecycle).toBe("CONSUMED");
    // COUNTS, not just the returned value: a second event is invisible to a return-value check.
    expect(store.readEventHorizon()).toBe(horizonAfterFirst);
    expect(decisionCount(store)).toBe(decisionsAfterFirst);
    expect(counts(store)).toEqual([3, 5, 4, 2, 2, 2]);
  });

  it("CHANGED BYTES under one decision identity refuse and consume nothing further", () => {
    const store = supersedableStore();
    const payload = supersedeRequest(store, { commandId: "cmd-supersede-1" });
    accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", payload), supersedeInput(),
    ));
    const horizon = store.readEventHorizon();

    const drifted = supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1", {
      ...payload, correlationId: "corr-drifted",
    }), supersedeInput());

    expect(drifted.ok).toBe(false);
    if (drifted.ok) throw new Error("expected a refusal");
    expect(drifted.code).toBe("GRAPH_SUPERSEDE_BYTES_CONFLICT");
    expect(drifted.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    expect(drifted.sourceCode).toBe("BOOTSTRAP_COMMAND_BYTES_CONFLICT");
    expect(drifted.sourceLayer).toBe("DAEMON_PREREQUISITE");
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("CONCURRENT supersession: the loser refuses, consumes nothing and advances no epoch", () => {
    const store = supersedableStore();
    // Both contexts are built BEFORE either commits, so both hold the same pre-supersession
    // ledger snapshot and both name `graph-revision-1` as the predecessor they expect.
    const first = supersedeContext(store, "cmd-supersede-1");
    const second = supersedeContext(store, "cmd-supersede-2");

    const winner = accept(supersedeActiveGraph(first, supersedeInput()));
    const loser = supersedeActiveGraph(second, supersedeInput());

    expect(winner.successorGraphEpoch).toBe(2);
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("expected the second supersession to lose");
    // The READ-SIDE fence answers first and that is the honest code: by the time the loser is
    // decided, `readCurrentActiveGraph` already names the winner's successor, so the predecessor
    // the loser expects is no longer active. The store's expected-version fence remains the
    // authority that would decide a genuine cross-process race, and it is unreachable from a
    // single-process fixture precisely because this read answers earlier.
    expect(loser.code).toBe("GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH");
    expect(loser.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    const active = readCurrentActiveGraph(store, PROJECT_ID);
    if (!active.ok) throw new Error("expected the winner's successor to be active");
    expect(active.graphEpoch).toBe(2);
    expect(active.revisionId).toBe(SUCCESSOR_REVISION_REF);
    expect(counts(store)).toEqual([3, 5, 4, 2, 2, 2]);
  });
});
