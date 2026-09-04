/**
 * The daemon prerequisite composer for `goal.close`.
 *
 * WHAT CHANGED, AND WHY IT IS THE WHOLE POINT. `goal.close` used to hand the core the closure
 * and zero-authority witnesses straight off the request payload: the core decided whether they
 * were WELL SHAPED, and nothing anywhere decided whether they were TRUE. This module derives
 * both witnesses from the exact durable records — the verification receipt, the review
 * acceptance, the verifier receipt and the activation ledger — so the refs the core validates
 * are hashes of committed bytes rather than of a caller's claim.
 *
 * NOTHING HERE COMMITS. Qualification is a pure read; the one durable write stays in the
 * handler, after this answers `ok`.
 *
 * THE READ AND THE WRITE ARE NOT ONE TRANSACTION, and cannot be: the evidence lives on the
 * verification, dispatch, activation and node aggregates while the write is a CAS on the GOAL
 * aggregate, and this store has no cross-aggregate transaction. A concurrent writer that moved
 * evidence between this answer and the commit would leave a closure derived from bytes that
 * changed underneath it. Two things bound the exposure: the goal's own expected-version CAS
 * still refuses a second close, and every record read here is append-only, so the failure mode
 * is a STALE derivation rather than a forged one. Closing that fully needs a durable read
 * fence, which belongs to the store rather than to this composer.
 *
 * TWO KNOWN GAPS, recorded rather than papered over:
 *  - design 278's designated completion node key is not durable anywhere in this daemon
 *    (grepped: it survives only as a test literal), so `completionNodeAcceptedRef` binds the
 *    WHOLE ordered approved node set. That proves more than a single designated node, not less.
 *  - `noCurrentPreparationGeneration` has no durable source at all and is declared, not derived.
 *    `noPendingDraftOrSupersession` DOES have one — a recorded re-plan — and this module refuses
 *    rather than asserting it away.
 */

import type { SqliteEventStore } from "@moe/store";

