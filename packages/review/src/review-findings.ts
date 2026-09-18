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

import { canonicalDigest, deepFreeze, isPlainRecord } from "./canonical.js";
import { REVIEW_ESCALATION_ROUND_LIMIT, REVIEW_FINDING_ATTRIBUTION_LIMITS } from "./review-contract.js";
import type {
  ReviewAccepted,
  ReviewDecisionLayer,
  ReviewFinding,
  ReviewFindingAttribution,
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
import { reviewContinuationAccepts, reviewContinuationMatches } from "./review-continuation.js";
import type { ReviewContinuationUse } from "./review-continuation.js";

export interface ReviewRoundInput {
  readonly findings: readonly ReviewFinding[];
  readonly round: number;
}

export interface ReviewRoundOutcome {
  readonly lineage: ReviewLineage;
  readonly routing: ReviewRouting;
}

export interface ReviewAcceptanceInput {
  readonly continuation?: ReviewContinuationUse;
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
  highestRound: number,
): string {
  // highestRound is INSIDE the digest so a store-corruption that lowered the
  // frontier to resurrect an earlier round is caught as a mismatch, exactly as
  // a truncated records array or a reset unsuccessfulRounds counter is.
  return canonicalDigest({ highestRound, records, unsuccessfulRounds });
}

export const EMPTY_REVIEW_LINEAGE: ReviewLineage = deepFreeze<ReviewLineage>({
  digest: lineageDigest([], 0, 0),
  highestRound: 0,
  records: [],
  unsuccessfulRounds: 0,
});

/**
 * A lineage that this reducer did not produce cannot be trusted to report its own history. The
 * concrete attack is a hand-reset `unsuccessfulRounds`, which would silently lift the escalation
 * cap, or a truncated `records` array, which would make every repeat finding look fresh.
 */
function lineageAttested(lineage: ReviewLineage): boolean {
  return lineage.digest
    === lineageDigest(lineage.records, lineage.unsuccessfulRounds, lineage.highestRound);
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function attributionRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= REVIEW_FINDING_ATTRIBUTION_LIMITS.refLength && !CONTROL_CHARACTER.test(value);
}

/**
 * Reads `attributedTo` exactly once into inert data: `undefined` when the finding is the
 * reporter's own, `null` when a present attribution is not the closed shape. A malformed one
 * refuses the whole round rather than being dropped - dropping it would charge the reporter for
 * a finding it said another node owns, and keeping it would put an unadmitted shape into the
 * lineage digest. Criteria are stored in one canonical order so caller order cannot move it.
 */
function inertAttribution(finding: ReviewFinding): ReviewFindingAttribution | null | undefined {
  const value: unknown = finding.attributedTo;
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || Object.keys(value).length !== 2) return null;
  const nodeKey = value["nodeKey"];
  const listed = value["criterionIds"];
  if (!attributionRef(nodeKey) || !Array.isArray(listed) || listed.length === 0
    || listed.length > REVIEW_FINDING_ATTRIBUTION_LIMITS.criteria) return null;
  const criterionIds: unknown[] = [...listed];
  if (!criterionIds.every(attributionRef) || new Set(criterionIds).size !== criterionIds.length) return null;
  return { criterionIds: (criterionIds as string[]).sort(), nodeKey };
}

/**
 * Copies a caller's finding into inert data, reading each field exactly once. An accessor that
 * answered differently on a later read would otherwise let a stored record drift away from the
 * fingerprint that was computed from it, which is why the fingerprint is taken from this copy
 * and never from the caller's object. `subject` is read once too, so its kind and locator
 * always come from the same reading; the attribution arrives already read by the caller.
 */
function inertFinding(finding: ReviewFinding, attributedTo: ReviewFindingAttribution | undefined): ReviewFinding {
  const subject = finding.subject;
  return {
    ...(attributedTo === undefined ? {} : { attributedTo }),
    detail: finding.detail,
    ruleId: finding.ruleId,
    severity: finding.severity,
    subject: { kind: subject.kind, locator: subject.locator },
  };
}

/**
 * The ordering comparison below cannot police the round number itself: every comparison against
 * NaN is false, so `NaN <= highestRound` does not refuse and the append-only guard is bypassed
 * entirely. Admission therefore runs BEFORE that comparison, and refuses rather than coercing —
 * `Number(x)` or a `|| 0` fallback would turn a malformed round into round 0 and silently rewrite
 * lineage history. `isSafeInteger` rather than `isInteger`: past 2^53 increments stop being
 * representable, so two distinct rounds could compare equal.
 */
function admissibleRound(round: number): boolean {
  return Number.isSafeInteger(round) && round >= 0;
}

/**
 * Records one review round and routes it. Design 15.2: the same finding fingerprint twice
 * escalates to re-plan, so a repeat routes `REJECT_PLAN` while fresh findings route
 * `REJECT_IMPLEMENTATION`. Every routing names the `FINDINGS` layer that decided it.
 *
 * Only the reporter's OWN findings charge its review. A finding attributed to another node is
 * recorded and attested like any other, but it names that node's missing work: counting it here
 * escalated an honest node forever (UnAI 2026-09-14/15, no round of either plan ever accepted).
 */
