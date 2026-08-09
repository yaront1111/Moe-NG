import { createRuntimeError } from "@moe/contracts";

import type { PlanningExpansionHoldBinding } from "./planning-command-contract.js";
import type {
  PlanningRunCommandKind,
  PlanningRunEvent,
  PlanningRunFacets,
  PlanningRunReducerResult,
  PlanningRunState,
  PlanningRunSuccessorData,
  PlanningUnsupportedReason,
} from "./planning-contract.js";
import { validExpansionHoldBinding } from "./planning-expansion-validation.js";
import { deepFreeze } from "./planning-snapshot.js";

/**
 * Every registry-backed rejection raised from this aggregate tags `PLANNING_RUN`. Only the
 * codes whose `validSources` include `PLANNING_RUN` may be used here: `ILLEGAL_TRANSITION`,
 * `EXPECTED_VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, and `PLANNING_SUBMISSION_FINALIZING`.
 * `createRuntimeError` silently degrades any other pairing to `UNKNOWN_ERROR`.
 */
export function rejected(error: ReturnType<typeof createRuntimeError>): PlanningRunReducerResult {
  return Object.freeze({ error, ok: false });
}

export function unknownFailure(): PlanningRunReducerResult {
  return rejected(createRuntimeError({ code: "UNKNOWN_ERROR" }));
}

export function illegal(
  state: PlanningRunState,
  kind: PlanningRunCommandKind,
): PlanningRunReducerResult {
  return rejected(createRuntimeError({
    code: "ILLEGAL_TRANSITION",
    details: { aggregateKind: "PLANNING_RUN", commandKind: kind, sourceState: state.lifecycle },
    source: { aggregate: "PLANNING_RUN", state: state.lifecycle },
  }));
}

export function versionConflict(
  state: PlanningRunState,
  expectedVersion: number,
): PlanningRunReducerResult {
  return rejected(createRuntimeError({
    code: "EXPECTED_VERSION_CONFLICT",
    details: { actualVersion: state.version, expectedVersion },
    source: { aggregate: "PLANNING_RUN", state: state.lifecycle },
  }));
}

export function idempotencyConflict(state: PlanningRunState): PlanningRunReducerResult {
  return rejected(createRuntimeError({
    code: "IDEMPOTENCY_CONFLICT",
    source: { aggregate: "PLANNING_RUN", state: state.lifecycle },
  }));
}

/** A sealed submission owns its sole finalization path; the drain fences everything else. */
export function finalizing(state: PlanningRunState): PlanningRunReducerResult {
  return rejected(createRuntimeError({
    code: "PLANNING_SUBMISSION_FINALIZING",
    details: { sourceState: state.lifecycle },
    source: { aggregate: "PLANNING_RUN", state: state.lifecycle },
  }));
}

/** Carries no `RuntimeError`: see `PlanningUnsupportedResult` for why the registry cannot. */
export function unsupported(
  reason: PlanningUnsupportedReason,
  executionBearingNodeKeys: readonly string[] = [],
): PlanningRunReducerResult {
  return deepFreeze({
    executionBearingNodeKeys, ok: false as const, reason, unsupported: true as const,
  });
}

export function accepted(
  state: PlanningRunState,
  events: readonly PlanningRunEvent[],
): PlanningRunReducerResult {
  return deepFreeze({ events, ok: true as const, state });
}

export function idle(): PlanningRunFacets {
  return { leaseSuspect: false, livePlannerEffect: false, owned: false, resumable: false };
}

export function clonedState(
  state: PlanningRunState,
  patch: Partial<PlanningRunState> = {},
): PlanningRunState {
  const facets = patch.facets ?? state.facets;
  return deepFreeze({ ...state, ...patch, facets: { ...facets } });
}

/** Rebuilt key by key, so an EXPANSION successor can never alias the rejected run's binding. */
function carriedBinding(value: PlanningExpansionHoldBinding): PlanningExpansionHoldBinding {
  return {
    generation: value.generation, goalVersion: value.goalVersion, graphEpoch: value.graphEpoch,
    holdId: value.holdId, lifecycle: "ACTIVE", parentNodeRef: value.parentNodeRef,
    parentRunRef: value.parentRunRef, proposalBaseHash: value.proposalBaseHash,
    sourceFingerprint: value.sourceFingerprint, truthClass: "DAEMON_VERIFIED",
    workerHandoff: { digest: value.workerHandoff.digest, ref: value.workerHandoff.ref },
  };
}

/**
 * Successor data is built from literals so it can never alias the rejected run's objects.
 *
 * An EXPANSION successor carries the same hold binding forward and seals nothing: dropping it
 * would produce a state claiming `runKind: "EXPANSION"` with no binding, which
 * `validExpansionContractState` refuses outright, silently degrading the successor's NEXT
 * command to `UNKNOWN_ERROR`. Carrying the binding is containment evidence only and grants no
 * approval, activation, or transition.
 */
export function successorData(
  state: PlanningRunState,
  runId: string,
): PlanningRunSuccessorData {
  const base = {
    approvedHashes: null, attemptRef: null, facets: idle(), goalRef: state.goalRef,
    graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT" as const, runId,
    runKind: state.runKind, sealedHashes: null, submissionHash: null, version: 1 as const,
  };
  const bound: unknown = (state as { readonly expansion?: unknown }).expansion;
  if (state.runKind !== "EXPANSION" || !validExpansionHoldBinding(bound)) return deepFreeze(base);
  const carried = { ...base, expansion: carriedBinding(bound), sealedProposal: null };
  return deepFreeze(carried);
}

export function rejectRun(
  state: PlanningRunState,
  commandId: string,
  findingsRef: string,
  successorRunId: string,
): PlanningRunReducerResult {
  const successor = successorData(state, successorRunId);
  const next = clonedState(state, {
    attemptRef: null, facets: idle(), leaseRef: null, lifecycle: "REJECTED" as const,
    version: state.version + 1,
  });
  const event = deepFreeze({ commandId, findingsRef, kind: "PlanningRunRejected" as const,
    successorRunId, version: next.version });
  return deepFreeze({ events: [event], ok: true as const, state: next, successor });
}
