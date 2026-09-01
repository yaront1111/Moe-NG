/**
 * Production-edge proof that a graph.supersede approval authorizes one durable successor only.
 * Every hostile PENDING input changes one binding field; the edge has the core decide it before
 * the service matcher evaluates the resulting record.
 */
import { afterEach, describe, expect, it } from "vitest";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import { replayGraphRevisionEvents } from "@moe/core";
import type { ApprovalDecisionRecord } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { budgetCommitmentDigest, budgetCommitmentMaterialForActiveGraph }
  from "../budget/budget-commitment.js";
import { POLICY_REF, approvalCommand } from "../bootstrap/bootstrap-test-fixtures.js";
import { readPolicyEvaluationAuthority } from
  "../bootstrap/bootstrap-policy-authority-reader.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
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
import { readSupersessionPolicyDecision } from "./supersession-policy-decision.js";
import type { SupersessionPolicyDecision } from "./supersession-policy-decision.js";

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
    mutate: (record) => ({ ...record,
      policyDecisionRef: different(record.policyDecisionRef ?? "") }) },
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

/** The predecessor's persisted activation ROOT digest: what :73 compared against before. */
function retiredBudgetNotion(store: SqliteEventStore): string {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`fixture has no active predecessor: ${active.code}`);
  const replayed = replayGraphRevisionEvents(
    store.readEvents(graphRevisionAggregateId(PROJECT_ID, active.revisionId)).map((event) => {
      const decoded = decodeBoundedJsonBytes(event.payload);
      return decoded.ok ? (decoded.value as JsonValue) : null;
    }),
  );
  if (!replayed.ok || replayed.state.boundHashes === null) {
    throw new Error("fixture predecessor carries no bound hashes");
  }
  return replayed.state.boundHashes.budgetHash;
}

function activeSnapshot(store: SqliteEventStore): Readonly<{ epoch: number; revision: string }> {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`fixture active graph unreadable: ${active.code}`);
  return Object.freeze({ epoch: active.graphEpoch, revision: active.revisionId });
}

function supersessionPolicyAuthority(store: SqliteEventStore): SupersessionPolicyDecision {
  const authority = readSupersessionPolicyDecision(store, PROJECT_ID, SUCCESSOR_REVISION_REF);
  if (!authority.ok) throw new Error(`${authority.code}/${authority.layer}`);
  return authority;
}

function durableSupersessionDigest(store: SqliteEventStore): string {
  const events = store.readEvents(policyAggregateId(PROJECT_ID));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.eventType !== "PolicyEvaluated") continue;
    const decoded = decodeBoundedJsonBytes(event.payload);
    const value: JsonValue | undefined = decoded.ok ? decoded.value : undefined;
    if (value === null || value === undefined || typeof value !== "object"
      || Array.isArray(value)) continue;
    const authority = readPolicyEvaluationAuthority(
      value, PROJECT_ID, Date.parse(event.committedAt),
    );
    if (authority.ok
      && authority.action === "graph.supersede"
      && authority.graphNodeRevisionRefs.length === 1
      && authority.graphNodeRevisionRefs[0] === SUCCESSOR_REVISION_REF
      && authority.scope.length === 1
      && authority.scope[0] === "node-b"
      && authority.policyRef === POLICY_REF
      && authority.principalId === PRINCIPAL) {
      return authority.decisionDigest;
    }
  }
  throw new Error("fixture has no strict durable graph.supersede policy digest");
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

  it("seals the supersession policy subject through the production policy command", () => {
    const authority = supersessionPolicyAuthority(supersedableStore());
    expect(authority.scope).toEqual(["node-b"]);
    expect(authority.principalId).toBe(PRINCIPAL);
    expect(authority.decisionDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the digest read from the durable supersession policy decision", () => {
    const store = supersedableStore();
    const authority = supersessionPolicyAuthority(store);
    const record = {
      ...successorBoundApprovalInput(store),
      policyDecisionRef: authority.decisionDigest,
    };
    const result = runGraphEdge(edgeFor(
      store, "cmd-bound-policy-decision", payloadFor(store, record),
    ));
    expect(result.disposition).toBe("DECIDED");
  });

  it("refuses a null policy decision at the graph supersede matcher", () => {
    const store = supersedableStore();
    const record = { ...successorBoundApprovalInput(store), policyDecisionRef: null };
    const refusal = refusalOf(() => runGraphEdge(edgeFor(
      store, "cmd-bound-policy-null", payloadFor(store, record),
    )));
    expect(refusal.code).toBe("GRAPH_SUPERSEDE_APPROVAL_POLICY_DECISION_MISMATCH");
    expect(refusal.layer).toBe("GRAPH_SUPERSEDE");
    expect(refusal.detail).toBe("GRAPH_SUPERSEDE_SERVICE");
  });

  // task-be80cb74. `budgetRef` on an approval record is a decide-time COMMITMENT since
  // task-61a2e8ad, not the activation root digest the predecessor's binding persists. The two
  // are deliberately non-aliasing -- budgetCommitmentDigest is domain-tagged so it can never
  // collide with the root -- so a supersede matcher comparing the record against
  // boundHashes.budgetHash refuses every honest commitment-carrying successor.
  it("admits a successor approval whose budgetRef is the durable commitment", () => {
    const store = supersedableStore();
    const material = budgetCommitmentMaterialForActiveGraph(
      store, { goalRef: GOAL_ID, projectId: PROJECT_ID },
    );
    if (!material.ok) throw new Error(`fixture commitment unavailable: ${material.code}`);
    const commitment = budgetCommitmentDigest(material.material);
    const bound = successorBoundApprovalInput(store);
    expect(bound.budgetRef).toBe(commitment);
    // NOT A FIXED POINT. The fixture now mints the commitment too, so comparing the arm against
    // the fixture would assert nothing. The guard is against the RETIRED notion instead -- the
    // predecessor's persisted activation ROOT digest -- read here through the same production
    // replay the matcher used to compare against. The two digests are domain-separated, and if
    // they ever aliased this whole arm would be vacuous.
    expect(commitment).not.toBe(retiredBudgetNotion(store));
    const result = runGraphEdge(edgeFor(
      store, "cmd-bound-commitment", payloadFor(store, { ...bound, budgetRef: commitment }),
    ));
    expect(result.disposition).toBe("DECIDED");
  });

  it("accepts the successor-bound record once and replays identical bytes without residue", () => {
    const store = supersedableStore();
    const record = successorBoundApprovalInput(store);
    expect(record.policyDecisionRef).toBe(durableSupersessionDigest(store));
    const payload = payloadFor(store, record);
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
