/**
 * The atomic two-leg writer (task-738a12a816e8421a96edd84648565a38), over a REAL file-backed
 * SqliteEventStore.
 *
 * ATOMICITY IS ASSERTED FROM THE LOSING SIDE. Every refusal arm below checks the aggregate the
 * writer did NOT name in its refusal: when the run leg is fenced, the HOLD leg must carry zero
 * events and version 0, and vice versa. Asserting only that the call refused would pass just as
 * happily against a writer that had already appended the primary leg.
 *
 * RAW CARDINALITY, NOT JUST VERSION. Both the aggregate version and the count of stored events of
 * each type are asserted, because a second append with the same version bump would move one and
 * not the other.
 *
 * WINDOWS HANDLE DISCIPLINE: every store is closed by `closeStores()` in `afterAll`.
 */

import { afterAll, describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { closeStores, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { commitExpansionRequest } from "./expansion-request-commit.js";
import type { ExpansionRequestCommitInput } from "./expansion-request-commit.js";
import { readCurrentExpansionRequest } from "./expansion-request-ledger.js";
import {
  EXPANSION_HOLD_EVENT_TYPE,
  EXPANSION_RUN_EVENT_TYPE,
  expansionHoldAggregateId,
} from "./expansion-request-records.js";
import {
  FIXTURE_GOAL_REF,
  FIXTURE_PROJECT_ID,
  holdCommandOf,
  holdStateOf,
  runRecordOf,
} from "./expansion-request-test-fixtures.js";

const encoder = new TextEncoder();

function inputOf(commandId = "cmd-expansion-1", holdId = "hold-1"): ExpansionRequestCommitInput {
  const hold = holdStateOf(holdCommandOf({ commandId, holdId }));
  return {
    envelope: {
      commandId,
      correlationId: `corr-${commandId}`,
      decidedAt: "2026-08-26T00:00:00.000Z",
      payload: {},
      principalId: "principal-1",
      projectId: FIXTURE_PROJECT_ID,
    },
    goalRef: FIXTURE_GOAL_REF,
    goalVersion: 0,
    hold,
    holdAggregateId: expansionHoldAggregateId(FIXTURE_PROJECT_ID, hold.holdId),
    requestBytes: encoder.encode(`request:${commandId}`),
    run: runRecordOf(hold),
  };
}

function counts(store: SqliteEventStore, input: ExpansionRequestCommitInput) {
  const holdEvents = store.readEvents(input.holdAggregateId);
  const runEvents = store.readEvents(input.run.state.runId);
  return {
    holdEvents: holdEvents.filter((e) => e.eventType === EXPANSION_HOLD_EVENT_TYPE).length,
    holdVersion: store.getAggregateVersion(input.holdAggregateId),
    runEvents: runEvents.filter((e) => e.eventType === EXPANSION_RUN_EVENT_TYPE).length,
    runVersion: store.getAggregateVersion(input.run.state.runId),
  };
}

/** Occupies an aggregate so the writer's `expectedVersion: 0` fence must fail on that leg. */
function occupy(store: SqliteEventStore, aggregateId: string): void {
  const payload = encoder.encode("occupied");
  store.commitExpectedVersionDecision({
    commandKind: "test.occupy",
    committedResultBytes: payload,
    correlationId: `occupy-${aggregateId}`,
    decidedAt: "2026-08-26T00:00:00.000Z",
    events: [{ eventId: `occupy:${aggregateId}`, eventType: "TestOccupied", payload }],
    expectedVersion: 0,
    key: {
      commandId: `occupy-${aggregateId}`,
      principalId: "principal-1",
      projectId: FIXTURE_PROJECT_ID,
    },
    requestBytes: payload,
    targetAggregateId: aggregateId,
  });
}

function refusalOf(value: unknown): Record<string, unknown> {
  const refusal = value as Record<string, unknown>;
  expect(refusal["ok"]).toBe(false);
  return refusal;
}

afterAll(() => {
  closeStores();
});

describe("commitExpansionRequest success (task-738a12a816e8421a96edd84648565a38)", () => {
  it("advances both aggregates exactly once inside one decision", () => {
    const store = openStore();
    const input = inputOf();
    const before = counts(store, input);
    expect(before).toStrictEqual({
      holdEvents: 0, holdVersion: 0, runEvents: 0, runVersion: 0,
    });
    expect(store.getAggregateVersion(input.goalRef)).toBe(input.goalVersion);
    const result = commitExpansionRequest(store, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.disposition).toBe("DECIDED");
    expect(result.decision.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
    expect(counts(store, input)).toStrictEqual({
      holdEvents: 1, holdVersion: 1, runEvents: 1, runVersion: 1,
    });
    expect(store.getAggregateVersion(input.goalRef)).toBe(input.goalVersion);
  });

  it("writes a pair the strict reader selects", () => {
    const store = openStore();
    const input = inputOf();
    expect(commitExpansionRequest(store, input).ok).toBe(true);
    const found = readCurrentExpansionRequest(store, {
      generation: input.hold.generation,
      goalRef: FIXTURE_GOAL_REF,
      graphEpoch: input.hold.graphEpoch,
      holdVersion: input.hold.version,
      parentNodeRef: input.hold.parentNodeRef,
      parentRunRef: input.hold.parentRunRef,
      planningRunRef: input.hold.planningRunRef,
      projectId: FIXTURE_PROJECT_ID,
    });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.pair.hold.holdId).toBe(input.hold.holdId);
    expect(found.pair.run.runId).toBe(input.run.state.runId);
  });

  it("answers an identical replay without writing anything more", () => {
    const store = openStore();
    const input = inputOf();
    expect(commitExpansionRequest(store, input).ok).toBe(true);
    const after = counts(store, input);
    const decisionsBefore = store.readCommandDecisionsAfter(0n, 200).items.length;

    const replay = commitExpansionRequest(store, input);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.disposition).toBe("REPLAYED");
    expect(counts(store, input)).toStrictEqual(after);
    expect(store.readCommandDecisionsAfter(0n, 200).items.length).toBe(decisionsBefore);
  });
});

describe("commitExpansionRequest refusals (task-738a12a816e8421a96edd84648565a38)", () => {
  it("refuses the same command id with different bytes and writes neither leg again", () => {
    const store = openStore();
    const input = inputOf();
    expect(commitExpansionRequest(store, input).ok).toBe(true);
    const after = counts(store, input);

    const refusal = refusalOf(commitExpansionRequest(store, {
      ...input, requestBytes: encoder.encode("a different request"),
    }));
    expect(refusal["code"]).toBe("EXPANSION_REQUEST_LEDGER_IDEMPOTENCY_CONFLICT");
    expect(refusal["layer"]).toBe("LEDGER");
    expect(refusal["sourceCode"]).toBe("IDEMPOTENCY_CONFLICT");
    expect(refusal["sourceLayer"]).toBe("DURABLE_STORE");
    expect(counts(store, input)).toStrictEqual(after);
  });

  it("leaves the HOLD leg untouched when the RUN leg is fenced", () => {
    const store = openStore();
    const input = inputOf();
    occupy(store, input.run.state.runId);
    const refusal = refusalOf(commitExpansionRequest(store, input));
    expect(refusal["code"]).toBe("EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT");
    expect(refusal["layer"]).toBe("LEDGER");
    // The primary leg is the one atomicity is easiest to lose: assert it, not the refusal.
    expect(counts(store, input)).toStrictEqual({
      holdEvents: 0, holdVersion: 0, runEvents: 0, runVersion: 1,
    });
  });

  it("leaves the RUN leg untouched when the HOLD leg is fenced", () => {
    const store = openStore();
    const input = inputOf();
    occupy(store, input.holdAggregateId);
    const refusal = refusalOf(commitExpansionRequest(store, input));
    expect(refusal["code"]).toBe("EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT");
    expect(refusal["layer"]).toBe("LEDGER");
    expect(counts(store, input)).toStrictEqual({
      holdEvents: 0, holdVersion: 1, runEvents: 0, runVersion: 0,
    });
  });

  it("writes neither append leg when the observed goal version has moved", () => {
    const store = openStore();
    const input = inputOf();
    expect(store.getAggregateVersion(FIXTURE_GOAL_REF)).toBe(0);
    occupy(store, FIXTURE_GOAL_REF);

    const refusal = refusalOf(commitExpansionRequest(store, input));
    expect(refusal["code"]).toBe("EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT");
    expect(refusal["layer"]).toBe("LEDGER");
    expect(refusal["sourceCode"]).toBe("EXPECTED_VERSION_CONFLICT");
    expect(refusal["sourceLayer"]).toBe("DURABLE_STORE");
    expect(store.getAggregateVersion(FIXTURE_GOAL_REF)).toBe(1);
    expect(counts(store, input)).toStrictEqual({
      holdEvents: 0, holdVersion: 0, runEvents: 0, runVersion: 0,
    });
  });

  it("refuses a goal fence that aliases an append aggregate", () => {
    const store = openStore();
    const input = inputOf();
    const refusal = refusalOf(commitExpansionRequest(store, {
      ...input, goalRef: input.holdAggregateId,
    }));
    expect(refusal["code"]).toBe("EXPANSION_REQUEST_LEDGER_UNAVAILABLE");
    expect(refusal["layer"]).toBe("LEDGER");
    expect(refusal["sourceCode"]).toBe("STORE_INPUT_INVALID");
    expect(refusal["sourceLayer"]).toBe("DURABLE_STORE");
    expect(counts(store, input)).toStrictEqual({
      holdEvents: 0, holdVersion: 0, runEvents: 0, runVersion: 0,
    });
  });

  it("binds the goal fence identity into replay", () => {
    const store = openStore();
    const input = inputOf();
    expect(commitExpansionRequest(store, input).ok).toBe(true);
    const after = counts(store, input);
    const refusal = refusalOf(commitExpansionRequest(store, {
      ...input, goalRef: "goal-other",
    }));
    expect(refusal["code"]).toBe("EXPANSION_REQUEST_LEDGER_IDEMPOTENCY_CONFLICT");
    expect(refusal["layer"]).toBe("LEDGER");
    expect(refusal["sourceCode"]).toBe("IDEMPOTENCY_CONFLICT");
    expect(refusal["sourceLayer"]).toBe("DURABLE_STORE");
    expect(counts(store, input)).toStrictEqual(after);
    expect(store.getAggregateVersion("goal-other")).toBe(0);
  });

  it("refuses a second distinct request for the same hold and run, writing nothing", () => {
    const store = openStore();
    const first = inputOf("cmd-first");
    expect(commitExpansionRequest(store, first).ok).toBe(true);
    const after = counts(store, first);

    const second = inputOf("cmd-second");
    const refusal = refusalOf(commitExpansionRequest(store, second));
    expect(refusal["code"]).toBe("EXPANSION_REQUEST_LEDGER_VERSION_CONFLICT");
    expect(refusal["layer"]).toBe("LEDGER");
    expect(counts(store, first)).toStrictEqual(after);
  });

  it("reports a store input fault as unavailable, carrying the store's own code", () => {
    const store = openStore();
    const input = inputOf();
    const refusal = refusalOf(commitExpansionRequest(store, {
      ...input, holdAggregateId: `${input.holdAggregateId}${String.fromCharCode(0)}x`,
    }));
    expect(refusal["code"]).toBe("EXPANSION_REQUEST_LEDGER_UNAVAILABLE");
    expect(refusal["layer"]).toBe("LEDGER");
    expect(refusal["sourceCode"]).toBe("STORE_INPUT_INVALID");
    expect(refusal["sourceLayer"]).toBe("DURABLE_STORE");
    expect(counts(store, input)).toStrictEqual({
      holdEvents: 0, holdVersion: 0, runEvents: 0, runVersion: 0,
    });
  });
});
