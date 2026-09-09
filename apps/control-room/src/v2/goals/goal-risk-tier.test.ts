import { POLICY_AUTO_APPROVAL_TIERS, POLICY_RISK_TIERS } from "@moe/core";
import { describe, expect, it } from "vitest";

import type { AdvisoryRiskClass, GoalDraft } from "./goal-model.js";
import { GOAL_RISK_TIERS, policyTierForRiskClass } from "./goal-risk-tier.js";
import { briefOfDraft } from "./live-goal-create.js";

/**
 * THE ROSTER IS DECLARED HERE, NOT READ FROM THE MAPPING. A test that iterated
 * `Object.keys(GOAL_RISK_TIERS)` would SHRINK with the mapping: deleting an entry would
 * delete the case that proves it, and the arm would stay green while a class silently
 * stopped mapping. `satisfies` keeps this literal honest in the other direction — a value
 * that leaves `AdvisoryRiskClass` fails to compile here.
 */
const ADVISORY_CLASSES = ["STANDARD", "ELEVATED", "RESTRICTED"] as const satisfies
  readonly AdvisoryRiskClass[];

/**
 * The compiler's half of the same coverage question: a FOURTH advisory class added to
 * `AdvisoryRiskClass` breaks this literal at typecheck, and the key comparison below then
 * fails at runtime too. Neither direction can drift alone.
 */
const EVERY_CLASS: Readonly<Record<AdvisoryRiskClass, true>> = {
  ELEVATED: true, RESTRICTED: true, STANDARD: true,
};

describe("policyTierForRiskClass", () => {
  it("covers exactly the declared advisory classes in both directions", () => {
    expect([...ADVISORY_CLASSES].sort()).toEqual(Object.keys(EVERY_CLASS).sort());
  });

  it("is total over the roster: every advisory class maps to a tier", () => {
    expect(ADVISORY_CLASSES.length).toBe(3);
    for (const riskClass of ADVISORY_CLASSES) {
      expect(typeof policyTierForRiskClass(riskClass)).toBe("string");
      expect(policyTierForRiskClass(riskClass)).toBe(GOAL_RISK_TIERS[riskClass]);
    }
  });

  it("pins the three pairs exactly", () => {
    expect(policyTierForRiskClass("STANDARD")).toBe("R0");
    expect(policyTierForRiskClass("ELEVATED")).toBe("R1");
    expect(policyTierForRiskClass("RESTRICTED")).toBe("R3");
  });

  it("is injective: three classes, three distinct tiers", () => {
    const tiers = ADVISORY_CLASSES.map((riskClass) => policyTierForRiskClass(riskClass));
    expect(new Set(tiers).size).toBe(ADVISORY_CLASSES.length);
  });

  /**
   * CLOSURE AGAINST THE PRODUCTION VOCABULARY, asserted against the IMPORTED constants.
   * A re-typed string literal here could not notice `POLICY_RISK_TIERS` moving underneath
   * it, which is the whole failure this arm exists to catch.
   */
  it("maps only into the production tier vocabulary", () => {
    for (const riskClass of ADVISORY_CLASSES) {
      expect(POLICY_RISK_TIERS).toContain(policyTierForRiskClass(riskClass));
    }
  });

  it("puts STANDARD and ELEVATED inside the auto-approvable ceiling and RESTRICTED outside", () => {
    expect(POLICY_AUTO_APPROVAL_TIERS).toContain(policyTierForRiskClass("STANDARD"));
    expect(POLICY_AUTO_APPROVAL_TIERS).toContain(policyTierForRiskClass("ELEVATED"));
    expect(POLICY_AUTO_APPROVAL_TIERS).not.toContain(policyTierForRiskClass("RESTRICTED"));
  });

  /**
   * R2 IS UNREACHABLE BY DESIGN, and that costs nothing: `evaluatePolicy` refuses R2 and R3
   * identically with HUMAN_ONLY_TIER, so RESTRICTED landing on R3 is the strictest of the two
   * human-only readings rather than a gap in the mapping.
   */
  it("leaves R2 unreachable while keeping it in the engine vocabulary", () => {
    const mapped = ADVISORY_CLASSES.map((riskClass) => policyTierForRiskClass(riskClass));
    expect(mapped).not.toContain("R2");
    expect(POLICY_RISK_TIERS).toContain("R2");
  });
});

/**
 * THE CONSUMER EDGE. A mapping nothing calls is a mapping that cannot regress, so these arms
 * run the PRODUCTION brief composer rather than restating the mapping: the tier reaches the
 * goal.create instructions the operator's draft becomes.
 */
describe("briefOfDraft carries the mapped policy tier", () => {
  const draftWith = (riskClass?: AdvisoryRiskClass): GoalDraft => ({
    acceptanceCriteria: [], budgetEnvelope: "", outcome: "Ship the thing",
    title: "Risk tier arm", ...(riskClass === undefined ? {} : { riskClass }),
  });

  it("names the tier beside the class for every advisory class", () => {
    for (const riskClass of ADVISORY_CLASSES) {
      const tier = policyTierForRiskClass(riskClass);
      expect(briefOfDraft(draftWith(riskClass)).instructions)
        .toContain(`Risk class: ${riskClass} (policy tier ${tier})`);
    }
  });

  /**
   * `riskClass` is OPTIONAL (goal-model.ts) and the form starts it undefined. The absent case
   * writes NO risk line at all rather than defaulting to a tier: inventing R0 for a goal whose
   * operator declared nothing would be the one silent widening this row must not ship.
   */
  it("writes no risk line, and invents no tier, when the operator declared no class", () => {
    const instructions = briefOfDraft(draftWith()).instructions;
    expect(instructions).not.toContain("Risk class:");
    expect(instructions).not.toContain("policy tier");
  });
});
