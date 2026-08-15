export {
  PROJECT_COMMAND_KINDS, PROJECT_TRANSITIONS, reduceProject,
} from "./project/project-reducer.js";
export type {
  ProjectAcceptedResult, ProjectActivateCommand, ProjectActivationWitness,
  ProjectBindRepositoryCommand, ProjectCommand, ProjectCommandKind, ProjectEvent,
  ProjectLifecycle, ProjectReducerResult, ProjectRegisterCommand, ProjectRejectedResult,
  ProjectState, RecoveryCompleteCommand, RecoveryCompletionWitness, RepositoryObservation,
  RestoreQuiesceCommand, RestoreQuiesceWitness,
} from "./project/project-contract.js";

/**
 * The content-addressed project configuration codec. `settingsDigest` is derived
 * from a domain-separated SHA-256 over the canonical settings bytes, so every
 * consumer that decodes these bytes agrees on the same authority or refuses.
 */
export {
  PROJECT_CONFIGURATION_CODEC_CODES, PROJECT_CONFIGURATION_CODEC_LAYERS,
  PROJECT_CONFIGURATION_SETTINGS_DIGEST_DOMAIN, createProjectConfigurationManifest,
  decodeProjectConfigurationManifestBytes, encodeProjectConfigurationManifest,
} from "./configuration/project-configuration-manifest.js";
export type {
  ProjectConfigurationCodecCode, ProjectConfigurationCodecLayer,
  ProjectConfigurationCodecRefusal, ProjectConfigurationManifestCreateResult,
  ProjectConfigurationManifestDecodeResult, ProjectConfigurationManifestEncodeResult,
} from "./configuration/project-configuration-manifest.js";

export {
  GOAL_COMMAND_KINDS, GOAL_TRANSITIONS, reduceGoal,
} from "./goal/goal-reducer.js";
export type {
  AcceptanceClosureWitness, CancellationAuthorizationWitness, GoalAcceptedResult,
  GoalActivateInitialGraphCommand, GoalCancelCommand, GoalCloseCommand, GoalCommand,
  GoalCommandKind, GoalCreateCommand, GoalEvent, GoalLifecycle, GoalPauseCommand,
  GoalQualificationInvalidatedCommand, GoalRecoveryFacets, GoalReducerResult,
  GoalRejectedResult, GoalReopenAsRevisionCommand, GoalResumeCommand, GoalSchedulingControl,
  GoalState, GoalSuccessorData, InitialGraphActivationWitness, ProjectReadyWitness,
  QualificationInvalidationWitness, ReopenAuthorizationWitness, ZeroAuthorityWitness,
} from "./goal/goal-contract.js";

export {
  PLANNING_RUN_COMMAND_KINDS,
  PLANNING_RUN_TRANSITIONS,
  reducePlanningRun,
} from "./planning/planning-run-reducer.js";
export type {
  GoalCancelPlanningCommand,
  GraphApproveCommand,
  NodeSummary,
  PlanApprovalWitness,
  PlanApproveCommand,
  PlanApproved,
  PlanProposeCommand,
  PlanReviseCommand,
  PlanRevisionCreated,
  PlanRevisionHashes,
  PlanRevisionSeal,
  PlanSubmissionWitness,
  PlanningAbsenceRecoveryWitness,
  PlanningActivationWitness,
  PlanningCancelCommand,
  PlanningCancellationWitness,
  PlanningClaimCommand,
  PlanningClaimWitness,
  PlanningClaimed,
  PlanningCreateDraftCommand,
  PlanningEffectTerminalProof,
  PlanningFinalizeSubmissionCommand,
  PlanningReadinessWitness,
  PlanningReadyCommand,
  PlanningRecoverAbsentCommand,
  PlanningRecoveredAbsent,
  PlanningRefusalWitness,
  PlanningReleaseCommand,
  PlanningReleaseWitness,
  PlanningReleased,
  PlanningResumeProof,
  PlanningRunAcceptedResult,
  PlanningRunActivated,
  PlanningRunCancelled,
  PlanningRunCommand,
  PlanningRunCommandKind,
  PlanningRunCreated,
  PlanningRunEvent,
  PlanningRunFacets,
  PlanningRunKind,
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
  SubmissionFinalizeWitness,
} from "./planning/planning-contract.js";

