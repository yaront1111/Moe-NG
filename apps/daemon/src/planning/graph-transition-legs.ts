import type { JsonObject, JsonValue, RuntimeError } from "@moe/contracts";
import type {
  ApprovalDecisionRecord,
  ApprovalPolicy,
  GraphActivationBinding,
  GraphRevisionState,
  HumanAuthorityGrant,
} from "@moe/core";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import { approvalPolicyHash, approvalPolicyMaterial } from "./approval-policy-digest.js";
import { composeGraphActivationBinding } from "./graph-activation-binding.js";
import type { GraphActivationBindingLayer } from "./graph-activation-binding.js";
import { buildGraphRevisionActivationLeg } from "./graph-revision-activation-leg.js";
import type { GraphRevisionActivationLayer } from "./graph-revision-activation-leg.js";

/**
 * The initial active-graph transition, composed end to end: derive, then build, then hand back
 * ONE fenced leg for the approval's single decision.
 *
 * This module exists so `approval-activation.ts` stays the commit site and nothing else. Three
 * separable judgements live behind it — which approval policy authorised this (a digest), which
 * five hashes and goal version bind it (the binding), and which lifecycle events represent it
 * (the fold) — and each owns its own layer so a refusal names the authority to inspect rather
 * than a composite that names none.
 *
 * ORDER IS LOAD-BEARING AND CHEAPEST-FIRST IS NOT THE RULE. The policy digest is pure and the
 * binding read-only, so both run before the revision leg touches the store; and the whole
 * composition runs before ANY commit, which is what makes "a refused activation leaves zero
 * residue" a property of the call sequence rather than of a cleanup path.
 */

export type GraphTransitionLayer =
  | GraphActivationBindingLayer
  | GraphRevisionActivationLayer
  | "GRAPH_REVISION";

export interface GraphTransitionRefused {
  readonly code: string;
  /** The core's own error when a REDUCER refused; `null` when the daemon did. */
  readonly error: RuntimeError | null;
  readonly layer: GraphTransitionLayer;
  readonly ok: false;
}

export interface GraphTransitionAccepted {
  readonly binding: GraphActivationBinding;
  readonly leg: ExpectedVersionDecisionLeg;
  readonly ok: true;
  readonly state: GraphRevisionState;
}

export type GraphTransitionResult = GraphTransitionAccepted | GraphTransitionRefused;

export interface GraphTransitionInput {
  /** The core's DECIDED approval record — its own `approvalRef`, never a payload field. */
  readonly approval: ApprovalDecisionRecord;
  /** The core's decided wait. A satisfied human gate proceeds at 0. */
  readonly authorityDelayMs: number;
  /** The server's digest over the durable budget root. */
  readonly budgetHash: string;
  /** The caller's activation witness. COMPARED, never bound from. */
  readonly claimed: JsonObject;
  readonly goal: JsonValue | undefined;
  readonly goalId: string;
  readonly grant: HumanAuthorityGrant | null;
  readonly graphRevisionRef: string;
  readonly policy: ApprovalPolicy;
  readonly principalId: string;
  readonly projectId: string;
  readonly requestCommandId: string;
  readonly run: JsonValue;
  readonly runId: string;
  readonly store: SqliteEventStore;
}

export function composeGraphTransition(input: GraphTransitionInput): GraphTransitionResult {
  const policyHash = approvalPolicyHash(approvalPolicyMaterial({
    delayMs: input.authorityDelayMs,
    goalRef: input.goalId,
    grant: input.grant,
    graphRevisionRef: input.graphRevisionRef,
    policy: input.policy,
    principalId: input.principalId,
    projectId: input.projectId,
    runId: input.runId,
  }));
  const composed = composeGraphActivationBinding({
    budgetHash: input.budgetHash,
    claimed: input.claimed,
    goal: input.goal,
    policyHash,
    projectId: input.projectId,
    run: input.run,
    store: input.store,
  });
  if (!composed.ok) {
    return Object.freeze({
      code: composed.code, error: null, layer: composed.layer, ok: false as const,
    });
  }
  const built = buildGraphRevisionActivationLeg({
    actorKind: input.approval.actorKind,
    approvalRef: input.approval.approvalRef,
    binding: composed.binding,
    commandId: input.requestCommandId,
    goalRef: input.goalId,
    planHash: composed.planHash,
    projectId: input.projectId,
    revisionId: input.graphRevisionRef,
    store: input.store,
    submissionRef: composed.submissionRef,
  });
  if (!built.ok) {
    // A CORE rejection carries its `RuntimeError`; a daemon one carries only its code. Both
    // travel under the layer that produced them, so neither is restamped as the other.
    return "error" in built
      ? Object.freeze({
        code: built.error.code, error: built.error, layer: built.layer, ok: false as const,
      })
      : Object.freeze({ code: built.code, error: null, layer: built.layer, ok: false as const });
  }
  return Object.freeze({
    binding: composed.binding, leg: built.leg, ok: true as const, state: built.state,
  });
}
