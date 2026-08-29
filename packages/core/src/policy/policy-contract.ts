/**
 * Policy evaluation vocabulary (design section 11.6). Approval record types live in the
 * sibling `approval-contract.ts` so neither file approaches the size ceiling.
 *
 * Vocabulary note: policy outcomes, risk tiers, obligation kinds, and reason codes have no
 * `@moe/contracts` vocabulary at all, so they are defined locally as frozen closed tuples. The
 * four outcome strings are design 11.6 verbatim; the task's "REQUIRE_APPROVAL" is a paraphrase
 * of `REQUIRE_HUMAN_APPROVAL`.
 *
 * Hash discipline: evaluation validates supplied identities; the sibling slice-digest module
 * separately derives the one content-addressed identity used by policy installation.
 */
import type { RuntimeError, RuntimeTruthClass } from "@moe/contracts";

/** Design 11.6: a policy evaluation returns exactly one of these. */
export const POLICY_OUTCOMES = Object.freeze([
  "ALLOW", "REQUIRE_HUMAN_APPROVAL", "HOLD_UNKNOWN", "DENY",
] as const);
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

/** Fail-closed dominance lattice: later entries dominate earlier ones. */
export const POLICY_OUTCOME_DOMINANCE: readonly PolicyOutcome[] = POLICY_OUTCOMES;

export const POLICY_RISK_TIERS = Object.freeze(["R0", "R1", "R2", "R3"] as const);
export type PolicyRiskTier = (typeof POLICY_RISK_TIERS)[number];

/** Design 710: only `R0`/`R1` action types may ever be opted into the automatic path. */
export const POLICY_AUTO_APPROVAL_TIERS = Object.freeze(["R0", "R1"] as const);
export type PolicyAutoApprovalTier = (typeof POLICY_AUTO_APPROVAL_TIERS)[number];

export const POLICY_OBLIGATION_KINDS = Object.freeze(["HARD", "SOFT"] as const);
export type PolicyObligationKind = (typeof POLICY_OBLIGATION_KINDS)[number];

export const POLICY_RULE_EFFECTS = Object.freeze([
  "ALLOW", "REQUIRE_HUMAN_APPROVAL", "DENY",
] as const);
export type PolicyRuleEffect = (typeof POLICY_RULE_EFFECTS)[number];

/** Closed local reason vocabulary. Every non-ALLOW outcome carries at least one. */
export const POLICY_REASON_CODES = Object.freeze([
  "ALLOWED_BY_POLICY",
  "AUTO_APPROVAL_NOT_OPTED_IN",
  "DENIED_BY_RULE",
  "FACT_TRUTH_UNKNOWN",
  "HUMAN_ONLY_TIER",
  "REQUIRED_FACT_MISSING",
  "REQUIRE_HUMAN_APPROVAL_BY_RULE",
  "RISK_TIER_UNCLASSIFIABLE",
  "SLICE_RELAXATION_DETECTED",
  "WAIVER_INVALID",
] as const);
export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

/** Design 718 obligations core attaches itself; they are never waivable. */
export const CORE_DECISION_REASON_OBLIGATION = "core.decision_reason_required";
export const CORE_STEP_UP_OBLIGATION = "core.step_up_authentication_required";

export interface PolicyObligation {
  readonly kind: PolicyObligationKind;
  readonly obligationId: string;
}

/**
 * A normalized immutable fact. `tier` is the tier this fact contributes, or `null` when the
 * fact matches rules without bearing on risk derivation (design 653/864 style facts).
 *
 * A `null` tier may be CLASSIFIED by policy (see `PolicyRiskClassification`) but is never
 * DEFAULTED: a fact no slice classifies leaves the derivation unclassifiable, which is a
 * refusal, not the lowest tier.
 */
export interface PolicyFactInput {
  readonly factId: string;
  readonly tier: PolicyRiskTier | null;
  readonly truthClass: RuntimeTruthClass;
}

