import { describe, expect, it } from "vitest";

import type {
  PolicyDecisionRecord,
  PolicyEvaluationInput,
  PolicyFactInput,
  PolicyRiskTier,
  PolicyRule,
  PolicySlice,
  PolicyWaiver,
} from "./policy-contract.js";
import { evaluatePolicy } from "./policy-evaluation.js";

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

const NODE = "node:alpha";
const OTHER = "node:beta";
const ACTION = "graph.approve";
const OPT_IN_R0 = { action: ACTION, tier: "R0" } as const;
const OPT_IN_R1 = { action: ACTION, tier: "R1" } as const;

const fact = (
  factId: string,
  tier: PolicyRiskTier | null,
  truthClass: PolicyFactInput["truthClass"] = "DAEMON_VERIFIED",
): PolicyFactInput => ({ factId, tier, truthClass });

const rule = (ruleId: string, over: Partial<PolicyRule> = {}): PolicyRule =>
  ({ effect: "ALLOW", obligations: [], requiredFactIds: [], ruleId, ...over });

const slice = (sliceRef: string, over: Partial<PolicySlice> = {}): PolicySlice =>
  ({ autoApprovalOptIns: [], rules: [], sliceRef, ...over });

const waiver = (over: Partial<PolicyWaiver> = {}): PolicyWaiver => ({
  expiresAtEpochMs: 9_000, humanApprovalRef: "approval:soft",
  namedObligationId: "obligation.soft", scope: [NODE], waiverRef: "waiver:1", ...over,
});

function input(over: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    action: ACTION,
    actor: "human:root",
    callerRiskHint: null,
    decisionDigest: hash("ab"),
    evaluatedAtEpochMs: 1_000,
    evaluatorVersion: "moe-policy-evaluator/1",
    facts: [fact("fact.read_only", "R0")],
    graphNodeRevisionRefs: [NODE],
    policyRevisionRef: hash("cd"),
    requiredFactIds: ["fact.read_only"],
    scope: [NODE],
    sliceChain: [slice("root", { autoApprovalOptIns: [OPT_IN_R0] })],
    waivers: [],
    ...over,
  };
}

function decide(over: Partial<PolicyEvaluationInput> = {}): PolicyDecisionRecord {
  const result = evaluatePolicy(input(over));
  if (!result.ok) throw new Error(`unexpected rejection ${result.error.code}`);
  return result.record;
}

function rejectionCode(value: unknown): string {
  const result = evaluatePolicy(value);
  if (result.ok) throw new Error("expected rejection");
  return result.error.code;
}

