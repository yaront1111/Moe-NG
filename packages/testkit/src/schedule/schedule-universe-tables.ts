import type {
  AggregateTransitionTable,
  RacePairRef,
  ScheduleDefinition,
  ScheduleStratum,
  TransitionEdge,
  TransitionRef,
} from "./schedule-model.js";

/**
 * Shared source data for the canonical CORE schedule universe.
 *
 * Every edge below is transcribed from a landed reducer, so the injected tables and the
 * authored schedules cannot drift apart: the gate re-derives the same domain from the
 * reducers themselves and fails on any difference.
 */

function edge(
  aggregate: string,
  fromState: string,
  commandKind: string,
  toState: string,
): TransitionRef {
  return { aggregate, commandKind, fromState, toState };
}

function race(aggregate: string, fromState: string, first: string, second: string): RacePairRef {
  return { aggregate, commandKinds: [first, second], fromState };
}

/** Every unordered pair of commands the author declares concurrently legal in one state. */
function racesIn(
  aggregate: string,
  fromState: string,
  commandKinds: readonly string[],
): readonly RacePairRef[] {
  const sorted = [...commandKinds].sort();
  return Object.freeze(sorted.flatMap((first, index) =>
    sorted.slice(index + 1).map((second) => race(aggregate, fromState, first, second))));
}

/** Creation commands leave no prior state; the pseudo-state keeps the edge set total. */
export const GENESIS_STATE = "GENESIS" as const;

const RUN = "PLANNING_RUN";
const REVISION = "GRAPH_REVISION";

export const EDGE = Object.freeze({
  gActivate: edge("GOAL", "DRAFT", "goal.activate_initial_graph", "EXECUTION_ENABLED"),
  gCancelClosing: edge("GOAL", "CLOSING", "goal.cancel", "CANCELLED"),
  gCancelDraft: edge("GOAL", "DRAFT", "goal.cancel", "CANCELLED"),
  gCancelExecuting: edge("GOAL", "EXECUTION_ENABLED", "goal.cancel", "CANCELLED"),
  gClose: edge("GOAL", "EXECUTION_ENABLED", "goal.close", "CLOSING"),
  gCloseAtomic: edge("GOAL", "EXECUTION_ENABLED", "goal.close", "COMPLETED"),
  gComplete: edge("GOAL", "CLOSING", "goal.close", "COMPLETED"),
  gCreate: edge("GOAL", GENESIS_STATE, "goal.create", "DRAFT"),
  gInvalidate: edge("GOAL", "CLOSING", "goal.qualification_invalidated", "EXECUTION_ENABLED"),
  gPauseDraft: edge("GOAL", "DRAFT", "goal.pause", "DRAFT"),
  gPauseExecuting: edge("GOAL", "EXECUTION_ENABLED", "goal.pause", "EXECUTION_ENABLED"),
  gReopenCancelled: edge("GOAL", "CANCELLED", "goal.reopen_as_revision", "CANCELLED"),
  gReopenCompleted: edge("GOAL", "COMPLETED", "goal.reopen_as_revision", "COMPLETED"),
  gResumeDraft: edge("GOAL", "DRAFT", "goal.resume", "DRAFT"),
  gResumeExecuting: edge("GOAL", "EXECUTION_ENABLED", "goal.resume", "EXECUTION_ENABLED"),
  pActivate: edge("PROJECT", "BOOTSTRAPPING", "project.activate", "READY"),
  pBind: edge("PROJECT", "BOOTSTRAPPING", "project.bind_repository", "BOOTSTRAPPING"),
  pQuiesceBootstrap: edge("PROJECT", "BOOTSTRAPPING", "recovery.restore_quiesce", "QUIESCED"),
  pQuiesceReady: edge("PROJECT", "READY", "recovery.restore_quiesce", "QUIESCED"),
  pRecover: edge("PROJECT", "QUIESCED", "recovery.complete", "READY"),
  pRegister: edge("PROJECT", GENESIS_STATE, "project.register", "BOOTSTRAPPING"),
  revActivate: edge(REVISION, "APPROVED", "graph.approve", "ACTIVE"),
  revActivateCompound: edge(REVISION, "PENDING_APPROVAL", "graph.approve", "ACTIVE"),
  revApprove: edge(REVISION, "PENDING_APPROVAL", "graph.approve", "APPROVED"),
  revCreate: edge(REVISION, GENESIS_STATE, "graph_revision.create", "DRAFT"),
  revRejectApproved: edge(REVISION, "APPROVED", "graph_revision.reject", "REJECTED"),
  revRejectDraft: edge(REVISION, "DRAFT", "graph_revision.reject", "REJECTED"),
  revRejectPending: edge(REVISION, "PENDING_APPROVAL", "graph_revision.reject", "REJECTED"),
  revSubmit: edge(REVISION, "DRAFT", "graph_revision.submit", "PENDING_APPROVAL"),
  /** The only authority-moving transition out of ACTIVE; the kernel binds the successor. */
  revSupersede: edge(REVISION, "ACTIVE", "graph.supersede", "SUPERSEDED"),
  runActivate: edge(RUN, "APPROVED", "graph.approve", "ACTIVATED"),
  runActivateCompound: edge(RUN, "PLAN_REVIEW", "graph.approve", "ACTIVATED"),
  runApprove: edge(RUN, "PLAN_REVIEW", "plan.approve", "APPROVED"),
  runApproveReplay: edge(RUN, "APPROVED", "plan.approve", "APPROVED"),
  runCancelApproved: edge(RUN, "APPROVED", "goal.cancel", "CANCELLED"),
  runCancelDraft: edge(RUN, "DRAFT", "goal.cancel", "CANCELLED"),
  runCancelDraining: edge(RUN, "SUBMISSION_DRAINING", "goal.cancel", "CANCELLED"),
  runCancelPlanning: edge(RUN, "PLANNING", "goal.cancel", "CANCELLED"),
  runCancelReady: edge(RUN, "READY", "goal.cancel", "CANCELLED"),
  runCancelReview: edge(RUN, "PLAN_REVIEW", "goal.cancel", "CANCELLED"),
  runClaim: edge(RUN, "READY", "planning.claim", "PLANNING"),
  runCreate: edge(RUN, GENESIS_STATE, "planning.create_draft", "DRAFT"),
  runPropose: edge(RUN, "PLANNING", "plan.propose", "PLANNING"),
  runProposeDrain: edge(RUN, "PLANNING", "plan.propose", "SUBMISSION_DRAINING"),
  runProposeReplay: edge(RUN, "SUBMISSION_DRAINING", "plan.propose", "SUBMISSION_DRAINING"),
  runReady: edge(RUN, "DRAFT", "planning.ready", "READY"),
  runRecover: edge(RUN, "PLANNING", "planning.recover_absent", "PLANNING"),
  runRefuse: edge(RUN, "PLANNING", "planning.finalize_submission", "REJECTED"),
  runRefuseDrained: edge(RUN, "SUBMISSION_DRAINING", "planning.finalize_submission", "REJECTED"),
  runRelease: edge(RUN, "PLANNING", "planning.release", "PLANNING"),
  runResume: edge(RUN, "PLANNING", "planning.claim", "PLANNING"),
  runRevise: edge(RUN, "PLAN_REVIEW", "plan.revise", "REJECTED"),
  runSeal: edge(RUN, "PLANNING", "planning.finalize_submission", "PLAN_REVIEW"),
  runSealDrained: edge(RUN, "SUBMISSION_DRAINING", "planning.finalize_submission", "PLAN_REVIEW"),
});

