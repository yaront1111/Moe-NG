import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { applyApprovalCommand, decideApprovalAuthority, grantHumanAuthority } from "@moe/core";

import { payloadObject, payloadRef, refuse, stateOf }
  from "./bootstrap/bootstrap-ledger.js";
import type { DurableLedger, HumanReviewWitness, ServiceOutcome }
  from "./bootstrap/bootstrap-ledger.js";
import { approvalDelayDisposition, readApprovalGate } from "./planning/approval-gate.js";
import { readApprovalPolicySettings } from "./planning/approval-policy-settings.js";
import { verifyApprovedRunBinding } from "./planning/approval-run-binding.js";
import { activateApprovedGraph } from "./planning/graph-activation-service.js";
import type { GraphActivationInput } from "./planning/graph-activation-service.js";
import { graphHandlerContext } from "./daemon-command-graph-contracts.js";
import type { GraphCommandRequest } from "./daemon-command-graph-contracts.js";

/**
 * `graph.approve` — the authority composition in front of task-eacea969's atomic transition
 * service (task-931f99e8).
 *
 * NOTHING HERE DECIDES. Every judgement belongs to a named authority: eligibility and the
 * decision floor to the core's `applyApprovalCommand`, the human gate and the delay to
 * `decideApprovalAuthority`, the policy to the daemon's own settings, WHICH run was approved to
 * `verifyApprovedRunBinding`, and the whole transition to `activateApprovedGraph`. This module
 * orders them and forwards whichever one answered, code and layer unchanged.
 *
 * THE RUN COMES OFF THE LEDGER, NEVER OFF THE PAYLOAD. `GraphActivationInput.run` is the
 * composition contract that interface calls its sharpest: the binding's content and quality
 * hashes are read from this record's `sealedHashes`, so a request shaped like a run would let a
 * caller name any body already durable in the store and have the server bind it. `stateOf` reads
 * the SAME fold the gate below reads, and `verifyApprovedRunBinding` compares the caller's
 * `graphRevisionRef` against the run's own durable one before anything is composed.
 */

interface DurableApprovedRun {
  readonly gate: ReturnType<typeof readApprovalGate>["gate"];
  readonly goalRef: string;
  readonly record: JsonValue;
  readonly submissionHash: string;
}

/**
 * `goalRef` is read from the RUN and not from the request, so an activation cannot be redirected
 * at a goal this plan was never proposed for.
 */
function durableApprovedRun(ledger: DurableLedger, runId: string): DurableApprovedRun | null {
  const run = stateOf(ledger, runId);
  if (run === undefined || run === null || typeof run !== "object" || Array.isArray(run)) {
    return null;
  }
  const submissionHash = payloadRef(run as JsonObject, "submissionHash");
  const state = payloadObject(run as JsonObject, "state");
  const goalRef = state === null ? null : payloadRef(state, "goalRef");
  if (submissionHash === null || goalRef === null) return null;
  return { gate: readApprovalGate(run, runId).gate, goalRef, record: run, submissionHash };
}

/**
 * The operator's own dispatch IS the human review the policy waits for.
 *
 * Reached only when the policy refused for want of a human AND the registry attached a
 * server-assembled witness — which for this kind is doubly fenced, because
 * `OPERATOR_PRINCIPAL_KINDS` has already refused every principal that is not the configured
 * operator. The grant is minted through the core's own `grantHumanAuthority` from that witness,
 * never from caller bytes, and the verdict is RE-DERIVED by handing the granted gate back to
 * `decideApprovalAuthority`. An explicit GO gate on the run outranks any click and never reaches
 * here.
 */
function operatorReviewAuthority(
  witness: HumanReviewWitness, runId: string, decidedAt: string,
  policy: ReturnType<typeof readApprovalPolicySettings>,
): ReturnType<typeof decideApprovalAuthority> {
  const granted = grantHumanAuthority(
    { gateId: `approval-review:${runId}`, grant: null, workRef: runId },
    { kind: "HUMAN", principalId: witness.principalId },
    Date.parse(decidedAt),
  );
  if (!granted.ok) return granted;
  return decideApprovalAuthority({ gate: granted.gate, policy });
}

interface ApproveEdgeInput {
  readonly humanReview: HumanReviewWitness | undefined;
  readonly ledger: DurableLedger;
  readonly request: GraphCommandRequest;
  readonly store: SqliteEventStore;
}

