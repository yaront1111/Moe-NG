import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { RuntimeError, RuntimeTruthClass } from "@moe/contracts";

export type GraphRevisionLifecycle = typeof RUNTIME_LIFECYCLES.GRAPH_REVISION[number];

export type GraphRevisionCommandKind =
  | "graph_revision.create"
  | "graph_revision.submit"
  | "graph.approve"
  | "graph_revision.reject"
  | "graph.supersede";

interface GraphRevisionCommandBase {
  readonly commandId: string;
  readonly expectedVersion: number;
}

/** The complete design-528 activation identity: graph, quality, budget, policy, goal version. */
export interface GraphActivationBinding {
  readonly budgetHash: string;
  readonly expectedGoalVersion: number;
  readonly graphHash: string;
  readonly policyHash: string;
  readonly qualityHash: string;
}

export interface GraphSubmissionWitness {
  readonly submissionRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface GraphRevisionApprovalWitness extends GraphActivationBinding {
  readonly approvalRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface GraphRevisionActivationWitness extends GraphActivationBinding {
  readonly activationRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface GraphRevisionRefusalWitness {
  readonly findingsRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface GraphRevisionCreateCommand extends GraphRevisionCommandBase {
  readonly goalRef: string;
  readonly graphContentHash: string;
  readonly kind: "graph_revision.create";
  readonly planHash: string;
  readonly revisionId: string;
}

export interface GraphRevisionSubmitCommand extends GraphRevisionCommandBase {
  readonly kind: "graph_revision.submit";
  readonly witness: GraphSubmissionWitness;
}

/**
 * One command covers the canonical `PENDING_APPROVAL -> APPROVED -> ACTIVE` compound and the
 * separate `APPROVED -> ACTIVE` step. From `PENDING_APPROVAL` the approval decision is required
 * and the activation is optional; from `APPROVED` only the activation is accepted.
 */
export interface GraphRevisionApproveCommand extends GraphRevisionCommandBase {
  readonly activation?: GraphRevisionActivationWitness;
  readonly approval?: GraphRevisionApprovalWitness;
  readonly kind: "graph.approve";
}

export interface GraphRevisionRejectCommand extends GraphRevisionCommandBase {
  readonly kind: "graph_revision.reject";
  readonly witness: GraphRevisionRefusalWitness;
}

/** Replacement supersession is Phase 5 (design section 10); every preview entry is refused. */
export interface GraphRevisionSupersedeCommand extends GraphRevisionCommandBase {
  readonly kind: "graph.supersede";
  readonly witness: GraphRevisionRefusalWitness;
}

export type GraphRevisionCommand =
  | GraphRevisionCreateCommand
  | GraphRevisionSubmitCommand
  | GraphRevisionApproveCommand
  | GraphRevisionRejectCommand
  | GraphRevisionSupersedeCommand;

export interface GraphRevisionState {
  readonly boundHashes: GraphActivationBinding | null;
  readonly goalRef: string;
  readonly graphContentHash: string;
  readonly lifecycle: GraphRevisionLifecycle;
  readonly planHash: string;
  readonly revisionId: string;
  readonly submissionRef: string | null;
  readonly version: number;
}

interface GraphRevisionEventBase {
  readonly commandId: string;
  readonly version: number;
}

export interface GraphRevisionCreated extends GraphRevisionEventBase {
  readonly goalRef: string;
  readonly graphContentHash: string;
  readonly kind: "GraphRevisionCreated";
  readonly planHash: string;
  readonly revisionId: string;
}

export interface GraphRevisionSubmitted extends GraphRevisionEventBase {
  readonly kind: "GraphRevisionSubmitted";
  readonly witness: GraphSubmissionWitness;
}

export interface GraphRevisionApproved extends GraphRevisionEventBase {
  readonly binding: GraphActivationBinding;
  readonly kind: "GraphRevisionApproved";
}

/** Carries the goal reference and expected goal version the daemon composes activation against. */
export interface GraphRevisionActivated extends GraphRevisionEventBase {
  readonly expectedGoalVersion: number;
  readonly goalRef: string;
  readonly kind: "GraphRevisionActivated";
  readonly witness: GraphRevisionActivationWitness;
}

export interface GraphRevisionRejected extends GraphRevisionEventBase {
  readonly kind: "GraphRevisionRejected";
  readonly witness: GraphRevisionRefusalWitness;
}

export type GraphRevisionEvent =
  | GraphRevisionCreated
  | GraphRevisionSubmitted
  | GraphRevisionApproved
  | GraphRevisionActivated
  | GraphRevisionRejected;

export interface GraphRevisionAcceptedResult {
  readonly events: readonly GraphRevisionEvent[];
  readonly ok: true;
  readonly state: GraphRevisionState;
}

export interface GraphRevisionRejectedResult {
  readonly error: RuntimeError;
  readonly ok: false;
}

export type GraphRevisionReducerResult =
  | GraphRevisionAcceptedResult
  | GraphRevisionRejectedResult;