export const RACE = Object.freeze({
  cCancelClose: race("GOAL", "CLOSING", "goal.cancel", "goal.close"),
  cCancelInvalidate: race("GOAL", "CLOSING", "goal.cancel", "goal.qualification_invalidated"),
  cCloseInvalidate: race("GOAL", "CLOSING", "goal.close", "goal.qualification_invalidated"),
  dActivateCancel: race("GOAL", "DRAFT", "goal.activate_initial_graph", "goal.cancel"),
  dActivatePause: race("GOAL", "DRAFT", "goal.activate_initial_graph", "goal.pause"),
  dActivateResume: race("GOAL", "DRAFT", "goal.activate_initial_graph", "goal.resume"),
  dCancelPause: race("GOAL", "DRAFT", "goal.cancel", "goal.pause"),
  dCancelResume: race("GOAL", "DRAFT", "goal.cancel", "goal.resume"),
  dPauseResume: race("GOAL", "DRAFT", "goal.pause", "goal.resume"),
  eCancelClose: race("GOAL", "EXECUTION_ENABLED", "goal.cancel", "goal.close"),
  eCancelPause: race("GOAL", "EXECUTION_ENABLED", "goal.cancel", "goal.pause"),
  eCancelResume: race("GOAL", "EXECUTION_ENABLED", "goal.cancel", "goal.resume"),
  eClosePause: race("GOAL", "EXECUTION_ENABLED", "goal.close", "goal.pause"),
  eCloseResume: race("GOAL", "EXECUTION_ENABLED", "goal.close", "goal.resume"),
  ePauseResume: race("GOAL", "EXECUTION_ENABLED", "goal.pause", "goal.resume"),
  pActivateBind: race("PROJECT", "BOOTSTRAPPING", "project.activate", "project.bind_repository"),
  pActivateQuiesce: race("PROJECT", "BOOTSTRAPPING", "project.activate", "recovery.restore_quiesce"),
  pBindQuiesce: race("PROJECT", "BOOTSTRAPPING", "project.bind_repository", "recovery.restore_quiesce"),
});

