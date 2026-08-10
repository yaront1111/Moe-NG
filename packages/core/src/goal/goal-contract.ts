import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { RuntimeError, RuntimeTruthClass } from "@moe/contracts";

export type GoalLifecycle = typeof RUNTIME_LIFECYCLES.GOAL[number];
export type GoalSchedulingControl = typeof RUNTIME_LIFECYCLES.GOAL_SCHEDULING[number];
export type GoalCommandKind =
  | "goal.create"
  | "goal.activate_initial_graph"
  | "goal.advance_graph_epoch"
  | "goal.close"
  | "goal.qualification_invalidated"
  | "goal.cancel"
  | "goal.reopen_as_revision"
  | "goal.pause"
  | "goal.resume";

interface GoalCommandBase {
  readonly commandId: string;
  readonly expectedVersion: number;
}

export interface ProjectReadyWitness {
  readonly projectReadyRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface InitialGraphActivationWitness {
  readonly activeGraphRevisionRef: string;
  readonly graphApprovalRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface AcceptanceClosureWitness {
  readonly acceptanceClosureRef: string;
  readonly completionNodeAcceptedRef: string;
  readonly noCurrentPreparationGeneration: true;
  readonly noPendingDraftOrSupersession: true;
  readonly obligationsHoldRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface ZeroAuthorityWitness {
  readonly truthClass: RuntimeTruthClass;
  readonly zeroAuthorityProofRef: string;
}

export interface QualificationInvalidationWitness {
  readonly proofInvalidatedRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface CancellationAuthorizationWitness {
  readonly authorizationRef: string;
  readonly subordinateAuthorityFenced: true;
  readonly truthClass: RuntimeTruthClass;
}

export interface ReopenAuthorizationWitness {
  readonly authorizationRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface GoalCreateCommand extends GoalCommandBase {
  readonly budgetAccountRef: string;
  readonly goalId: string;
  readonly kind: "goal.create";
  readonly planningRunRef: string;
  readonly projectId: string;
  readonly witness: ProjectReadyWitness;
}

export interface GoalActivateInitialGraphCommand extends GoalCommandBase {
  readonly kind: "goal.activate_initial_graph";
  readonly witness: InitialGraphActivationWitness;
}

export interface GoalAdvanceGraphEpochCommand extends GoalCommandBase {
  readonly graphEpoch: number;
  readonly kind: "goal.advance_graph_epoch";
  readonly predecessorGraphRevisionRef: string;
  readonly successorGraphRevisionRef: string;
}

export interface GoalCloseCommand extends GoalCommandBase {
  readonly closureWitness?: AcceptanceClosureWitness;
  readonly kind: "goal.close";
  readonly zeroAuthorityWitness?: ZeroAuthorityWitness;
}

export interface GoalQualificationInvalidatedCommand extends GoalCommandBase {
  readonly kind: "goal.qualification_invalidated";
  readonly witness: QualificationInvalidationWitness;
}

export interface GoalCancelCommand extends GoalCommandBase {
  readonly kind: "goal.cancel";
  readonly witness: CancellationAuthorizationWitness;
}

export interface GoalReopenAsRevisionCommand extends GoalCommandBase {
  readonly budgetAccountRef: string;
  readonly kind: "goal.reopen_as_revision";
  readonly newGoalId: string;
  readonly planningRunRef: string;
  readonly witness: ReopenAuthorizationWitness;
}

// Terminal reopen advances concurrency metadata but never moves the old goal lifecycle backward.

export interface GoalPauseCommand extends GoalCommandBase {
  readonly kind: "goal.pause";
  readonly schedulingControl: Exclude<GoalSchedulingControl, "RUNNING">;
}

export interface GoalResumeCommand extends GoalCommandBase {
  readonly kind: "goal.resume";
}

export type GoalCommand =
  | GoalCreateCommand
  | GoalActivateInitialGraphCommand
  | GoalAdvanceGraphEpochCommand
  | GoalCloseCommand
  | GoalQualificationInvalidatedCommand
  | GoalCancelCommand
  | GoalReopenAsRevisionCommand
  | GoalPauseCommand
  | GoalResumeCommand;

export interface GoalRecoveryFacets {
  readonly qualificationInvalidatedRef: string | null;
}

export interface GoalState {
  readonly activeGraphRevisionRef: string | null;
  readonly budgetAccountRef: string;
  readonly generation: number;
  readonly goalId: string;
  readonly graphEpoch: number;
  readonly lifecycle: GoalLifecycle;
  readonly planningRunRef: string;
  readonly predecessorGoalRef: string | null;
  readonly projectId: string;
  readonly recoveryFacets: GoalRecoveryFacets;
  readonly schedulingControl: GoalSchedulingControl;
  readonly version: number;
}

interface GoalEventBase {
  readonly commandId: string;
  readonly version: number;
}

export interface GoalCreated extends GoalEventBase {
  readonly budgetAccountRef: string;
  readonly goalId: string;
  readonly kind: "GoalCreated";
  readonly planningRunRef: string;
  readonly projectId: string;
  readonly witness: ProjectReadyWitness;
}

export interface GoalExecutionEnabled extends GoalEventBase {
  readonly graphEpoch: number;
  readonly kind: "GoalExecutionEnabled";
  readonly witness: InitialGraphActivationWitness;
}

/** A successor activation advances authority; it is not another initial enablement witness. */
export interface GoalGraphEpochAdvanced extends GoalEventBase {
  readonly activeGraphRevisionRef: string;
  readonly graphEpoch: number;
  readonly kind: "GoalGraphEpochAdvanced";
  readonly predecessorGraphRevisionRef: string;
}

export interface GoalClosing extends GoalEventBase {
  readonly kind: "GoalClosing";
  readonly witness: AcceptanceClosureWitness;
}

export interface GoalCompleted extends GoalEventBase {
  readonly kind: "GoalCompleted";
  readonly witness: ZeroAuthorityWitness;
}

export interface GoalQualificationInvalidated extends GoalEventBase {
  readonly kind: "GoalQualificationInvalidated";
  readonly witness: QualificationInvalidationWitness;
}

export interface GoalCancelled extends GoalEventBase {
  readonly kind: "GoalCancelled";
  readonly witness: CancellationAuthorizationWitness;
}

export interface GoalReopenedAsRevision extends GoalEventBase {
  readonly generation: number;
  readonly kind: "GoalReopenedAsRevision";
  readonly newGoalId: string;
  readonly witness: ReopenAuthorizationWitness;
}

export interface GoalSchedulingChanged extends GoalEventBase {
  readonly kind: "GoalSchedulingChanged";
  readonly schedulingControl: GoalSchedulingControl;
}

export type GoalEvent =
  | GoalCreated
  | GoalExecutionEnabled
  | GoalGraphEpochAdvanced
  | GoalClosing
  | GoalCompleted
  | GoalQualificationInvalidated
  | GoalCancelled
  | GoalReopenedAsRevision
  | GoalSchedulingChanged;

export type GoalSuccessorData = Omit<GoalState, "version"> & { readonly version: 1 };

export interface GoalAcceptedResult {
  readonly events: readonly GoalEvent[];
  readonly ok: true;
  readonly state: GoalState;
  readonly successor?: GoalSuccessorData;
}

export interface GoalRejectedResult {
  readonly error: RuntimeError;
  readonly layer: "GOAL";
  readonly ok: false;
}

export type GoalReducerResult = GoalAcceptedResult | GoalRejectedResult;
