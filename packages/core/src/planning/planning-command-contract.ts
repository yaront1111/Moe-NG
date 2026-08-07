import type { RuntimeTruthClass } from "@moe/contracts";

/**
 * `REVISION` and `EXPANSION` stay representable for forward compatibility (design section 8.1
 * rows 293-303) but every Foundation Preview path returns the typed UNSUPPORTED variant; the
 * linear single-node slice is Phase 4 scope and multi-node planning lands in Phase 5.
 */
export type PlanningRunKind = "INITIAL" | "REVISION" | "EXPANSION";

export type PlanningRunCommandKind =
  | "planning.create_draft"
  | "planning.ready"
  | "planning.claim"
  | "planning.release"
  | "planning.recover_absent"
  | "plan.propose"
  | "planning.finalize_submission"
  | "plan.approve"
  | "plan.revise"
  | "graph.approve"
  | "goal.cancel"
  | "planning.cancel";

interface PlanningRunCommandBase {
  readonly commandId: string;
  readonly expectedVersion: number;
}

export interface PlanningReadinessWitness {
  readonly acceptanceCriteriaRef: string;
  readonly intentBaseRef: string;
  readonly planningBudgetRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanningClaimWitness {
  readonly attemptRef: string;
  readonly contextRef: string;
  readonly leaseRef: string;
  readonly providerSlotRef: string;
  readonly truthClass: RuntimeTruthClass;
}

/** Resuming an unowned run proves the prior attempt terminal and binds its exact handoff. */
export interface PlanningResumeProof {
  readonly handoffKind: "SAFE_RELEASE_HANDOFF" | "NO_HANDOFF_RECOVERY";
  readonly handoffRef: string;
  readonly priorAttemptTerminalRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanningReleaseWitness {
  readonly attemptTerminalRef: string;
  readonly handoffRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanningAbsenceRecoveryWitness {
  readonly effectsAbsentRef: string;
  readonly leaseFencedRef: string;
  readonly missingInMemoryState: "UNKNOWN";
  readonly priorAttemptTerminalRef: string;
  readonly recoverySealRef: string;
  readonly resourcesAbsentRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanSubmissionWitness {
  readonly attemptRef: string;
  readonly submissionRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanningEffectTerminalProof {
  readonly effectTerminalRef: string;
  readonly resourcesTerminalRef: string;
  readonly truthClass: RuntimeTruthClass;
}

/** Structural node facts the admission pass counts. Core never trusts a caller's own count. */
export interface NodeSummary {
  readonly executionBearing: boolean;
  readonly nodeKey: string;
}

export interface SubmissionFinalizeWitness {
  readonly attemptTerminalRef: string;
  readonly effectTerminalRef: string;
  readonly nodeSummaries: readonly NodeSummary[];
  readonly providerSlotTerminalRef: string;
  readonly resourcesTerminalRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanRevisionHashes {
  readonly dependencyHash: string;
  readonly graphContentHash: string;
  readonly planHash: string;
  readonly qualityHash: string;
}

export interface PlanRevisionSeal extends PlanRevisionHashes {
  readonly graphRevisionRef: string;
}

export interface PlanningRefusalWitness {
  readonly findingsRef: string;
  readonly successorRunId: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanApprovalWitness extends PlanRevisionHashes {
  readonly approvalRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanningActivationWitness {
  readonly activationRef: string;
  readonly budgetHash: string;
  readonly expectedGoalVersion: number;
  readonly goalDraftNoActiveRevision: true;
  readonly graphHash: string;
  readonly policyHash: string;
  readonly qualityHash: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanningCancellationWitness {
  readonly authorizationRef: string;
  readonly noLiveOrUnknownEffect: true;
  readonly truthClass: RuntimeTruthClass;
}

export interface PlanningCreateDraftCommand extends PlanningRunCommandBase {
  readonly goalRef: string;
  readonly kind: "planning.create_draft";
  readonly runId: string;
  readonly runKind: PlanningRunKind;
}

export interface PlanningReadyCommand extends PlanningRunCommandBase {
  readonly kind: "planning.ready";
  readonly witness: PlanningReadinessWitness;
}

export interface PlanningClaimCommand extends PlanningRunCommandBase {
  readonly kind: "planning.claim";
  readonly resumeProof?: PlanningResumeProof;
  readonly witness: PlanningClaimWitness;
}

export interface PlanningReleaseCommand extends PlanningRunCommandBase {
  readonly kind: "planning.release";
  readonly witness: PlanningReleaseWitness;
}

export interface PlanningRecoverAbsentCommand extends PlanningRunCommandBase {
  readonly kind: "planning.recover_absent";
  readonly witness: PlanningAbsenceRecoveryWitness;
}

export interface PlanProposeCommand extends PlanningRunCommandBase {
  readonly effectTerminalProof?: PlanningEffectTerminalProof;
  readonly kind: "plan.propose";
  readonly proposalKind: PlanningRunKind;
  readonly submissionHash: string;
  readonly witness: PlanSubmissionWitness;
}

export interface PlanningFinalizeSubmissionCommand extends PlanningRunCommandBase {
  readonly kind: "planning.finalize_submission";
  readonly refusal?: PlanningRefusalWitness;
  readonly revision?: PlanRevisionSeal;
  readonly witness: SubmissionFinalizeWitness;
}

export interface PlanApproveCommand extends PlanningRunCommandBase {
  readonly kind: "plan.approve";
  readonly witness: PlanApprovalWitness;
}

export interface PlanReviseCommand extends PlanningRunCommandBase {
  readonly kind: "plan.revise";
  readonly witness: PlanningRefusalWitness;
}

export interface GraphApproveCommand extends PlanningRunCommandBase {
  readonly kind: "graph.approve";
  readonly planApproval?: PlanApprovalWitness;
  readonly witness: PlanningActivationWitness;
}

export interface GoalCancelPlanningCommand extends PlanningRunCommandBase {
  readonly kind: "goal.cancel";
  readonly witness: PlanningCancellationWitness;
}

/** Expansion-only in the design (rows 301-302); every preview entry is refused. */
export interface PlanningCancelCommand extends PlanningRunCommandBase {
  readonly kind: "planning.cancel";
  readonly witness: PlanningCancellationWitness;
}

export type PlanningRunCommand =
  | PlanningCreateDraftCommand
  | PlanningReadyCommand
  | PlanningClaimCommand
  | PlanningReleaseCommand
  | PlanningRecoverAbsentCommand
  | PlanProposeCommand
  | PlanningFinalizeSubmissionCommand
  | PlanApproveCommand
  | PlanReviseCommand
  | GraphApproveCommand
  | GoalCancelPlanningCommand
  | PlanningCancelCommand;
