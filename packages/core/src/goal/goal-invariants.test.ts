import { describe, expect, it } from "vitest";

import { reduceGoal } from "./goal-reducer.js";
import type {
  GoalCommand,
  GoalLifecycle,
  GoalReducerResult,
  GoalState,
} from "./goal-contract.js";

function mutableState(lifecycle: GoalLifecycle, version = 7): GoalState {
  const active = lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING";
  return {
    activeGraphRevisionRef: active ? "graph-1" : null,
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
    version,
  };
}

function expectIllegal(
  result: GoalReducerResult,
  commandKind: GoalCommand["kind"],
  sourceState: GoalLifecycle,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("ILLEGAL_TRANSITION");
  expect(result.error.details).toEqual({ aggregateKind: "GOAL", commandKind, sourceState });
}

function expectUnknown(result: GoalReducerResult): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("UNKNOWN_ERROR");
}

const ACTIVATE = Object.freeze({
  commandId: "cmd-activate", expectedVersion: 7, kind: "goal.activate_initial_graph" as const,
  witness: { activeGraphRevisionRef: "graph-2", graphApprovalRef: "approval-1",
    truthClass: "DAEMON_VERIFIED" as const },
});
const COMBINED_CLOSE = Object.freeze({
  closureWitness: { acceptanceClosureRef: "closure-1",
    completionNodeAcceptedRef: "accepted-1", noCurrentPreparationGeneration: true as const,
    noPendingDraftOrSupersession: true as const, obligationsHoldRef: "obligations-1",
    truthClass: "DAEMON_VERIFIED" as const },
  commandId: "cmd-close", expectedVersion: 7, kind: "goal.close" as const,
  zeroAuthorityWitness: { truthClass: "DAEMON_VERIFIED" as const,
    zeroAuthorityProofRef: "zero-1" },
});

