import type { SqliteEventStore } from "@moe/store";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { NODE_BRANCH_PREFIX } from "./node-worktrees.js";
import type { LandedBranch } from "./node-integration.js";

/**
 * The branches the integrator may merge: one per node whose work was accepted and whose landing
 * committed, read from the durable receipts rather than from Git (2026-09-16). A node that has
 * not landed, landed nothing, or landed on the project's own branch offers nothing here — the
 * last of those is the single-tree layout, where the work is already on the branch.
 *
 * Unreadable review or landing evidence yields no branch: an unproved commit is never merged.
 */
export function landedNodeBranches(
  store: SqliteEventStore, projectId: string, nodes: readonly { readonly nodeRef: string }[],
): readonly LandedBranch[] {
  const landed: LandedBranch[] = [];
  for (const { nodeRef } of nodes) {
    try {
      const review = readReviewLedger(store, projectId, nodeRef);
      if (review.unreadable || review.accepted === undefined) continue;
      const receipt = readLandingReceipt(store, projectId,
        landingReceiptId(projectId, nodeRef, review.accepted.verifierReceiptId));
      if (!receipt.ok || receipt.receipt.outcome !== "COMMITTED" || receipt.receipt.commit === null) continue;
      const { branch, sha } = receipt.receipt.commit;
      if (!branch.startsWith(NODE_BRANCH_PREFIX)) continue;
      landed.push(Object.freeze({ branch, nodeRef, sha }));
    } catch { /* one unreadable node never costs the others their merge */ }
  }
  return Object.freeze(landed);
}
