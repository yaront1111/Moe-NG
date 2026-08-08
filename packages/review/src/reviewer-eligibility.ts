/**
 * Reviewer independence and calibration (design 15.1, 15.3).
 *
 * Independence is computed over caller-supplied DURABLE FACTS — the authorship set and the lease
 * history of the reviewed subject — and answers on a three-valued lattice. Two properties are
 * load-bearing and are the reason this is not a boolean:
 *
 * - fail closed: either fact being unresolvable yields `UNKNOWN` with
 *   `UNKNOWN_REVIEWER_INDEPENDENCE`, never a default of eligible, and `UNKNOWN` can never produce
 *   an acceptance qualification. Unverifiable evidence must not gain authority.
 * - do not over-refuse: a MUTATING lease disqualifies, a READ_ONLY lease does not, and a lease
 *   over some other subject does not. Treating every lease as disqualifying would make
 *   independent review impossible while leaving the suite green.
 *
 * A proven disqualification dominates an unresolvable fact — it is the more certain answer — but
 * both codes are reported so an audit can see the whole picture.
 *
 * Calibration is a pure function of the same facts: no clock, no randomness, no sampling.
 */
import { byCanonicalOrder, canonicalDigest, deepFreeze } from "./canonical.js";
import { REVIEW_INDEPENDENCE_LEVEL } from "./review-contract.js";
import type {
  ReviewIndependenceVerdict,
  ReviewReasonCode,
  ReviewResult,
  ReviewerCalibration,
  ReviewerEligibilityAssessment,
  ReviewerIndependenceAssessment,
  ReviewerIndependenceInput,
} from "./review-contract.js";

/**
 * A blank principal or a blank subject reference names nobody and nothing, so neither fact can
 * be proven about it. Treating either as resolved would let an unnamed reviewer pass the author
 * comparison and the lease scope by vacuous inequality.
 */
function identified(input: ReviewerIndependenceInput): boolean {
  return input.reviewer.length > 0 && input.subjectRef.length > 0;
}

/**
 * An EMPTY authorship set is not a resolved one. Reviewed work always has an author, so an empty
 * set means the lookup returned nothing, not that nobody wrote it — and a vacuous `includes`
 * against it would clear every reviewer including the author.
 */
function authorshipKnown(input: ReviewerIndependenceInput): boolean {
  return input.authorshipResolved && identified(input) && input.authors.length > 0;
}

function leaseHistoryKnown(input: ReviewerIndependenceInput): boolean {
  return input.leaseHistoryResolved && identified(input);
}

function heldMutatingLease(input: ReviewerIndependenceInput): boolean {
  return input.leaseHistory.some((lease) =>
    lease.kind === "MUTATING"
    && lease.principal === input.reviewer
    && lease.subjectRef === input.subjectRef);
}

/**
 * The exact fact set the verdict is derived from, normalised so arrival order cannot change the
 * digest. Nothing outside this record may influence calibration.
 */
function calibrationFacts(input: ReviewerIndependenceInput): Record<string, unknown> {
  return {
    authors: [...input.authors].sort(),
    authorshipResolved: input.authorshipResolved,
    leaseHistory: input.leaseHistory
      .map((lease) => ({
        kind: lease.kind,
        principal: lease.principal,
        subjectRef: lease.subjectRef,
      }))
      .sort(byCanonicalOrder),
    leaseHistoryResolved: input.leaseHistoryResolved,
    reviewer: input.reviewer,
    subjectRef: input.subjectRef,
  };
}

export function reviewerCalibrationDigest(input: ReviewerIndependenceInput): string {
  return canonicalDigest(calibrationFacts(input));
}

export function assessReviewerIndependence(
  input: ReviewerIndependenceInput,
): ReviewerIndependenceAssessment {
  const codes: ReviewReasonCode[] = [];
  if (authorshipKnown(input) && input.authors.includes(input.reviewer)) {
    codes.push("REVIEWER_IS_AUTHOR");
  }
  if (leaseHistoryKnown(input) && heldMutatingLease(input)) {
    codes.push("REVIEWER_HELD_MUTATING_LEASE");
  }
  const proven = codes.length > 0;
  if (!authorshipKnown(input) || !leaseHistoryKnown(input)) {
    codes.push("UNKNOWN_REVIEWER_INDEPENDENCE");
  }
  const verdict: ReviewIndependenceVerdict = proven
    ? "NOT_INDEPENDENT"
    : codes.length > 0 ? "UNKNOWN" : "INDEPENDENT";
  return deepFreeze<ReviewerIndependenceAssessment>({
    calibrationDigest: reviewerCalibrationDigest(input),
    level: REVIEW_INDEPENDENCE_LEVEL,
    reasonCodes: codes.sort(),
    verdict,
  });
}

/**
 * Design 15.3: auto-acceptance is unavailable to a stale or unproven reviewer. `STALE` is a known
 * fact about a real calibration; `UNKNOWN` currency, a failed sentinel set, and an unnamed corpus
 * revision are all "never proven", which is a different claim and gets its own code.
 */
function calibrationCodes(calibration: ReviewerCalibration): readonly ReviewReasonCode[] {
  const codes: ReviewReasonCode[] = [];
  if (calibration.staleness === "STALE") codes.push("REVIEWER_CALIBRATION_STALE");
  if (calibration.staleness === "UNKNOWN"
    || !calibration.sentinelPassed
    || calibration.corpusRevision.length === 0) {
    codes.push("REVIEWER_CALIBRATION_UNPROVEN");
  }
  return codes;
}

/**
 * The ELIGIBILITY gate an acceptance must pass before any proof or policy layer is consulted.
 * The refusal names the proven disqualification when there is one and falls back to
 * `UNKNOWN_REVIEWER_INDEPENDENCE` only when nothing was proven, so "we could not tell" is never
 * reported as "we checked and it failed".
 */
export function qualifyReviewerForAcceptance(
  input: ReviewerIndependenceInput,
  calibration: ReviewerCalibration,
): ReviewResult<ReviewerEligibilityAssessment> {
  const independence = assessReviewerIndependence(input);
  if (independence.verdict !== "INDEPENDENT") {
    const proven = independence.reasonCodes
      .find((code) => code !== "UNKNOWN_REVIEWER_INDEPENDENCE");
    return deepFreeze<ReviewResult<ReviewerEligibilityAssessment>>({
      code: proven ?? "UNKNOWN_REVIEWER_INDEPENDENCE",
      layer: "ELIGIBILITY",
      ok: false,
    });
  }
  const codes = calibrationCodes(calibration);
  const refusal = codes[0];
  if (refusal !== undefined) {
    return deepFreeze<ReviewResult<ReviewerEligibilityAssessment>>({
      code: refusal,
      layer: "ELIGIBILITY",
      ok: false,
    });
  }
  return deepFreeze<ReviewResult<ReviewerEligibilityAssessment>>({
    ok: true,
    value: { calibrationEligible: true, independence, reasonCodes: [] },
  });
}
