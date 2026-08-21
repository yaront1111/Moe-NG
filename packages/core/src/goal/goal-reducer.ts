import { createRuntimeError } from "@moe/contracts";

import type {
  GoalAdvanceGraphEpochCommand,
  GoalActivateInitialGraphCommand,
  GoalCancelCommand,
  GoalCloseCommand,
  GoalCommand,
  GoalCommandKind,
  GoalCreateCommand,
  GoalLifecycle,
  GoalPauseCommand,
  GoalQualificationInvalidatedCommand,
  GoalReducerResult,
  GoalReopenAsRevisionCommand,
  GoalSchedulingControl,
  GoalState,
  GoalSuccessorData,
} from "./goal-contract.js";
import {
  accepted,
  clonedState,
  deepFreeze,
  illegal,
  rejected,
  unknownFailure,
  versionConflict,
} from "./goal-results.js";
import {
  GOAL_COMMAND_KINDS,
  snapshotGoalCommand,
  snapshotGoalState,
  validActivation,
  validCancellation,
  validClosure,
  validExpectedVersion,
  validInvalidation,
  validPause,
  validProjectReady,
  validRef,
  validReopen,
  validZeroAuthority,
} from "./goal-validation.js";

export { GOAL_COMMAND_KINDS };

export const GOAL_TRANSITIONS = Object.freeze({
  "goal.create": Object.freeze([]),
  "goal.activate_initial_graph": Object.freeze(["DRAFT"]),
  "goal.advance_graph_epoch": Object.freeze(["EXECUTION_ENABLED"]),
  "goal.close": Object.freeze(["EXECUTION_ENABLED", "CLOSING"]),
  "goal.qualification_invalidated": Object.freeze(["CLOSING"]),
  "goal.cancel": Object.freeze(["DRAFT", "EXECUTION_ENABLED", "CLOSING"]),
  "goal.reopen_as_revision": Object.freeze(["COMPLETED", "CANCELLED"]),
  "goal.pause": Object.freeze(["DRAFT", "EXECUTION_ENABLED"]),
  "goal.resume": Object.freeze(["DRAFT", "EXECUTION_ENABLED"]),
} as const satisfies Readonly<Record<GoalCommandKind, readonly GoalLifecycle[]>>);
function create(command: GoalCreateCommand): GoalReducerResult {
  const valid = command.expectedVersion === 0 && validRef(command.goalId)
    && validRef(command.projectId) && validRef(command.budgetAccountRef)
    && validRef(command.planningRunRef) && validProjectReady(command.witness);
  if (!valid) return unknownFailure();
  const witness = deepFreeze({ ...command.witness });
  const state = deepFreeze({
    activeGraphRevisionRef: null, budgetAccountRef: command.budgetAccountRef,
    generation: 1, goalId: command.goalId, graphEpoch: 0, lifecycle: "DRAFT" as const,
    planningRunRef: command.planningRunRef, predecessorGoalRef: null,
    projectId: command.projectId, recoveryFacets: { qualificationInvalidatedRef: null },
    schedulingControl: "RUNNING" as const, version: 1,
  });
  return accepted(state, [deepFreeze({
    budgetAccountRef: command.budgetAccountRef, commandId: command.commandId,
    goalId: command.goalId, kind: "GoalCreated" as const,
    planningRunRef: command.planningRunRef, projectId: command.projectId,
    version: 1, witness,
  })]);
}
function nextGraphEpoch(state: GoalState): number {
  return state.graphEpoch + 1;
}

function activatedState(state: GoalState, activeGraphRevisionRef: string): GoalState {
  return clonedState(state, { activeGraphRevisionRef,
    graphEpoch: nextGraphEpoch(state), lifecycle: "EXECUTION_ENABLED" as const,
    version: state.version + 1 });
}

function activate(state: GoalState, command: GoalActivateInitialGraphCommand): GoalReducerResult {
  if (!validActivation(command.witness)) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = activatedState(state, witness.activeGraphRevisionRef);
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    graphEpoch: next.graphEpoch, kind: "GoalExecutionEnabled" as const,
    version: next.version, witness })]);
}