/** Planning-run contention, grouped by the state whose command fan-in produces it. */
export const RUN_RACE = Object.freeze({
  approvedDecision: racesIn(RUN, "APPROVED", ["goal.cancel", "graph.approve", "plan.approve"]),
  draftReadiness: racesIn(RUN, "DRAFT", ["goal.cancel", "planning.ready"]),
  drain: racesIn(RUN, "SUBMISSION_DRAINING",
    ["goal.cancel", "plan.propose", "planning.finalize_submission"]),
  lease: racesIn(RUN, "PLANNING",
    ["goal.cancel", "planning.claim", "planning.recover_absent", "planning.release"]),
  readyClaim: racesIn(RUN, "READY", ["goal.cancel", "planning.claim"]),
  recovery: racesIn(RUN, "PLANNING", ["plan.propose", "planning.finalize_submission",
    "planning.recover_absent", "planning.release"]),
  review: racesIn(RUN, "PLAN_REVIEW",
    ["goal.cancel", "graph.approve", "plan.approve", "plan.revise"]),
  seal: racesIn(RUN, "PLANNING",
    ["plan.propose", "planning.claim", "planning.finalize_submission"]),
  submission: racesIn(RUN, "PLANNING",
    ["goal.cancel", "plan.propose", "planning.finalize_submission"]),
});

export const REVISION_RACE = Object.freeze({
  approved: racesIn(REVISION, "APPROVED", ["graph.approve", "graph_revision.reject"]),
  draft: racesIn(REVISION, "DRAFT", ["graph_revision.reject", "graph_revision.submit"]),
  pending: racesIn(REVISION, "PENDING_APPROVAL", ["graph.approve", "graph_revision.reject"]),
});

/** Named fault boundaries from design 20.2 #CORE-S4: abstract points, never executed here. */
export const FAULT = Object.freeze({
  ack: "boundary.transaction_ack",
  artifact: "boundary.artifact_write",
  begin: "boundary.transaction_begin",
  checkpoint: "boundary.wal_checkpoint",
  commit: "boundary.transaction_commit",
  effect: "boundary.effect_activation",
  lock: "boundary.lock_acquire",
  outbox: "boundary.outbox_publish",
  registration: "boundary.registration",
  restore: "boundary.restore_slot_switch",
});

export const CORE_FAULT_BOUNDARIES: readonly string[] = Object.freeze(
  [...new Set(Object.values(FAULT))].sort(),
);

export const ALL_LANDED_EDGES: readonly TransitionRef[] = Object.freeze(Object.values(EDGE));

/** Commands whose landed table row is empty because they create the aggregate. */
export const GENESIS_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  GOAL: Object.freeze(["goal.create"]),
  GRAPH_REVISION: Object.freeze(["graph_revision.create"]),
  PLANNING_RUN: Object.freeze(["planning.create_draft"]),
  PROJECT: Object.freeze(["project.register"]),
});

/** Commands whose landed table row is empty because no state admits them at all. */
export const NEVER_LEGAL_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  GOAL: Object.freeze([]),
  GRAPH_REVISION: Object.freeze([]),
  PLANNING_RUN: Object.freeze(["planning.cancel"]),
  PROJECT: Object.freeze([]),
});

function tableFor(aggregate: string): AggregateTransitionTable {
  const edges: readonly TransitionEdge[] = ALL_LANDED_EDGES
    .filter((item) => item.aggregate === aggregate)
    .map(({ commandKind, fromState, toState }) => ({ commandKind, fromState, toState }));
  return { aggregate, edges };
}

/** Injected tables stay in lockstep with EDGE, so no schedule can cite a phantom edge. */
export const CORE_TRANSITION_TABLES: readonly AggregateTransitionTable[] = Object.freeze([
  tableFor("GOAL"),
  tableFor(REVISION),
  tableFor(RUN),
  tableFor("PROJECT"),
]);

export function defineSchedule(
  scheduleId: string,
  obligationRefs: readonly string[],
  stratum: ScheduleStratum,
  transitionRefs: readonly TransitionRef[],
  racePairRefs: readonly RacePairRef[],
  faultBoundaryRefs: readonly string[],
): ScheduleDefinition {
  return { faultBoundaryRefs, obligationRefs, racePairRefs, scheduleId, stratum, transitionRefs };
}
