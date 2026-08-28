import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { hex64 } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  activeGraphSlotAggregateId,
  buildActiveGraphSlotLeg,
  observeActiveGraphSlot,
} from "./active-graph-slot.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import {
  PROJECT_ID,
  GOAL_ID,
  RUN_ID,
  SECOND_GOAL_ID,
  SECOND_GRAPH_CONTENT_HASH,
  SECOND_GRAPH_REVISION_REF,
  SECOND_RUN_ID,
  SECOND_SUBMISSION_HASH,
  approvableStoreWithTwoGoals,
  closeStores,
  commitSeamFacade,
  contextFor,
  inputFor,
  inputForSecondGoal,
  openEmptyFileStore,
  requestFor,
  twoHandles,
} from "./graph-activation-test-fixtures.js";
import { activateApprovedGraph } from "./graph-activation-service.js";
import { buildGraphRevisionActivationLeg } from "./graph-revision-activation-leg.js";
import { supersedeActiveGraph } from "./graph-supersede-service.js";
import {
  SUCCESSOR_REVISION_REF,
  prepareSupersession,
  supersedeContext,
  supersedeInput,
} from "./graph-supersede-test-fixtures.js";

const encoder = new TextEncoder();

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && !Array.isArray(value)
    && typeof value === "object";
}

function runState(store: SqliteEventStore, runId: string): JsonObject {
  const value: JsonValue | undefined = stateOf(readDurableLedger(store, PROJECT_ID), runId);
  if (!isJsonObject(value)) throw new Error(`fixture run ${runId} is not an object`);
  const state = value["state"];
  if (!isJsonObject(state)) throw new Error(`fixture run ${runId} has no state object`);
  return state;
}

afterEach(closeStores);

