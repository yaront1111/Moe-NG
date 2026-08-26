import { applyApprovalCommand } from "@moe/core";
import type { ApprovalDecisionRecord } from "@moe/core";

import { payloadObject } from "./bootstrap/bootstrap-ledger.js";
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
 * Reads the CALLER's payload, not the assembled request: the two approval members are stripped
 * before the supersede codec sees them, so this must run against the untrimmed bytes.
 */
export function decideGraphSupersedeApproval(
  facts: GraphRequestFacts,
): GraphSupersedeApprovalResult {
  const command = payloadObject(facts.envelope.payload, "command");
  const record = payloadObject(facts.envelope.payload, "record");
  if (command === null || record === null) {
    return refused("BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (record["actor"] !== facts.principalId) {
    return refused("BOOTSTRAP_APPROVAL_ACTOR_UNBOUND", "DAEMON_INGRESS");
  }
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
