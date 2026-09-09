/**
 * THE ROLLBACK TARGET AN OPERATOR CAN ACTUALLY SPEND, resolved once and shared by every surface
 * that offers one. `deployment.rollback` admits a receipt only when ALL of `readDeployReceipt` ok,
 * `environment` matches, `outcome === "DEPLOYED"` and `imageDigest !== null` hold
 * (rollback-command.ts:98-101). This module mirrors that admission rule so a control the daemon
 * OFFERS is a control the daemon will ACCEPT.
 *
 * WHY `EnvironmentDeployState.previous` IS THE WRONG ANSWER, and why this module exists. That
 * member is POSITIONAL in the raw receipt list (deploy-ledger.ts:91) and the ledger keeps REFUSED
 * receipts in that list — "Receipts are held in LEDGER ORDER and never collapsed"
 * (deploy-ledger.ts:55). So after a deploy that REFUSED, `previous` names the receipt that is
 * still RUNNING, and after two refusals it names a receipt the handler refuses outright with
 * DEPLOY_ROLLBACK_RECEIPT_INVALID. The rule below instead projects the history down to the
 * receipts that actually ran: the LAST of those is the running image, the one BEFORE it is the
 * target, and fewer than two means there is nothing behind the running image to go back to.
 */
import type { EnvironmentDeployState } from "./deploy-ledger.js";

/** The exact tuple a `deployment.rollback` payload and its confirmation need, and nothing else. */
export interface RollbackTarget {
  /** The image that receipt started. Never null here: a null-digest receipt is not a target. */
  readonly imageDigest: string;
  readonly sha: string;
  /** The receipt id, which is a sha256 hex digest and so satisfies the handler's 64-hex gate. */
  readonly toReceiptRef: string;
}

/**
 * The receipt this environment would roll back TO, or null when it has no spendable target.
 *
 * Null covers every "no control authority" case with one answer: no state, no deploys, one
 * successful deploy (that IS the running image), and a history whose only other successes carry
 * no image digest. A caller must not substitute `current`, `previous` or a sha of its own.
 */
export function resolveRollbackTarget(state: EnvironmentDeployState | null): RollbackTarget | null {
  if (state === null) return null;
  const ran = state.receipts.filter(
    (receipt) => receipt.outcome === "DEPLOYED" && receipt.imageDigest !== null,
  );
  const target = ran[ran.length - 2];
  if (target === undefined || target.imageDigest === null) return null;
  return Object.freeze({
    imageDigest: target.imageDigest, sha: target.sha, toReceiptRef: target.receiptId,
  });
}