function advanceSlot(store: SqliteEventStore, sequence: number): void {
  const commandId = `cmd-slot-seed-${sequence}`;
  const observed = observeActiveGraphSlot(store, PROJECT_ID);
  const response = store.commitExpectedVersionDecisionLegs({
    commandKind: "test.active_graph_slot_seed",
    committedResultBytes: encoder.encode("{}"),
    correlationId: `corr-slot-seed-${sequence}`,
    decidedAt: `2026-08-08T00:00:0${sequence}.000Z`,
    key: { commandId, principalId: "principal-1", projectId: PROJECT_ID },
    legs: [buildActiveGraphSlotLeg({
      commandId, graphEpoch: sequence, observed, projectId: PROJECT_ID,
      reason: "ACTIVATE", revisionId: `seeded-revision-${sequence}`,
    })],
    requestBytes: encoder.encode(JSON.stringify({ sequence })),
  });
  expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

type CommitLegs = SqliteEventStore["commitExpectedVersionDecisionLegs"];

/** Simulates a pre-slot activation while still driving the production activation service. */
function legacyActivationFacade(handle: SqliteEventStore): SqliteEventStore {
  const slotId = activeGraphSlotAggregateId(PROJECT_ID);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "commitExpectedVersionDecisionLegs") {
        const withoutSlot: CommitLegs = (input) => target.commitExpectedVersionDecisionLegs({
          ...input, legs: input.legs.filter((leg) => leg.aggregateId !== slotId),
        });
        return withoutSlot;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("task-37c56d29 active-graph slot fixture", () => {
  it("builds two sealed review runs before either graph is active", () => {
    const store = approvableStoreWithTwoGoals();
    const first = runState(store, RUN_ID);
    const second = runState(store, SECOND_RUN_ID);

    expect([first["lifecycle"], second["lifecycle"]])
      .toStrictEqual(["PLAN_REVIEW", "PLAN_REVIEW"]);
    expect(second["graphRevisionRef"]).toBe(SECOND_GRAPH_REVISION_REF);
    expect(second["submissionHash"]).toBe(SECOND_SUBMISSION_HASH);
    expect(second["sealedHashes"]).toMatchObject({
      graphContentHash: SECOND_GRAPH_CONTENT_HASH,
      planHash: SECOND_SUBMISSION_HASH,
    });
    expect(readCurrentActiveGraph(store, PROJECT_ID)).toMatchObject({
      code: "ACTIVE_GRAPH_ABSENT", layer: "ACTIVE_GRAPH_PROJECTION", ok: false,
    });
  });
});

describe("task-37c56d29 project-wide activation serialization", () => {
  it("rejects the activation whose observed project slot became stale", () => {
    const seeded = approvableStoreWithTwoGoals();
    const { a, b } = twoHandles(seeded);
    const horizonBefore = a.readEventHorizon();
    let horizonAfterWinner = 0n;
    const loserRequest = requestFor("cmd-slot-loser");
    let winnerOk = false;
    const facade = commitSeamFacade(a, () => {
      const winner = activateApprovedGraph(
        contextFor(b, requestFor("cmd-slot-winner")), inputForSecondGoal(b),
      );
      winnerOk = winner.ok;
      horizonAfterWinner = b.readEventHorizon();
    });

    const loser = activateApprovedGraph(contextFor(facade, loserRequest), inputFor(a));
    const active = readCurrentActiveGraph(a, PROJECT_ID);
    expect(winnerOk).toBe(true);
    expect(active).not.toMatchObject({
      code: "ACTIVE_GRAPH_SPLIT_BRAIN", layer: "ACTIVE_GRAPH_PROJECTION", ok: false,
    });
    expect(horizonAfterWinner - horizonBefore).toBe(7n);
    // The loser adds only the store-owned rejection audit event; no business leg survives.
    expect(a.readEventHorizon() - horizonAfterWinner).toBe(1n);

    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("stale activation unexpectedly committed");
    expect({ code: loser.code, refusedBy: loser.refusedBy }).toStrictEqual({
      code: "EXPECTED_VERSION_CONFLICT", refusedBy: "DURABLE_STORE",
    });
    const decision = a.getCommandDecision({
      commandId: loserRequest.commandId,
      principalId: loserRequest.principalId,
      projectId: loserRequest.projectId,
    });
    expect(decision?.targetAggregateId).toBe(`active-graph-slot:${PROJECT_ID}`);
    expect(decision).toMatchObject({ expectedVersion: 0, observedVersion: 1 });
    expect(a.readEvents(GOAL_ID).filter((event) => event.eventType === "GoalExecutionEnabled"))
      .toHaveLength(0);
    expect(a.getAggregateVersion(`graph-revision:${PROJECT_ID}:graph-revision-1`)).toBe(0);
    expect(a.readEvents(SECOND_GOAL_ID).filter((event) => event.eventType === "GoalExecutionEnabled"))
      .toHaveLength(1);
    expect(active).toMatchObject({ ok: true, revisionId: SECOND_GRAPH_REVISION_REF });
  });

  it("observes and advances a slot whose version is already greater than zero", () => {
    const store = approvableStoreWithTwoGoals();
    advanceSlot(store, 1);
    advanceSlot(store, 2);
    const before = observeActiveGraphSlot(store, PROJECT_ID);

    const outcome = activateApprovedGraph(
      contextFor(store, requestFor("cmd-slot-second-lifetime")), inputForSecondGoal(store),
    );

    expect(outcome.ok).toBe(true);
    expect(before.version).toBe(2);
    expect(observeActiveGraphSlot(store, PROJECT_ID)).toStrictEqual({
      aggregateId: before.aggregateId, version: before.version + 1,
    });
  });

  it("keeps the slot outside graph-revision and internal aggregate namespaces", () => {
    const store = openEmptyFileStore();
    const slotId = activeGraphSlotAggregateId(PROJECT_ID);
    advanceSlot(store, 1);

    const active = readCurrentActiveGraph(store, PROJECT_ID);
    const built = buildGraphRevisionActivationLeg({
      actorKind: "HUMAN", approvalRef: "approval-slot-only",
      binding: {
        budgetHash: hex64("b1"), expectedGoalVersion: 1, graphHash: hex64("b2"),
        policyHash: hex64("b3"), qualityHash: hex64("b4"),
      },
      commandId: "cmd-slot-only", goalRef: "goal-slot-only", planHash: hex64("b5"),
      projectId: PROJECT_ID, revisionId: "graph-slot-only", store,
      submissionRef: hex64("b6"),
    });
    expect.soft(active).toMatchObject({
      code: "ACTIVE_GRAPH_ABSENT", layer: "ACTIVE_GRAPH_PROJECTION", ok: false,
    });
    expect.soft(built).toMatchObject({ ok: true });
    expect.soft(slotId.startsWith(`graph-revision:${PROJECT_ID}:`)).toBe(false);
    expect.soft(slotId.startsWith("moe-internal:")).toBe(false);
  });

  it("serializes an initial activation against a concurrent supersession", () => {
    const seeded = approvableStoreWithTwoGoals();
    const { a, b } = twoHandles(seeded);
    const activationRequest = requestFor("cmd-approve-after-supersede");
    let superseded = false;
    const facade = commitSeamFacade(a, () => {
      const legacy = activateApprovedGraph(
        contextFor(legacyActivationFacade(b), requestFor("cmd-legacy-active")), inputFor(b),
      );
      if (!legacy.ok) throw new Error(`legacy activation refused: ${legacy.code}`);
      prepareSupersession(b);
      const outcome = supersedeActiveGraph(
        supersedeContext(b, "cmd-cross-supersede"), supersedeInput(),
      );
      superseded = outcome.ok;
    });

    const loser = activateApprovedGraph(
      contextFor(facade, activationRequest), inputForSecondGoal(a),
    );
    const active = readCurrentActiveGraph(a, PROJECT_ID);

    expect(superseded).toBe(true);
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("initial activation survived the supersession");
    expect({ code: loser.code, refusedBy: loser.refusedBy }).toStrictEqual({
      code: "EXPECTED_VERSION_CONFLICT", refusedBy: "DURABLE_STORE",
    });
    expect(a.getCommandDecision({
      commandId: activationRequest.commandId,
      principalId: activationRequest.principalId,
      projectId: activationRequest.projectId,
    })?.targetAggregateId).toBe(activeGraphSlotAggregateId(PROJECT_ID));
    expect(active).toMatchObject({
      graphEpoch: 2, ok: true, revisionId: SUCCESSOR_REVISION_REF,
    });
  });

  it("preserves a stale slot as the supersession refusal source", () => {
    const seeded = approvableStoreWithTwoGoals();
    const activated = activateApprovedGraph(
      contextFor(seeded, requestFor("cmd-stale-slot-active")), inputFor(seeded),
    );
    if (!activated.ok) throw new Error(`fixture activation refused: ${activated.code}`);
    prepareSupersession(seeded);
    const { a, b } = twoHandles(seeded);
    const commandId = "cmd-stale-slot-supersede";
    const facade = commitSeamFacade(a, () => advanceSlot(b, 2));

    const outcome = supersedeActiveGraph(
      supersedeContext(facade, commandId), supersedeInput(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("stale-slot supersession unexpectedly committed");
    expect(outcome).toMatchObject({
      code: "GRAPH_SUPERSEDE_CONCURRENT_ACTIVATION",
      refusedBy: "DURABLE_STORE",
      sourceCode: "EXPECTED_VERSION_CONFLICT",
      sourceLayer: "DURABLE_STORE",
    });
    expect(a.getCommandDecision({
      commandId, principalId: "principal-1", projectId: PROJECT_ID,
    })).toMatchObject({
      expectedVersion: 1,
      observedVersion: 2,
      targetAggregateId: activeGraphSlotAggregateId(PROJECT_ID),
    });
  });
});