export {
  GRAPH_REVISION_COMMAND_KINDS,
  GRAPH_REVISION_TRANSITIONS,
  reduceGraphRevision,
} from "./planning/graph-revision-reducer.js";
export type {
  GraphActivationBinding,
  GraphRevisionAcceptedResult,
  GraphRevisionActivated,
  GraphRevisionActivationWitness,
  GraphRevisionApprovalWitness,
  GraphRevisionApproveCommand,
  GraphRevisionApproved,
  GraphRevisionCommand,
  GraphRevisionCommandKind,
  GraphRevisionCreateCommand,
  GraphRevisionCreated,
  GraphRevisionEvent,
  GraphRevisionLifecycle,
  GraphRevisionReducerResult,
  GraphRevisionRefusalWitness,
  GraphRevisionRejectCommand,
  GraphRevisionRejected,
  GraphRevisionRejectedResult,
  GraphRevisionState,
  GraphRevisionSubmitCommand,
  GraphRevisionSubmitted,
  GraphRevisionSupersedeCommand,
  GraphSubmissionWitness,
} from "./planning/graph-revision-contract.js";

export { evaluatePolicy } from "./policy/policy-evaluation.js";
export {
  CORE_DECISION_REASON_OBLIGATION,
  CORE_STEP_UP_OBLIGATION,
  POLICY_AUTO_APPROVAL_TIERS,
  POLICY_OBLIGATION_KINDS,
  POLICY_OUTCOMES,
  POLICY_OUTCOME_DOMINANCE,
  POLICY_REASON_CODES,
  POLICY_RISK_TIERS,
  POLICY_RULE_EFFECTS,
} from "./policy/policy-contract.js";
export type {
  PolicyAutoApprovalOptIn,
  PolicyAutoApprovalTier,
  PolicyDecisionRecord,
  PolicyEvaluationAcceptedResult,
  PolicyEvaluationInput,
  PolicyEvaluationRejectedResult,
  PolicyEvaluationResult,
  PolicyFactInput,
  PolicyObligation,
  PolicyObligationKind,
  PolicyOutcome,
  PolicyReasonCode,
  PolicyRecordedFact,
  PolicyRiskAssessment,
  PolicyRiskTier,
  PolicyRule,
  PolicyRuleEffect,
  PolicySlice,
  PolicyWaiver,
} from "./policy/policy-contract.js";

export {
  applyApprovalCommand,
  applyApprovalInvalidation,
  evaluateCarryForward,
} from "./policy/approval-invalidation.js";
export {
  APPROVAL_ACTOR_KINDS,
  APPROVAL_COMMAND_KINDS,
  CARRY_FORWARD_REASON_CODES,
} from "./policy/approval-contract.js";
export type {
  ApprovalAcceptedResult,
  ApprovalActorKind,
  ApprovalCommand,
  ApprovalCommandKind,
  ApprovalDecideCommand,
  ApprovalDecision,
  ApprovalDecisionRecord,
  ApprovalDependencyChanges,
  ApprovalImpactSet,
  ApprovalInvalidationInput,
  ApprovalLifecycle,
  ApprovalRejectedResult,
  ApprovalResult,
  ApprovalSuccessorLink,
  ApprovalValidity,
  ApprovalWithdrawCommand,
  CarryForwardInput,
  CarryForwardReasonCode,
  CarryForwardVerdict,
} from "./policy/approval-contract.js";

export {
  EXPANSION_HOLD_CAUSES, EXPANSION_HOLD_COMMAND_KINDS,
  EXPANSION_HOLD_ERROR_CODES, EXPANSION_HOLD_LAYERS, reduceExpansionPlanningHold,
} from "./expansion/expansion-planning-hold.js";
export type {
  CreateExpansionHoldCommand, ExpansionHandoffBinding, ExpansionHoldCause,
  ExpansionHoldErrorCode, ExpansionHoldLayer, ExpansionHoldLifecycle,
  ExpansionPlanningHoldCommand, ExpansionPlanningHoldEvent, ExpansionPlanningHoldResult,
  ExpansionPlanningHoldState, ExpansionReleaseEvidence, ExpansionTerminalProof,
  TransitionExpansionHoldCommand,
} from "./expansion/expansion-planning-hold.js";

