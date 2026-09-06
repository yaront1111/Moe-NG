import { afterEach, expect, it, vi } from "vitest";
import type { SqliteEventStore } from "@moe/store";
import { closeStores, GOAL_ID, PROJECT_ID, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { criterionWorld } from "../criterion-evidence/criterion-test-fixtures.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { compiledContractAggregateId } from "../planning/compiled-contract-binding.js";
import { approveNodes, seedReviewAcceptance } from "./goal-closure-test-fixtures.js";
import { readApprovedNodeScope } from "./goal-close-prerequisite.js";
import { qualifyGoalClosure } from "./goal-qualification.js";
import * as qualificationReads from "./goal-qualification-reads.js";
import { readApprovedExecutionScope } from "./goal-approved-execution-scope.js";

afterEach(() => { vi.restoreAllMocks(); closeStores(); });
function hostileRead(store: SqliteEventStore, overrides: Partial<Pick<SqliteEventStore, "readEvents" | "readAggregateEvents" | "getAggregateVersion">>): SqliteEventStore {
  return new Proxy({} as SqliteEventStore, { get: (_target, property) => {
    const value = Reflect.get(overrides, property) ?? Reflect.get(store, property, store);
    return typeof value === "function" ? value.bind(store) : value;
  } });
}

it("qualifies the approved compiled execution while preserving local keys on its durable approval", () => {
  const { store } = criterionWorld(); const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
  const ref = compiledExecutionRef(PROJECT_ID, graph, "node-slice");
  expect(readApprovedNodeScope(store, GOAL_ID)?.scope).toEqual(["node-slice"]);
  seedReviewAcceptance(store, ref);
  expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: true, legs: { [ref]: "LIVE" } });
});

it("inherits neither a raw-key acceptance nor a different goal's acceptance for the same local key", () => {
  const { store } = criterionWorld(); const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
  seedReviewAcceptance(store, "node-slice");
  const foreign = compiledExecutionRef(PROJECT_ID, { ...graph, goalRef: "goal-unrelated" }, "node-slice");
  seedReviewAcceptance(store, foreign);
  expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: false,
    code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED", message: "no durable review acceptance names this approved node" });
  const ref = compiledExecutionRef(PROJECT_ID, graph, "node-slice");
  expect(ref).not.toBe(foreign);
  seedReviewAcceptance(store, ref);
  expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: true, legs: { [ref]: "LIVE" } });
});

it("refuses malformed compiled binding instead of falling back to an accepted raw key", () => {
  const { store } = criterionWorld(); const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
  seedReviewAcceptance(store, "node-slice");
  const target = compiledContractAggregateId(PROJECT_ID, graph.planningRunRef!);
  const original = store.readAggregateEvents.bind(store);
  const hostile = hostileRead(store, { readAggregateEvents: (aggregate, from, limit) => {
    const page = original(aggregate, from, limit);
    return aggregate !== target ? page : { ...page, items: page.items.map((event) => ({ ...event, payload: new TextEncoder().encode("{}") })) };
  } });
  expect(qualifyGoalClosure(hostile, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: false, code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED" });
});

it("refuses an approved scope that omits an execution-bearing graph node", () => {
  const { store } = criterionWorld(); seedReviewAcceptance(store, "unrelated-local-key");
  const original = store.readEvents.bind(store);
  const hostile = hostileRead(store, { readEvents: (aggregate) => original(aggregate).map((event) => {
    if (aggregate !== GOAL_ID || event.eventType !== "GoalExecutionEnabled") return event;
    const payload = JSON.parse(Buffer.from(event.payload).toString("utf8"));
    payload.approval.approvedNodeScope = ["unrelated-local-key"];
    return { ...event, payload: new TextEncoder().encode(JSON.stringify(payload)) };
  }) });
  expect(qualifyGoalClosure(hostile, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: false, code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED" });
});

it("refuses legacy LIVE evidence when no Foundation receipt proves the approved subject", () => {
  const store = openStore(); approveNodes(store, ["node-1"]); seedReviewAcceptance(store, "node-1");
  expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: false,
    code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED", message: "no Foundation receipt proves the legacy approved node" });
});

it("refuses missing compiled graph provenance instead of using a raw-key acceptance", () => {
  const { store } = criterionWorld(); seedReviewAcceptance(store, "node-slice");
  const original = store.readEvents.bind(store);
  const hostile = hostileRead(store, { readEvents: (aggregate) => aggregate.startsWith("graph-body:") ? [] : original(aggregate) });
  expect(qualifyGoalClosure(hostile, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: false, code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED" });
});

it("does not classify a source-bound historical compiler run as legacy when the new binding is absent", () => {
  const { store } = criterionWorld(); const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
  seedReviewAcceptance(store, "node-slice");
  const target = compiledContractAggregateId(PROJECT_ID, graph.planningRunRef!);
  const original = store.readAggregateEvents.bind(store);
  const hostile = hostileRead(store, {
    getAggregateVersion: (aggregate) => aggregate === target ? 0 : store.getAggregateVersion(aggregate),
    readAggregateEvents: (aggregate, from, limit) => {
      const page = original(aggregate, from, limit);
      return aggregate === target ? { ...page, items: [], hasMore: false } : page;
    },
  });
  expect(qualifyGoalClosure(hostile, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: false,
    code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED", message: "no current approval names an approved node scope" });
});

it("does not hide a legacy activation for the local key when scoped review evidence is used", () => {
  const { store } = criterionWorld(); const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
  seedReviewAcceptance(store, compiledExecutionRef(PROJECT_ID, graph, "node-slice"));
  // Hostile durable-reader input: an older authority account is still active under the raw key.
  vi.spyOn(qualificationReads, "accountDurableActivations").mockReturnValue([{ aggregateId: "old-attempt",
    nodeKey: "node-slice", readsBackAs: { effectIdentity: "old-effect", leaseIdentity: "old-lease" } }]);
  expect(qualifyGoalClosure(store, PROJECT_ID, GOAL_ID)).toMatchObject({ ok: false,
    code: "GOAL_CLOSE_AUTHORITY_REMAINS", message: "a legacy activation ambiguously names a compiled node" });
});

it.each(["payload", "eventType"])("does not classify a malformed GoalCreated %s as explicit legacy provenance", (field) => {
  const store = openStore(); approveNodes(store, ["node-1"]);
  const original = store.readAggregateEvents.bind(store);
  const hostile = hostileRead(store, { readAggregateEvents: (aggregate, from, limit) => {
    const page = original(aggregate, from, limit);
    return aggregate !== GOAL_ID ? page : { ...page, items: page.items.map((event) => event.aggregateSequence !== 1
      ? event : field === "payload" ? { ...event, payload: new TextEncoder().encode("{}") }
        : { ...event, eventType: "UnrelatedEvent" }) };
  } });
  expect(readApprovedExecutionScope(hostile, PROJECT_ID, GOAL_ID)).toBeNull();
});
