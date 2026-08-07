/**
 * Result, rejection, and state-clone construction for the graph revision aggregate. Holds no
 * transition logic: the reducer decides, this module shapes what the decision returns.
 */
import { createRuntimeError } from "@moe/contracts";

import type {
  GraphRevisionCommandKind,
  GraphRevisionEvent,
  GraphRevisionReducerResult,
  GraphRevisionState,
} from "./graph-revision-contract.js";
import { deepFreeze } from "./planning-snapshot.js";

export function rejected(error: ReturnType<typeof createRuntimeError>): GraphRevisionReducerResult {
  return Object.freeze({ error, ok: false });
}

export function unknownFailure(): GraphRevisionReducerResult {
  return rejected(createRuntimeError({ code: "UNKNOWN_ERROR" }));
}

export function illegal(
  state: GraphRevisionState,
  kind: GraphRevisionCommandKind,
): GraphRevisionReducerResult {
  return rejected(createRuntimeError({
    code: "ILLEGAL_TRANSITION",
    details: { aggregateKind: "GRAPH_REVISION", commandKind: kind, sourceState: state.lifecycle },
    source: { aggregate: "GRAPH_REVISION", state: state.lifecycle },
  }));
}

/** Approval or activation bytes that do not bind this revision's sealed identity. */
export function rebound(state: GraphRevisionState): GraphRevisionReducerResult {
  return rejected(createRuntimeError({
    code: "REVISION_REBOUND",
    source: { aggregate: "GRAPH_REVISION", state: state.lifecycle },
  }));
}

export function supersededAuthority(state: GraphRevisionState): GraphRevisionReducerResult {
  return rejected(createRuntimeError({
    code: "SUPERSEDED_AUTHORITY",
    source: { aggregate: "GRAPH_REVISION", state: state.lifecycle },
  }));
}

export function versionConflict(
  state: GraphRevisionState,
  expectedVersion: number,
): GraphRevisionReducerResult {
  return rejected(createRuntimeError({
    code: "EXPECTED_VERSION_CONFLICT",
    details: { actualVersion: state.version, expectedVersion },
    source: { aggregate: "GRAPH_REVISION", state: state.lifecycle },
  }));
}

export function accepted(
  state: GraphRevisionState,
  events: readonly GraphRevisionEvent[],
): GraphRevisionReducerResult {
  return deepFreeze({ events, ok: true as const, state });
}

/** Content identity is never part of the patch surface. */
export function clonedState(
  state: GraphRevisionState,
  patch: Partial<Omit<GraphRevisionState, "graphContentHash" | "planHash">>,
): GraphRevisionState {
  return deepFreeze({ ...state, ...patch });
}
