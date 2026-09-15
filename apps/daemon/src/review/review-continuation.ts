import { REVIEW_ESCALATION_ROUND_LIMIT, buildReviewPackage, recordReviewRound, validReviewContinuationApproval } from "@moe/review";
import { roundStalled } from "./review-stall.js";
import type { ReviewContinuationApproval, ReviewContinuationUse } from "@moe/review";
import { isDeepStrictEqual } from "node:util";
import type { ReviewLedger, ReviewRoundRecord } from "./review-read-model.js";

// The bounded JSON decoder deliberately builds null-prototype records. Compare JSON data,
// including every key, without mistaking that ingress hardening for a binding mismatch.
const sameJson = (left: unknown, right: unknown): boolean => {
  try { return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right))); }
  catch { return false; }
};

/** Persisted beside the human decision; its own decision digest is added by the ledger reader. */
export function reviewContinuationSource(
  projectId: string, subjectRef: string, reviewVersion: number, source: ReviewRoundRecord,
) {
  return { projectId, subjectRef, reviewVersion, sourceDecisionId: source.decisionId,
    sourceResultSha256: source.resultSha256, sourceAggregateVersion: source.aggregateVersion,
    sourceLineageDigest: source.lineage.digest, sourceRound: source.round,
    sourceReviewInputDigest: source.reviewInputDigest, unsuccessfulRounds: source.lineage.unsuccessfulRounds };
}

export function continuationSourceAttested(source: ReviewRoundRecord): boolean {
  if (source.packageItems.status !== "PRESENT" || source.round !== source.lineage.highestRound) return false;
  const built = buildReviewPackage(source.packageItems.items);
  return built.ok && built.value.reviewInputDigest === source.reviewInputDigest
    && recordReviewRound(source.lineage, { findings: [], round: source.round + 1 }).ok;
}

/** A grant must bind the exact failed package and the exact aggregate the human decided on. */
export function readReviewContinuationApproval(
  value: unknown, projectId: string, subjectRef: string, reviewVersion: number,
  latest: ReviewRoundRecord | undefined,
  decision: Readonly<{ decisionId: string; currentVersion: number; resultSha256: string }>,
  previous?: ReviewRoundRecord,
): ReviewContinuationApproval | undefined {
  // Exhausted (design 15.2) or stalled (review-stall.ts): the two reviews a human may extend.
  const due = latest !== undefined && ((latest.routing.route === "ESCALATE"
    && latest.lineage.unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT) || roundStalled(previous, latest));
  if (latest === undefined || !due || !continuationSourceAttested(latest)
    || decision.currentVersion !== reviewVersion + 1
    || !sameJson(value, reviewContinuationSource(projectId, subjectRef, reviewVersion, latest))) return undefined;
  const approval = { version: "moe-review-continuation/1" as const, projectId, subjectRef,
    decisionId: decision.decisionId, decisionResultSha256: decision.resultSha256,
    decisionVersion: decision.currentVersion, sourceDecisionId: latest.decisionId,
    sourceResultSha256: latest.resultSha256, sourceAggregateVersion: latest.aggregateVersion,
    sourceLineageDigest: latest.lineage.digest, sourceRound: latest.round,
    unsuccessfulRounds: latest.lineage.unsuccessfulRounds };
  return validReviewContinuationApproval(approval) ? Object.freeze(approval) : undefined;
}

/** Read-time proof of consumption. No marker, boolean, or routing field can mint a grant. */
export function readReviewContinuationUse(
  value: unknown, approval: ReviewContinuationApproval | undefined,
  prior: ReviewRoundRecord | undefined, round: ReviewRoundRecord,
): ReviewContinuationUse | undefined {
  if (approval === undefined || prior === undefined || !continuationSourceAttested(round)
    || round.aggregateVersion !== approval.decisionVersion + 1) return undefined;
  const use = { projectId: approval.projectId, subjectRef: approval.subjectRef, round: round.round, approval };
  if (!sameJson(value, use)) return undefined;
  const findings = round.lineage.records.filter((record) => record.round === round.round).map((record) => record.finding);
  const reduced = recordReviewRound(prior.lineage, { findings, round: round.round }, use);
  return reduced.ok && sameJson(reduced.value.lineage, round.lineage)
    && sameJson(reduced.value.routing, round.routing) ? Object.freeze(use) : undefined;
}

export function reviewContinuationForSubmission(
  ledger: ReviewLedger, projectId: string, subjectRef: string, round: number,
): ReviewContinuationUse | undefined {
  const approval = ledger.continuation;
  return ledger.unreadable || ledger.replanned || ledger.accepted !== undefined || approval === undefined
    ? undefined : { approval, projectId, subjectRef, round };
}

export function reviewContinuationForAcceptance(ledger: ReviewLedger): ReviewContinuationUse | undefined {
  const latest = ledger.rounds.at(-1);
  return ledger.unreadable || ledger.replanned || latest?.routing.route !== "ACCEPT"
    ? undefined : latest.continuation;
}

/** Historical escalation is retained for audit, but never supplies another attempt. */
export function reviewContinuationAvailable(ledger: ReviewLedger): boolean {
  return !ledger.unreadable && !ledger.replanned && ledger.accepted === undefined && ledger.continuation !== undefined;
}
