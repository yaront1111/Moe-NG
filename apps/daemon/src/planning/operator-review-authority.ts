import { decideApprovalAuthority, grantHumanAuthority } from "@moe/core";

import type { HumanReviewWitness } from "../bootstrap/bootstrap-ledger.js";
import type { readApprovalPolicySettings } from "./approval-policy-settings.js";

/**
 * The operator's own dispatch IS the human review the approval policy waits for — ONE
 * composition shared by `graph.approve` (`daemon-command-graph-approve.ts`), `approval.decide`
 * (`planning-services.ts`) and `approval.decide_intent` (`approval-intent.ts`). A second copy
 * would be a competing human-authority path.
 *
 * Callers reach it only when `decideApprovalAuthority` refused at the APPROVAL_POLICY layer for
 * want of a human AND a server-assembled {@link HumanReviewWitness} is attached — evidence that
 * the AUTHENTICATED principal on the request is the configured operator. An explicit GO gate on
 * the run outranks any click and never reaches here.
 *
 * The grant is minted from the witness through the core's own `grantHumanAuthority` — never from
 * caller bytes — bound to `approval-review:<runId>` and the run as its work, at the registry's
 * `decidedAt`. The verdict is then RE-DERIVED by handing the granted gate back to
 * `decideApprovalAuthority`, which consults the gate first by construction. Nothing here decides
 * the grant's validity; the kernel does, both ways, and its refusals are forwarded unchanged.
 */
export function operatorReviewAuthority(
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
