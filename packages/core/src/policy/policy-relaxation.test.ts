/**
 * Slice composition along the EVIDENCE dimension.
 *
 * `assessEvidence` derives the required-fact set from the folded rule set, and the fold keeps the
 * LAST declaration of each `ruleId`. So `requiredFactIds` is an authority field, not merely a
 * matching predicate: a child that shrinks it deletes a parent's `HOLD_UNKNOWN` trigger. This file
 * pins that dimension of "children tighten, never relax" — the one the effect/obligation cases in
 * `policy-decision-table.test.ts` do not reach.
 */
import { describe, expect, it } from "vitest";

import type {
  PolicyDecisionRecord,
  PolicyEvaluationInput,
  PolicyRule,
  PolicySlice,
} from "./policy-contract.js";
import { evaluatePolicy } from "./policy-evaluation.js";

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

const NODE = "node:alpha";
const ACTION = "graph.approve";
const OPT_IN_R1 = { action: ACTION, tier: "R1" } as const;
const TIER_FACT = { factId: "fact.tier", tier: "R0", truthClass: "DAEMON_VERIFIED" } as const;
const AUDIT_FACT = { factId: "fact.audit", tier: null, truthClass: "DAEMON_VERIFIED" } as const;
const SIGN_FACT = { factId: "fact.signoff", tier: null, truthClass: "DAEMON_VERIFIED" } as const;
const ALL_FACTS = [TIER_FACT, AUDIT_FACT, SIGN_FACT];

const rule = (requiredFactIds: readonly string[]): PolicyRule =>
  ({ effect: "ALLOW", obligations: [], requiredFactIds, ruleId: "rule.audit" });

/**
 * Every link redeclares the opt-in, because the effective opt-in set is the LAST slice's
 * declaration; without it a two-link chain lands on `REQUIRE_HUMAN_APPROVAL` for an unrelated
 * reason and the evidence dimension under test would never be reached.
 */
const link = (sliceRef: string, requiredFactIds: readonly string[]): PolicySlice =>
  ({ autoApprovalOptIns: [OPT_IN_R1], rules: [rule(requiredFactIds)], sliceRef });

function input(over: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    action: ACTION,
    actor: "human:root",
    callerRiskHint: null,
    decisionDigest: hash("ab"),
    evaluatedAtEpochMs: 1_000,
    evaluatorVersion: "moe-policy-evaluator/1",
    facts: [TIER_FACT],
    graphNodeRevisionRefs: [NODE],
    policyRevisionRef: hash("cd"),
    requiredFactIds: [],
    scope: [NODE],
    sliceChain: [link("root", ["fact.audit"])],
    waivers: [],
    ...over,
  };
}

function decide(over: Partial<PolicyEvaluationInput> = {}): PolicyDecisionRecord {
  const result = evaluatePolicy(input(over));
  if (!result.ok) throw new Error(`unexpected rejection ${result.error.code}`);
  return result.record;
}

describe("policy slice relaxation over required facts", () => {
  it("refuses a child that shrinks a parent rule's required-fact set", () => {
    const alone = decide();
    expect(alone.decision).toBe("HOLD_UNKNOWN");
    expect(alone.reasonCodes).toContain("REQUIRED_FACT_MISSING");
    const shrunk = decide({ sliceChain: [link("root", ["fact.audit"]), link("child", [])] });
    expect(shrunk.decision).toBe("DENY");
    expect(shrunk.reasonCodes).toContain("SLICE_RELAXATION_DETECTED");
  });

  it("refuses a partial shrink even when every fact is present and usable", () => {
    const parent = link("root", ["fact.audit", "fact.signoff"]);
    expect(decide({ facts: ALL_FACTS, sliceChain: [parent] }).decision).toBe("ALLOW");
    const partial = decide({
      facts: ALL_FACTS,
      sliceChain: [parent, link("child", ["fact.audit"])],
    });
    expect(partial.decision).toBe("DENY");
    expect(partial.reasonCodes).toContain("SLICE_RELAXATION_DETECTED");
  });

  it("admits an equal or widened redeclaration and keeps the widened one fail-closed", () => {
    const parent = link("root", ["fact.audit"]);
    const equal = decide({
      facts: ALL_FACTS,
      sliceChain: [parent, link("child", ["fact.audit"])],
    });
    expect(equal.decision).toBe("ALLOW");
    const child = link("child", ["fact.audit", "fact.signoff"]);
    expect(decide({ facts: ALL_FACTS, sliceChain: [parent, child] }).decision).toBe("ALLOW");
    const missing = decide({
      facts: [TIER_FACT, AUDIT_FACT],
      sliceChain: [parent, child],
    });
    expect(missing.decision).toBe("HOLD_UNKNOWN");
    expect(missing.reasonCodes).toContain("REQUIRED_FACT_MISSING");
    expect(missing.reasonCodes).not.toContain("SLICE_RELAXATION_DETECTED");
  });

  it("gives a waiver no path over a shrunken required-fact set", () => {
    const chain = [link("root", ["fact.audit"]), link("child", [])];
    const named = ["fact.audit", "rule.audit", "obligation.soft"] as const;
    for (const namedObligationId of named) {
      const record = decide({
        sliceChain: chain,
        waivers: [{
          expiresAtEpochMs: 9_000, humanApprovalRef: "approval:soft",
          namedObligationId, scope: [NODE], waiverRef: "waiver:1",
        }],
      });
      expect(record.decision).toBe("DENY");
      expect(record.reasonCodes).toContain("SLICE_RELAXATION_DETECTED");
    }
  });

  it("compares each link against the running effective rule, not only against the root", () => {
    const chain = [
      link("root", ["fact.audit"]),
      link("middle", ["fact.audit", "fact.signoff"]),
      link("leaf", ["fact.audit"]),
    ];
    const record = decide({ facts: ALL_FACTS, sliceChain: chain });
    expect(record.decision).toBe("DENY");
    expect(record.reasonCodes).toContain("SLICE_RELAXATION_DETECTED");
  });
});
