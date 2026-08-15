/**
 * Structured findings and append-only rejection lineage (design 15.2).
 *
 * A finding's IDENTITY is its typed subject plus its rule id. `detail` and `severity` are
 * reported but never hashed, so rewording a finding or downgrading its severity cannot evade
 * repeat detection — and, in the other direction, byte-identical prose about a different subject
 * is not a repeat. Keying on text would collapse both rules into string equality.
 *
 * Lineage is append-only. A round number is first admitted as a safe non-negative integer —
 * `FINDING_ROUND_INVALID` otherwise, because a comparison cannot police NaN — and must then
 * advance strictly past the last recorded round; anything else refuses with
 * `FINDING_LINEAGE_APPEND_ONLY`. Either way the caller's lineage — including its digest — is
 * left exactly as it was. Every returned lineage is deep-frozen, so an earlier
 * record cannot be rewritten in place either.
 */
import { evaluatePolicy } from "@moe/core";
import type { PolicyEvaluationInput, PolicyOutcome, PolicyReasonCode } from "@moe/core";

import { canonicalDigest, deepFreeze } from "./canonical.js";
import { REVIEW_ESCALATION_ROUND_LIMIT } from "./review-contract.js";
import type {
  ReviewAccepted,
  ReviewDecisionLayer,
  ReviewFinding,
  ReviewFindingRecord,
  ReviewLineage,
  ReviewProofState,
  ReviewReasonCode,
  ReviewRefusal,
  ReviewResult,
  ReviewRoute,
  ReviewRouting,
  ReviewerCalibration,
  ReviewerIndependenceInput,
} from "./review-contract.js";
import { qualifyReviewerForAcceptance } from "./reviewer-eligibility.js";

export interface ReviewRoundInput {
  readonly findings: readonly ReviewFinding[];
  readonly round: number;
}

export interface ReviewRoundOutcome {
  readonly lineage: ReviewLineage;
  readonly routing: ReviewRouting;
}

export interface ReviewAcceptanceInput {
  readonly calibration: ReviewerCalibration;
  readonly lineage: ReviewLineage;
  readonly policy: PolicyEvaluationInput;
  readonly proof: ReviewProofState;
  readonly reviewInputDigest: string;
  readonly reviewer: ReviewerIndependenceInput;
}

export interface ReviewAcceptanceQualification {
  readonly policyDecision: PolicyOutcome;
  readonly policyReasonCodes: readonly PolicyReasonCode[];
  readonly reviewInputDigest: string;
  readonly reviewerCalibrationDigest: string;
}

/** Carries @moe/core's reason codes verbatim so the two surfaces cannot drift apart. */
export interface ReviewAcceptanceRefusal {
  readonly code: ReviewReasonCode;
  readonly layer: ReviewDecisionLayer;
  readonly ok: false;
  readonly policyReasonCodes: readonly PolicyReasonCode[];
}

export type ReviewAcceptanceResult =
  | ReviewAccepted<ReviewAcceptanceQualification>
  | ReviewAcceptanceRefusal;

function refuse(code: ReviewReasonCode): ReviewRefusal {
  return deepFreeze<ReviewRefusal>({ code, layer: "FINDINGS", ok: false });
}

/** Typed identity only. Adding `detail` here would make every repeat evadable by rewording. */
export function findingFingerprint(finding: ReviewFinding): string {
  return canonicalDigest({
    ruleId: finding.ruleId,
    subject: { kind: finding.subject.kind, locator: finding.subject.locator },
  });
}

function lineageDigest(
  records: readonly ReviewFindingRecord[],
  unsuccessfulRounds: number,
): string {
  return canonicalDigest({ records, unsuccessfulRounds });
}

export const EMPTY_REVIEW_LINEAGE: ReviewLineage = deepFreeze<ReviewLineage>({
  digest: lineageDigest([], 0),
  records: [],
  unsuccessfulRounds: 0,
});

/**
 * A lineage that this reducer did not produce cannot be trusted to report its own history. The
 * concrete attack is a hand-reset `unsuccessfulRounds`, which would silently lift the escalation
 * cap, or a truncated `records` array, which would make every repeat finding look fresh.
 */
function lineageAttested(lineage: ReviewLineage): boolean {
  return lineage.digest === lineageDigest(lineage.records, lineage.unsuccessfulRounds);
}

/**
 * Copies a caller's finding into inert data, reading each field exactly once. An accessor that
 * answered differently on a later read would otherwise let a stored record drift away from the
 * fingerprint that was computed from it.
 */
function inertFinding(finding: ReviewFinding): ReviewFinding {
  return {
    detail: finding.detail,
    ruleId: finding.ruleId,
    severity: finding.severity,
    subject: { kind: finding.subject.kind, locator: finding.subject.locator },
  };
}

/**
 * The ordering comparison below cannot police the round number itself: every comparison against
 * NaN is false, so `NaN <= lastRound(...)` does not refuse and the append-only guard is bypassed
 * entirely. Admission therefore runs BEFORE that comparison, and refuses rather than coercing —
 * `Number(x)` or a `|| 0` fallback would turn a malformed round into round 0 and silently rewrite
 * lineage history. `isSafeInteger` rather than `isInteger`: past 2^53 increments stop being
 * representable, so two distinct rounds could compare equal.
 */
