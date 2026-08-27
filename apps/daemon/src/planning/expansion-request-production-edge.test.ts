/** Production graph edge -> durable release selector -> atomic expansion request proof. */
import { afterAll, describe, expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { runGraphEdge } from "../daemon-command-graph-edges.js";
import type { GraphEdgeContext } from "../daemon-command-graph-edges.js";
import { readExpansionRequestAuthority }
  from "./expansion-request-current-authority.js";
import type { ExpansionRequestPayload } from "./expansion-request-contracts.js";
import { identitiesOf } from "./expansion-request-derivation.js";
import { readCurrentExpansionRequest } from "./expansion-request-ledger.js";
import {
  EXPANSION_HOLD_EVENT_TYPE,
  EXPANSION_RUN_EVENT_TYPE,
  expansionHoldAggregateId,
} from "./expansion-request-records.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  SELECTOR_DECIDED_AT,
  SELECTOR_GOAL_ID,
  SELECTOR_NODE_KEY,
  SELECTOR_RUN_ID,
  cleanupSelectorWorlds,
  openSelectorStore,
  selectorWorld,
} from "./expansion-release-selector-test-fixtures.js";

const encoder = new TextEncoder();
interface PairIdentity {
  readonly generation: number; readonly goalVersion: number;
  readonly graphEpoch: number; readonly holdAggregateId: string;
  readonly holdId: string; readonly planningRunRef: string;
}

afterAll(() => cleanupSelectorWorlds());

function payload(rationale = "the parent needs a released sub-plan"): ExpansionRequestPayload {
  return {
    goalRef: SELECTOR_GOAL_ID,
    parentNodeRef: SELECTOR_NODE_KEY,
    parentRunRef: SELECTOR_RUN_ID,
    rationale,
  };
}

function edge(store: SqliteEventStore, commandId: string,
  requestPayload: ExpansionRequestPayload = payload()): GraphEdgeContext {
  return {
    clock: () => SELECTOR_DECIDED_AT,
    envelope: {
      commandId, correlationId: `corr-${commandId}`,
      expectedVersion: 0, payload: { ...requestPayload },
    },
    humanReview: Object.freeze({ principalId: PRINCIPAL_ID }),
    kind: "graph.request_expansion",
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
  };
}

function identityOf(store: SqliteEventStore): PairIdentity {
  const current = readExpansionRequestAuthority({
    ledger: readDurableLedger(store, PROJECT_ID),
    payload: payload(),
    projectId: PROJECT_ID,
    store,
  });
  if (!current.ok) throw new Error(`current authority refused: ${current.code}`);
  const ids = identitiesOf(current.authority);
  return {
    generation: current.authority.generation,
    goalVersion: current.authority.goalVersion,
    graphEpoch: current.authority.graphEpoch,
    holdAggregateId: expansionHoldAggregateId(PROJECT_ID, ids.holdId),
    ...ids,
  };
}

function pairCounts(store: SqliteEventStore, identity: PairIdentity) {
  return {
    hold: store.readEvents(identity.holdAggregateId)
      .filter((event) => event.eventType === EXPANSION_HOLD_EVENT_TYPE).length,
    run: store.readEvents(identity.planningRunRef)
      .filter((event) => event.eventType === EXPANSION_RUN_EVENT_TYPE).length,
  };
}

function decisionCount(store: SqliteEventStore): number {
  return store.readCommandDecisionsAfter(0n, 1_000).items.length;
}

function expectRefusal(run: () => unknown, code: string, layer: string,
  detail: string): DomainRefusal {
  try {
    run();
  } catch (error) {
    if (!(error instanceof DomainRefusal)) throw error;
    expect(error.code).toBe(code);
    expect(error.layer).toBe(layer);
    expect(error.detail).toBe(detail);
    return error;
  }
  throw new Error("expected production edge refusal");
}

