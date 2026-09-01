import { applyApprovalCommand, decideApprovalAuthority, grantHumanAuthority } from "@moe/core";
import type { ApprovalDecisionRecord } from "@moe/core";

import { payloadObject } from "./bootstrap/bootstrap-ledger.js";
import type { HumanReviewWitness } from "./bootstrap/bootstrap-ledger.js";
import { approvalDelayDisposition } from "./planning/approval-gate.js";
import { readApprovalPolicySettings } from "./planning/approval-policy-settings.js";
import type { GraphRequestFacts } from "./daemon-command-graph-contracts.js";

/**
 * The successor's approval, DECIDED by the core before `graph.supersede` reaches its service
 * (task-931f99e8).
 *
 * `GraphSupersedeInput.approval` is "the core's DECIDED approval record, not a request payload":
 * its `approvalRef` is the only approval identity the successor's `graph.approve` leg may cite,
 * and its `actorKind` — never a caller string — decides whether the truth class is HUMAN_APPROVED
 * or DAEMON_VERIFIED. So the two approval members are read here, handed to the core's own
 * `applyApprovalCommand`, and the core's verdict is what travels on. A caller cannot present a
 * decided record: it can only present bytes the core then judges.
 *
 * THE ACTOR IS A CLAIM, NOT AN IDENTITY. It is compared with the AUTHENTICATED principal and
 * refused on disagreement, never trusted and never silently rewritten — the same guard
 * `approval.decide` applies, and the reason `record` is admitted at all.
 */

/** The two approval members, stripped from the request before the supersede codec reads it. */
export const GRAPH_APPROVAL_INTENT_KEYS = Object.freeze(["command", "record"] as const);

export interface GraphSupersedeApprovalRefused {
  readonly ok: false;
  readonly refusal: {
    readonly code: string; readonly layer: string; readonly refusedBy: string;
    readonly sourceCode: string | null; readonly sourceLayer: string | null;
  };
}

export type GraphSupersedeApprovalResult =
  | { readonly approval: ApprovalDecisionRecord; readonly ok: true }
  | GraphSupersedeApprovalRefused;

function refused(
  code: string, layer: string, sourceCode: string | null = null,
  sourceLayer: string | null = null,
): GraphSupersedeApprovalRefused {
  return Object.freeze({
    ok: false as const,
    refusal: Object.freeze({
      code, layer, refusedBy: "DAEMON_GRAPH_INGRESS", sourceCode, sourceLayer,
    }),
  });
}

/**
 * The operator's own dispatch IS the human review the policy waits for — the same fall-through
 * `graph.approve` and `approval.decide` apply, reproduced here rather than reached around.
 *
 * Only ever called when the policy refused for want of a human AND the registry attached a
 * SERVER-assembled witness, which it does exclusively when the authenticated principal is the
 * configured operator. The grant is minted through the core's own `grantHumanAuthority` from that
 * witness and the verdict is RE-DERIVED by handing the granted gate back to
 * `decideApprovalAuthority`, so nothing here decides.
 *
 * THE COMMAND ID IS A LABEL, NOT AUTHORITY. A supersession has no runId, so the replay-stable
 * envelope `commandId` is what names the gate and the work it is bound to; it confers nothing.
 * The human principal comes from the witness and from nowhere else, and a caller cannot forge a
 * witness because it never travels on the payload.
 */
function operatorReviewAuthority(
  witness: HumanReviewWitness, commandId: string, decidedAt: string,
  policy: ReturnType<typeof readApprovalPolicySettings>,
): ReturnType<typeof decideApprovalAuthority> {
  const granted = grantHumanAuthority(
    { gateId: `supersede-review:${commandId}`, grant: null, workRef: commandId },
    { kind: "HUMAN", principalId: witness.principalId },
    Date.parse(decidedAt),
  );
  if (!granted.ok) return granted;
  return decideApprovalAuthority({ gate: granted.gate, policy });
}

