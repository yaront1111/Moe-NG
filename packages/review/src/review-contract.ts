/**
 * Closed vocabulary for independent review (design section 15).
 *
 * Everything here is frozen data and types; no logic lives in this file.
 *
 * Two deliberate shapes:
 *
 * - independence is a THREE-VALUED lattice, not a boolean plus an error. Design 15.1 gives
 *   `UNKNOWN_REVIEWER_INDEPENDENCE` its own meaning — "no eligible reviewer could be proven" —
 *   which is a different fact from "this reviewer is provably an author". A boolean collapses
 *   them, and epic rail 4 requires the unprovable one to stay unprovable rather than inherit the
 *   authority of a decided refusal.
 * - the clean package's exclusions (design 15.2) are expressed as an ALLOW-LIST of item kinds.
 *   A worker transcript is not filtered out of the package; it is a kind the builder cannot
 *   accept. `REVIEW_PACKAGE_FORBIDDEN_ITEM_KINDS` exists only so the nearest legal attempt gets
 *   a specific refusal code instead of a generic "unknown kind".
 *
 * Nothing here restates a policy rule. Approval validity and acceptance qualification are
 * consumed from `@moe/core`'s policy modules by `review-findings.ts`; a second copy would drift.
 */

/** Design 15.1 independence lattice. `UNKNOWN` can never qualify an acceptance. */
export const REVIEW_INDEPENDENCE_VERDICTS = Object.freeze([
  "INDEPENDENT", "NOT_INDEPENDENT", "UNKNOWN",
] as const);
export type ReviewIndependenceVerdict = (typeof REVIEW_INDEPENDENCE_VERDICTS)[number];

/** Design 15.1 names the default level honestly; it claims role separation, not model identity. */
export const REVIEW_INDEPENDENCE_LEVEL = "ROLE_SEPARATED_CLEAN_CONTEXT" as const;
export type ReviewIndependenceLevel = typeof REVIEW_INDEPENDENCE_LEVEL;

/** A lease that mutated the subject disqualifies; a read-only lease never does. */
export const REVIEW_LEASE_KINDS = Object.freeze(["MUTATING", "READ_ONLY"] as const);
export type ReviewLeaseKind = (typeof REVIEW_LEASE_KINDS)[number];

/** Design 15.3 calibration currency. `UNKNOWN` is unproven, never "probably fine". */
export const REVIEW_CALIBRATION_STALENESS = Object.freeze([
  "CURRENT", "STALE", "UNKNOWN",
] as const);
export type ReviewCalibrationStaleness = (typeof REVIEW_CALIBRATION_STALENESS)[number];

/** Proof of the reviewed work. `FAILED` and `UNKNOWN` are distinct and neither may accept. */
export const REVIEW_PROOF_STATES = Object.freeze(["PASSED", "FAILED", "UNKNOWN"] as const);
export type ReviewProofState = (typeof REVIEW_PROOF_STATES)[number];

/** Design 15.2 outcomes, verbatim. */
export const REVIEW_ROUTES = Object.freeze([
  "ACCEPT", "REJECT_IMPLEMENTATION", "REJECT_PLAN", "UNKNOWN_EVIDENCE", "ESCALATE",
] as const);
export type ReviewRoute = (typeof REVIEW_ROUTES)[number];

/** Which layer refused. Epic rail 6: a test must pin the layer, not only the outcome. */
export const REVIEW_DECISION_LAYERS = Object.freeze([
  "ELIGIBILITY", "PACKAGE", "FINDINGS", "ACCEPTANCE",
] as const);
export type ReviewDecisionLayer = (typeof REVIEW_DECISION_LAYERS)[number];

/** Design 15.2: three unsuccessful rounds create a `REVIEW_ESCALATION` blocker. */
export const REVIEW_ESCALATION_ROUND_LIMIT = 3;

/**
 * Absolute per-subject round ceiling: 8x the escalation limit, pinned as a literal so moving
 * either bound is a conscious act. An escalation is a blocker with a human-in-loop fix round
 * after it, not an unbounded resubmission channel; past this ceiling no further round is
 * admissible for the subject at all.
 */
