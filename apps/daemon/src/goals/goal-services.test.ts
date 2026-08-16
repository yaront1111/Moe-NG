import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GRAPH_REVISION_REF,
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  SUBMISSION_HASH,
  acceptancePayload,
  approvalPayload,
  approvalRecord,
  closeStores,
  closureWitness,
  decisionCount,
  driveThrough,
  envelope,
  goalPayload,
  openStore,
  send,
  zeroAuthorityWitness,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { REVIEW_SCHEMA_VERSION } from "../review/review-contracts.js";
import { readReviewLedger } from "../review/review-ledger.js";
import { runReviewCommand } from "../review/review-services.js";
import { seedVerifierReceipt } from "../review/review-test-fixtures.js";
import {
  GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED,
  GOAL_PREREQUISITE_REFUSAL_CODES,
} from "./goal-close-prerequisite.js";
import { GOAL_HANDLERS } from "./goal-services.js";

/**
 * Goal creation and final acceptance. The ingress and sequence rules are not restated here —
 * they are proven once against the shared pipeline — so these assertions concern only what this
 * module contributes: routing to `reduceGoal` and surfacing the core's own verdict.
 *
 * Acceptance is the highest-risk command in the daemon: it is the one that turns work into an
 * accepted terminal state, so a forged or evidence-free acceptance is the worst defect
 * available here. Every refusal arm below therefore reads the goal back out of the store — a
 * handler that mutated and then refused would sail through a return-value-only assertion.
 */

interface GoalRow {
  readonly activeGraphRevisionRef?: string | null;
  readonly lifecycle?: string;
  readonly version?: number;
}

const encoder = new TextEncoder();

function goalRow(store: SqliteEventStore): GoalRow | undefined {
  return readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result as
    GoalRow | undefined;
}

function approveNodes(store: SqliteEventStore, nodeRefs: readonly string[]): void {
  driveThrough(store, "approval.decide");
  const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
    record: { ...approvalRecord(SUBMISSION_HASH), approvedNodeScope: [...nodeRefs] },
  })));
  if (!outcome.ok) throw new Error(`approval setup failed: ${outcome.code}`);
}