describe("policy decision table", () => {
  it("reaches every outcome with a stable reason code", () => {
    expect(decide()).toMatchObject({ decision: "ALLOW", reasonCodes: ["ALLOWED_BY_POLICY"] });
    const denied = decide({
      sliceChain: [slice("root", { rules: [rule("deny.me", { effect: "DENY" })] })],
    });
    expect(denied.decision).toBe("DENY");
    expect(denied.reasonCodes).toContain("DENIED_BY_RULE");
    const human = decide({ facts: [fact("fact.read_only", "R2")] });
    expect(human.decision).toBe("REQUIRE_HUMAN_APPROVAL");
    expect(human.reasonCodes).toContain("HUMAN_ONLY_TIER");
    const unknown = decide({ facts: [] });
    expect(unknown.decision).toBe("HOLD_UNKNOWN");
    expect(unknown.reasonCodes).toContain("REQUIRED_FACT_MISSING");
  });

  it("never yields ALLOW when a required fact is unknown, weak, or absent", () => {
    const permutations: readonly Partial<PolicyEvaluationInput>[] = [
      { facts: [] },
      { facts: [fact("fact.read_only", "R0", "UNKNOWN")] },
      { facts: [fact("fact.read_only", "R0", "OBSERVED")] },
      { facts: [fact("fact.read_only", "R0", "AGENT_REPORTED")] },
      { facts: [fact("fact.read_only", null)] },
      { callerRiskHint: "R0", facts: [] },
      { facts: [], waivers: [waiver()] },
      { facts: [fact("fact.read_only", "R0", "UNKNOWN")], waivers: [waiver()] },
    ];
    for (const over of permutations) {
      const record = decide(over);
      expect(record.decision).toBe("HOLD_UNKNOWN");
      expect(record.reasonCodes.length).toBeGreaterThan(0);
    }
  });

  it("raises but never lowers the daemon-derived tier from a caller hint", () => {
    const raised = decide({ callerRiskHint: "R3" });
    expect(raised.riskAssessment).toMatchObject({
      callerRiskHint: "R3", computedTier: "R0", effectiveTier: "R3",
    });
    expect(raised.decision).toBe("REQUIRE_HUMAN_APPROVAL");
    const lowered = decide({ callerRiskHint: "R0", facts: [fact("fact.read_only", "R2")] });
    expect(lowered.riskAssessment).toMatchObject({ computedTier: "R2", effectiveTier: "R2" });
    expect(lowered.decision).toBe("REQUIRE_HUMAN_APPROVAL");
  });

  it("keeps the hint out of the recorded fact set and the used-fact subset", () => {
    const record = decide({ callerRiskHint: "R3" });
    expect(record.inputFacts).toEqual([{ factId: "fact.read_only", truthClass: "DAEMON_VERIFIED" }]);
    expect(record.riskAssessment.usedFactIds).toEqual(["fact.read_only"]);
  });

  it("holds unknown even when the caller hints a decidable tier", () => {
    const record = decide({ callerRiskHint: "R2", facts: [] });
    expect(record.decision).toBe("HOLD_UNKNOWN");
    expect(record.riskAssessment).toMatchObject({
      callerRiskHint: "R2", computedTier: null, effectiveTier: null,
    });
  });

  it("applies the DENY > HOLD_UNKNOWN > REQUIRE_HUMAN_APPROVAL > ALLOW lattice", () => {
    const denyOverUnknown = decide({
      facts: [], sliceChain: [slice("root", { rules: [rule("d", { effect: "DENY" })] })],
    });
    expect(denyOverUnknown.decision).toBe("DENY");
    const unknownOverHuman = decide({ callerRiskHint: "R2", facts: [] });
    expect(unknownOverHuman.decision).toBe("HOLD_UNKNOWN");
    const humanOverAllow = decide({
      sliceChain: [slice("root", {
        autoApprovalOptIns: [OPT_IN_R0],
        rules: [rule("a"), rule("h", { effect: "REQUIRE_HUMAN_APPROVAL" })],
      })],
    });
    expect(humanOverAllow.decision).toBe("REQUIRE_HUMAN_APPROVAL");
    expect(humanOverAllow.reasonCodes).toContain("REQUIRE_HUMAN_APPROVAL_BY_RULE");
  });

  it("refuses a child slice that relaxes a parent rule, obligation, or opt-in", () => {
    const parent = slice("root", {
      rules: [rule("r", {
        effect: "DENY", obligations: [{ kind: "HARD", obligationId: "obligation.hard" }],
      })],
    });
    const relaxations: readonly PolicySlice[] = [
      slice("child", { rules: [rule("r", { effect: "ALLOW" })] }),
      slice("child", { rules: [rule("r", { effect: "DENY" })] }),
      slice("child", {
        rules: [rule("r", {
          effect: "DENY", obligations: [{ kind: "SOFT", obligationId: "obligation.hard" }],
        })],
      }),
      slice("child", { autoApprovalOptIns: [OPT_IN_R1] }),
    ];
    for (const child of relaxations) {
      const record = decide({ sliceChain: [parent, child] });
      expect(record.decision).toBe("DENY");
      expect(record.reasonCodes).toContain("SLICE_RELAXATION_DETECTED");
    }
  });

  it("accepts a scoped, unexpired, human-approved waiver over a named SOFT obligation only", () => {
    const parent = slice("root", {
      autoApprovalOptIns: [OPT_IN_R0],
      rules: [rule("r", { obligations: [{ kind: "SOFT", obligationId: "obligation.soft" }] })],
    });
    const child = slice("child", { autoApprovalOptIns: [OPT_IN_R0], rules: [rule("r")] });
    const waived = decide({ sliceChain: [parent, child], waivers: [waiver()] });
    expect(waived.decision).toBe("ALLOW");
    expect(waived.obligations).toEqual([]);
    const invalid: readonly PolicyWaiver[] = [
      waiver({ expiresAtEpochMs: 1_000 }),
      waiver({ expiresAtEpochMs: 999 }),
      waiver({ scope: [OTHER] }),
      waiver({ namedObligationId: "obligation.other" }),
    ];
    for (const bad of invalid) {
      const record = decide({ sliceChain: [parent, child], waivers: [bad] });
      expect(record.decision).toBe("DENY");
      expect(record.reasonCodes).toContain("SLICE_RELAXATION_DETECTED");
    }
    expect(decide({ sliceChain: [parent, child], waivers: [waiver({ scope: [OTHER] })] })
      .reasonCodes).toContain("WAIVER_INVALID");
    expect(rejectionCode(input({
      sliceChain: [parent, child], waivers: [waiver({ humanApprovalRef: "" })],
    }))).toBe("INPUT_INVALID");
  });

  it("makes the automatic path structurally unavailable above R1", () => {
    expect(rejectionCode(input({
      sliceChain: [slice("root", {
        autoApprovalOptIns: [{ action: ACTION, tier: "R2" } as unknown as typeof OPT_IN_R0],
      })],
    }))).toBe("INPUT_INVALID");
    for (const tier of ["R2", "R3"] as const) {
      const record = decide({
        facts: [fact("fact.read_only", tier)],
        sliceChain: [slice("root", { autoApprovalOptIns: [OPT_IN_R1] })],
      });
      expect(record.decision).toBe("REQUIRE_HUMAN_APPROVAL");
      expect(record.reasonCodes).toContain("HUMAN_ONLY_TIER");
    }
  });

  it("obliges reason and step-up on R3 and defaults R0/R1 to manual approval", () => {
    const r3 = decide({ facts: [fact("fact.read_only", "R3")] });
    expect(r3.obligations).toEqual([
      { kind: "HARD", obligationId: "core.decision_reason_required" },
      { kind: "HARD", obligationId: "core.step_up_authentication_required" },
    ]);
    const manual = decide({ sliceChain: [slice("root")] });
    expect(manual.decision).toBe("REQUIRE_HUMAN_APPROVAL");
    expect(manual.reasonCodes).toContain("AUTO_APPROVAL_NOT_OPTED_IN");
  });

  it("records provenance, freezes the record, and stays deterministic", () => {
    const record = decide();
    expect(record).toMatchObject({
      action: ACTION,
      decisionDigest: hash("ab"),
      evaluatorVersion: "moe-policy-evaluator/1",
      graphNodeRevisionRefs: [NODE],
      matchedRuleIds: [],
      policyRevisionRef: hash("cd"),
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.reasonCodes)).toBe(true);
    expect(Object.isFrozen(record.riskAssessment)).toBe(true);
    expect(decide()).toEqual(record);
  });

  it("rejects malformed input with INPUT_INVALID and no lifecycle source", () => {
    expect(rejectionCode(null)).toBe("INPUT_INVALID");
    expect(rejectionCode(input({ decisionDigest: "not-a-digest" }))).toBe("INPUT_INVALID");
    expect(rejectionCode(input({ evaluatedAtEpochMs: Number.NaN }))).toBe("INPUT_INVALID");
    expect(rejectionCode(input({
      facts: [fact("dupe", "R0"), fact("dupe", "R1")],
    }))).toBe("INPUT_INVALID");
    expect(rejectionCode(input({ sliceChain: [] }))).toBe("INPUT_INVALID");
  });
});
