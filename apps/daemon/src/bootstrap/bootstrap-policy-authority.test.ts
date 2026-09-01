import { describe, expect, it } from "vitest";

import {
  POLICY_DECISION_DIGEST_VERSION,
  decisionDigestFor,
} from "./bootstrap-policy-authority.js";

function material(): Record<string, unknown> {
  return {
    projectId: "project-1",
    serverSources: {
      evaluationTimeSource: "DAEMON_COMMAND_CLOCK",
      evaluatorVersionSource: "DAEMON_BUILD",
      waiverResolutionStatus: "RESOLVED_EMPTY",
    },
    verifiedInput: {
      action: "effect.activate",
      actor: "operator-1",
      callerRiskHint: null,
      evaluatedAtEpochMs: 1_760_000_000_000,
      evaluatorVersion: "moe-policy-evaluator/1",
      facts: [{ factId: "fact-1", tier: null, truthClass: "UNKNOWN" }],
      graphNodeRevisionRefs: ["node-revision-1"],
      policyRevisionRef: "a".repeat(64),
      requiredFactIds: ["fact-1"],
      scope: ["project:project-1"],
      sliceChain: [{ autoApprovalOptIns: [], rules: [], sliceRef: "a".repeat(64) }],
      waivers: [],
    },
    verifiedOutcome: {
      action: "effect.activate",
      actor: "operator-1",
      decision: "HOLD_UNKNOWN",
      evaluatorVersion: "moe-policy-evaluator/1",
      graphNodeRevisionRefs: ["node-revision-1"],
      inputFacts: [{ factId: "fact-1", truthClass: "UNKNOWN" }],
      matchedRuleIds: [],
      obligations: [],
      policyRevisionRef: "a".repeat(64),
      reasonCodes: ["RISK_TIER_UNCLASSIFIABLE"],
      riskAssessment: {
        callerRiskHint: null,
        computedTier: null,
        effectiveTier: null,
        usedFactIds: [],
      },
    },
  };
}

describe("policy decision digest v2", () => {
  it("pins the durable preimage vocabulary", () => {
    expect(POLICY_DECISION_DIGEST_VERSION).toBe("moe.policy.validate.decision.v2");
    expect(decisionDigestFor(material() as never))
      .toBe("1e68b0685881711d10cfaec8d871a53f581a34079a5f528f65f38b473bf12bdc");
  });

  it("is canonical across object construction order", () => {
    const base = material();
    const reordered = {
      verifiedOutcome: base["verifiedOutcome"],
      serverSources: base["serverSources"],
      verifiedInput: base["verifiedInput"],
      projectId: base["projectId"],
    };
    expect(decisionDigestFor(reordered as never)).toBe(decisionDigestFor(base as never));
  });

  it("changes for every authority-bearing input and outcome family", () => {
    const base = material();
    const input = base["verifiedInput"] as Record<string, unknown>;
    const outcome = base["verifiedOutcome"] as Record<string, unknown>;
    const risk = outcome["riskAssessment"] as Record<string, unknown>;
    const mutations: readonly Record<string, unknown>[] = Object.freeze([
      { ...base, projectId: "project-2" },
      { ...base, serverSources: { waiverResolutionStatus: "RESOLVED_NONEMPTY" } },
      { ...base, verifiedInput: { ...input, action: "plan.approve" } },
      { ...base, verifiedInput: { ...input, actor: "operator-2" } },
      { ...base, verifiedInput: { ...input, callerRiskHint: "R0" } },
      { ...base, verifiedInput: { ...input, evaluatedAtEpochMs: 1_760_000_000_001 } },
      { ...base, verifiedInput: { ...input, evaluatorVersion: "evaluator-2" } },
      { ...base, verifiedInput: { ...input, facts: [] } },
      { ...base, verifiedInput: { ...input, graphNodeRevisionRefs: [] } },
      { ...base, verifiedInput: { ...input, policyRevisionRef: "b".repeat(64) } },
      { ...base, verifiedInput: { ...input, requiredFactIds: [] } },
      { ...base, verifiedInput: { ...input, scope: [] } },
      { ...base, verifiedInput: { ...input, sliceChain: [] } },
      { ...base, verifiedInput: { ...input, waivers: [{ waiverRef: "waiver-1" }] } },
      { ...base, verifiedOutcome: { ...outcome, decision: "DENY" } },
      { ...base, verifiedOutcome: { ...outcome, matchedRuleIds: ["rule-1"] } },
      { ...base, verifiedOutcome: { ...outcome, obligations: [{ kind: "HARD" }] } },
      { ...base, verifiedOutcome: { ...outcome, reasonCodes: ["DENIED_BY_RULE"] } },
      { ...base, verifiedOutcome: {
        ...outcome,
        riskAssessment: { ...risk, computedTier: "R1" },
      } },
    ]);
    expect(mutations).toHaveLength(19);
    expect(mutations.length).toBeGreaterThan(0);
    const baseline = decisionDigestFor(base as never);
    for (const mutation of mutations) {
      expect(decisionDigestFor(mutation as never)).not.toBe(baseline);
    }
  });

  it("retains array order because slice composition order is semantic", () => {
    const base = material();
    const input = base["verifiedInput"] as Record<string, unknown>;
    const first = { autoApprovalOptIns: [], rules: [], sliceRef: "a".repeat(64) };
    const second = { autoApprovalOptIns: [], rules: [], sliceRef: "b".repeat(64) };
    expect(decisionDigestFor({
      ...base,
      verifiedInput: { ...input, sliceChain: [first, second] },
    } as never)).not.toBe(decisionDigestFor({
      ...base,
      verifiedInput: { ...input, sliceChain: [second, first] },
    } as never));
  });
});