/**
 * The core half of the expansion admission protocol: bind one scheduler-admitted
 * expansion to an approval identity, then approve it manually.
 *
 * CURATED, NOT COMPLETE. `canonicalBytes`, `expansionIdentityOf` and
 * `refuseExpansionPreparation` are exported from their modules so the approval
 * module can re-derive and refuse, and they stay unpublished on purpose: a
 * consumer that could recompute the canonical identity itself would be able to
 * fork the identity authority these two modules exist to hold, and a consumer
 * never needs to construct a refusal it is supposed to receive.
 */
export {
  EXPANSION_PREPARATION_CODES, EXPANSION_PREPARATION_COMPONENTS, EXPANSION_PREPARATION_LAYERS,
  prepareExpansion,
} from "./expansion/expansion-preparation.js";
export type {
  ExpansionAdmittedFacts, ExpansionApprovalCriteria, ExpansionBudgetReservationFacts,
  ExpansionFairnessFacts, ExpansionFenceFacts, ExpansionFundingFacts, ExpansionPolicyFacts,
  ExpansionPreparation, ExpansionPreparationCode, ExpansionPreparationComponent,
  ExpansionPreparationInput, ExpansionPreparationLayer, ExpansionPreparationRefusal,
  ExpansionPreparationResult, ExpansionPreparationSources, ExpansionPreparedFacts,
  ExpansionResourceReservationFacts,
} from "./expansion/expansion-preparation.js";

export {
  EXPANSION_APPROVAL_CODES, EXPANSION_APPROVAL_COMPONENTS, EXPANSION_APPROVAL_LAYERS,
  approveExpansionManually,
} from "./expansion/expansion-approval.js";
export type {
  ExpansionApprovalBinding, ExpansionApprovalClaim, ExpansionApprovalCode,
  ExpansionApprovalComponent, ExpansionApprovalLayer, ExpansionApprovalRefusal,
  ExpansionApprovalRequest, ExpansionApprovalResult,
} from "./expansion/expansion-approval.js";

export {
  PLANNING_EXPANSION_ERROR_CODES, PLANNING_EXPANSION_LAYERS, PLANNING_EXPANSION_TARGETS,
  inspectPlanningExpansionContract, snapshotPlanningRunContractState, validExpansionCreateCommand,
  validExpansionCreatedEvent, validExpansionHoldBinding, validExpansionProposalIdentity,
  validExpansionProposeCommand, validExpansionSealedEvent, validPlanningRunContractState,
} from "./planning/planning-expansion-validation.js";
export type { PlanningExpansionErrorCode, PlanningExpansionInspection,
  PlanningExpansionLayer, PlanningExpansionTarget } from "./planning/planning-expansion-validation.js";
export type { PlanningExpansionHoldBinding, PlanningExpansionProposalIdentity } from "./planning/planning-command-contract.js";
export type { PlanningRunContractState } from "./planning/planning-event-contract.js";

export { SUPERSESSION_DISPOSITION_KINDS, SUPERSESSION_KERNEL_LAYER, decideSupersession } from "./supersession/supersession-engine.js";
export type { SupersessionAcceptedResult, SupersessionDecision, SupersessionDisposition, SupersessionDispositionKind,
  SupersessionInput, SupersessionPredecessorBinding, SupersessionRefusal, SupersessionResult, SupersessionSafeCarry,
  SupersessionSuccessorBinding } from "./supersession/supersession-engine.js";

/**
 * Identity is re-exported through its own curated area seam rather than as per-module blocks:
 * `./identity/index.ts` already curates the three identity modules, so duplicating its surface
 * here would create a second place to keep in sync. Nothing else in this file collides with it.
 */
export * from "./identity/index.js";
