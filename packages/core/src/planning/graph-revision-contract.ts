import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { RuntimeError, RuntimeTruthClass } from "@moe/contracts";

import type {
  SupersessionDecision,
  SupersessionInput,
} from "../supersession/supersession-engine.js";

export type GraphRevisionLifecycle = typeof RUNTIME_LIFECYCLES.GRAPH_REVISION[number];

/** Names the aggregate that refused, because `RuntimeError` carries no lifecycle source. */
export const GRAPH_REVISION_LAYER = "GRAPH_REVISION" as const;

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

/**
 * Names the predecessor whose authority a successor activation replaces. Field names mirror the
 * kernel's `SupersessionSuccessorBinding` so the `GraphRevisionSuperseded` binding maps across
 * without translation; `predecessorGraphEpoch` is the extra fact the kernel binding does not
 * carry, and it is what lets activation validate `epoch + 1` without reaching outside the command.
 */
export interface GraphRevisionSuccessionBinding {
  readonly predecessorGraphContentHash: string;
  readonly predecessorGraphEpoch: number;
  readonly predecessorRevisionId: string;
}

export interface GraphRevisionActivationWitness extends GraphActivationBinding {
  readonly activationRef: string;
  /**
   * A BOUND REFERENCE to the goal-owned epoch this activation binds — the goal aggregate's
   * `goal.activate_initial_graph` remains the only authority that advances an epoch, and this
   * aggregate never increments one. Exactly `1` for an initial activation and exactly
   * `succession.predecessorGraphEpoch + 1` for a successor; an unverifiable epoch refuses.
   */
  readonly graphEpoch: number;
  /** Absent means an initial activation; present means this revision replaces the named one. */
  readonly succession?: GraphRevisionSuccessionBinding;
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

/**
 * Replacement supersession (design section 10). The command carries the whole kernel input —
 * predecessor identity and epoch, successor identity/content/epoch, and carry evidence — because
 * the decision is taken by `decideSupersession`, never restated by this aggregate.
 */
export interface GraphRevisionSupersedeCommand extends GraphRevisionCommandBase {
  readonly kind: "graph.supersede";
  readonly supersession: SupersessionInput;
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
  /**
   * A BOUND REFERENCE to the goal-owned epoch this revision was activated at — not a private
   * counter. `goal.activate_initial_graph` remains the only authority that advances an epoch;
   * persisting the bound value here is what lets supersession bind predecessor to successor.
   * It is `>= 1` exactly when the lifecycle is `ACTIVE` or `SUPERSEDED`, and exactly `0` otherwise.
   */
  readonly graphEpoch: number;
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

/**
 * The atomic authority move: this revision is SUPERSEDED and the named successor is ACTIVE at
 * exactly predecessor epoch + 1, bound together by the kernel's `authorityHash`.
 */
export interface GraphRevisionSuperseded extends GraphRevisionEventBase {
  readonly authorityHash: string;
  readonly kind: "GraphRevisionSuperseded";
  readonly successor: SupersessionDecision["successor"];
}

export type GraphRevisionEvent =
  | GraphRevisionCreated
  | GraphRevisionSubmitted
  | GraphRevisionApproved
  | GraphRevisionActivated
  | GraphRevisionRejected
  | GraphRevisionSuperseded;

export interface GraphRevisionAcceptedResult {
  readonly events: readonly GraphRevisionEvent[];
  readonly ok: true;
  readonly state: GraphRevisionState;
}

/** `layer` is production, not cosmetic: `createRuntimeError` validates a source then drops it. */
export interface GraphRevisionRejectedResult {
  readonly error: RuntimeError;
  readonly layer: typeof GRAPH_REVISION_LAYER;
  readonly ok: false;
}

export type GraphRevisionReducerResult =
  | GraphRevisionAcceptedResult
  | GraphRevisionRejectedResult;
