/**
 * Production-edge proof that `graph.supersede` consults the BOARD APPROVAL POLICY and the
 * server-assembled human witness, exactly as `graph.approve` does (task-5b8a7966).
 *
 * Every arm drives the real `runGraphEdge` against a real `supersedableStore()` with the
 * successor-bound record `successorBoundApprovalInput` mints, so the authenticated-actor guard,
 * the core reducer, the APPROVE guard, task-b54b5609's seven-field matcher and every
 * `graph-supersede-service` fact fence would ALL accept. The only thing that varies is the
 * approval configuration and whether a witness is attached.
 *
 * DIVERGENCE (epic rail 7A). The two refusals below deliberately carry the SAME
 * `APPROVAL_HUMAN_REVIEW_REQUIRED` @ `APPROVAL_POLICY`, so the code alone cannot say which
 * mechanism answered. Each is therefore paired with an otherwise byte-identical arm that DECIDES,
 * varying one degree of freedom:
 *
 *   A (REQUIRE_HUMAN, no witness) refuses  <-> B (REQUIRE_HUMAN, witness) decides.
 *       Only the policy's want-of-human fence can refuse A; B proves the same record is otherwise
 *       valid and that the witness fall-through is what clears it.
 *   C (SPEED, delay 2000, no witness) refuses <-> D (SPEED, delay 0, no witness) decides.
 *       C reaches an OK PROCEED_WITHOUT_HUMAN policy result, so the policy fence CANNOT be what
 *       refuses it; only the non-IMMEDIATE delay fence can. D holds the configuration axis and
 *       moves only the delay.
 *
 * Loosening either fence alone therefore reddens a DIFFERENT arm, which is what step 4's
 * one-degree drills measure. The accepted arms B and D are the controls proving no downstream
 * fence is answering first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { approvalCommand } from "../bootstrap/bootstrap-test-fixtures.js";
import type { HumanReviewWitness } from "../bootstrap/bootstrap-ledger.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { runGraphEdge } from "../daemon-command-graph-edges.js";
import type { GraphEdgeContext } from "../daemon-command-graph-edges.js";
import { graphRevisionAggregateId } from "./active-graph-projection.js";
import { activeGraphSlotAggregateId } from "./active-graph-slot.js";
import { APPROVAL_MODE_ENV_KEY, SPEED_MODE_DELAY_ENV_KEY }
  from "./approval-policy-settings.js";
import { closeStores } from "./graph-activation-test-fixtures.js";
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
const OPERATOR_WITNESS: HumanReviewWitness = Object.freeze({ principalId: PRINCIPAL });

/** The policy's OWN code and layer, forwarded by the ingress rather than translated. */
const POLICY_CODE = "APPROVAL_HUMAN_REVIEW_REQUIRED";
const POLICY_LAYER = "APPROVAL_POLICY";
const INGRESS_DETAIL = `DAEMON_GRAPH_INGRESS (${POLICY_CODE}/${POLICY_LAYER})`;

const TRACKED_AGGREGATES = Object.freeze([
  GOAL_ID,
  graphRevisionAggregateId(PROJECT_ID, GRAPH_REVISION_REF),
  graphRevisionAggregateId(PROJECT_ID, SUCCESSOR_REVISION_REF),
  preparationAggregateId(PROJECT_ID, GOAL_ID),
  fundingAggregateId(PROJECT_ID, GOAL_ID),
  planningFenceAggregateId(PROJECT_ID, GOAL_ID),
  activeGraphSlotAggregateId(PROJECT_ID),
] as const);

afterEach(() => {
  closeStores();
  vi.unstubAllEnvs();
});

/** Both keys are stubbed on EVERY arm so no ambient board setting can decide an outcome. */
function stubApprovalPolicy(mode: string, delayMs: string): void {
  vi.stubEnv(APPROVAL_MODE_ENV_KEY, mode);
  vi.stubEnv(SPEED_MODE_DELAY_ENV_KEY, delayMs);
}