function acceptReviewedNode(store: SqliteEventStore, nodeRef: string): void {
  const receipt = seedVerifierReceipt(store, nodeRef, PROJECT_ID);
  const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-review-accept-${nodeRef}`,
    correlationId: "corr-goal-close-review",
    decidedAt: "2026-08-10T00:00:00.000Z",
    expectedVersion: receipt.currentVersion,
    kind: "integration.accept_output",
    payload: { receiptId: receipt.receiptId, subjectRef: nodeRef },
    principalId: "reviewer-1",
    projectId: PROJECT_ID,
    schemaVersion: REVIEW_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(`review setup failed for ${nodeRef}: ${outcome.code}`);
}

function stageUnreadableExecutionApproval(
  store: SqliteEventStore,
  eventPayload: Record<string, unknown>,
): void {
  driveThrough(store, "approval.decide");
  const aggregate = readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID);
  if (aggregate === undefined || aggregate.result === null
    || typeof aggregate.result !== "object" || Array.isArray(aggregate.result)) {
    throw new Error("goal setup did not create a readable draft");
  }
  const enabled = {
    ...aggregate.result,
    activeGraphRevisionRef: GRAPH_REVISION_REF,
    graphEpoch: 1,
    lifecycle: "EXECUTION_ENABLED",
    version: 2,
  };
  const committed = store.commitExpectedVersionDecision({
    commandKind: "approval.decide",
    committedResultBytes: encoder.encode(JSON.stringify(enabled)),
    correlationId: "corr-corrupt-approval",
    decidedAt: "2026-08-10T00:00:00.000Z",
    events: [{
      eventId: "cmd-corrupt-approval-GoalExecutionEnabled",
      eventType: "GoalExecutionEnabled",
      payload: encoder.encode(JSON.stringify(eventPayload)),
    }],
    expectedVersion: aggregate.currentVersion,
    key: {
      commandId: "cmd-corrupt-approval",
      principalId: "principal-1",
      projectId: PROJECT_ID,
    },
    requestBytes: encoder.encode(JSON.stringify({ kind: "approval.decide", payload: {} })),
    targetAggregateId: GOAL_ID,
  });
  expect(committed.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

function stageUnreadableReviewAcceptance(store: SqliteEventStore, nodeRef: string): void {
  const committed = store.commitExpectedVersionDecision({
    commandKind: "integration.accept_output",
    committedResultBytes: encoder.encode("{}"),
    correlationId: "corr-corrupt-review",
    decidedAt: "2026-08-10T00:00:00.000Z",
    events: [{
      eventId: `cmd-corrupt-review-${nodeRef}`,
      eventType: "ReviewOutputAccepted",
      payload: encoder.encode(JSON.stringify({ subjectRef: nodeRef })),
    }],
    expectedVersion: readReviewLedger(store, PROJECT_ID, nodeRef).version,
    key: {
      commandId: `cmd-corrupt-review-${nodeRef}`,
      principalId: "reviewer-1",
      projectId: PROJECT_ID,
    },
    requestBytes: encoder.encode(JSON.stringify({
      kind: "integration.accept_output",
      payload: { subjectRef: nodeRef },
    })),
    targetAggregateId: nodeRef,
  });
  expect(committed.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

interface DurableCloseSnapshot {
  readonly decisionCount: number;
  readonly goal: GoalRow | undefined;
  readonly goalEventCount: number;
}

function closeSnapshot(store: SqliteEventStore): DurableCloseSnapshot {
  return {
    decisionCount: decisionCount(store),
    goal: goalRow(store),
    goalEventCount: store.readEvents(GOAL_ID).length,
  };
}

function expectNoCloseMutation(store: SqliteEventStore, before: DurableCloseSnapshot): void {
  expect(decisionCount(store)).toBe(before.decisionCount);
  expect(goalRow(store)).toEqual(before.goal);
  expect(store.readEvents(GOAL_ID)).toHaveLength(before.goalEventCount);
}

afterEach(closeStores);

describe("goal service surface", () => {
  it("contributes the create and close handlers, appended in that order", () => {
    expect(Object.keys(GOAL_HANDLERS)).toEqual(["goal.create", "goal.close"]);
  });

  it("declares the goal-close review prerequisite in a stable daemon vocabulary", () => {
    expect(GOAL_PREREQUISITE_REFUSAL_CODES).toEqual([
      "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
    ]);
    expect(GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED)
      .toBe("GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED");
  });
});

describe("goal create", () => {
  it("commits one durable decision on an active project", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.create", 0, goalPayload()));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(outcome.disposition).toBe("DECIDED");
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(decisionCount(store)).toBe(before + 1);

    const goal = readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID);
    expect(goal).toBeDefined();
    expect((goal?.result as { lifecycle?: string } | undefined)?.lifecycle).toBe("DRAFT");
  });

  it("surfaces the core's own reason code for a stale expected version", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    expect(send(store, envelope("goal.create", 0, goalPayload())).ok).toBe(true);
    const before = decisionCount(store);

    // A distinct commandId, so the replay path cannot answer and the reducer must.
    const outcome = send(
      store,
      envelope("goal.create", 0, goalPayload(), "cmd-goal-again"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    // The reducer checks version agreement before the transition table, so a second create at
    // version 0 against a goal already at version 1 is a conflict, not an illegal transition.
    expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(outcome.advisoryOnly).toBe(true);
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses a goal whose witness is absent, at the ingress layer, and commits nothing", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.create", 0, {
      budgetAccountRef: "budget-account-1",
      goalId: GOAL_ID,
      planningRunRef: RUN_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.has(GOAL_ID)).toBe(false);
  });

  it("lets the core refuse a malformed witness rather than pre-judging it", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.create", 0, {
      ...goalPayload(),
      witness: { projectReadyRef: "ready-1", truthClass: "NOT_A_TRUTH_CLASS" },
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("UNKNOWN_ERROR");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.has(GOAL_ID)).toBe(false);
  });
});

/**
 * J1's THIRD human action (design 1095): final acceptance of the verified, reviewed result.
 *
 * It must reach the accepted terminal state in ONE action, which is why both witnesses are
 * required: the core's `close` moves a goal carrying only the closure witness to CLOSING, an
 * intermediate state J1 has no fourth action to leave.
 */
describe("goal close accepts the verified result", () => {
  it("refuses before core when no approved node has durable review acceptance", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome).toMatchObject({
      advisoryOnly: true,
      authority: "NONE",
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      ok: false,
      refusedBy: "DAEMON_PREREQUISITE",
    });
    expectNoCloseMutation(store, before);
  });

  it("refuses before core when only part of the approved node scope is accepted", () => {
    const store = openStore();
    approveNodes(store, ["node-1", "node-2"]);
    acceptReviewedNode(store, "node-1");
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      ok: false,
      refusedBy: "DAEMON_PREREQUISITE",
    });
    expectNoCloseMutation(store, before);
  });

  it("refuses before core when an approved node's durable review ledger is unreadable", () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    acceptReviewedNode(store, "node-1");
    stageUnreadableReviewAcceptance(store, "node-1");
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      ok: false,
      refusedBy: "DAEMON_PREREQUISITE",
    });
    expectNoCloseMutation(store, before);
  });

  it.each([
    ["missing", { activation: { graphApprovalRef: "approval-1" }, events: [] }],
    ["unreadable", {
      approval: {
        approvedNodeScope: "node-1",
        decision: "APPROVE",
        lifecycle: "DECIDED",
        validity: "CURRENT",
      },
    }],
  ] as const)("refuses when durable execution approval evidence is %s", (_name, payload) => {
    const store = openStore();
    stageUnreadableExecutionApproval(store, payload);
    acceptReviewedNode(store, "node-1");
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      ok: false,
      refusedBy: "DAEMON_PREREQUISITE",
    });
    expectNoCloseMutation(store, before);
  });

  it("refuses a decided current approval whose approved node scope is empty", () => {
    const store = openStore();
    approveNodes(store, []);
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      ok: false,
      refusedBy: "DAEMON_PREREQUISITE",
    });
    expectNoCloseMutation(store, before);
  });

  it("drives the goal to its accepted terminal state when every approved node is accepted", () => {
    const store = openStore();
    approveNodes(store, ["node-1", "node-2"]);
    acceptReviewedNode(store, "node-1");
    acceptReviewedNode(store, "node-2");
    const before = decisionCount(store);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(outcome.disposition).toBe("DECIDED");
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(decisionCount(store)).toBe(before + 1);
    const goal = goalRow(store);
    expect(goal?.lifecycle).toBe("COMPLETED");
    // Closing and completion are both applied by the one command, so the version moves by two.
    expect(goal?.version).toBe(4);
    expect(goal?.activeGraphRevisionRef).toBe(null);
  });

  it("refuses an acceptance carrying no closure evidence, at the ingress layer", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.close", 2, {
      goalId: GOAL_ID,
      zeroAuthorityWitness: zeroAuthorityWitness(),
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  it("refuses an acceptance carrying no zero-authority proof, leaving no half-closed goal", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.close", 2, {
      closureWitness: closureWitness(),
      goalId: GOAL_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    // Not CLOSING: a goal parked mid-closure would need a fourth human action to escape.
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  it("lets the CORE refuse closure evidence that does not hold, and commits nothing", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    acceptReviewedNode(store, "node-1");
    const before = decisionCount(store);
    // Shaped like a closure witness, so the daemon's shape gate passes and the core's
    // `validClosure` is the layer that must answer: the obligations claim is not asserted.
    const outcome = send(store, envelope("goal.close", 2, acceptancePayload({
      closureWitness: closureWitness({ noPendingDraftOrSupersession: false }),
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  it("lets the CORE refuse an acceptance whose review evidence is self-reported", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    acceptReviewedNode(store, "node-1");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload({
      closureWitness: closureWitness({ truthClass: "SELF_REPORTED" }),
    })));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  it("refuses a stale expected version through the core rather than overwriting", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    acceptReviewedNode(store, "node-1");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.close", 99, acceptancePayload()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  it("refuses a second acceptance of an already accepted goal, by the core's transitions", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    acceptReviewedNode(store, "node-1");
    expect(send(store, envelope("goal.close", 2, acceptancePayload())).ok).toBe(true);
    const before = decisionCount(store);

    // A distinct commandId, so the replay path cannot answer and the transition table must.
    const outcome = send(
      store,
      envelope("goal.close", 4, acceptancePayload(), "cmd-goal.close-again"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.version).toBe(4);
  });
});
