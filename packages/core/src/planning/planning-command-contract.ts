import type { RuntimeTruthClass } from "@moe/contracts";

import type { ExpansionHandoffBinding } from "../expansion/expansion-planning-hold.js";

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

/**
 * The active EXPANSION_PLANNING hold this run was opened under, projected from the landed hold
 * aggregate. Evidence of CONTAINMENT only: it proves a bounded planning window is open and
 * current, and addresses no child, graph, budget, resource, lease, effect or slot. `graphEpoch`
 * and `generation` are staleness counters compared for currency, never handles, so an ACTIVE
 * lifecycle is never an approval or an activation and grants no transition. Fields are packed
 * because every planning source is held to a hard 250 physical lines by its own sweep.
 * Composition consumer: task-93b0314e09f248118e21f92699989468.
 */
export interface PlanningExpansionHoldBinding {
  readonly generation: number; readonly goalVersion: number; readonly graphEpoch: number;
  readonly holdId: string; readonly lifecycle: "ACTIVE"; readonly parentNodeRef: string;
  readonly parentRunRef: string; readonly proposalBaseHash: string;
  readonly sourceFingerprint: string; readonly truthClass: "DAEMON_VERIFIED";
  readonly workerHandoff: ExpansionHandoffBinding;
}

/** Bound to the existing submission witness rather than being a second free identity. */
export interface PlanningExpansionProposalIdentity {
  readonly proposalHash: string; readonly proposalRef: string;
  readonly truthClass: "DAEMON_VERIFIED";
}

interface PlanningCreateDraftCommandBase extends PlanningRunCommandBase {
  readonly goalRef: string; readonly kind: "planning.create_draft"; readonly runId: string;
}

/** Discriminated on `runKind`, so a binding on INITIAL/REVISION is not representable at all. */
export type PlanningCreateDraftCommand =
  | (PlanningCreateDraftCommandBase & { readonly runKind: "INITIAL" | "REVISION" })
  | (PlanningCreateDraftCommandBase & { readonly expansion: PlanningExpansionHoldBinding;
    readonly runKind: "EXPANSION" });

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

interface PlanProposeCommandBase extends PlanningRunCommandBase {
  readonly effectTerminalProof?: PlanningEffectTerminalProof;
  readonly kind: "plan.propose"; readonly submissionHash: string;
  readonly witness: PlanSubmissionWitness;
}

/** An EXPANSION proposal seals its identity against the same submission the witness names. */
export type PlanProposeCommand =
  | (PlanProposeCommandBase & { readonly proposalKind: "INITIAL" | "REVISION" })
  | (PlanProposeCommandBase & { readonly expansion: PlanningExpansionHoldBinding;
    readonly proposalKind: "EXPANSION";
    readonly sealedProposal: PlanningExpansionProposalIdentity });

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
