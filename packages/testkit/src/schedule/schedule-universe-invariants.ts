import type {
  AggregateTransitionTable,
  RacePairRef,
  ScheduleDefinition,
  ScheduleStratum,
  TransitionEdge,
  TransitionRef,
} from "./schedule-model.js";

/**
 * Canonical CORE schedule universe, invariant half (design 20.1 #CORE-I1..#CORE-I22).
 *
 * Landed aggregates (PROJECT, GOAL) carry real transition tables, so their schedules are
 * checked against the derived edge and race-pair universe. Aggregates whose reducers have
 * not landed are referenced abstractly through ABSTRACT_EDGE and resolve to an auditable
 * UNKNOWN rather than a fabricated PASS.
 */

function edge(aggregate: string, fromState: string, commandKind: string, toState: string): TransitionRef {
  return { aggregate, commandKind, fromState, toState };
}

function race(aggregate: string, fromState: string, first: string, second: string): RacePairRef {
  return { aggregate, commandKinds: [first, second], fromState };
}

/** Creation commands leave no prior state; the pseudo-state keeps the edge set total. */
export const GENESIS_STATE = "GENESIS" as const;

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
});

/** Aggregates whose reducers have not landed: referenced, never asserted. */
export const ABSTRACT_EDGE = Object.freeze({
  graphActivate: edge("GRAPH_REVISION", "APPROVED", "graph.activate", "ACTIVE"),
  graphSupersede: edge("GRAPH_REVISION", "ACTIVE", "graph.activate", "SUPERSEDED"),
  planClaim: edge("PLANNING_RUN", "READY", "planning.claim", "PLANNING"),
  planSubmit: edge("PLANNING_RUN", "PLANNING", "planning.submit", "PLAN_REVIEW"),
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

function tableFor(aggregate: string): AggregateTransitionTable {
  const edges: readonly TransitionEdge[] = ALL_LANDED_EDGES
    .filter((item) => item.aggregate === aggregate)
    .map(({ commandKind, fromState, toState }) => ({ commandKind, fromState, toState }));
  return { aggregate, edges };
}

/** Injected tables stay in lockstep with EDGE, so no schedule can cite a phantom edge. */
export const CORE_TRANSITION_TABLES: readonly AggregateTransitionTable[] = Object.freeze([
  tableFor("GOAL"),
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

const two = "TWO_EVENT" as const;
const multi = "MULTI_EVENT" as const;

export const CORE_INVARIANT_SCHEDULES: readonly ScheduleDefinition[] = Object.freeze([
  defineSchedule("CORE-I1-PAIR", ["CORE-I1"], two,
    [EDGE.gActivate, EDGE.gCancelDraft], [RACE.dActivateCancel], [FAULT.lock]),
  defineSchedule("CORE-I1-PARTIAL-ORDER", ["CORE-I1"], multi,
    [EDGE.gActivate, EDGE.gCancelDraft, EDGE.gPauseDraft], [RACE.dCancelPause],
    [FAULT.lock, FAULT.commit]),
  defineSchedule("CORE-I2-PAIR", ["CORE-I2"], two,
    [EDGE.pQuiesceReady, EDGE.pRecover], [RACE.pActivateQuiesce], [FAULT.restore]),
  defineSchedule("CORE-I3-PAIR", ["CORE-I3"], two,
    ALL_LANDED_EDGES, [RACE.cCloseInvalidate], [FAULT.commit]),
  defineSchedule("CORE-I4-PAIR", ["CORE-I4"], two,
    [EDGE.gClose, EDGE.gInvalidate], [RACE.cCancelInvalidate], [FAULT.artifact]),
  defineSchedule("CORE-I4-PARTIAL-ORDER", ["CORE-I4"], multi,
    [EDGE.gClose, EDGE.gInvalidate, EDGE.gComplete], [RACE.cCloseInvalidate, RACE.cCancelClose],
    [FAULT.artifact, FAULT.commit]),
  defineSchedule("CORE-I5-PAIR", ["CORE-I5"], two,
    [EDGE.gCloseAtomic], [RACE.eCancelClose], [FAULT.commit, FAULT.ack]),
  defineSchedule("CORE-I6-PAIR", ["CORE-I6"], two,
    [EDGE.gClose, EDGE.gComplete], [RACE.eClosePause], [FAULT.commit]),
  defineSchedule("CORE-I6-PARTIAL-ORDER", ["CORE-I6"], multi,
    [EDGE.gClose, EDGE.gComplete, EDGE.gInvalidate], [RACE.cCloseInvalidate],
    [FAULT.commit, FAULT.artifact]),
  defineSchedule("CORE-I7-PAIR", ["CORE-I7"], two,
    [EDGE.gPauseExecuting, EDGE.gResumeExecuting], [RACE.ePauseResume], [FAULT.begin]),
  defineSchedule("CORE-I8-PAIR", ["CORE-I8"], two,
    [EDGE.gReopenCompleted, ABSTRACT_EDGE.graphSupersede], [RACE.eCancelPause],
    [FAULT.registration]),
  defineSchedule("CORE-I8-PARTIAL-ORDER", ["CORE-I8"], multi,
    [EDGE.gReopenCompleted, ABSTRACT_EDGE.graphSupersede, ABSTRACT_EDGE.graphActivate],
    [RACE.dActivateResume], [FAULT.registration, FAULT.effect]),
  defineSchedule("CORE-I9-PAIR", ["CORE-I9"], two,
    [EDGE.gPauseDraft, EDGE.gResumeDraft], [RACE.dPauseResume], [FAULT.ack]),
  defineSchedule("CORE-I10-PAIR", ["CORE-I10"], two,
    [EDGE.gActivate, EDGE.gReopenCancelled], [RACE.dActivatePause], [FAULT.begin]),
  defineSchedule("CORE-I11-PAIR", ["CORE-I11"], two,
    [EDGE.gActivate, EDGE.gCancelExecuting], [RACE.eCancelResume], [FAULT.effect]),
  defineSchedule("CORE-I12-PAIR", ["CORE-I12"], two,
    [EDGE.gActivate, EDGE.gCloseAtomic], [RACE.dCancelResume], [FAULT.commit]),
  defineSchedule("CORE-I13-PAIR", ["CORE-I13"], two,
    [EDGE.pBind, EDGE.pActivate], [RACE.pActivateBind], [FAULT.registration]),
  defineSchedule("CORE-I14-PAIR", ["CORE-I14"], two,
    [EDGE.gClose, EDGE.gCloseAtomic], [RACE.eCloseResume], [FAULT.artifact]),
  defineSchedule("CORE-I14-PARTIAL-ORDER", ["CORE-I14"], multi,
    [EDGE.gClose, EDGE.gCloseAtomic, EDGE.gComplete], [RACE.cCancelClose],
    [FAULT.artifact, FAULT.checkpoint]),
  defineSchedule("CORE-I15-PAIR", ["CORE-I15"], two,
    [EDGE.pBind, EDGE.pQuiesceBootstrap], [RACE.pBindQuiesce], [FAULT.artifact]),
  defineSchedule("CORE-I16-PAIR", ["CORE-I16"], two,
    [EDGE.gCancelExecuting, EDGE.gResumeExecuting], [RACE.eCancelPause], [FAULT.outbox]),
  defineSchedule("CORE-I16-PARTIAL-ORDER", ["CORE-I16"], multi,
    [EDGE.gCancelExecuting, EDGE.gResumeExecuting, EDGE.gPauseExecuting],
    [RACE.ePauseResume, RACE.eCancelResume], [FAULT.outbox, FAULT.effect]),
  defineSchedule("CORE-I17-PAIR", ["CORE-I17"], two,
    [EDGE.pQuiesceReady, EDGE.pRecover], [RACE.pActivateQuiesce], [FAULT.checkpoint]),
  defineSchedule("CORE-I17-PARTIAL-ORDER", ["CORE-I17"], multi,
    [EDGE.pQuiesceReady, EDGE.pRecover, EDGE.pQuiesceBootstrap], [RACE.pBindQuiesce],
    [FAULT.checkpoint, FAULT.begin]),
  defineSchedule("CORE-I18-PAIR", ["CORE-I18"], two,
    [EDGE.gInvalidate, EDGE.gClose], [RACE.cCloseInvalidate], [FAULT.ack]),
  defineSchedule("CORE-I19-PAIR", ["CORE-I19"], two,
    [EDGE.gCancelClosing, EDGE.gReopenCancelled], [RACE.cCancelClose], [FAULT.outbox]),
  defineSchedule("CORE-I20-PAIR", ["CORE-I20"], two,
    [EDGE.gPauseExecuting, EDGE.gResumeDraft], [RACE.dPauseResume], [FAULT.begin]),
  defineSchedule("CORE-I21-PAIR", ["CORE-I21"], two,
    [EDGE.gActivate, EDGE.gPauseExecuting], [RACE.dCancelPause], [FAULT.lock]),
  defineSchedule("CORE-I21-PARTIAL-ORDER", ["CORE-I21"], multi,
    [EDGE.gActivate, EDGE.gPauseExecuting, EDGE.gResumeExecuting, EDGE.gCancelDraft],
    [RACE.eClosePause], [FAULT.lock, FAULT.ack]),
  defineSchedule("CORE-I22-PAIR", ["CORE-I22"], two,
    [EDGE.pRegister, EDGE.pQuiesceReady, EDGE.pRecover], [RACE.pActivateQuiesce], [FAULT.restore]),
  defineSchedule("CORE-I22-PARTIAL-ORDER", ["CORE-I22"], multi,
    [EDGE.pRegister, EDGE.pQuiesceReady, EDGE.pRecover, EDGE.pQuiesceBootstrap],
    [RACE.pActivateBind], [FAULT.restore, FAULT.checkpoint]),
]);
