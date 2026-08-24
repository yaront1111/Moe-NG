import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GRAPH_REVISION_REF,
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  acceptancePayload,
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
import {
  GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED,
  GOAL_PREREQUISITE_LAYER,
  GOAL_PREREQUISITE_REFUSAL_CODES,
} from "./goal-close-prerequisite.js";
import {
  approveNodes,
  scanGlobalEvents,
  seedReviewAcceptance,
} from "./goal-closure-test-fixtures.js";
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
 *
 * NO ARM HERE CLOSES A GOAL, and that is a statement about production rather than about this
 * file. Closing needs a durable Foundation verification receipt, which needs a proven attempt,
 * which needs a committed activation no test world can produce — `runEffectActivateCommand`
 * refuses. Governor ruling comment-937524c83a1945a5afae3ed8ac2405b9 clause 3 forbids rebuilding
 * that world below the admission path, so the seven arms that required it are RETIRED rather
 * than faked. Core's own `EXECUTION_ENABLED -> CLOSING -> COMPLETED` transition, its
 * ILLEGAL_TRANSITION on a second close and its EXPECTED_VERSION_CONFLICT still have an owner in
 * `packages/core/src/goal/goal-reducer.test.ts`; the DAEMON-side composition of a SUCCESSFUL
 * close has NO owner until production can mint an activation. Stated plainly so the absence
 * below reads as a disclosed gap and not as coverage.
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

/** The frozen tuple `goal.close` answers while no durable Foundation verification receipt names
 *  an approved node. Restated by hand, in full, so a code, a refusing layer or an authority
 *  quietly changing reddens here instead of passing as "still refused". */
const NO_RECEIPT_REFUSAL = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  code: "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT",
  ok: false,
  refusedBy: "DAEMON_PREREQUISITE",
});

/** No committed activation ANYWHERE, with the world's own events as the positive control. */
function expectUnactivatedWorld(store: SqliteEventStore): void {
  const scan = scanGlobalEvents(store);
  expect(scan.total).toBeGreaterThan(0);
  expect(scan.exhausted).toBe(true);
  expect(scan.activationRows).toBe(0);
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

  it("declares the goal-close prerequisites in a stable daemon vocabulary", () => {
    // Restated BY HAND, in order. Deriving this list from the production array would grow on
    // both sides at once and stay green while an unguarded code shipped.
    expect(GOAL_PREREQUISITE_REFUSAL_CODES).toEqual([
      "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT",
      "GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS",
      "GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE",
      "GOAL_CLOSE_VERIFICATION_NOT_PASSED",
      "GOAL_CLOSE_RESULT_DIGEST_MISMATCH",
      "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
      "GOAL_CLOSE_AUTHORITY_REMAINS",
    ]);
    expect(new Set(GOAL_PREREQUISITE_REFUSAL_CODES).size)
      .toBe(GOAL_PREREQUISITE_REFUSAL_CODES.length);
    expect(GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED)
      .toBe("GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED");
    // All eight refuse at ONE layer, which is why every arm below pins the layer too.
    expect(GOAL_PREREQUISITE_LAYER).toBe("DAEMON_PREREQUISITE");
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
 *
 * Both witness VALUES are now derived by the daemon from durable records, so the payload's own
 * refs are declared and inert. That is asserted in both directions below rather than trusted:
 * garbage refs still close when the records hold, and perfect refs still refuse when they do not.
 */
describe("goal close accepts the verified result", () => {
  it("refuses before core when no durable verification receipt names the approved node", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    // The REVIEWED half is present, so the review guard cannot be what answers below.
    seedReviewAcceptance(store, "node-1");
    expectUnactivatedWorld(store);
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome).toMatchObject(NO_RECEIPT_REFUSAL);
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
    seedReviewAcceptance(store, "node-1");
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

  /**
   * DoD 1, direction TWO — the half that still has a reachable subject. A perfectly-shaped
   * payload that `validClosure` and `validZeroAuthority` would both accept still refuses, at the
   * DAEMON layer, because no durable record backs it. Direction ONE (garbage payload witnesses
   * that close anyway on durable records) needed a successful close and is retired with the rest.
   */
  it("refuses perfectly-shaped payload witnesses when no durable record backs them", () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    expectUnactivatedWorld(store);
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload({
      closureWitness: closureWitness({ truthClass: "DAEMON_VERIFIED" }),
      zeroAuthorityWitness: zeroAuthorityWitness(),
    })));

    expect(outcome).toMatchObject(NO_RECEIPT_REFUSAL);
    expectNoCloseMutation(store, before);
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

});
