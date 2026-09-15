import { canonicalDigest } from "./canonical.js";
import type { ReviewLineage } from "./review-contract.js";

/** Host-proved human decision. This is never accepted from a review command payload. */
export interface ReviewContinuationApproval {
  readonly version: "moe-review-continuation/1";
  readonly projectId: string;
  readonly subjectRef: string;
  readonly decisionId: string;
  readonly decisionResultSha256: string;
  readonly decisionVersion: number;
  readonly sourceDecisionId: string;
  readonly sourceResultSha256: string;
  readonly sourceAggregateVersion: number;
  readonly sourceLineageDigest: string;
  readonly sourceRound: number;
  readonly unsuccessfulRounds: number;
}

/** Scope and round come from the host's current command, independently of the approval. */
export interface ReviewContinuationUse {
  readonly projectId: string;
  readonly subjectRef: string;
  readonly round: number;
  readonly approval: ReviewContinuationApproval;
}

const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const ref = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Shape validation is shared with the durable reader; a malformed grant conveys no authority. */
export function validReviewContinuationApproval(value: unknown): value is ReviewContinuationApproval {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as ReviewContinuationApproval;
  return item.version === "moe-review-continuation/1"
    && ref(item.projectId) && ref(item.subjectRef) && ref(item.decisionId) && ref(item.sourceDecisionId)
    && digest(item.decisionResultSha256) && digest(item.sourceResultSha256) && digest(item.sourceLineageDigest)
    && integer(item.decisionVersion) && integer(item.sourceAggregateVersion)
    && item.decisionVersion > item.sourceAggregateVersion
    && integer(item.sourceRound) && integer(item.unsuccessfulRounds);
}

/** A grant is consumed by one append to exactly the lineage the human saw. */
export function reviewContinuationMatches(
  lineage: ReviewLineage, round: number, use: ReviewContinuationUse,
): boolean {
  const approval = use?.approval;
  return validReviewContinuationApproval(approval)
    && use.projectId === approval.projectId && use.subjectRef === approval.subjectRef
    && integer(round) && use.round === round && round > approval.sourceRound
    && lineage.highestRound === approval.sourceRound
    && lineage.digest === approval.sourceLineageDigest
    && lineage.unsuccessfulRounds === approval.unsuccessfulRounds;
}

/**
 * Acceptance may spend only the clean result of that append, never a subsequent attempt. The
 * clean append may carry findings attributed to OTHER nodes - they never charge this one - so
 * only an unattributed record past the approved round disqualifies it.
 */
export function reviewContinuationAccepts(lineage: ReviewLineage, use: ReviewContinuationUse): boolean {
  if (!validReviewContinuationApproval(use?.approval) || lineage.highestRound !== use.round
    || lineage.records.some((record) => record.round > use.approval.sourceRound
      && record.finding.attributedTo === undefined)) return false;
  const source = { ...lineage, highestRound: use.approval.sourceRound,
    records: lineage.records.filter((record) => record.round <= use.approval.sourceRound) };
  const sourceDigest = canonicalDigest({ highestRound: source.highestRound,
    records: source.records, unsuccessfulRounds: source.unsuccessfulRounds });
  return reviewContinuationMatches({ ...source, digest: sourceDigest }, use.round, use);
}
