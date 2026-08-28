/**
 * Production-edge proof that a graph.supersede approval authorizes one durable successor only.
 * Every hostile PENDING input changes one binding field; the edge has the core decide it before
 * the service matcher evaluates the resulting record.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "@moe/contracts";
import type { ApprovalDecisionRecord } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { approvalCommand } from "../bootstrap/bootstrap-test-fixtures.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { runGraphEdge } from "../daemon-command-graph-edges.js";
import type { GraphEdgeContext } from "../daemon-command-graph-edges.js";
import { graphRevisionAggregateId, readCurrentActiveGraph }
  from "./active-graph-projection.js";
import { activeGraphSlotAggregateId, observeActiveGraphSlot } from "./active-graph-slot.js";
import { closeStores } from "./graph-activation-test-fixtures.js";
import type { GraphSupersedeCode } from "./graph-supersede-contracts.js";
import {
  GOAL_ID, GRAPH_REVISION_REF, PROJECT_ID, SUCCESSOR_GRAPH_CONTENT_HASH,
  SUCCESSOR_REVISION_REF, currentPreparationFence, successorBoundApprovalInput,
  supersedableStore,
} from "./graph-supersede-test-fixtures.js";
import {
  fundingAggregateId, planningFenceAggregateId, preparationAggregateId,
} from "./supersession-preparation-contracts.js";

const PRINCIPAL = "principal-1";
const DECIDED_AT = "2026-08-26T00:00:00.000Z";
const TRACKED_AGGREGATES = Object.freeze([
  GOAL_ID,
  graphRevisionAggregateId(PROJECT_ID, GRAPH_REVISION_REF),
  graphRevisionAggregateId(PROJECT_ID, SUCCESSOR_REVISION_REF),
  preparationAggregateId(PROJECT_ID, GOAL_ID),
  fundingAggregateId(PROJECT_ID, GOAL_ID),
  planningFenceAggregateId(PROJECT_ID, GOAL_ID),
  activeGraphSlotAggregateId(PROJECT_ID),
] as const);

type BoundField = keyof Pick<ApprovalDecisionRecord,
  "exactRevisionHash" | "approvedNodeScope" | "budgetRef" | "criteriaRef"
  | "planQualityAssessmentRef" | "applicablePolicyRef" | "policyDecisionRef">;

interface BindingCase {
  readonly code: GraphSupersedeCode;
  readonly field: BoundField;
  readonly mutate: (record: ApprovalDecisionRecord) => ApprovalDecisionRecord;
}

function different(value: string): string {
  if (value.length === 0) throw new Error("fixture binding must be non-empty");
  return `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;
}

const BINDING_CASES = Object.freeze([
  { field: "exactRevisionHash", code: "GRAPH_SUPERSEDE_APPROVAL_REVISION_MISMATCH",
    mutate: (record) => ({ ...record, exactRevisionHash: different(record.exactRevisionHash) }) },
  { field: "approvedNodeScope", code: "GRAPH_SUPERSEDE_APPROVAL_SCOPE_MISMATCH",
    mutate: (record) => ({ ...record, approvedNodeScope: [...record.approvedNodeScope, "node-x"] }) },
  { field: "budgetRef", code: "GRAPH_SUPERSEDE_APPROVAL_BUDGET_MISMATCH",
    mutate: (record) => ({ ...record, budgetRef: different(record.budgetRef) }) },
  { field: "criteriaRef", code: "GRAPH_SUPERSEDE_APPROVAL_CRITERIA_MISMATCH",
    mutate: (record) => ({ ...record, criteriaRef: different(record.criteriaRef) }) },
  { field: "planQualityAssessmentRef", code: "GRAPH_SUPERSEDE_APPROVAL_QUALITY_MISMATCH",
    mutate: (record) => ({ ...record,
      planQualityAssessmentRef: different(record.planQualityAssessmentRef) }) },
  { field: "applicablePolicyRef", code: "GRAPH_SUPERSEDE_APPROVAL_POLICY_MISMATCH",
    mutate: (record) => ({ ...record, applicablePolicyRef: different(record.applicablePolicyRef) }) },
  { field: "policyDecisionRef", code: "GRAPH_SUPERSEDE_APPROVAL_POLICY_DECISION_MISMATCH",
    mutate: (record) => ({ ...record, policyDecisionRef: "0".repeat(64) }) },
] satisfies readonly BindingCase[]);

afterEach(() => { closeStores(); });

function edgeFor(
  store: SqliteEventStore, commandId: string, payload: Record<string, unknown>,
): GraphEdgeContext {
  return {
    clock: () => DECIDED_AT,
    envelope: { commandId, correlationId: "corr-binding", expectedVersion: 0,
      payload: payload as JsonObject },
    humanReview: Object.freeze({ principalId: PRINCIPAL }),
    kind: "graph.supersede",
    principalId: PRINCIPAL,
    projectId: PROJECT_ID,
    store,
  };
}

function payloadFor(
  store: SqliteEventStore, record: unknown,
): Record<string, unknown> {
  const fence = currentPreparationFence(store);
  return {
    command: approvalCommand(),
    expectedPredecessorRevisionRef: GRAPH_REVISION_REF,
    expectedPreparationVersion: fence.expectedPreparationVersion,
    generation: fence.generation,
    goalRef: GOAL_ID,
    record,
    successorGraphContentHash: SUCCESSOR_GRAPH_CONTENT_HASH,
    successorRevisionRef: SUCCESSOR_REVISION_REF,
  };
}

function refusalOf(run: () => unknown): DomainRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
  throw new Error("expected the edge to refuse");
}

function decisionCount(store: SqliteEventStore): number {
  return store.readCommandDecisionsAfter(0n, 1_000).items.length;
}

function eventCounts(store: SqliteEventStore): readonly number[] {
  return TRACKED_AGGREGATES.map((aggregateId) => store.readEvents(aggregateId).length);
}

function activeSnapshot(store: SqliteEventStore): Readonly<{ epoch: number; revision: string }> {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`fixture active graph unreadable: ${active.code}`);
  return Object.freeze({ epoch: active.graphEpoch, revision: active.revisionId });
}

function changedKeys(
  before: ApprovalDecisionRecord, after: ApprovalDecisionRecord,
): readonly string[] {
  return (Object.keys(before) as Array<keyof ApprovalDecisionRecord>)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

describe("graph.supersede binds approval to the durable successor (task-b54b5609)", () => {
  it("enumerates all seven binding fields exactly once", () => {
    expect(BINDING_CASES).toHaveLength(7);
    expect(TRACKED_AGGREGATES).toHaveLength(7);
    expect(new Set(TRACKED_AGGREGATES).size).toBe(7);
    expect(BINDING_CASES.map(({ field }) => field)).toEqual([
      "exactRevisionHash", "approvedNodeScope", "budgetRef", "criteriaRef",
      "planQualityAssessmentRef", "applicablePolicyRef", "policyDecisionRef",
    ]);
    expect(new Set(BINDING_CASES.map(({ field }) => field)).size).toBe(7);
  });

  it("accepts the successor-bound record once and replays identical bytes without residue", () => {
    const store = supersedableStore();
    const payload = payloadFor(store, successorBoundApprovalInput(store));
    const before = decisionCount(store);

    const first = runGraphEdge(edgeFor(store, "cmd-bound-accepted", payload));
    expect(first.disposition).toBe("DECIDED");
    expect(decisionCount(store)).toBe(before + 1);
    const horizon = store.readEventHorizon();
    const events = eventCounts(store);
    const active = activeSnapshot(store);
    const slot = observeActiveGraphSlot(store, PROJECT_ID);

    const replay = runGraphEdge(edgeFor(store, "cmd-bound-accepted", payload));
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.effectId).toBe(first.effectId);
    expect(decisionCount(store)).toBe(before + 1);
    expect(store.readEventHorizon()).toBe(horizon);
    expect(eventCounts(store)).toEqual(events);
    expect(activeSnapshot(store)).toEqual(active);
    expect(observeActiveGraphSlot(store, PROJECT_ID)).toEqual(slot);
  });

  it.each(BINDING_CASES)("refuses a single-field $field mismatch without residue", (testCase) => {
    const store = supersedableStore();
    const bound = successorBoundApprovalInput(store);
    const hostile = testCase.mutate(bound);
    expect(changedKeys(bound, hostile)).toEqual([testCase.field]);
    const decisions = decisionCount(store);
    const horizon = store.readEventHorizon();
    const events = eventCounts(store);
    const fence = currentPreparationFence(store);
    const active = activeSnapshot(store);
    const slot = observeActiveGraphSlot(store, PROJECT_ID);

    const refusal = refusalOf(() => runGraphEdge(edgeFor(
      store, `cmd-bound-${testCase.field}`, payloadFor(store, hostile),
    )));

    expect(refusal.code).toBe(testCase.code);
    expect(refusal.layer).toBe("GRAPH_SUPERSEDE");
    expect(refusal.detail).toBe("GRAPH_SUPERSEDE_SERVICE");
    expect(decisionCount(store)).toBe(decisions);
    expect(store.readEventHorizon()).toBe(horizon);
    expect(eventCounts(store)).toEqual(events);
    expect(currentPreparationFence(store)).toEqual(fence);
    expect(activeSnapshot(store)).toEqual(active);
    expect(observeActiveGraphSlot(store, PROJECT_ID)).toEqual(slot);
  });

  it.each(["extra", "missing"] as const)(
    "refuses an approval record whose key roster is %s at the core boundary",
    (field) => {
      const store = supersedableStore();
      const bound = successorBoundApprovalInput(store);
      const record: unknown = field === "extra"
        ? { ...bound, unexpected: "smuggled" }
        : (({ exactRevisionHash: _omitted, ...missing }) => missing)(bound);
      const decisions = decisionCount(store);
      const horizon = store.readEventHorizon();
      const active = activeSnapshot(store);

      const refusal = refusalOf(() => runGraphEdge(edgeFor(
        store, `cmd-bound-${field}-key`, payloadFor(store, record),
      )));

      expect(refusal.code).toBe("INPUT_INVALID");
      expect(refusal.layer).toBe("CORE_REDUCER");
      expect(refusal.detail).toBe("DAEMON_GRAPH_INGRESS (INPUT_INVALID/CORE_REDUCER)");
      expect(decisionCount(store)).toBe(decisions);
      expect(store.readEventHorizon()).toBe(horizon);
      expect(activeSnapshot(store)).toEqual(active);
    },
  );
});
