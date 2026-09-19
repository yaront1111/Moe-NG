import { sep } from "node:path";

import type { SqliteEventStore } from "@moe/store";

import { NODE_TREES_DIRECTORY } from "../orchestrator/node-worktrees.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landedWithNoEffect, landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { nodeCommitMerged } from "../repository/repository-integration-read.js";
import { readReviewLedgers } from "../review/review-read-model.js";

/**
 * A dependency is satisfied when its work is ON THE PROJECT BRANCH, not when its review was
 * accepted. With MOE_NODE_TREES=1 every node codes in its own tree on its own `moe/` branch and
 * the integrator merges that branch later; the surface used to release a dependent at the
 * producer's ACCEPTANCE, so the dependent's tree was cut from a project HEAD that lacked the
 * dependency (UnAI 2026-09-19, three times). Every such seat found the code missing, hand-copied
 * the dependency branch's files into its own delivery, and that delivery then conflicted with the
 * real branch at integration.
 *
 * Satisfied, exactly one of:
 *  (a) COMMITTED from the project's own checkout — the single-tree layout, where the landing IS
 *      the project branch. Decided by WHERE the landing was made (the receipt's workspace), never
 *      by the branch's spelling: moe-next's own project branch is `moe/work-<date>`, so a prefix
 *      test would hold every dependent there forever, and a seat may `git switch -c` inside its
 *      tree, which would pass a prefix test with the work nowhere the integrator merges.
 *  (b) COMMITTED from a tree under `.moe-next/trees` AND the integrator recorded that exact sha
 *      MERGED, named or not (`nodeCommitMerged`);
 *  (c) a genuine zero-byte delivery: REFUSED NOTHING_TO_COMMIT with no landing intent journaled
 *      for that acceptance (`landedWithNoEffect`, the same rule goal closure and publication use).
 * Everything else — accepted with no receipt yet, WAITING or CONFLICTED from a tree, any other
 * refusal, an unreadable ledger or receipt — is NOT satisfied. Fail closed: an error reads as
 * "not yet", never as "done". Pure store reads, safe on the poll path; the caller memoises per
 * surface read, because the integration read is a walk of the whole integration aggregate.
 */
/** Mirrors node-worktrees.ts: a tree lives under `<project>/.moe-next/trees/`, on either separator. */
export function landedFromTree(workspace: string): boolean {
  const marker = `${sep}${NODE_TREES_DIRECTORY}${sep}`;
  return workspace.replaceAll("/", sep).replaceAll("\\", sep).includes(marker);
}

export function dependencySatisfied(store: SqliteEventStore, projectId: string, nodeRef: string): boolean {
  try {
    const reviews = readReviewLedgers(store, projectId, new Set([nodeRef]));
    const ledger = reviews.ledgers.get(nodeRef);
    if (ledger === undefined || ledger.unreadable || ledger.accepted === undefined) return false;
    // The receipt for THIS acceptance, by its own id: a withdrawn-and-re-accepted node's earlier
    // landing answers for the earlier acceptance only (node-landed-branches.ts reads it the same way).
    const landing = readLandingReceipt(store, projectId,
      landingReceiptId(projectId, nodeRef, ledger.accepted.verifierReceiptId));
    if (!landing.ok) return false;
    const { receipt } = landing;
    if (receipt.commit === null) return landedWithNoEffect(receipt, reviews.landingIntents);
    if (!landedFromTree(receipt.workspace)) return true;
    return nodeCommitMerged(store, projectId, nodeRef, receipt.commit.sha);
  } catch {
    return false;
  }
}