/**
 * The BOARD's approval policy, applied to a supersession exactly as `graph.approve` applies it.
 *
 * A supersession has no runId and `GraphRequestFacts` carries no ledger, so there is no durable
 * gate to read and none is manufactured: `gate: null` hands the board policy straight to the
 * core. Whichever authority answers is forwarded code and layer UNCHANGED — the policy's own
 * vocabulary, never translated into a local one — and it answers BEFORE the reducer, so a
 * refusal leaves no decision and no event behind it.
 */
function decideSupersedeAuthority(
  humanReview: HumanReviewWitness | undefined, commandId: string, decidedAt: string,
): GraphSupersedeApprovalRefused | null {
  const policy = readApprovalPolicySettings(process.env);
  const decided = decideApprovalAuthority({ gate: null, policy });
  const authority = !decided.ok && decided.code === "APPROVAL_HUMAN_REVIEW_REQUIRED"
    && decided.layer === "APPROVAL_POLICY" && humanReview !== undefined
    ? operatorReviewAuthority(humanReview, commandId, decidedAt, policy)
    : decided;
  if (!authority.ok) {
    return refused(authority.code, authority.layer, authority.code, authority.layer);
  }
  // The delay REFUSES rather than clamps: `delayMs` is a safe integer wider than `setTimeout`
  // accepts, and above 2**31-1 a timer would clamp the most conservative configuration a board
  // can write into an immediate proceed — here, into an unreviewed supersession.
  if (approvalDelayDisposition(authority.delayMs) !== "IMMEDIATE") {
    return refused(
      "APPROVAL_HUMAN_REVIEW_REQUIRED", "APPROVAL_POLICY",
      "APPROVAL_HUMAN_REVIEW_REQUIRED", "APPROVAL_POLICY",
    );
  }
  return null;
}

/**
 * Reads the CALLER's payload, not the assembled request: the two approval members are stripped
 * before the supersede codec sees them, so this must run against the untrimmed bytes.
 *
 * `decidedAt` is the SERVER-assembled replay-stable moment `assembleGraphRequest` injected, taken
 * from the request rather than from `facts.envelope.payload` — a raw supersede payload carries no
 * `decidedAt`, and reading one from caller bytes would let a caller date its own grant.
 */
export function decideGraphSupersedeApproval(
  facts: GraphRequestFacts,
  humanReview: HumanReviewWitness | undefined,
  decidedAt: string,
): GraphSupersedeApprovalResult {
  const command = payloadObject(facts.envelope.payload, "command");
  const record = payloadObject(facts.envelope.payload, "record");
  if (command === null || record === null) {
    return refused("BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (record["actor"] !== facts.principalId) {
    return refused("BOOTSTRAP_APPROVAL_ACTOR_UNBOUND", "DAEMON_INGRESS");
  }
  // The board's policy is consulted BEFORE the reducer. A board that requires human review — or
  // a delay — for `graph.approve` was being bypassed by supersession, which replaces the running
  // graph outright and is the stronger act of the two (task-5b8a7966).
  const unauthorized = decideSupersedeAuthority(
    humanReview, facts.envelope.commandId, decidedAt,
  );
  if (unauthorized !== null) return unauthorized;
  const verdict = applyApprovalCommand(record, command);
  // The core's own code, forwarded rather than translated into a local vocabulary. A
  // `RuntimeError` carries no layer of its own, so it travels on CORE_REDUCER -- the one layer
  // the daemon reserves for a reducer verdict, and the same one `refuseFromCore` stamps.
  if (!verdict.ok) {
    return refused(verdict.error.code, "CORE_REDUCER", verdict.error.code, "CORE_REDUCER");
  }
  // A supersession replaces the running graph, so it may only ride an APPROVE. A typed decline
  // is a different journey and letting one through would activate a successor nobody approved.
  if (verdict.value.decision !== "APPROVE") {
    return refused("BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_PREREQUISITE");
  }
  return Object.freeze({ approval: verdict.value, ok: true as const });
}
