import type {
  PlanningClaimCommand,
  PlanningCreateDraftCommand,
  PlanningReadyCommand,
  PlanningRecoverAbsentCommand,
  PlanningReleaseCommand,
  PlanningRunCommand,
  PlanningRunCommandKind,
  PlanningRunLifecycle,
  PlanningRunReducerResult,
  PlanningRunState,
} from "./planning-contract.js";
import {
  accepted,
  clonedState,
  idempotencyConflict,
  idle,
  illegal,
  finalizing,
  unknownFailure,
  versionConflict,
} from "./planning-results.js";
import {
  activate,
  approvePlan,
  cancel,
  finalize,
  propose,
  revisePlan,
} from "./planning-run-submission.js";
import {
  snapshotPlanningRunContractState,
  validExpansionCreateCommand,
} from "./planning-expansion-validation.js";
import {
  deepFreeze,
  snapshotCommand,
  validExpectedVersion,
  validRef,
} from "./planning-snapshot.js";
import {
  validAbsenceRecovery,
  validClaim,
  validReadiness,
  validRelease,
  validResume,
  validRunKind,
} from "./planning-validation.js";

export const PLANNING_RUN_COMMAND_KINDS = Object.freeze([
  "planning.create_draft", "planning.ready", "planning.claim", "planning.release",
  "planning.recover_absent", "plan.propose", "planning.finalize_submission", "plan.approve",
  "plan.revise", "graph.approve", "goal.cancel", "planning.cancel",
] as const satisfies readonly PlanningRunCommandKind[]);

/** Design section 8.1 rows 280-306 for compound INITIAL and REVISION submissions. */
export const PLANNING_RUN_TRANSITIONS = Object.freeze({
  "planning.create_draft": Object.freeze([]),
  "planning.ready": Object.freeze(["DRAFT"]),
  "planning.claim": Object.freeze(["READY", "PLANNING"]),
  "planning.release": Object.freeze(["PLANNING"]),
  "planning.recover_absent": Object.freeze(["PLANNING"]),
  "plan.propose": Object.freeze(["PLANNING", "SUBMISSION_DRAINING"]),
  "planning.finalize_submission": Object.freeze(["PLANNING", "SUBMISSION_DRAINING"]),
  "plan.approve": Object.freeze(["PLAN_REVIEW", "APPROVED"]),
  "plan.revise": Object.freeze(["PLAN_REVIEW"]),
  "graph.approve": Object.freeze(["PLAN_REVIEW", "APPROVED"]),
  "goal.cancel": Object.freeze([
    "DRAFT", "READY", "PLANNING", "SUBMISSION_DRAINING", "PLAN_REVIEW", "APPROVED",
  ]),
  "planning.cancel": Object.freeze([]),
} as const satisfies Readonly<Record<PlanningRunCommandKind, readonly PlanningRunLifecycle[]>>);

/** The hold binding is carried verbatim and nothing is sealed: creation grants no authority. */
function createExpansion(
  command: PlanningCreateDraftCommand & { readonly runKind: "EXPANSION" },
): PlanningRunReducerResult {
  if (!validExpansionCreateCommand(command)) return unknownFailure();
  const expansion = command.expansion;
  const state = deepFreeze({
    approvedHashes: null, attemptRef: null, expansion, facets: idle(), goalRef: command.goalRef,
    graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT" as const, runId: command.runId,
    runKind: "EXPANSION" as const, sealedHashes: null, sealedProposal: null,
    submissionHash: null, version: 1,
  });
  return accepted(state, [deepFreeze({
    commandId: command.commandId, expansion, goalRef: state.goalRef,
    kind: "PlanningRunCreated" as const, runId: state.runId, runKind: "EXPANSION" as const,
    version: 1,
  })]);
}

function create(command: PlanningCreateDraftCommand): PlanningRunReducerResult {
  if (command.expectedVersion !== 0 || !validRef(command.runId) || !validRef(command.goalRef)
    || !validRunKind(command.runKind)) {
    return unknownFailure();
  }
  if (command.runKind === "EXPANSION") return createExpansion(command);
  const state = deepFreeze({
    approvedHashes: null, attemptRef: null, facets: idle(), goalRef: command.goalRef,
    graphRevisionRef: null, leaseRef: null, lifecycle: "DRAFT" as const, runId: command.runId,
    runKind: command.runKind, sealedHashes: null, submissionHash: null, version: 1,
  });
  return accepted(state, [deepFreeze({
    commandId: command.commandId, goalRef: state.goalRef, kind: "PlanningRunCreated" as const,
    runId: state.runId, runKind: state.runKind, version: 1,
  })]);
}

