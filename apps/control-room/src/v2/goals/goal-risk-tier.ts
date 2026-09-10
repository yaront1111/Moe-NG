import type { PolicyRiskTier } from "@moe/core";

import type { AdvisoryRiskClass } from "./goal-model.js";

/**
 * THE FORM'S ADVISORY RISK CLASS, READ AS THE POLICY ENGINE'S TIER.
 *
 * The new-goal form records one of three advisory classes; the policy engine speaks a
 * four-tier vocabulary (`POLICY_RISK_TIERS`). Until this module existed the class reached
 * nothing but a line of prose in the goal brief, so the operator's own risk judgement was
 * invisible to every gate that decides whether a human must answer.
 *
 * THE MAPPING IS TOTAL AND INJECTIVE, AND R2 IS DELIBERATELY UNREACHABLE. A three-value set
 * cannot surject onto a four-value one, so reachability is not a property this mapping can
 * have and is not one it claims. Nothing is weakened by the gap: R2 and R3 are BOTH refused
 * as human-only by `evaluatePolicy`, which answers REQUIRE_HUMAN_APPROVAL with the reason
 * code HUMAN_ONLY_TIER for either, so RESTRICTED lands on the strictest available reading.
 *
 * THIS IS THE SUBJECT'S TIER, NEVER AN AUTO-APPROVAL OPT-IN. The two are separate operands
 * of the same engine test (`entry.action === action && tierRank(entry.tier) >= tierRank(tier)`):
 * the opt-in is a HOST-scoped standing declaration per action with a tier ceiling, installed
 * once in the policy slice, while the tier below is per goal and reaches the engine as a fact
 * classification. Deriving an opt-in from a goal's risk class would be the wrong model, and
 * would also make the digest-pinned installed slice non-constant.
 *
 * `Record<AdvisoryRiskClass, PolicyRiskTier>` is what makes this TOTAL: adding a fourth
 * advisory class is a COMPILE error here rather than a silent fallthrough at a call site.
 * The type import is deliberate — `@moe/core`'s policy barrel also re-exports the slice
 * digest producer, which imports `node:crypto`, and a browser module takes no value from it.
 */
export const GOAL_RISK_TIERS: Readonly<Record<AdvisoryRiskClass, PolicyRiskTier>> = Object.freeze({
  ELEVATED: "R1",
  RESTRICTED: "R3",
  STANDARD: "R0",
});

/** The policy tier one advisory class means. Total over the three declared classes. */
export function policyTierForRiskClass(riskClass: AdvisoryRiskClass): PolicyRiskTier {
  return GOAL_RISK_TIERS[riskClass];
}
