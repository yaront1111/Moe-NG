import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  closeStores,
  decisionCount,
  driveThrough,
  envelope,
  goalPayload,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { GOAL_HANDLERS } from "./goal-services.js";

/**
 * Goal creation. The ingress and sequence rules are not restated here — they are proven once
 * against the shared pipeline — so these assertions concern only what this module contributes:
 * routing to `reduceGoal` and surfacing the core's own verdict.
 */

afterEach(closeStores);

describe("goal service surface", () => {
  it("contributes exactly the goal.create handler", () => {
    expect(Object.keys(GOAL_HANDLERS)).toEqual(["goal.create"]);
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