import { readReviewLedger } from "../review/review-ledger.js";
import type { AcceptanceRecord } from "../review/review-read-model.js";
import { readVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import {
  GOAL_CLOSE_AUTHORITY_REMAINS,
  GOAL_CLOSE_RESULT_DIGEST_MISMATCH,
  GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED,
  GOAL_CLOSE_REVIEW_PACKAGE_STALE,
  GOAL_CLOSE_VERIFICATION_NOT_PASSED,
  readApprovedNodeScope,
} from "./goal-close-prerequisite.js";
import {
  composeClosure, readLiveNodeEvidence, refuseClosure as refuse,
} from "./goal-live-evidence.js";
import type {
  ClosureLeg, GoalClosureQualification, GoalClosureRefused,
} from "./goal-live-evidence.js";
import {
  accountDurableActivations, indexDurableReceipts, verifiedResultHolds,
} from "./goal-qualification-reads.js";

/**
 * The closure vocabulary and the composer live in `./goal-live-evidence.ts`, which owns the
 * second leg. They are re-exported here so this module stays the single import site the rest of
 * the daemon knows: `foundation/foundation-surface.ts` takes all four names from here.
 */
export { GOAL_CLOSURE_WITNESS_VERSION } from "./goal-live-evidence.js";
export type {
  GoalClosureQualification, GoalClosureQualified, GoalClosureRefused,
} from "./goal-live-evidence.js";

/** The review half: the acceptance, the receipt it names, and the round that receipt attests. */
function reviewClosure(
  store: SqliteEventStore, projectId: string, nodeRef: string,
): AcceptanceRecord | GoalClosureRefused {
  const review = readReviewLedger(store, projectId, nodeRef);
  const { accepted } = review;
  if (review.unreadable || accepted === undefined) {
    return refuse(GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED,
      "no durable review acceptance names this approved node");
  }
  if (review.delta !== undefined) {
    return refuse(GOAL_CLOSE_REVIEW_PACKAGE_STALE,
      "a durable re-plan supersedes the accepted review package");
  }
  const verifier = readVerifierReceipt(store, projectId, accepted.verifierReceiptId);
  if (!verifier.ok) {
    return refuse(GOAL_CLOSE_REVIEW_PACKAGE_STALE,
      "the accepted verifier receipt does not read back");
  }
  if (verifier.receiptSha256 !== accepted.verifierReceiptSha256
    || verifier.receipt.reviewInputDigest !== accepted.reviewInputDigest) {
    return refuse(GOAL_CLOSE_REVIEW_PACKAGE_STALE,
      "the accepted verifier receipt does not match the acceptance");
  }
  // The exact comparison `acceptOutput` made at acceptance time, re-made now: a later round
  // means the package the acceptance attests is no longer the current one.
  const latest = review.rounds[review.rounds.length - 1];
  const { source } = verifier.receipt;
  if (latest === undefined || source.aggregateVersion !== latest.aggregateVersion
    || source.decisionId !== latest.decisionId || source.resultSha256 !== latest.resultSha256) {
    return refuse(GOAL_CLOSE_REVIEW_PACKAGE_STALE,
      "the accepted verifier receipt no longer attests the latest review round");
  }
  return accepted;
}

/**
 * Design 278 asks for proof that no planning, execution, review or qualification authority
 * outlives the accepted goal. No durable RELEASE record exists anywhere in this daemon — the
 * activation ledger writes a commit plus exactly three transitions and nothing terminal, and
 * `LeaseRecord.state` is frozen ACTIVE by event immutability — so the honest, measurable subset
 * is used: every durable activation whose attempt record names an in-scope node must be the one
 * that node's PASSED receipt names, and must still read back as that receipt's lease and effect.
 * Anything unaccounted, unattributable or unreadable refuses.
 */
function zeroAuthority(
  store: SqliteEventStore, projectId: string, bound: readonly ClosureLeg[],
): number | GoalClosureRefused {
  const accounts = accountDurableActivations(store, projectId);
  if (accounts === null) {
    return refuse(GOAL_CLOSE_AUTHORITY_REMAINS, "the durable activation stream is unreadable");
  }
  // ONLY a Foundation leg ever took a lease and an effect, so only a Foundation leg can account
  // for one. A live node has no activation to name; an activation that names one is unaccounted
  // and refuses below, exactly as an activation naming an out-of-scope node always did.
  const byNode = new Map(bound
    .filter((entry) => entry.leg === "FOUNDATION")
    .map((entry) => [entry.nodeRef, entry.receipt]));
  for (const account of accounts) {
    if (account.nodeKey === null) {
      return refuse(GOAL_CLOSE_AUTHORITY_REMAINS,
        "a durable activation has no readable attempt record");
    }
    const receipt = byNode.get(account.nodeKey);
    if (receipt === undefined) continue;
    if (receipt.attemptAggregateId !== account.aggregateId) {
      return refuse(GOAL_CLOSE_AUTHORITY_REMAINS,
        "a durable activation is not named by its node's evidence receipt");
    }
    if (account.readsBackAs === null
      || account.readsBackAs.leaseIdentity !== receipt.leaseIdentity
      || account.readsBackAs.effectIdentity !== receipt.effectIdentity) {
      return refuse(GOAL_CLOSE_AUTHORITY_REMAINS,
        "a durable activation does not read back as its receipt's lease and effect");
    }
  }
  return accounts.length;
}

function qualify(
  store: SqliteEventStore, projectId: string, goalId: string,
): GoalClosureQualification {
  const approved = readApprovedNodeScope(store, goalId);
  if (approved === null) {
    return refuse(GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED,
      "no current approval names an approved node scope");
  }
  const nodes = [...new Set(approved.scope)].sort();
  const indexed = indexDurableReceipts(store, new Set(nodes));
  if (!indexed.ok) return refuse(indexed.code, indexed.message);
  const bound: ClosureLeg[] = [];
  for (const nodeRef of nodes) {
    const receipt = indexed.index.get(nodeRef);
    if (receipt !== undefined) {
      if (receipt.verdict !== "PASSED") {
        return refuse(GOAL_CLOSE_VERIFICATION_NOT_PASSED,
          "the durable verification receipt did not pass");
      }
      if (!verifiedResultHolds(store, receipt)) {
        return refuse(GOAL_CLOSE_RESULT_DIGEST_MISMATCH,
          "the verified result no longer reads back as the record its receipt names");
      }
    }
    // The review half is what BOTH legs share, so it is asked once for either: an acceptance is
    // present, no re-plan supersedes it, and its verifier receipt still attests the latest round.
    const accepted = reviewClosure(store, projectId, nodeRef);
    if ("ok" in accepted) return accepted;
    if (receipt !== undefined) {
      bound.push(Object.freeze({ accepted, leg: "FOUNDATION" as const, nodeRef, receipt }));
      continue;
    }
    // NO Foundation receipt names this node, and the running loop mints none — its own durable
    // evidence answers instead. `GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT` is unreachable from here
    // as a result, and stays in the roster declared rather than raised.
    const live = readLiveNodeEvidence(store, projectId, nodeRef, accepted);
    if ("ok" in live) return live;
    bound.push(live);
  }
  const activations = zeroAuthority(store, projectId, bound);
  if (typeof activations !== "number") return activations;
  return composeClosure(approved.approvalRef, nodes, bound, activations);
}

/**
 * Fails closed on a thrown store: an exception is evidence about nothing, so it answers with
 * the most conservative code in the vocabulary and commits nothing. Every other answer below
 * names the exact durable state that refused.
 */
export function qualifyGoalClosure(
  store: SqliteEventStore, projectId: string, goalId: string,
): GoalClosureQualification {
  try {
    return qualify(store, projectId, goalId);
  } catch {
    return refuse(GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED,
      "the durable closure evidence could not be read");
  }
}
