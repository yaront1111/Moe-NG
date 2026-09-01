/**
 * Pure four-outcome policy evaluation (design section 11.6).
 *
 * The result is a fold of four independent layers onto the fail-closed dominance lattice
 * `DENY > HOLD_UNKNOWN > REQUIRE_HUMAN_APPROVAL > ALLOW`:
 *
 * 1. evidence  — a missing, `UNKNOWN`, or below-floor required fact yields `HOLD_UNKNOWN`;
 * 2. relaxation — a child slice that weakens a parent rule or obligation yields `DENY`;
 * 3. rules     — the effective rule set's strongest effect;
 * 4. risk tier — `R2`/`R3` are human-only, `R0`/`R1` need an explicit opt-in.
 *
 * Because `HOLD_UNKNOWN` dominates both `REQUIRE_HUMAN_APPROVAL` and `ALLOW`, no layer below it
 * can launder unknown evidence into an allowance; and because a waiver only ever suppresses a
 * layer-2 relaxation, a waiver structurally cannot turn `HOLD_UNKNOWN` into `ALLOW` (design 712).
 *
 * `INPUT_INVALID` is the only rejection code raised here. It declares no valid lifecycle source
 * in the registry, so it is raised WITHOUT one — passing a `{aggregate:'APPROVAL'}` source would
 * silently degrade to `UNKNOWN_ERROR` in `createRuntimeError`.
 */
import { createRuntimeError } from "@moe/contracts";

import { dominant, foldSlices } from "./policy-composition.js";
import type { SliceFold } from "./policy-composition.js";
import {
  CORE_DECISION_REASON_OBLIGATION,
  CORE_STEP_UP_OBLIGATION,
} from "./policy-contract.js";
import type {
  PolicyDecisionRecord,
  PolicyEvaluationInput,
  PolicyEvaluationResult,
  PolicyFactInput,
  PolicyObligation,
  PolicyOutcome,
  PolicyReasonCode,
  PolicyRiskAssessment,
  PolicyRiskTier,
  PolicyRule,
} from "./policy-contract.js";
import {
  deepFreeze,
  maxTier,
  strongTruth,
  tierRank,
  validateEvaluationInput,
} from "./policy-validation.js";

/**
 * Derives the daemon tier. Only a fact clearing the strong-truth floor may ground a tier:
 * `OBSERVED` and `AGENT_REPORTED` are not daemon-derived, so they are unclassifiable rather
 * than usable. No tier-bearing fact at all leaves `computedTier` null — never a silent `R0`.
 *
 * The folded chain's classifications are an OVERLAY on that same fold, never a second
 * derivation: a fact the policy classifies contributes max(its own tier, the declared tier), so
 * policy can only RAISE. It cannot lower a fact that already bears a stronger tier; it cannot
 * promote a fact below the truth floor, because the floor is checked FIRST; and a fact no slice
 * classifies still contributes nothing, so an unclassifiable evaluation stays unclassifiable.
 */
function assessRisk(
  input: PolicyEvaluationInput,
  fold: SliceFold,
): { readonly assessment: PolicyRiskAssessment; readonly unclassifiable: boolean } {
  const declared = new Map(fold.classifications.map((entry) => [entry.factId, entry.tier]));
  let computedTier: PolicyRiskTier | null = null;
  const usedFactIds: string[] = [];
  for (const fact of input.facts) {
    if (!strongTruth(fact.truthClass)) continue;
    const tier = maxTier(fact.tier, declared.get(fact.factId) ?? null);
    if (tier === null) continue;
    computedTier = maxTier(computedTier, tier);
    usedFactIds.push(fact.factId);
  }
  const effectiveTier = computedTier === null
    ? null
    : maxTier(computedTier, input.callerRiskHint);
  return {
    assessment: {
      callerRiskHint: input.callerRiskHint,
      computedTier,
      effectiveTier,
      usedFactIds: [...usedFactIds].sort(),
    },
    unclassifiable: computedTier === null,
  };
}

/**
 * Evidence layer. A required fact must be present, classified, and above the truth floor.
 *
 * The required set is unioned over EVERY slice in the chain rather than over the folded rule set.
 * The two are identical in a legal chain — a child may only widen a rule's required facts — and a
 * chain that shrinks one is already DENY from the relaxation layer. Reading the whole chain makes
 * this layer's refusal independent of the fold's last-declaration semantics, so both layers would
 * have to regress before a shrunken redeclaration could reach `ALLOW` again.
 */
function assessEvidence(
  input: PolicyEvaluationInput,
  facts: ReadonlyMap<string, PolicyFactInput>,
  codes: Set<PolicyReasonCode>,
): PolicyOutcome {
  const required = new Set(input.requiredFactIds);
  for (const slice of input.sliceChain) {
    for (const rule of slice.rules) for (const id of rule.requiredFactIds) required.add(id);
  }
  let outcome: PolicyOutcome = "ALLOW";
  for (const id of required) {
    const fact = facts.get(id);
    if (fact === undefined) {
      codes.add("REQUIRED_FACT_MISSING");
      outcome = "HOLD_UNKNOWN";
    } else if (fact.truthClass === "UNKNOWN" || (fact.tier !== null && !strongTruth(fact.truthClass))) {
      codes.add("FACT_TRUTH_UNKNOWN");
      outcome = "HOLD_UNKNOWN";
    }
  }
  return outcome;
}

