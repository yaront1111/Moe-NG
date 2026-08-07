/**
 * Compatibility facade for the planning-run contract. The declarations live in two leaves —
 * `planning-command-contract.ts` (intent: kinds, witnesses, proofs, commands) and
 * `planning-event-contract.ts` (observation: lifecycle, state, events, results) — and this
 * module re-exports the identical public surface so every existing `planning-contract.js`
 * import keeps working. Names are pinned explicitly rather than wildcarded so a new leaf
 * export can never silently widen this surface. Type-only: the module has no runtime exports.
 */
export type {
  GoalCancelPlanningCommand,
  GraphApproveCommand,
  NodeSummary,
  PlanApprovalWitness,
  PlanApproveCommand,
  PlanProposeCommand,
  PlanReviseCommand,
  PlanRevisionHashes,
  PlanRevisionSeal,
  PlanSubmissionWitness,
  PlanningAbsenceRecoveryWitness,
  PlanningActivationWitness,
  PlanningCancelCommand,
  PlanningCancellationWitness,
  PlanningClaimCommand,
  PlanningClaimWitness,
  PlanningCreateDraftCommand,
  PlanningEffectTerminalProof,
  PlanningFinalizeSubmissionCommand,
  PlanningReadinessWitness,
  PlanningReadyCommand,
  PlanningRecoverAbsentCommand,
  PlanningRefusalWitness,
  PlanningReleaseCommand,
  PlanningReleaseWitness,
  PlanningResumeProof,
  PlanningRunCommand,
  PlanningRunCommandKind,
  PlanningRunKind,
  SubmissionFinalizeWitness,
} from "./planning-command-contract.js";
export type {
  PlanApproved,
  PlanRevisionCreated,
  PlanningClaimed,
  PlanningRecoveredAbsent,
  PlanningReleased,
  PlanningRunAcceptedResult,
  PlanningRunActivated,
  PlanningRunCancelled,
  PlanningRunCreated,
  PlanningRunEvent,
  PlanningRunFacets,
  PlanningRunLifecycle,
  PlanningRunReady,
  PlanningRunReducerResult,
  PlanningRunRejected,
  PlanningRunRejectedResult,
  PlanningRunState,
  PlanningRunSuccessorData,
  PlanningSubmissionSealed,
  PlanningUnsupportedReason,
  PlanningUnsupportedResult,
} from "./planning-event-contract.js";