/** The five payload members this kind admits, read once and refused as a set. */
function intentOf(request: GraphCommandRequest): {
  readonly activation: JsonObject; readonly command: JsonObject;
  readonly graphRevisionRef: string; readonly record: JsonObject; readonly runId: string;
} | null {
  const activation = payloadObject(request.payload, "activation");
  const command = payloadObject(request.payload, "command");
  const graphRevisionRef = payloadRef(request.payload, "graphRevisionRef");
  const record = payloadObject(request.payload, "record");
  const runId = payloadRef(request.payload, "runId");
  if (activation === null || command === null || graphRevisionRef === null || record === null
    || runId === null) {
    return null;
  }
  return { activation, command, graphRevisionRef, record, runId };
}

export function runGraphApproveEdge(input: ApproveEdgeInput): ServiceOutcome {
  const { ledger, request, store } = input;
  const intent = intentOf(request);
  if (intent === null) return refuse(null, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  // The approval record is durable authority attributed to a human. Its actor is a CLAIM to
  // compare with the authenticated envelope principal, never an identity to trust or rewrite.
  if (intent.record["actor"] !== request.principalId) {
    return refuse(null, "BOOTSTRAP_APPROVAL_ACTOR_UNBOUND", "DAEMON_INGRESS");
  }
  const run = durableApprovedRun(ledger, intent.runId);
  // An unknown run is a MISSING prerequisite, not a hash disagreement: collapsing the two makes
  // a wrong runId report as revision drift and sends an operator after the wrong field.
  if (run === null) return refuse(null, "BOOTSTRAP_PREREQUISITE_MISSING", "DAEMON_PREREQUISITE");
  if (payloadRef(intent.record, "exactRevisionHash") !== run.submissionHash) {
    return refuse(null, "BOOTSTRAP_REVISION_HASH_MISMATCH", "DAEMON_PREREQUISITE");
  }
  // The policy comes from the daemon's own settings and from nowhere else. There is no default
  // and no payload branch, so self-approval is unrepresentable here rather than merely absent
  // from the allow-list next door.
  const policy = readApprovalPolicySettings(process.env);
  const decided = decideApprovalAuthority({ gate: run.gate, policy });
  const authority = !decided.ok && decided.code === "APPROVAL_HUMAN_REVIEW_REQUIRED"
    && decided.layer === "APPROVAL_POLICY" && input.humanReview !== undefined
    ? operatorReviewAuthority(input.humanReview, intent.runId, request.decidedAt, policy)
    : decided;
  if (!authority.ok) return refuse(null, authority.code, authority.layer);
  // The delay REFUSES rather than clamps: `delayMs` is a safe integer wider than `setTimeout`
  // accepts, and above 2**31-1 a timer would clamp the most conservative configuration a board
  // can write into an immediate proceed.
  if (approvalDelayDisposition(authority.delayMs) !== "IMMEDIATE") {
    return refuse(null, "APPROVAL_HUMAN_REVIEW_REQUIRED", "APPROVAL_POLICY");
  }
  const verdict = applyApprovalCommand(intent.record, intent.command);
  // The core's own code, carried on the layer the daemon reserves for a reducer verdict.
  // `refuseFromCore` is not reachable here: it demands a `BootstrapCommandKind` and
  // `graph.approve` deliberately is not one.
  if (!verdict.ok) return refuse(null, verdict.error.code, "CORE_REDUCER", verdict.error);
  // An activation may only ride an APPROVE. A typed decline is J4's journey; letting a
  // non-approval through would activate a graph the human refused.
  if (verdict.value.decision !== "APPROVE") {
    return refuse(null, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_PREREQUISITE");
  }
  const bound = verifyApprovedRunBinding({
    graphRevisionRef: intent.graphRevisionRef, run: run.record, runId: intent.runId, store,
  });
  if (!bound.ok) return refuse(null, bound.code, bound.layer);
  const activation: GraphActivationInput = {
    activation: intent.activation,
    approval: verdict.value,
    authorityDelayMs: authority.delayMs,
    binding: bound.binding,
    goalId: run.goalRef,
    grant: authority.grant,
    graphRevisionRef: intent.graphRevisionRef,
    policy,
    run: run.record,
  };
  return activateApprovedGraph(graphHandlerContext(store, ledger, request), activation);
}