function edgeFor(
  store: SqliteEventStore, commandId: string, payload: Record<string, unknown>,
  humanReview: HumanReviewWitness | undefined,
): GraphEdgeContext {
  return {
    clock: () => DECIDED_AT,
    envelope: { commandId, correlationId: "corr-authority", expectedVersion: 0,
      payload: payload as JsonObject },
    humanReview,
    kind: "graph.supersede",
    principalId: PRINCIPAL,
    projectId: PROJECT_ID,
    store,
  };
}

function payloadFor(store: SqliteEventStore): Record<string, unknown> {
  const fence = currentPreparationFence(store);
  return {
    command: approvalCommand(),
    expectedPredecessorRevisionRef: GRAPH_REVISION_REF,
    expectedPreparationVersion: fence.expectedPreparationVersion,
    generation: fence.generation,
    goalRef: GOAL_ID,
    record: successorBoundApprovalInput(store),
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

interface Baseline {
  readonly decisions: number;
  readonly events: readonly number[];
  readonly horizon: bigint;
}

function baselineOf(store: SqliteEventStore): Baseline {
  return Object.freeze({
    decisions: decisionCount(store), events: eventCounts(store),
    horizon: store.readEventHorizon(),
  });
}

function expectUnchanged(store: SqliteEventStore, baseline: Baseline): void {
  expect(decisionCount(store)).toBe(baseline.decisions);
  expect(eventCounts(store)).toEqual(baseline.events);
  expect(store.readEventHorizon()).toBe(baseline.horizon);
}

/** Every refusal arm pins the SAME four facts: code, layer, refusing layer, and zero residue. */
function expectPolicyRefusal(
  store: SqliteEventStore, baseline: Baseline, refusal: DomainRefusal,
): void {
  expect(refusal.code).toBe(POLICY_CODE);
  expect(refusal.layer).toBe(POLICY_LAYER);
  expect(refusal.detail).toBe(INGRESS_DETAIL);
  expectUnchanged(store, baseline);
}

describe("graph.supersede ingress consults the approval policy (task-5b8a7966)", () => {
  it("A: refuses under REQUIRE_HUMAN when no server witness is attached", () => {
    stubApprovalPolicy("", "");
    const store = supersedableStore();
    const payload = payloadFor(store);
    const baseline = baselineOf(store);

    const refusal = refusalOf(() => runGraphEdge(
      edgeFor(store, "cmd-authority-no-witness", payload, undefined),
    ));

    expectPolicyRefusal(store, baseline, refusal);
  });

  it("B: decides the same bytes under REQUIRE_HUMAN once the operator witness is present", () => {
    stubApprovalPolicy("", "");
    const store = supersedableStore();
    const payload = payloadFor(store);
    const baseline = baselineOf(store);

    const decision = runGraphEdge(
      edgeFor(store, "cmd-authority-witness", payload, OPERATOR_WITNESS),
    );

    expect(decision.disposition).toBe("DECIDED");
    expect(decisionCount(store)).toBe(baseline.decisions + 1);
  });

  it("C: refuses a non-IMMEDIATE SPEED delay even though the policy itself proceeds", () => {
    stubApprovalPolicy("SPEED", "2000");
    const store = supersedableStore();
    const payload = payloadFor(store);
    const baseline = baselineOf(store);

    const refusal = refusalOf(() => runGraphEdge(
      edgeFor(store, "cmd-authority-delayed", payload, undefined),
    ));

    expectPolicyRefusal(store, baseline, refusal);
  });

  it("D: decides the same bytes at SPEED delay zero with no witness", () => {
    stubApprovalPolicy("SPEED", "0");
    const store = supersedableStore();
    const payload = payloadFor(store);
    const baseline = baselineOf(store);

    const decision = runGraphEdge(
      edgeFor(store, "cmd-authority-immediate", payload, undefined),
    );

    expect(decision.disposition).toBe("DECIDED");
    expect(decisionCount(store)).toBe(baseline.decisions + 1);
  });
});
