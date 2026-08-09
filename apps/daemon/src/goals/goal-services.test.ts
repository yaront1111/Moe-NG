import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
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

function goalRow(store: SqliteEventStore): GoalRow | undefined {
  return readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result as
    GoalRow | undefined;
}

afterEach(closeStores);

describe("goal service surface", () => {
  it("contributes the create and close handlers, appended in that order", () => {
    expect(Object.keys(GOAL_HANDLERS)).toEqual(["goal.create", "goal.close"]);
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
  it("drives the goal to its accepted terminal state in one durable decision", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
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