export function recordReviewRound(
  lineage: ReviewLineage,
  round: ReviewRoundInput,
  continuation?: ReviewContinuationUse,
): ReviewResult<ReviewRoundOutcome> {
  if (!lineageAttested(lineage)) return refuse("FINDING_LINEAGE_DIGEST_MISMATCH");
  if (!admissibleRound(round.round)) return refuse("FINDING_ROUND_INVALID");
  // The frontier is the highest round EVER admitted, not the highest recorded:
  // a clean round appends no record but still advances it, so an earlier or
  // equal round can never be replayed after an acceptance.
  if (round.round <= lineage.highestRound) return refuse("FINDING_LINEAGE_APPEND_ONLY");
  if (continuation !== undefined && !reviewContinuationMatches(lineage, round.round, continuation)) {
    return refuse("REVIEW_CONTINUATION_INVALID");
  }
  const added: ReviewFindingRecord[] = [];
  for (const finding of round.findings) {
    const attributedTo = inertAttribution(finding);
    if (attributedTo === null) return refuse("FINDING_ATTRIBUTION_INVALID");
    const inert = inertFinding(finding, attributedTo);
    added.push({ finding: inert, fingerprint: findingFingerprint(inert), round: round.round });
  }
  const owned = (record: ReviewFindingRecord): boolean => record.finding.attributedTo === undefined;
  const own = added.filter(owned);
  // Only a CRITICAL or MAJOR own finding blocks. A MINOR one is informational: it is RECORDED in
  // the lineage for reviewers exactly as before, but it neither reroutes the round nor counts it
  // as unsuccessful. Measured on UnAI 2026-09-18: a conscientious worker recorded one honest
  // MINOR note per round ("no assigned criterion and no required check fails because of this"),
  // each note made the round unsuccessful, the escalation limit was reached, and once past it the
  // operator continuation could rescue only a round with NO own findings — so the verifier never
  // ran and the node looped until the operator ordered the worker to suppress true information.
  const blocking = own.filter((record) => record.finding.severity !== "MINOR");
  const seen = new Set(lineage.records.filter(owned).map((record) => record.fingerprint));
  const repeatFingerprints = [
    ...new Set(blocking.map((record) => record.fingerprint).filter((entry) => seen.has(entry))),
  ].sort();
  const clean = blocking.length === 0;
  const unsuccessfulRounds = lineage.unsuccessfulRounds + (clean ? 0 : 1);
  const records = [...lineage.records, ...added];
  // The guard above proved round.round > highestRound, so this only ever raises it.
  const highestRound = round.round;
  const escalated = unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT
    && !(clean && continuation !== undefined);
  const route: ReviewRoute = escalated
    ? "ESCALATE"
    : clean ? "ACCEPT" : repeatFingerprints.length > 0 ? "REJECT_PLAN" : "REJECT_IMPLEMENTATION";
  const reasonCodes: readonly ReviewReasonCode[] = escalated ? ["REVIEW_ROUND_CAP_REACHED"] : [];
  return deepFreeze<ReviewResult<ReviewRoundOutcome>>({
    ok: true,
    value: {
      lineage: {
        digest: lineageDigest(records, unsuccessfulRounds, highestRound),
        highestRound,
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
  if (input.continuation !== undefined && (input.reviewer.subjectRef !== input.continuation.subjectRef
    || !reviewContinuationAccepts(input.lineage, input.continuation))) {
    return acceptanceRefusal("REVIEW_CONTINUATION_INVALID", "FINDINGS", []);
  }
  if (input.lineage.unsuccessfulRounds >= REVIEW_ESCALATION_ROUND_LIMIT && input.continuation === undefined) {
    return acceptanceRefusal("REVIEW_ROUND_CAP_REACHED", "FINDINGS", []);
  }
  if (input.proof === "FAILED") return acceptanceRefusal("PROOF_FAILED", "ACCEPTANCE", []);
  // Membership, not enumeration of the bad cases: only "PASSED" proceeds. A value outside the
  // closed vocabulary is exactly as unproven as "UNKNOWN", so it refuses with that code rather
  // than falling open into the policy gate.
  if (input.proof !== "PASSED") return acceptanceRefusal("PROOF_UNKNOWN", "ACCEPTANCE", []);
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
      // Binds the ReviewerCalibration facts THEMSELVES alongside the independence digest.
      // The independence digest alone covers no calibration field, so two acceptances under
      // different corpus revisions would hash identically on this field.
      reviewerCalibrationDigest: canonicalDigest({
        calibration: {
          corpusRevision: input.calibration.corpusRevision,
          sentinelPassed: input.calibration.sentinelPassed,
          staleness: input.calibration.staleness,
        },
        independence: eligible.value.independence.calibrationDigest,
      }),
    },
  });
}