function ready(state: PlanningRunState, command: PlanningReadyCommand): PlanningRunReducerResult {
  if (!validReadiness(command.witness)) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, { lifecycle: "READY" as const, version: state.version + 1 });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "PlanningRunReady" as const, version: next.version, witness })]);
}

function claim(state: PlanningRunState, command: PlanningClaimCommand): PlanningRunReducerResult {
  const resumeProof: unknown = command.resumeProof;
  const resumed = state.lifecycle === "PLANNING";
  const proofOk = resumed
    ? !state.facets.owned && state.facets.resumable && validResume(resumeProof)
    : resumeProof === undefined;
  if (!validClaim(command.witness) || !proofOk) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, {
    attemptRef: witness.attemptRef,
    facets: { leaseSuspect: false, livePlannerEffect: true, owned: true, resumable: false },
    leaseRef: witness.leaseRef, lifecycle: "PLANNING" as const, version: state.version + 1,
  });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "PlanningClaimed" as const, resumed, version: next.version, witness })]);
}

function release(
  state: PlanningRunState,
  command: PlanningReleaseCommand,
): PlanningRunReducerResult {
  if (!validRelease(command.witness) || !state.facets.owned) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, {
    attemptRef: null, facets: { ...idle(), resumable: true }, leaseRef: null,
    version: state.version + 1,
  });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "PlanningReleased" as const, version: next.version, witness })]);
}

function recoverAbsent(
  state: PlanningRunState,
  command: PlanningRecoverAbsentCommand,
): PlanningRunReducerResult {
  const recoverable = state.facets.owned || state.facets.leaseSuspect;
  if (!validAbsenceRecovery(command.witness) || !recoverable) return illegal(state, command.kind);
  const witness = deepFreeze({ ...command.witness });
  const next = clonedState(state, {
    attemptRef: null, facets: { ...idle(), resumable: true }, leaseRef: null,
    version: state.version + 1,
  });
  return accepted(next, [deepFreeze({ commandId: command.commandId,
    kind: "PlanningRecoveredAbsent" as const, version: next.version, witness })]);
}

function apply(state: PlanningRunState, command: PlanningRunCommand): PlanningRunReducerResult {
  switch (command.kind) {
    case "planning.ready": return ready(state, command);
    case "planning.claim": return claim(state, command);
    case "planning.release": return release(state, command);
    case "planning.recover_absent": return recoverAbsent(state, command);
    case "plan.propose": return propose(state, command);
    case "planning.finalize_submission": return finalize(state, command);
    case "plan.approve": return approvePlan(state, command);
    case "plan.revise": return revisePlan(state, command);
    case "graph.approve": return activate(state, command);
    case "goal.cancel": return cancel(state, command);
    case "planning.create_draft": case "planning.cancel": return illegal(state, command.kind);
  }
}

function safeToApply(state: PlanningRunState, command: PlanningRunCommand): boolean {
  const compound = command.kind === "graph.approve" && state.lifecycle === "PLAN_REVIEW";
  return state.version <= Number.MAX_SAFE_INTEGER - (compound ? 2 : 1);
}

/** Pure lifecycle reduction; the decision ledger owns command replay and conflict lookup. */
export function reducePlanningRun(
  state: PlanningRunState | undefined,
  command: PlanningRunCommand,
): PlanningRunReducerResult {
  const input = snapshotCommand(command, PLANNING_RUN_COMMAND_KINDS) as
    PlanningRunCommand | undefined;
  if (input === undefined) return unknownFailure();
  if (state === undefined) {
    if (input.kind !== "planning.create_draft" || !validRef(input.commandId)) {
      return unknownFailure();
    }
    return create(input);
  }
  const current = snapshotPlanningRunContractState(state);
  if (current === undefined) return unknownFailure();
  if (!validExpectedVersion(input.expectedVersion)) return illegal(current, input.kind);
  if (input.expectedVersion !== current.version) {
    return versionConflict(current, input.expectedVersion);
  }
  if (!validRef(input.commandId)) return idempotencyConflict(current);
  const allowed: readonly PlanningRunLifecycle[] = PLANNING_RUN_TRANSITIONS[input.kind];
  if (!allowed.includes(current.lifecycle)) {
    return current.lifecycle === "SUBMISSION_DRAINING"
      ? finalizing(current) : illegal(current, input.kind);
  }
  if (!safeToApply(current, input)) return illegal(current, input.kind);
  return apply(current, input);
}
