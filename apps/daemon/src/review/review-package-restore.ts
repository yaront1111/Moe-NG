import { buildReviewPackage } from "@moe/review";
import type { ReviewDecisionLayer, ReviewPackageBoundItem } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";

import { readReviewLedger } from "./review-read-model.js";
import type { ReviewRoundRecord } from "./review-read-model.js";

/**
 * Recovering a recorded round's evidence package, and PROVING it is the one the round was raised
 * against (design 15.2).
 *
 * `review-round-items.ts` can say a stored item set is well-shaped. It cannot say the set is the
 * right one: a substituted item is well-shaped too, and answers every structural question
 * identically. Only the `reviewInputDigest` the handler recorded BESIDE the items at submit time
 * distinguishes them, so this module recomputes the digest over the restored items with the
 * kernel's own public `buildReviewPackage` and compares it against that STORED value.
 *
 * The comparison is recomputed-against-stored and must stay that way. Comparing a recomputation
 * against a second recomputation over the same restored items is the classic tautology: both
 * operands come from one source, they agree unconditionally, and a substituted set passes.
 *
 * Package VALIDITY is never re-decided here. `buildReviewPackage` refuses an unbindable set with
 * its own code and its own layer, and both are surfaced unchanged, so evidence always names which
 * gate answered rather than flattening a kernel refusal into a local one.
 *
 * These codes are deliberately NOT members of `REVIEW_INGRESS_REFUSAL_CODES` or
 * `REVIEW_PREREQUISITE_REFUSAL_CODES`: those vocabularies describe what the review COMMAND surface
 * emits, and this is a read-side verification that decides no command.
 */

export const REVIEW_PACKAGE_RESTORE_CODES = Object.freeze([
  "REVIEW_PACKAGE_DIGEST_MISMATCH",
  "REVIEW_PACKAGE_ITEMS_ABSENT",
  "REVIEW_PACKAGE_ROUND_NOT_FOUND",
  "REVIEW_PACKAGE_ROUND_UNREADABLE",
] as const);

export type ReviewPackageRestoreCode = (typeof REVIEW_PACKAGE_RESTORE_CODES)[number];

/** Which gate answered. Two can, so evidence must say which one did. */
export type ReviewPackageRestoreRefusedBy = "DAEMON_PREREQUISITE" | "REVIEW_KERNEL";

export interface ReviewPackageRestored {
  readonly items: readonly ReviewPackageBoundItem[];
  readonly ok: true;
  /** The digest stored at submit time, re-proved against the restored items. */
  readonly reviewInputDigest: string;
  readonly round: number;
}

export interface ReviewPackageRestoreRefused {
  readonly code: ReviewPackageRestoreCode | string;
  /** `@moe/review`'s own layer when the kernel answered, null when this module did. */
  readonly kernelLayer: ReviewDecisionLayer | null;
  readonly ok: false;
  readonly refusedBy: ReviewPackageRestoreRefusedBy;
}

export type ReviewPackageRestoreResult = ReviewPackageRestoreRefused | ReviewPackageRestored;

function refuse(code: ReviewPackageRestoreCode): ReviewPackageRestoreRefused {
  return Object.freeze({
    code,
    kernelLayer: null,
    ok: false as const,
    refusedBy: "DAEMON_PREREQUISITE" as const,
  });
}

function refuseFromKernel(code: string, layer: ReviewDecisionLayer): ReviewPackageRestoreRefused {
  return Object.freeze({
    code,
    kernelLayer: layer,
    ok: false as const,
    refusedBy: "REVIEW_KERNEL" as const,
  });
}

/**
 * The check itself, over a round already read. Exposed separately so a caller holding a ledger
 * does not pay for a second full scan of the decision log to ask one question about one round.
 */
export function verifyStoredPackageItems(
  record: ReviewRoundRecord,
): ReviewPackageRestoreResult {
  if (record.packageItems.status !== "PRESENT") return refuse("REVIEW_PACKAGE_ITEMS_ABSENT");
  const items = record.packageItems.items;
  const rebuilt = buildReviewPackage(items);
  if (!rebuilt.ok) return refuseFromKernel(rebuilt.code, rebuilt.layer);
  // Against the digest the HANDLER stored, never against a second recomputation of these items.
  if (rebuilt.value.reviewInputDigest !== record.reviewInputDigest) {
    return refuse("REVIEW_PACKAGE_DIGEST_MISMATCH");
  }
  return Object.freeze({
    items,
    ok: true as const,
    reviewInputDigest: record.reviewInputDigest,
    round: record.round,
  });
}

/**
 * Restores one subject's round by number.
 *
 * An unreadable ledger refuses BEFORE the round lookup: `readReviewLedger` drops a round it
 * cannot parse, so a wanted round could silently read as "not found" when what actually happened
 * is that its bytes were rejected. Two different facts must not share one code.
 */
export function restoreReviewPackage(
  store: SqliteEventStore,
  projectId: string,
  subjectRef: string,
  round: number,
): ReviewPackageRestoreResult {
  const ledger = readReviewLedger(store, projectId, subjectRef);
  if (ledger.unreadable) return refuse("REVIEW_PACKAGE_ROUND_UNREADABLE");
  const record = ledger.rounds.find((entry) => entry.round === round);
  if (record === undefined) return refuse("REVIEW_PACKAGE_ROUND_NOT_FOUND");
  return verifyStoredPackageItems(record);
}