function advanceEpoch(state: GoalState, command: GoalAdvanceGraphEpochCommand): GoalReducerResult {
  const { graphEpoch, predecessorGraphRevisionRef, successorGraphRevisionRef } = command;
  if (!validRef(predecessorGraphRevisionRef) || !validRef(successorGraphRevisionRef)
    || !Number.isSafeInteger(graphEpoch)) return unknownFailure();
  if (predecessorGraphRevisionRef !== state.activeGraphRevisionRef) {
    return illegal(state, command.kind);
  }
  if (successorGraphRevisionRef === predecessorGraphRevisionRef) {
    return illegal(state, command.kind);
  }
  if (graphEpoch !== nextGraphEpoch(state)) return illegal(state, command.kind);
  const next = activatedState(state, successorGraphRevisionRef);
  return accepted(next, [deepFreeze({ activeGraphRevisionRef: successorGraphRevisionRef,
    commandId: command.commandId, graphEpoch: next.graphEpoch,
    kind: "GoalGraphEpochAdvanced" as const, predecessorGraphRevisionRef,
    version: next.version })]);
}
function close(state: GoalState, command: GoalCloseCommand): GoalReducerResult {
  const closure = command.closureWitness;
  const zero = command.zeroAuthorityWitness;
  if (state.lifecycle === "CLOSING") {
    if (closure !== undefined || !validZeroAuthority(zero)) return illegal(state, command.kind);
    const witness = deepFreeze({ ...zero });
    const next = clonedState(state, { activeGraphRevisionRef: null,
      lifecycle: "COMPLETED" as const, recoveryFacets: { qualificationInvalidatedRef: null },
      version: state.version + 1 });
    return accepted(next, [deepFreeze({ commandId: command.commandId,
      kind: "GoalCompleted" as const, version: next.version, witness })]);
  }
  if (!validClosure(closure) || (zero !== undefined && !validZeroAuthority(zero))) {
    return illegal(state, command.kind);
  }
  const closureCopy = deepFreeze({ ...closure });
  const closingVersion = state.version + 1;
  const closing = deepFreeze({ commandId: command.commandId, kind: "GoalClosing" as const,
    version: closingVersion, witness: closureCopy });
  if (zero === undefined) return accepted(clonedState(state, {
    lifecycle: "CLOSING" as const, recoveryFacets: { qualificationInvalidatedRef: null },
    version: closingVersion }), [closing]);
  const zeroCopy = deepFreeze({ ...zero });
  const next = clonedState(state, { activeGraphRevisionRef: null,
    lifecycle: "COMPLETED" as const, recoveryFacets: { qualificationInvalidatedRef: null },
    version: closingVersion + 1 });
  const completed = deepFreeze({ commandId: command.commandId, kind: "GoalCompleted" as const,
    version: next.version, witness: zeroCopy });
  return accepted(next, [closing, completed]);
}
function invalidate(
  state: GoalState,
  command: GoalQualificationInvalidatedCommand,
): GoalReducerResult {
  if (!validInvalidation(command.witness)) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, { lifecycle: "EXECUTION_ENABLED" as const,
    recoveryFacets: { qualificationInvalidatedRef: witness.proofInvalidatedRef },
    version: state.version + 1 });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "GoalQualificationInvalidated" as const, version: next.version, witness })]);
}
function cancel(state: GoalState, command: GoalCancelCommand): GoalReducerResult {
  if (!validCancellation(command.witness)) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, { activeGraphRevisionRef: null,
    lifecycle: "CANCELLED" as const, recoveryFacets: { qualificationInvalidatedRef: null },
    version: state.version + 1 });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "GoalCancelled" as const, version: next.version, witness })]);
}
function reopen(state: GoalState, command: GoalReopenAsRevisionCommand): GoalReducerResult {
  if (!validRef(command.newGoalId) || command.newGoalId === state.goalId
    || !validRef(command.budgetAccountRef)
    || !validRef(command.planningRunRef) || !validReopen(command.witness)) {
    return illegal(state, command.kind);
  }
  const successor: GoalSuccessorData = deepFreeze({
    activeGraphRevisionRef: null, budgetAccountRef: command.budgetAccountRef,
    generation: state.generation + 1, goalId: command.newGoalId, graphEpoch: 0,
    lifecycle: "DRAFT", planningRunRef: command.planningRunRef,
    predecessorGoalRef: state.goalId, projectId: state.projectId,
    recoveryFacets: { qualificationInvalidatedRef: null }, schedulingControl: "RUNNING", version: 1,
  });
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, { version: state.version + 1 });
  const event = deepFreeze({ commandId: command.commandId, generation: successor.generation,
    kind: "GoalReopenedAsRevision" as const, newGoalId: successor.goalId,
    version: next.version, witness });
  return deepFreeze({ events: [event], ok: true as const,
    state: next, successor });
}
function schedule(
  state: GoalState,
  command: GoalPauseCommand | Extract<GoalCommand, { kind: "goal.resume" }>,
): GoalReducerResult {
  const control: GoalSchedulingControl = command.kind === "goal.resume"
    ? "RUNNING" : command.schedulingControl;
  if (command.kind === "goal.pause" && !validPause(control)) return illegal(state, command.kind);
  const next = clonedState(state, { schedulingControl: control, version: state.version + 1 });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "GoalSchedulingChanged" as const, schedulingControl: control, version: next.version })]);
}