function admissibleRound(round: number): boolean {
  return Number.isSafeInteger(round) && round >= 0;
}

function lastRound(lineage: ReviewLineage): number {
  return lineage.records.reduce(
    (highest, record) => record.round > highest ? record.round : highest,
    0,
  );
}

/**
 * Records one review round and routes it. Design 15.2: the same finding fingerprint twice
 * escalates to re-plan, so a repeat routes `REJECT_PLAN` while fresh findings route
 * `REJECT_IMPLEMENTATION`. Every routing names the `FINDINGS` layer that decided it.
 */
export function recordReviewRound(
  lineage: ReviewLineage,
  round: ReviewRoundInput,
): ReviewResult<ReviewRoundOutcome> {
  if (!lineageAttested(lineage)) return refuse("FINDING_LINEAGE_DIGEST_MISMATCH");
  if (!admissibleRound(round.round)) return refuse("FINDING_ROUND_INVALID");
  if (round.round <= lastRound(lineage)) return refuse("FINDING_LINEAGE_APPEND_ONLY");
  const seen = new Set(lineage.records.map((record) => record.fingerprint));
  const added: readonly ReviewFindingRecord[] = round.findings.map((finding) => ({
    finding: inertFinding(finding),
    fingerprint: findingFingerprint(finding),
    round: round.round,
  }));
  const repeatFingerprints = [
    ...new Set(added.map((record) => record.fingerprint).filter((entry) => seen.has(entry))),
  ].sort();
  const clean = added.length === 0;
  const unsuccessfulRounds = lineage.unsuccessfulRounds + (clean ? 0 : 1);
  const records = [...lineage.records, ...added];
  const escalated = unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT;
  const route: ReviewRoute = escalated
    ? "ESCALATE"
    : clean ? "ACCEPT" : repeatFingerprints.length > 0 ? "REJECT_PLAN" : "REJECT_IMPLEMENTATION";
  const reasonCodes: readonly ReviewReasonCode[] = escalated ? ["REVIEW_ROUND_CAP_REACHED"] : [];
  return deepFreeze<ReviewResult<ReviewRoundOutcome>>({
    ok: true,
    value: {
      lineage: {
        digest: lineageDigest(records, unsuccessfulRounds),
        records,
        unsuccessfulRounds,
      },
      routing: { layer: "FINDINGS", reasonCodes, repeatFingerprints, route },
    },
  });
}

function acceptanceRefusal(
  code: ReviewReasonCode,
  layer: ReviewDecisionLayer,
  policyReasonCodes: readonly PolicyReasonCode[],
): ReviewAcceptanceRefusal {
  return deepFreeze<ReviewAcceptanceRefusal>({ code, layer, ok: false, policyReasonCodes });
}

/**
 * Acceptance qualification (design 15.2, 710). Four gates in order, each naming the layer that
 * answered so a test can pin which one refused:
 *
 * 1. ELIGIBILITY — an author, a prior mutating lease holder, an UNKNOWN independence verdict, or
 *    an uncalibrated reviewer never reaches the later gates;
 * 2. FINDINGS — reaching the round cap never auto-accepts (design 15.2);
 * 3. ACCEPTANCE proof — `FAILED` and `UNKNOWN` are separate refusals. "We could not tell" and
 *    "we checked and it failed" are different facts and only one of them may later become
 *    provable, so collapsing them would destroy information;
 * 4. ACCEPTANCE policy — the verdict is @moe/core's `evaluatePolicy`, consumed whole. Its reason
 *    codes are carried verbatim rather than reinterpreted; no policy rule is restated here.
 */
export function qualifyReviewAcceptance(input: ReviewAcceptanceInput): ReviewAcceptanceResult {
  const eligible = qualifyReviewerForAcceptance(input.reviewer, input.calibration);
  if (!eligible.ok) return acceptanceRefusal(eligible.code, eligible.layer, []);
  if (!lineageAttested(input.lineage)) {
    return acceptanceRefusal("FINDING_LINEAGE_DIGEST_MISMATCH", "FINDINGS", []);
  }
  if (input.lineage.unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT) {
    return acceptanceRefusal("REVIEW_ROUND_CAP_REACHED", "FINDINGS", []);
  }
  if (input.proof === "FAILED") return acceptanceRefusal("PROOF_FAILED", "ACCEPTANCE", []);
  if (input.proof === "UNKNOWN") return acceptanceRefusal("PROOF_UNKNOWN", "ACCEPTANCE", []);
  const evaluated = evaluatePolicy(input.policy);
  if (!evaluated.ok) return acceptanceRefusal("ACCEPTANCE_POLICY_REFUSED", "ACCEPTANCE", []);
  if (evaluated.record.decision !== "ALLOW") {
    return acceptanceRefusal(
      "ACCEPTANCE_POLICY_REFUSED",
      "ACCEPTANCE",
      evaluated.record.reasonCodes,
    );
  }
  return deepFreeze<ReviewAcceptanceResult>({
    ok: true,
    value: {
      policyDecision: evaluated.record.decision,
      policyReasonCodes: evaluated.record.reasonCodes,
      reviewInputDigest: input.reviewInputDigest,
      reviewerCalibrationDigest: eligible.value.independence.calibrationDigest,
    },
  });
}