function occupyGoal(store: SqliteEventStore, commandId: string): void {
  const bytes = encoder.encode(commandId);
  store.commitExpectedVersionDecision({
    commandKind: "test.move_goal",
    committedResultBytes: bytes,
    correlationId: `corr-${commandId}`,
    decidedAt: SELECTOR_DECIDED_AT,
    events: [{
      eventId: `event-${commandId}`, eventType: "GoalMoved", payload: bytes,
    }],
    expectedVersion: store.getAggregateVersion(SELECTOR_GOAL_ID),
    key: { commandId, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: bytes,
    targetAggregateId: SELECTOR_GOAL_ID,
  });
}

function interceptNextCommit(store: SqliteEventStore,
  interleave: () => void): Readonly<{ calls: () => number; store: SqliteEventStore }> {
  const commit = store.commitExpectedVersionDecisionLegs.bind(store);
  let calls = 0;
  const intercepted = new Proxy(store, {
    get(target, property) {
      if (property === "commitExpectedVersionDecisionLegs") return (
        input: Parameters<typeof commit>[0],
      ): ReturnType<typeof commit> => {
        calls += 1;
        if (calls === 1) interleave();
        return commit(input);
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { calls: () => calls, store: intercepted };
}

describe("production expansion request graph edge", () => {
  it("commits only one ACTIVE hold and its bound EXPANSION run", async () => {
    const world = await selectorWorld("expansion-edge-accepted");
    const store = openSelectorStore(world.storePath);
    try {
      const identity = identityOf(store);
      const horizon = store.readEventHorizon();
      const beforeDecisions = decisionCount(store);

      const decided = runGraphEdge(edge(store, "cmd-expansion-production"));
      expect(decided.disposition).toBe("DECIDED");
      expect(decisionCount(store)).toBe(beforeDecisions + 1);
      const written = store.readEventsAfter(horizon, 100).items;
      expect(written.map((event) => event.eventType).sort()).toStrictEqual(
        [EXPANSION_HOLD_EVENT_TYPE, EXPANSION_RUN_EVENT_TYPE].sort(),
      );
      expect(written).toHaveLength(2);

      const pair = readCurrentExpansionRequest(store, {
        generation: identity.generation,
        goalRef: SELECTOR_GOAL_ID,
        graphEpoch: identity.graphEpoch,
        holdVersion: 1,
        parentNodeRef: SELECTOR_NODE_KEY,
        parentRunRef: SELECTOR_RUN_ID,
        planningRunRef: identity.planningRunRef,
        projectId: PROJECT_ID,
      });
      expect(pair.ok).toBe(true);
      if (!pair.ok) return;
      expect(pair.pair.hold.lifecycle).toBe("ACTIVE");
      expect(pair.pair.run.runKind).toBe("EXPANSION");
      if (pair.pair.run.runKind !== "EXPANSION") return;
      expect(pair.pair.run.expansion.holdId).toBe(identity.holdId);
      expect(pairCounts(store, identity)).toStrictEqual({ hold: 1, run: 1 });
    } finally {
      store.close();
    }
  });

  it("replays byte-identically without another decision or event", async () => {
    const world = await selectorWorld("expansion-edge-replay");
    const store = openSelectorStore(world.storePath);
    try {
      const request = edge(store, "cmd-expansion-replay");
      const first = runGraphEdge(request);
      expect(first.disposition).toBe("DECIDED");
      const key = {
        commandId: "cmd-expansion-replay", principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
      };
      const firstRecord = store.getCommandDecision(key);
      expect(firstRecord).not.toBeNull();
      if (firstRecord === null) return;
      const bytes = Uint8Array.from(firstRecord.resultBytes);
      const horizon = store.readEventHorizon();
      const decisions = decisionCount(store);
      const replay = runGraphEdge(request);
      expect(replay.disposition).toBe("REPLAYED");
      const replayRecord = store.getCommandDecision(key);
      expect(replayRecord).toStrictEqual(firstRecord);
      expect(replayRecord?.resultBytes).toStrictEqual(bytes);
      expect(replayRecord?.decisionSha256).toBe(firstRecord.decisionSha256);
      expect(decisionCount(store)).toBe(decisions);
      expect(store.readEventHorizon()).toBe(horizon);
    } finally {
      store.close();
    }
  });

  it("refuses same identity with different bytes and writes nothing", async () => {
    const world = await selectorWorld("expansion-edge-conflict");
    const store = openSelectorStore(world.storePath);
    try {
      const commandId = "cmd-expansion-conflict";
      runGraphEdge(edge(store, commandId));
      const horizon = store.readEventHorizon();
      const decisions = decisionCount(store);
      expectRefusal(
        () => runGraphEdge(edge(store, commandId, payload("different bytes"))),
        "EXPANSION_REQUEST_LEDGER_IDEMPOTENCY_CONFLICT",
        "LEDGER",
        "EXPANSION_REQUEST_SERVICE (IDEMPOTENCY_CONFLICT/DURABLE_STORE)",
      );
      expect(store.readEventHorizon()).toBe(horizon);
      expect(decisionCount(store)).toBe(decisions);
    } finally {
      store.close();
    }
  });

  it("refuses a goal movement at the commit seam and leaves no stale pair after reopen", async () => {
    const world = await selectorWorld("expansion-edge-goal-race");
    const store = openSelectorStore(world.storePath);
    const mover = openSelectorStore(world.storePath);
    const identity = identityOf(store);
    try {
      const intercepted = interceptNextCommit(
        store, () => occupyGoal(mover, "cmd-goal-move"),
      );
      expectRefusal(
        () => runGraphEdge(edge(intercepted.store, "cmd-expansion-goal-race")),
        "EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT",
        "LEDGER",
        "EXPANSION_REQUEST_SERVICE (EXPECTED_VERSION_CONFLICT/DURABLE_STORE)",
      );
      expect(intercepted.calls()).toBe(1);
    } finally {
      store.close();
      mover.close();
    }

    const reopened = openSelectorStore(world.storePath);
    try {
      expect(reopened.getAggregateVersion(SELECTOR_GOAL_ID)).toBe(identity.goalVersion + 1);
      expect(pairCounts(reopened, identity)).toStrictEqual({ hold: 0, run: 0 });
    } finally {
      reopened.close();
    }
  });

  it("lets one interleaved request win and the loser append zero events", async () => {
    const world = await selectorWorld("expansion-edge-competing");
    const firstStore = openSelectorStore(world.storePath);
    const secondStore = openSelectorStore(world.storePath);
    const identity = identityOf(firstStore);
    let winner: ReturnType<typeof runGraphEdge> | undefined;
    let winnerCounts: ReturnType<typeof pairCounts> | undefined;
    try {
      const intercepted = interceptNextCommit(firstStore, () => {
        winner = runGraphEdge(edge(secondStore, "cmd-expansion-winner"));
        winnerCounts = pairCounts(secondStore, identity);
      });
      expectRefusal(
        () => runGraphEdge(edge(intercepted.store, "cmd-expansion-loser")),
        "EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT",
        "LEDGER",
        "EXPANSION_REQUEST_SERVICE (EXPECTED_VERSION_CONFLICT/DURABLE_STORE)",
      );
      expect(intercepted.calls()).toBe(1);
      expect(winner?.disposition).toBe("DECIDED");
      expect(winnerCounts).toStrictEqual({ hold: 1, run: 1 });
      expect(pairCounts(firstStore, identity)).toStrictEqual(winnerCounts);
    } finally {
      firstStore.close();
      secondStore.close();
    }

    const reopened = openSelectorStore(world.storePath);
    try {
      expect(pairCounts(reopened, identity)).toStrictEqual({ hold: 1, run: 1 });
    } finally {
      reopened.close();
    }
  });
});
