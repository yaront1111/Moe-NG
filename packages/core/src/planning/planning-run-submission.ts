import type {
  GoalCancelPlanningCommand,
  GraphApproveCommand,
  PlanApproveCommand,
  PlanProposeCommand,
  PlanReviseCommand,
  PlanRevisionHashes,
  PlanningFinalizeSubmissionCommand,
  PlanningRunEvent,
  PlanningRunReducerResult,
  PlanningRunState,
} from "./planning-contract.js";
import {
  accepted,
  clonedState,
  idle,
  illegal,
  rejectRun,
  unsupported,
} from "./planning-results.js";
import { deepFreeze, validHex64 } from "./planning-snapshot.js";
import {
  executionBearingKeys,
  sameHashes,
  validActivation,
  validCancellation,
  validEffectTerminal,
  validFinalize,
  validHumanRefusal,
  validPlanApproval,
  validRefusal,
  validRunKind,
  validSeal,
  validSubmission,
} from "./planning-validation.js";

function hashesOf(source: PlanRevisionHashes): PlanRevisionHashes {
  return deepFreeze({
    dependencyHash: source.dependencyHash, graphContentHash: source.graphContentHash,
    planHash: source.planHash, qualityHash: source.qualityHash,
  });
}

export function propose(
  state: PlanningRunState,
  command: PlanProposeCommand,
): PlanningRunReducerResult {
  if (!validSubmission(command.witness) || !validHex64(command.submissionHash)
    || !validRunKind(command.proposalKind)) {
    return illegal(state, command.kind);
  }
  if (command.proposalKind !== "INITIAL") return unsupported("PLANNING_KIND_UNSUPPORTED");
  if (state.submissionHash !== null) {
    return state.submissionHash === command.submissionHash
      ? accepted(clonedState(state), []) : illegal(state, command.kind);
  }
  const proof: unknown = command.effectTerminalProof;
  const proven = proof !== undefined;
  if (!state.facets.owned || (proven && !validEffectTerminal(proof))) {
    return illegal(state, command.kind);
  }
  const draining = state.facets.livePlannerEffect && !proven;
  const next = clonedState(state, {
    facets: { ...state.facets, livePlannerEffect: draining },
    lifecycle: draining ? "SUBMISSION_DRAINING" as const : "PLANNING" as const,
    submissionHash: command.submissionHash, version: state.version + 1,
  });
  return accepted(next, [deepFreeze({ commandId: command.commandId, draining,
    kind: "PlanningSubmissionSealed" as const, submissionHash: command.submissionHash,
    version: next.version })]);
}

/**
 * Foundation Preview admission (design 396 and 1322) runs here, at submission validation, so a
 * multi-node graph can never reach `PLAN_REVIEW`. The refusal branch deliberately skips it: the
 * daemon's follow-up refusal for a refused admission must stay reachable (design row 293).
 */
export function finalize(
  state: PlanningRunState,
  command: PlanningFinalizeSubmissionCommand,
): PlanningRunReducerResult {
  const refusal: unknown = command.refusal;
  const revision: unknown = command.revision;
  if (!validFinalize(command.witness) || state.submissionHash === null
    || (refusal === undefined) === (revision === undefined)) {
    return illegal(state, command.kind);
  }
  if (refusal !== undefined) {
    if (!validRefusal(refusal) || refusal.successorRunId === state.runId) {
      return illegal(state, command.kind);
    }
    return rejectRun(state, command.commandId, refusal.findingsRef, refusal.successorRunId);
  }
  if (!validSeal(revision)) return illegal(state, command.kind);
  const bearing = executionBearingKeys(command.witness);
  if (bearing.length > 1) return unsupported("MULTI_NODE_EXECUTION_UNSUPPORTED", bearing);
  if (bearing.length === 0) return illegal(state, command.kind);
  const hashes = hashesOf(revision);
  const next = clonedState(state, {
    attemptRef: null, facets: idle(), graphRevisionRef: revision.graphRevisionRef, leaseRef: null,
    lifecycle: "PLAN_REVIEW" as const, sealedHashes: hashes, version: state.version + 1,
  });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    graphRevisionRef: revision.graphRevisionRef, hashes, kind: "PlanRevisionCreated" as const,
    version: next.version })]);
}

export function approvePlan(
  state: PlanningRunState,
  command: PlanApproveCommand,
): PlanningRunReducerResult {
  if (!validPlanApproval(command.witness)) return illegal(state, command.kind);
  const hashes = hashesOf(command.witness);
  if (state.lifecycle === "APPROVED") {
    return state.approvedHashes !== null && sameHashes(state.approvedHashes, hashes)
      ? accepted(clonedState(state), []) : illegal(state, command.kind);
  }
  if (state.sealedHashes === null || !sameHashes(state.sealedHashes, hashes)) {
    return illegal(state, command.kind);
  }
  const next = clonedState(state, { approvedHashes: hashes, lifecycle: "APPROVED" as const,
    version: state.version + 1 });
  return accepted(next, [deepFreeze({ commandId: command.commandId, hashes,
    kind: "PlanApproved" as const, version: next.version })]);
}

export function revisePlan(
  state: PlanningRunState,
  command: PlanReviseCommand,
): PlanningRunReducerResult {
  if (!validHumanRefusal(command.witness) || command.witness.successorRunId === state.runId) {
    return illegal(state, command.kind);
  }
  return rejectRun(state, command.commandId, command.witness.findingsRef,
    command.witness.successorRunId);
}

/** J1: plan decision, graph decision, and activation commit as one atomic result. */
export function activate(
  state: PlanningRunState,
  command: GraphApproveCommand,
): PlanningRunReducerResult {
  const sealed = state.sealedHashes;
  const planApproval: unknown = command.planApproval;
  const compound = state.lifecycle === "PLAN_REVIEW";
  if (!validActivation(command.witness) || sealed === null
    || command.witness.graphHash !== sealed.graphContentHash
    || command.witness.qualityHash !== sealed.qualityHash) {
    return illegal(state, command.kind);
  }
  const witness = deepFreeze({ ...command.witness });
  const events: PlanningRunEvent[] = [];
  let version = state.version;
  let approvedHashes = state.approvedHashes;
  if (compound) {
    if (!validPlanApproval(planApproval) || !sameHashes(sealed, planApproval)) {
      return illegal(state, command.kind);
    }
    approvedHashes = hashesOf(planApproval);
    version += 1;
    events.push(deepFreeze({ commandId: command.commandId, hashes: approvedHashes,
      kind: "PlanApproved" as const, version }));
  } else if (planApproval !== undefined || approvedHashes === null
    || !sameHashes(approvedHashes, sealed)) {
    return illegal(state, command.kind);
  }
  version += 1;
  const next = clonedState(state, { approvedHashes, lifecycle: "ACTIVATED" as const, version });
  events.push(deepFreeze({ commandId: command.commandId, kind: "PlanningRunActivated" as const,
    version, witness }));
  return accepted(next, events);
}

export function cancel(
  state: PlanningRunState,
  command: GoalCancelPlanningCommand,
): PlanningRunReducerResult {
  if (!validCancellation(command.witness) || state.facets.livePlannerEffect) {
    return illegal(state, command.kind);
  }
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, { attemptRef: null, facets: idle(), leaseRef: null,
    lifecycle: "CANCELLED" as const, version: state.version + 1 });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "PlanningRunCancelled" as const, version: next.version, witness })]);
}
