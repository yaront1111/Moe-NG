import { describe, expect, it } from "vitest";

import type { GoalCommand, GoalReducerResult, GoalState } from "./goal-contract.js";
import { GOAL_TRANSITIONS, reduceGoal } from "./goal-reducer.js";

const ACTIVE_REF = "graph-revision-1";
const SUCCESSOR_REF = "graph-revision-2";

function state(
  lifecycle: GoalState["lifecycle"] = "EXECUTION_ENABLED",
): GoalState {
  const active = lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING";
  return {
    activeGraphRevisionRef: active ? ACTIVE_REF : null,
    budgetAccountRef: "budget-1",
    generation: 1,
    goalId: "goal-1",
    graphEpoch: lifecycle === "DRAFT" ? 0 : 1,
    lifecycle,
    planningRunRef: "planning-1",
    predecessorGoalRef: null,
    projectId: "project-1",
    recoveryFacets: { qualificationInvalidatedRef: null },
    schedulingControl: "RUNNING",
    version: 7,
  };
}

function advance(overrides: Readonly<Record<string, unknown>> = {}): GoalCommand {
  return {
    commandId: "cmd-advance-epoch",
    expectedVersion: 7,
    graphEpoch: 2,
    kind: "goal.advance_graph_epoch",
    predecessorGraphRevisionRef: ACTIVE_REF,
    successorGraphRevisionRef: SUCCESSOR_REF,
    ...overrides,
  } as unknown as GoalCommand;
}

function expectRefusal(
  result: GoalReducerResult,
  code: "ILLEGAL_TRANSITION" | "UNKNOWN_ERROR",
): void {
  expect({
    code: result.ok ? undefined : result.error.code,
    layer: result.ok ? undefined : result.layer,
  }).toEqual({ code, layer: "GOAL" });
  expect(result.ok).toBe(false);
  expect(Object.hasOwn(result, "state")).toBe(false);
}

describe("goal graph epoch advance", () => {
  it("increments the owned epoch exactly once and activates the named successor", () => {
    const result = reduceGoal(state(), advance());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toMatchObject({
      activeGraphRevisionRef: SUCCESSOR_REF,
      graphEpoch: 2,
      lifecycle: "EXECUTION_ENABLED",
      version: 8,
    });
    expect(result.events).toEqual([{
      activeGraphRevisionRef: SUCCESSOR_REF,
      commandId: "cmd-advance-epoch",
      graphEpoch: 2,
      kind: "GoalGraphEpochAdvanced",
      predecessorGraphRevisionRef: ACTIVE_REF,
      version: 8,
    }]);
  });

  it("refuses a predecessor mismatch without changing or returning aggregate state", () => {
    const current = state();
    const before = JSON.stringify(current);

    const result = reduceGoal(current, advance({ predecessorGraphRevisionRef: "graph-other" }));

    expectRefusal(result, "ILLEGAL_TRANSITION");
    expect(JSON.stringify(current)).toBe(before);
    expect(current).toEqual(state());
  });

  it("refuses a self-succession naming the active revision as its own successor", () => {
    expectRefusal(
      reduceGoal(state(), advance({ successorGraphRevisionRef: ACTIVE_REF })),
      "ILLEGAL_TRANSITION",
    );
  });

  const invalidEpochs = [
    { graphEpoch: 0, name: "stale", reasonCode: "ILLEGAL_TRANSITION" },
    { graphEpoch: 1, name: "equal", reasonCode: "ILLEGAL_TRANSITION" },
    { graphEpoch: 3, name: "skipped", reasonCode: "ILLEGAL_TRANSITION" },
    { graphEpoch: 1.5, name: "non-integer", reasonCode: "UNKNOWN_ERROR" },
  ] as const;

  it("generates at least one invalid epoch case", () => {
    expect(invalidEpochs.length).toBeGreaterThan(0);
  });

  it.each(invalidEpochs)("refuses a $name epoch with $reasonCode", ({ graphEpoch, reasonCode }) => {
    expectRefusal(reduceGoal(state(), advance({ graphEpoch })), reasonCode);
  });

  const unknownEvidence = [
    { field: "predecessorGraphRevisionRef", value: undefined },
    { field: "graphEpoch", value: undefined },
  ] as const;

  it("generates at least one unknown-evidence case", () => {
    expect(unknownEvidence.length).toBeGreaterThan(0);
  });

  it.each(unknownEvidence)("fails closed when $field is unknown", ({ field, value }) => {
    expectRefusal(reduceGoal(state(), advance({ [field]: value })), "UNKNOWN_ERROR");
  });

  it("does not admit an epoch advance from DRAFT", () => {
    expect(GOAL_TRANSITIONS["goal.advance_graph_epoch"]).toEqual(["EXECUTION_ENABLED"]);
    expectRefusal(reduceGoal(state("DRAFT"), advance()), "ILLEGAL_TRANSITION");
  });

  it("keeps initial activation admitted from DRAFT", () => {
    expect(GOAL_TRANSITIONS["goal.activate_initial_graph"]).toEqual(["DRAFT"]);
    const draft = state("DRAFT");
    const result = reduceGoal(draft, {
      commandId: "cmd-activate",
      expectedVersion: draft.version,
      kind: "goal.activate_initial_graph",
      witness: {
        activeGraphRevisionRef: ACTIVE_REF,
        graphApprovalRef: "approval-1",
        truthClass: "DAEMON_VERIFIED",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.graphEpoch).toBe(1);
    expect(result.state.activeGraphRevisionRef).toBe(ACTIVE_REF);
    expect(result.events[0]).toMatchObject({ graphEpoch: 1, kind: "GoalExecutionEnabled" });
  });

  it("keeps initial activation fenced out of the live lifecycle", () => {
    const current = state();
    expectRefusal(reduceGoal(current, {
      commandId: "cmd-reactivate-initial",
      expectedVersion: current.version,
      kind: "goal.activate_initial_graph",
      witness: {
        activeGraphRevisionRef: SUCCESSOR_REF,
        graphApprovalRef: "approval-2",
        truthClass: "DAEMON_VERIFIED",
      },
    }), "ILLEGAL_TRANSITION");
  });
});