/** Recorded sibling of the risk assessment: every fact ID and truth class seen (design 697). */
export interface PolicyRecordedFact {
  readonly factId: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface PolicyRule {
  readonly effect: PolicyRuleEffect;
  readonly obligations: readonly PolicyObligation[];
  readonly requiredFactIds: readonly string[];
  readonly ruleId: string;
}

export interface PolicyAutoApprovalOptIn {
  readonly action: string;
  readonly tier: PolicyAutoApprovalTier;
}

/**
 * Policy's own risk vocabulary: the tier a POLICY REVISION assigns to one fact id. This is the
 * only place a tier may enter the chain from outside the daemon, and it is DATA a policy author
 * commits, never a field an agent or a planner supplies on a request. It carries no truth class:
 * a classification says what a fact id MEANS, never that the fact was observed.
 */
export interface PolicyRiskClassification {
  readonly factId: string;
  readonly tier: PolicyRiskTier;
}

/**
 * One link of the ordered root-to-node policy slice chain. Composition folds the chain in
 * order; a later slice may only tighten what an earlier one established.
 *
 * `riskClassifications` is OPTIONAL and ABSENT is exactly EMPTY, so every slice authored before
 * the vocabulary existed keeps its content identity. It is not a defaulting rule: an absent
 * table classifies nothing, so a run whose facts it would have classified is unclassifiable and
 * refuses. The key is present-or-absent only — an explicitly `undefined` table is refused.
 */
export interface PolicySlice {
  readonly autoApprovalOptIns: readonly PolicyAutoApprovalOptIn[];
  readonly riskClassifications?: readonly PolicyRiskClassification[];
  readonly rules: readonly PolicyRule[];
  readonly sliceRef: string;
}

/** Design 699: the only legal relaxation — scoped, expiring, human-approved, SOFT-only. */
export interface PolicyWaiver {
  readonly expiresAtEpochMs: number;
  readonly humanApprovalRef: string;
  readonly namedObligationId: string;
  readonly scope: readonly string[];
  readonly waiverRef: string;
}

export interface PolicyEvaluationInput {
  readonly action: string;
  readonly actor: string;
  readonly callerRiskHint: PolicyRiskTier | null;
  readonly decisionDigest: string;
  readonly evaluatedAtEpochMs: number;
  readonly evaluatorVersion: string;
  readonly facts: readonly PolicyFactInput[];
  readonly graphNodeRevisionRefs: readonly string[];
  readonly policyRevisionRef: string;
  readonly requiredFactIds: readonly string[];
  readonly scope: readonly string[];
  readonly sliceChain: readonly PolicySlice[];
  readonly waivers: readonly PolicyWaiver[];
}

/**
 * `computedTier` is daemon-derived from normalized immutable facts. `callerRiskHint` is
 * recorded but never lowers it; `effectiveTier` is the maximum of the two. All three stay
 * separately visible so an audit can see exactly what the caller contributed.
 */
export interface PolicyRiskAssessment {
  readonly callerRiskHint: PolicyRiskTier | null;
  readonly computedTier: PolicyRiskTier | null;
  readonly effectiveTier: PolicyRiskTier | null;
  readonly usedFactIds: readonly string[];
}

export interface PolicyDecisionRecord {
  readonly action: string;
  readonly actor: string;
  readonly decision: PolicyOutcome;
  readonly decisionDigest: string;
  readonly evaluatorVersion: string;
  readonly graphNodeRevisionRefs: readonly string[];
  readonly inputFacts: readonly PolicyRecordedFact[];
  readonly matchedRuleIds: readonly string[];
  readonly obligations: readonly PolicyObligation[];
  readonly policyRevisionRef: string;
  readonly reasonCodes: readonly PolicyReasonCode[];
  readonly riskAssessment: PolicyRiskAssessment;
}

export interface PolicyEvaluationAcceptedResult {
  readonly ok: true;
  readonly record: PolicyDecisionRecord;
}

export interface PolicyEvaluationRejectedResult {
  readonly error: RuntimeError;
  readonly ok: false;
}

export type PolicyEvaluationResult =
  | PolicyEvaluationAcceptedResult
  | PolicyEvaluationRejectedResult;
