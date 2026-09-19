import type { SqliteEventStore } from "@moe/store";
import { landedFromTree } from "../http/dependency-integration.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { NODE_BRANCH_PREFIX } from "./node-worktrees.js";
import type { LandedBranch } from "./node-integration.js";

/**
 * Whether a COMMITTED landing is the integrator's to merge: one made in a node's own tree, however
 * the seat spelled its branch (it may `git switch -c wip` there; the merge is by sha, and the
 * dependency gate and the publication credit already wait on that merge by WHERE the landing was
 * made), or one on a `moe/` branch as before. Shared with the withdrawal's conflict rule, so a
 * landing the integrator can conflict on is always one the withdrawal can hand back.
 */
export const integratorMerges = (workspace: string, branch: string): boolean =>
  branch.startsWith(NODE_BRANCH_PREFIX) || landedFromTree(workspace);

/**
 * The branches the integrator may merge: one per node whose work was accepted and whose landing
 * committed, read from the durable receipts rather than from Git (2026-09-16). A node that has
 * not landed, landed nothing, or landed on the project's own branch offers nothing here — the
 * last of those is the single-tree layout, where the work is already on the branch.
 *
 * A project branch that is itself spelled `moe/` (moe-next's own is `moe/work-<date>`) passes the
 * prefix from the project's checkout, so each entry says WHERE it landed (`fromTree`, the receipt's
 * workspace): the integrator writes a missing merge record only for a landing a gate waits on.
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
      if (!integratorMerges(receipt.receipt.workspace, branch)) continue;
      landed.push(Object.freeze({ branch, fromTree: landedFromTree(receipt.receipt.workspace), nodeRef, sha }));
    } catch { /* one unreadable node never costs the others their merge */ }
  }
  return Object.freeze(landed);
}