export const REVIEW_ROUND_ABSOLUTE_CEILING = 24;

/** Pinned package version; it participates in the package digest. */
export const REVIEW_PACKAGE_VERSION = "moe-review-package/1" as const;

/** Closed reason vocabulary. Every refusal in this package names exactly one of these. */
export const REVIEW_REASON_CODES = Object.freeze([
  "ACCEPTANCE_APPROVAL_NOT_CURRENT",
  "ACCEPTANCE_POLICY_REFUSED",
  "FINDING_LINEAGE_APPEND_ONLY",
  "FINDING_LINEAGE_DIGEST_MISMATCH",
  "FINDING_ROUND_INVALID",
  "PACKAGE_BINDING_AMBIGUOUS",
  "PACKAGE_BINDING_INCOMPLETE",
  "PACKAGE_ITEM_DIGEST_INVALID",
  "PACKAGE_ITEM_KIND_FORBIDDEN",
  "PACKAGE_ITEM_KIND_UNKNOWN",
  "PACKAGE_ITEM_LOCATOR_INVALID",
  "PROOF_FAILED",
  "PROOF_UNKNOWN",
  "REVIEWER_CALIBRATION_STALE",
  "REVIEWER_CALIBRATION_UNPROVEN",
  "REVIEWER_HELD_MUTATING_LEASE",
  "REVIEWER_IS_AUTHOR",
  "REVIEW_ROUND_CAP_REACHED",
  "UNKNOWN_REVIEWER_INDEPENDENCE",
] as const);
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

export interface ReviewRefusal {
  readonly code: ReviewReasonCode;
  readonly layer: ReviewDecisionLayer;
  readonly ok: false;
}

export interface ReviewAccepted<T> {
  readonly ok: true;
  readonly value: T;
}

export type ReviewResult<T> = ReviewAccepted<T> | ReviewRefusal;

/** One durable lease fact over the reviewed subject. Supplied; this package observes only. */
export interface ReviewLeaseRecord {
  readonly kind: ReviewLeaseKind;
  readonly principal: string;
  readonly subjectRef: string;
}

/**
 * Durable facts the independence verdict is computed over. The two `*Resolved` flags are the
 * fail-closed hinge: an unresolvable fact yields `UNKNOWN`, never a default of eligible.
 */
export interface ReviewerIndependenceInput {
  readonly authors: readonly string[];
  readonly authorshipResolved: boolean;
  readonly leaseHistory: readonly ReviewLeaseRecord[];
  readonly leaseHistoryResolved: boolean;
  readonly reviewer: string;
  readonly subjectRef: string;
}

export interface ReviewerIndependenceAssessment {
  readonly calibrationDigest: string;
  readonly level: ReviewIndependenceLevel;
  readonly reasonCodes: readonly ReviewReasonCode[];
  readonly verdict: ReviewIndependenceVerdict;
}

/** Design 15.3 currency and sentinel gate. Both are caller-supplied durable facts. */
export interface ReviewerCalibration {
  readonly corpusRevision: string;
  readonly sentinelPassed: boolean;
  readonly staleness: ReviewCalibrationStaleness;
}

export interface ReviewerEligibilityAssessment {
  readonly calibrationEligible: boolean;
  readonly independence: ReviewerIndependenceAssessment;
  readonly reasonCodes: readonly ReviewReasonCode[];
}

/**
 * Allow-list of item kinds the clean package can express (design 15.2 contents). The forbidden
 * kinds below are NOT members; they are named separately only to earn a precise refusal code.
 */
export const REVIEW_PACKAGE_ITEM_KINDS = Object.freeze([
  "CRITERION", "DAEMON_ARTIFACT", "DAEMON_RECEIPT", "GRAPH_HASH", "INTEGRATED_TREE",
  "PLAN_HASH", "RUBRIC", "SUBMITTED_BYTES",
] as const);
export type ReviewPackageItemKind = (typeof REVIEW_PACKAGE_ITEM_KINDS)[number];