function apply(state: GoalState, command: GoalCommand): GoalReducerResult {
  switch (command.kind) {
    case "goal.activate_initial_graph": return activate(state, command);
    case "goal.advance_graph_epoch": return advanceEpoch(state, command);
    case "goal.close": return close(state, command);
    case "goal.qualification_invalidated": return invalidate(state, command);
    case "goal.cancel": return cancel(state, command);
    case "goal.reopen_as_revision": return reopen(state, command);
    case "goal.pause": case "goal.resume": return schedule(state, command);
    case "goal.create": return illegal(state, command.kind);
  }
}

function safeToApply(state: GoalState, command: GoalCommand): boolean {
  if (command.kind === "goal.reopen_as_revision") {
    return state.generation < Number.MAX_SAFE_INTEGER
      && state.version < Number.MAX_SAFE_INTEGER;
  }
  const combined = command.kind === "goal.close" && state.lifecycle === "EXECUTION_ENABLED"
    && command.zeroAuthorityWitness !== undefined;
  const versionDelta = combined ? 2 : 1;
  return state.version <= Number.MAX_SAFE_INTEGER - versionDelta;
}

/** Pure lifecycle reduction; the decision ledger owns command replay and conflict lookup. */
export function reduceGoal(state: GoalState | undefined, command: GoalCommand): GoalReducerResult {
  const input = snapshotGoalCommand(command);
  if (input === undefined) return unknownFailure();
  if (state === undefined) {
    if (input.kind !== "goal.create" || typeof input.commandId !== "string"
      || input.commandId.length === 0) {
      return unknownFailure();
    }
    return create(input);
  }
  const current = snapshotGoalState(state);
  if (current === undefined) return unknownFailure();
  if (!validExpectedVersion(input.expectedVersion)) return illegal(current, input.kind);
  if (input.expectedVersion !== current.version) return versionConflict(current, input.expectedVersion);
  if (typeof input.commandId !== "string" || input.commandId.length === 0) {
    return rejected(createRuntimeError({
      code: "IDEMPOTENCY_CONFLICT", source: { aggregate: "GOAL", state: current.lifecycle },
    }));
  }
  const allowed: readonly GoalLifecycle[] = GOAL_TRANSITIONS[input.kind];
  if (!allowed.includes(current.lifecycle)) return illegal(current, input.kind);
  if (!safeToApply(current, input)) return illegal(current, input.kind);
  return apply(current, input);
}
