/**
 * Result and state-clone construction for the goal aggregate. Transition decisions remain in
 * the reducer; this module only shapes their immutable results.
 */
import { createRuntimeError } from "@moe/contracts";

import type {
  GoalCommandKind,
  GoalEvent,
  GoalReducerResult,
  GoalState,
} from "./goal-contract.js";

export const GOAL_LAYER = "GOAL" as const;

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Every refusal names its layer here once, because `RuntimeError` cannot carry the source. */
export function rejected(error: ReturnType<typeof createRuntimeError>): GoalReducerResult {
  return Object.freeze({ error, layer: GOAL_LAYER, ok: false });
}

export function unknownFailure(): GoalReducerResult {
  return rejected(createRuntimeError({ code: "UNKNOWN_ERROR" }));
}

export function illegal(state: GoalState, kind: GoalCommandKind): GoalReducerResult {
  return rejected(createRuntimeError({
    code: "ILLEGAL_TRANSITION",
    details: { aggregateKind: "GOAL", commandKind: kind, sourceState: state.lifecycle },
    source: { aggregate: GOAL_LAYER, state: state.lifecycle },
  }));
}

export function versionConflict(state: GoalState, expectedVersion: number): GoalReducerResult {
  return rejected(createRuntimeError({
    code: "EXPECTED_VERSION_CONFLICT",
    details: { actualVersion: state.version, expectedVersion },
    source: { aggregate: GOAL_LAYER, state: state.lifecycle },
  }));
}

export function accepted(
  state: GoalState,
  events: readonly GoalEvent[],
): GoalReducerResult {
  return deepFreeze({ events, ok: true as const, state });
}

export function clonedState(state: GoalState, patch: Partial<GoalState> = {}): GoalState {
  const recoveryFacets = patch.recoveryFacets ?? state.recoveryFacets;
  return deepFreeze({ ...state, ...patch, recoveryFacets: { ...recoveryFacets } });
}