/** Design 883 and DoD 2: what a reviewer must never receive. Disjoint from the allow-list. */
export const REVIEW_PACKAGE_FORBIDDEN_ITEM_KINDS = Object.freeze([
  "HANDOFF_PERSUASION", "JOURNAL_ENTRY", "SELF_ASSESSMENT", "WORKER_TRANSCRIPT",
] as const);
export type ReviewPackageForbiddenItemKind =
  (typeof REVIEW_PACKAGE_FORBIDDEN_ITEM_KINDS)[number];

/** The six fields DoD 2 requires the package to bind. The digest covers all of them. */
export const REVIEW_PACKAGE_BOUND_FIELDS = Object.freeze([
  "criteria", "hashes", "receipts", "rubric", "submittedBytes", "tree",
] as const);
export type ReviewPackageBoundField = (typeof REVIEW_PACKAGE_BOUND_FIELDS)[number];

/**
 * Input item. `kind` is a bare `string` on purpose: a forbidden kind must be constructible at
 * the input boundary so the builder can refuse it with a named code. It is never constructible
 * in the built package, whose fields only ever hold `ReviewPackageItemKind`.
 */
export interface ReviewPackageItemInput {
  readonly digest: string;
  readonly kind: string;
  readonly locator: string;
}

export interface ReviewPackageBoundItem {
  readonly digest: string;
  readonly kind: ReviewPackageItemKind;
  readonly locator: string;
}

/** Rubric slot: one pinned rubric revision, cited by opaque digest with its version as locator. */
export type ReviewRubric = ReviewPackageBoundItem;

/**
 * Receipts are cited as opaque content-addressed references and validated for shape only. The
 * evidence receipt pipeline owns their internals; reconstructing that shape here would create a
 * seam that has to be undone.
 */
export interface ReviewPackageBinding {
  readonly criteria: readonly ReviewPackageBoundItem[];
  readonly hashes: readonly ReviewPackageBoundItem[];
  readonly receipts: readonly ReviewPackageBoundItem[];
  readonly rubric: ReviewRubric;
  readonly submittedBytes: ReviewPackageBoundItem;
  readonly tree: ReviewPackageBoundItem;
}

export interface ReviewPackage {
  readonly bound: ReviewPackageBinding;
  readonly reviewInputDigest: string;
  readonly version: typeof REVIEW_PACKAGE_VERSION;
}

export const REVIEW_FINDING_SUBJECT_KINDS = Object.freeze([
  "ARTIFACT", "CRITERION", "NODE", "RECEIPT",
] as const);
export type ReviewFindingSubjectKind = (typeof REVIEW_FINDING_SUBJECT_KINDS)[number];

export const REVIEW_FINDING_SEVERITIES = Object.freeze([
  "CRITICAL", "MAJOR", "MINOR",
] as const);
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

/** Typed identity of what a finding is about. Prose is never part of it. */
export interface ReviewFindingSubject {
  readonly kind: ReviewFindingSubjectKind;
  readonly locator: string;
}

/**
 * A structured finding. Its identity is `subject` + `ruleId`; `detail` and `severity` are
 * reported but carry no identity, so rewording a finding cannot evade repeat detection.
 */
export interface ReviewFinding {
  readonly detail: string;
  readonly ruleId: string;
  readonly severity: ReviewFindingSeverity;
  readonly subject: ReviewFindingSubject;
}

export interface ReviewFindingRecord {
  readonly finding: ReviewFinding;
  readonly fingerprint: string;
  readonly round: number;
}

/** Append-only rejection lineage. `digest` attests the exact recorded sequence. */
export interface ReviewLineage {
  readonly digest: string;
  /** The highest round number ever admitted, INCLUDING clean rounds that append
   *  no record. The append-only frontier reads this, not the record set, so a
   *  clean (accepting) round cannot leave an earlier round resubmittable. */
  readonly highestRound: number;
  readonly records: readonly ReviewFindingRecord[];
  readonly unsuccessfulRounds: number;
}

export interface ReviewRouting {
  readonly layer: ReviewDecisionLayer;
  readonly reasonCodes: readonly ReviewReasonCode[];
  readonly repeatFingerprints: readonly string[];
  readonly route: ReviewRoute;
}