describe("goal reducer state invariants", () => {
  it("does not freeze mutable caller state and returns a frozen value copy on reopen", () => {
    const draft = mutableState("DRAFT");
    const paused = reduceGoal(draft, {
      commandId: "cmd-pause", expectedVersion: 7, kind: "goal.pause",
      schedulingControl: "PAUSE_AFTER_CURRENT_STEP",
    });
    expect(paused.ok).toBe(true);
    expect(Object.isFrozen(draft)).toBe(false);
    expect(Object.isFrozen(draft.recoveryFacets)).toBe(false);
    const terminal = mutableState("COMPLETED");
    const reopened = reduceGoal(terminal, {
      budgetAccountRef: "budget-2", commandId: "cmd-reopen", expectedVersion: 7,
      kind: "goal.reopen_as_revision", newGoalId: "goal-2", planningRunRef: "planning-2",
      witness: { authorizationRef: "approval-2", truthClass: "HUMAN_APPROVED" },
    });
    expect(reopened.ok).toBe(true);
    expect(Object.isFrozen(terminal)).toBe(false);
    if (!reopened.ok) return;
    expect(reopened.state).toEqual({ ...terminal, version: 8 });
    expect(reopened.state).not.toBe(terminal);
    expect(Object.isFrozen(reopened.state.recoveryFacets)).toBe(true);
  });

  it("pins activation, closing, invalidation, cancellation, and resume facets", () => {
    const activated = reduceGoal(mutableState("DRAFT"), ACTIVATE);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.state).toMatchObject({
      activeGraphRevisionRef: "graph-2", graphEpoch: 1, lifecycle: "EXECUTION_ENABLED",
    });
    const closing = reduceGoal(activated.state, {
      closureWitness: { acceptanceClosureRef: "closure-1",
        completionNodeAcceptedRef: "accepted-1", noCurrentPreparationGeneration: true,
        noPendingDraftOrSupersession: true, obligationsHoldRef: "obligations-1",
        truthClass: "DAEMON_VERIFIED" },
      commandId: "cmd-close", expectedVersion: 8, kind: "goal.close",
    });
    expect(closing.ok && closing.state.activeGraphRevisionRef).toBe("graph-2");
    if (!closing.ok) return;
    const invalidated = reduceGoal(closing.state, {
      commandId: "cmd-invalidate", expectedVersion: 9, kind: "goal.qualification_invalidated",
      witness: { proofInvalidatedRef: "proof-invalid-1", truthClass: "DAEMON_VERIFIED" },
    });
    expect(invalidated.ok && invalidated.state.recoveryFacets).toEqual({
      qualificationInvalidatedRef: "proof-invalid-1",
    });
    if (!invalidated.ok) return;
    const reclosed = reduceGoal(invalidated.state, {
      closureWitness: { acceptanceClosureRef: "closure-2",
        completionNodeAcceptedRef: "accepted-2", noCurrentPreparationGeneration: true,
        noPendingDraftOrSupersession: true, obligationsHoldRef: "obligations-2",
        truthClass: "DAEMON_VERIFIED" },
      commandId: "cmd-reclose", expectedVersion: 10, kind: "goal.close",
    });
    expect(reclosed.ok && reclosed.state.recoveryFacets).toEqual({
      qualificationInvalidatedRef: null,
    });
    if (!reclosed.ok) return;
    const cancelled = reduceGoal(reclosed.state, {
      commandId: "cmd-cancel", expectedVersion: 11, kind: "goal.cancel",
      witness: { authorizationRef: "approval-2", subordinateAuthorityFenced: true,
        truthClass: "HUMAN_APPROVED" },
    });
    expect(cancelled.ok && cancelled.state).toMatchObject({
      activeGraphRevisionRef: null,
      recoveryFacets: { qualificationInvalidatedRef: null },
    });
    const paused = { ...mutableState("EXECUTION_ENABLED"),
      schedulingControl: "DRAIN_AND_PAUSE" as const };
    const resumed = reduceGoal(paused, {
      commandId: "cmd-resume", expectedVersion: 7, kind: "goal.resume",
    });
    expect(resumed.ok && resumed.state.schedulingControl).toBe("RUNNING");
  });

  it("rejects malformed facets, impossible epochs, and unsafe numbers", () => {
    const pause = { commandId: "cmd-pause", expectedVersion: 7, kind: "goal.pause",
      schedulingControl: "DRAIN_AND_PAUSE" } as const;
    const badFacet = { ...mutableState("DRAFT"),
      recoveryFacets: { qualificationInvalidatedRef: null, extra: true } } as unknown as GoalState;
    expectUnknown(reduceGoal(badFacet, pause));
    const impossibleFacet = { ...mutableState("DRAFT"),
      recoveryFacets: { qualificationInvalidatedRef: "proof-invalid-1" } } as GoalState;
    expectUnknown(reduceGoal(impossibleFacet, pause));
    const badCompleted = { ...mutableState("COMPLETED"), graphEpoch: 0 } as GoalState;
    expectUnknown(reduceGoal(badCompleted, {
      budgetAccountRef: "budget-2", commandId: "cmd-reopen", expectedVersion: 7,
      kind: "goal.reopen_as_revision", newGoalId: "goal-2", planningRunRef: "planning-2",
      witness: { authorizationRef: "approval-2", truthClass: "HUMAN_APPROVED" },
    }));
    expectUnknown(reduceGoal(mutableState("DRAFT", 0), { ...pause, expectedVersion: 0 }));
    const max = mutableState("DRAFT", Number.MAX_SAFE_INTEGER);
    expectIllegal(reduceGoal(max, { ...ACTIVATE, expectedVersion: Number.MAX_SAFE_INTEGER }),
      ACTIVATE.kind, "DRAFT");
    const badLineage = { ...mutableState("DRAFT"), generation: 2 } as GoalState;
    expectUnknown(reduceGoal(badLineage, pause));
  });

  it("rejects every proof class below the named authority floor", () => {
    const lowCreate = {
      budgetAccountRef: "budget-1", commandId: "cmd-create", expectedVersion: 0,
      goalId: "goal-1", kind: "goal.create", planningRunRef: "planning-1",
      projectId: "project-1",
      witness: { projectReadyRef: "project-ready-1", truthClass: "OBSERVED" },
    } as unknown as GoalCommand;
    const createResult = reduceGoal(undefined, lowCreate);
    expect(createResult.ok).toBe(false);
    if (!createResult.ok) expect(createResult.error.code).toBe("UNKNOWN_ERROR");
    const lowActivation = { ...ACTIVATE,
      witness: { ...ACTIVATE.witness, truthClass: "OBSERVED" } } as unknown as GoalCommand;
    expectIllegal(reduceGoal(mutableState("DRAFT"), lowActivation), ACTIVATE.kind, "DRAFT");
    const hidden = Symbol("authority");
    const extraActivation = { ...ACTIVATE,
      witness: { ...ACTIVATE.witness, [hidden]: { grant: true } } } as GoalCommand;
    expectIllegal(reduceGoal(mutableState("DRAFT"), extraActivation), ACTIVATE.kind, "DRAFT");
    let reads = 0;
    const changingWitness = { ...ACTIVATE.witness };
    Object.defineProperty(changingWitness, "truthClass", { enumerable: true,
      get: () => (++reads === 1 ? "DAEMON_VERIFIED" : "UNKNOWN") });
    expectIllegal(reduceGoal(mutableState("DRAFT"), {
      ...ACTIVATE, witness: changingWitness,
    } as GoalCommand), ACTIVATE.kind, "DRAFT");
    const lowZero = { commandId: "cmd-complete", expectedVersion: 7, kind: "goal.close",
      zeroAuthorityWitness: { truthClass: "AGENT_REPORTED", zeroAuthorityProofRef: "zero-1" },
    } as unknown as GoalCommand;
    expectIllegal(reduceGoal(mutableState("CLOSING"), lowZero), "goal.close", "CLOSING");
    const lowInvalidation = { commandId: "cmd-invalidate", expectedVersion: 7,
      kind: "goal.qualification_invalidated",
      witness: { proofInvalidatedRef: "proof-1", truthClass: "UNKNOWN" },
    } as unknown as GoalCommand;
    expectIllegal(reduceGoal(mutableState("CLOSING"), lowInvalidation),
      "goal.qualification_invalidated", "CLOSING");
    const lowCancel = {
      commandId: "cmd-cancel", expectedVersion: 7, kind: "goal.cancel",
      witness: { authorizationRef: "approval-1", subordinateAuthorityFenced: true,
        truthClass: "DAEMON_VERIFIED" },
    } as unknown as GoalCommand;
    expectIllegal(reduceGoal(mutableState("EXECUTION_ENABLED"), lowCancel),
      "goal.cancel", "EXECUTION_ENABLED");
    const lowReopen = { budgetAccountRef: "budget-2", commandId: "cmd-reopen",
      expectedVersion: 7, kind: "goal.reopen_as_revision", newGoalId: "goal-2",
      planningRunRef: "planning-2",
      witness: { authorizationRef: "approval-2", truthClass: "DAEMON_VERIFIED" },
    } as unknown as GoalCommand;
    expectIllegal(reduceGoal(mutableState("COMPLETED"), lowReopen),
      "goal.reopen_as_revision", "COMPLETED");
  });

  it("keeps combined-close versions safe at the integer boundary", () => {
    const lastSafeStart = Number.MAX_SAFE_INTEGER - 2;
    const completed = reduceGoal(mutableState("EXECUTION_ENABLED", lastSafeStart), {
      ...COMBINED_CLOSE, expectedVersion: lastSafeStart,
    });
    expect(completed.ok && completed.state.version).toBe(Number.MAX_SAFE_INTEGER);
    if (!completed.ok) return;
    const reopened = reduceGoal(completed.state, {
      budgetAccountRef: "budget-2", commandId: "cmd-reopen",
      expectedVersion: Number.MAX_SAFE_INTEGER, kind: "goal.reopen_as_revision",
      newGoalId: "goal-2", planningRunRef: "planning-2",
      witness: { authorizationRef: "approval-2", truthClass: "HUMAN_APPROVED" },
    });
    expectIllegal(reopened, "goal.reopen_as_revision", "COMPLETED");
    const unsafeStart = Number.MAX_SAFE_INTEGER - 1;
    expectIllegal(reduceGoal(mutableState("EXECUTION_ENABLED", unsafeStart), {
      ...COMBINED_CLOSE, expectedVersion: unsafeStart,
    }), "goal.close", "EXECUTION_ENABLED");
  });

  it("rejects a self-referential successor goal", () => {
    const result = reduceGoal(mutableState("COMPLETED"), {
      budgetAccountRef: "budget-2", commandId: "cmd-reopen", expectedVersion: 7,
      kind: "goal.reopen_as_revision", newGoalId: "goal-1", planningRunRef: "planning-2",
      witness: { authorizationRef: "approval-2", truthClass: "HUMAN_APPROVED" },
    });
    expectIllegal(result, "goal.reopen_as_revision", "COMPLETED");
  });

  it("advances the terminal version so a stale second reopen is rejected", () => {
    const terminal = mutableState("COMPLETED");
    const reopen = { budgetAccountRef: "budget-2", commandId: "cmd-reopen", expectedVersion: 7,
      kind: "goal.reopen_as_revision", newGoalId: "goal-2", planningRunRef: "planning-2",
      witness: { authorizationRef: "approval-2", truthClass: "HUMAN_APPROVED" },
    } as const;
    const first = reduceGoal(terminal, reopen);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.version).toBe(8);
    const second = reduceGoal(first.state, { ...reopen, commandId: "cmd-reopen-2",
      newGoalId: "goal-3" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("EXPECTED_VERSION_CONFLICT");
  });

  it("fails closed for null state and unknown command kinds", () => {
    expectUnknown(reduceGoal(null as unknown as GoalState, ACTIVATE));
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectUnknown(reduceGoal(revoked.proxy as GoalState, ACTIVATE));
    let reads = 0;
    const accessor = { ...ACTIVATE };
    Object.defineProperty(accessor, "kind", { enumerable: true,
      get: () => (++reads === 1 ? "goal.activate_initial_graph" : "goal.unknown") });
    expectUnknown(reduceGoal(mutableState("DRAFT"), accessor as GoalCommand));
    const unknown = { ...ACTIVATE, kind: "goal.unknown" } as unknown as GoalCommand;
    expectUnknown(reduceGoal(mutableState("DRAFT"), unknown));
  });
});