function assessRules(
  rules: readonly PolicyRule[],
  facts: ReadonlyMap<string, PolicyFactInput>,
  codes: Set<PolicyReasonCode>,
): { readonly matchedRuleIds: readonly string[]; readonly obligations: readonly PolicyObligation[];
  readonly outcome: PolicyOutcome } {
  const matchedRuleIds: string[] = [];
  const obligations = new Map<string, PolicyObligation>();
  let outcome: PolicyOutcome = "ALLOW";
  for (const rule of rules) {
    if (!rule.requiredFactIds.every((id) => facts.has(id))) continue;
    matchedRuleIds.push(rule.ruleId);
    for (const obligation of rule.obligations) obligations.set(obligation.obligationId, obligation);
    if (rule.effect === "DENY") codes.add("DENIED_BY_RULE");
    if (rule.effect === "REQUIRE_HUMAN_APPROVAL") codes.add("REQUIRE_HUMAN_APPROVAL_BY_RULE");
    outcome = dominant(outcome, rule.effect);
  }
  return {
    matchedRuleIds: matchedRuleIds.sort(),
    obligations: [...obligations.values()].sort(
      (left, right) => left.obligationId < right.obligationId ? -1 : 1,
    ),
    outcome,
  };
}

/** Design 710: R2/R3 are human-only; R0/R1 need an explicit opt-in, so manual is the default. */
function assessTier(
  tier: PolicyRiskTier | null,
  fold: SliceFold,
  action: string,
  codes: Set<PolicyReasonCode>,
): PolicyOutcome {
  if (tier === null) return "ALLOW";
  if (tier === "R2" || tier === "R3") {
    codes.add("HUMAN_ONLY_TIER");
    return "REQUIRE_HUMAN_APPROVAL";
  }
  if (fold.optIns.some((entry) => entry.action === action && tierRank(entry.tier) >= tierRank(tier))) {
    return "ALLOW";
  }
  codes.add("AUTO_APPROVAL_NOT_OPTED_IN");
  return "REQUIRE_HUMAN_APPROVAL";
}

function coreObligations(tier: PolicyRiskTier | null): readonly PolicyObligation[] {
  if (tier !== "R3") return [];
  return [
    { kind: "HARD", obligationId: CORE_DECISION_REASON_OBLIGATION },
    { kind: "HARD", obligationId: CORE_STEP_UP_OBLIGATION },
  ];
}

/**
 * Evaluates one policy decision. Returns a deep-frozen record for every reachable outcome;
 * only structurally malformed input is a rejection.
 */
export function evaluatePolicy(value: unknown): PolicyEvaluationResult {
  const input = validateEvaluationInput(value);
  if (input === undefined) {
    return { error: createRuntimeError({ code: "INPUT_INVALID" }), ok: false };
  }
  const codes = new Set<PolicyReasonCode>();
  const facts = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const fold = foldSlices(input);
  const risk = assessRisk(input, fold);
  if (risk.unclassifiable) codes.add("RISK_TIER_UNCLASSIFIABLE");
  if (fold.relaxed) codes.add("SLICE_RELAXATION_DETECTED");
  if (fold.waiverInvalid) codes.add("WAIVER_INVALID");
  const rules = assessRules(fold.rules, facts, codes);
  let decision = dominant(assessEvidence(input, facts, codes), rules.outcome);
  decision = dominant(decision, risk.unclassifiable ? "HOLD_UNKNOWN" : "ALLOW");
  decision = dominant(decision, fold.relaxed ? "DENY" : "ALLOW");
  decision = dominant(decision, assessTier(risk.assessment.effectiveTier, fold, input.action, codes));
  const core = coreObligations(risk.assessment.effectiveTier);
  return deepFreeze({
    ok: true,
    record: {
      action: input.action,
      actor: input.actor,
      decision,
      decisionDigest: input.decisionDigest,
      evaluatorVersion: input.evaluatorVersion,
      graphNodeRevisionRefs: [...input.graphNodeRevisionRefs],
      inputFacts: input.facts
        .map((fact) => ({ factId: fact.factId, truthClass: fact.truthClass }))
        .sort((left, right) => left.factId < right.factId ? -1 : 1),
      matchedRuleIds: rules.matchedRuleIds,
      obligations: [...core, ...rules.obligations],
      policyRevisionRef: input.policyRevisionRef,
      reasonCodes: decision === "ALLOW" ? ["ALLOWED_BY_POLICY"] : [...codes].sort(),
      riskAssessment: risk.assessment,
    } satisfies PolicyDecisionRecord,
  });
}
