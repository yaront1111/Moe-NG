import { describe, expect, it } from "vitest";

import type { ApprovalDecisionRecord, ApprovalImpactSet } from "./approval-contract.js";
import { applyApprovalCommand, applyApprovalInvalidation } from "./approval-invalidation.js";
import { POLICY_OUTCOMES, POLICY_RISK_TIERS } from "./policy-contract.js";
import type {
  PolicyEvaluationInput,
  PolicyFactInput,
  PolicyOutcome,
  PolicyRiskTier,
  PolicySlice,
} from "./policy-contract.js";
import { evaluatePolicy } from "./policy-evaluation.js";

/**
 * Deterministic linear congruential generator. `Math.random` is deliberately unused anywhere in
 * this area: a replayable seed is what makes "same seed -> identical trace" assertable at all.
 */
function lcg(seed: number): () => number {
  let state = (seed * 2_654_435_761) >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const FACT_IDS = ["f.alpha", "f.beta", "f.gamma"] as const;
const STRONG = ["DAEMON_VERIFIED", "HUMAN_APPROVED"] as const;
const WEAK = ["OBSERVED", "AGENT_REPORTED", "UNKNOWN"] as const;
/** Weighted toward the auto-approvable tiers so the ALLOW branch is actually reached. */
const TIERS = [null, "R0", "R0", "R1", "R1", "R2", "R3"] as const;
const HINTS = [null, null, "R0", "R1", "R2", "R3"] as const;
const EFFECTS = ["ALLOW", "ALLOW", "REQUIRE_HUMAN_APPROVAL", "DENY"] as const;
const ACTION = "graph.approve";
const NODE = "node:alpha";
const OTHER = "node:beta";
const SWEEP = 320;

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function buildInput(rand: () => number): PolicyEvaluationInput {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const facts: PolicyFactInput[] = [];
  for (const factId of FACT_IDS) {
    if (rand() < 0.2) continue;
    facts.push({ factId, tier: pick(TIERS), truthClass: rand() < 0.7 ? pick(STRONG) : pick(WEAK) });
  }
  const named = { kind: pick(["HARD", "SOFT"] as const), obligationId: "obligation.named" };
  const obligations = rand() < 0.3 ? [named] : [];
  /** Required facts vary BETWEEN links — the child keeps, widens, or SHRINKS the root's set. The
   * shrink is the shape this sweep could not emit, so invariant (1) passed vacuously over it. */
  const rootRequired = rand() < 0.55 ? FACT_IDS.filter(() => rand() < 0.6) : [];
  const draw = rand();
  const childRequired = draw < 0.35 ? rootRequired.slice(1)
    : draw < 0.6 ? [...new Set([...rootRequired, pick(FACT_IDS)])] : rootRequired;
  const optIns = rand() < 0.7 ? [{ action: ACTION, tier: pick(["R0", "R1"] as const) }] : [];
  const slice = (sliceRef: string, rules: PolicySlice["rules"]): PolicySlice =>
    ({ autoApprovalOptIns: optIns, rules, sliceRef });
  const root = slice("slice:root", rand() < 0.6
    ? [{ effect: pick(EFFECTS), obligations, requiredFactIds: rootRequired, ruleId: "r.core" }] : []);
  const child = slice("slice:child", rand() < 0.5
    ? [{ effect: pick(EFFECTS), obligations: [], requiredFactIds: childRequired, ruleId: "r.core" }] : []);
  return {
    action: ACTION,
    actor: "human:root",
    callerRiskHint: pick(HINTS),
    decisionDigest: hash("ab"),
    evaluatedAtEpochMs: 1_000,
    evaluatorVersion: "moe-policy-evaluator/1",
    facts,
    graphNodeRevisionRefs: [NODE],
    policyRevisionRef: hash("cd"),
    requiredFactIds: FACT_IDS.filter(() => rand() < 0.7),
    scope: [NODE],
    sliceChain: rand() < 0.5 ? [root] : [root, child],
    waivers: rand() < 0.4 ? [{
      expiresAtEpochMs: 9_000, humanApprovalRef: "approval:soft",
      namedObligationId: "obligation.named", scope: [NODE], waiverRef: "waiver:1",
    }] : [],
  };
}

const strongTruth = (v: string): boolean => v === "DAEMON_VERIFIED" || v === "HUMAN_APPROVED";

/** A required fact is unusable when absent, UNKNOWN, or a tier claim below the floor. The set is
 * unioned over every slice's rules as well as the top-level list, so a fact any link in the chain
 * demanded still counts even if a later link stopped demanding it. */
function hasUnusableRequiredFact(input: PolicyEvaluationInput): boolean {
  const required = new Set(input.requiredFactIds);
  for (const slice of input.sliceChain) {
    for (const rule of slice.rules) for (const id of rule.requiredFactIds) required.add(id);
  }
  return [...required].some((id) => {
    const fact = input.facts.find((entry) => entry.factId === id);
    if (fact === undefined) return true;
    return fact.truthClass === "UNKNOWN" || (fact.tier !== null && !strongTruth(fact.truthClass));
  });
}

/** The generator redeclares only `r.core`, so a shrink is visible from the chain's two links. */
function shrinksRequiredFacts(input: PolicyEvaluationInput): boolean {
  const ancestor = input.sliceChain[0]?.rules[0]?.requiredFactIds ?? [];
  const redeclared = input.sliceChain[1]?.rules[0]?.requiredFactIds;
  return redeclared !== undefined && ancestor.some((id) => !redeclared.includes(id));
}

describe("policy invariants", () => {
  it("never reaches ALLOW with an unusable required fact, across the whole sweep", () => {
    const seen = new Map<PolicyOutcome, number>();
    let unusable = 0;
    let shrunk = 0;
    for (let seed = 0; seed < SWEEP; seed += 1) {
      const input = buildInput(lcg(seed));
      const result = evaluatePolicy(input);
      if (!result.ok) throw new Error(`unexpected rejection ${result.error.code}`);
      const { decision } = result.record;
      seen.set(decision, (seen.get(decision) ?? 0) + 1);
      if (shrinksRequiredFacts(input)) {
        shrunk += 1;
        expect(decision).toBe("DENY");
        expect(result.record.reasonCodes).toContain("SLICE_RELAXATION_DETECTED");
      }
      if (!hasUnusableRequiredFact(input)) continue;
      unusable += 1;
      expect(decision).not.toBe("ALLOW");
      expect(result.record.reasonCodes.length).toBeGreaterThan(0);
    }
    expect(unusable).toBeGreaterThan(0);
    /** Observed 10/320 at this tuning; the floor is a canary against a generator retune. */
    expect(shrunk).toBeGreaterThanOrEqual(5);
    for (const outcome of POLICY_OUTCOMES) expect(seen.get(outcome) ?? 0).toBeGreaterThan(0);
  });

  it("lets a hint raise the effective tier but never touch the computed tier or fact set", () => {
    const tiers = new Set<PolicyRiskTier>();
    for (let seed = 0; seed < SWEEP; seed += 1) {
      const input = buildInput(lcg(seed));
      const hinted = evaluatePolicy(input);
      const bare = evaluatePolicy({ ...input, callerRiskHint: null });
      if (!hinted.ok || !bare.ok) throw new Error("unexpected rejection");
      const { computedTier, effectiveTier } = hinted.record.riskAssessment;
      expect(computedTier).toBe(bare.record.riskAssessment.computedTier);
      expect(hinted.record.riskAssessment.usedFactIds).toEqual(bare.record.riskAssessment.usedFactIds);
      expect(hinted.record.inputFacts).toEqual(bare.record.inputFacts);
      if (computedTier === null) { expect(effectiveTier).toBeNull(); continue; }
      tiers.add(computedTier);
      expect(effectiveTier).not.toBeNull();
      expect(POLICY_RISK_TIERS.indexOf(effectiveTier as PolicyRiskTier))
        .toBeGreaterThanOrEqual(POLICY_RISK_TIERS.indexOf(computedTier));
    }
    for (const tier of POLICY_RISK_TIERS) expect(tiers.has(tier)).toBe(true);
  });

  it("never lets a waiver launder unusable evidence into an allowance", () => {
    let waived = 0;
    for (let seed = 0; seed < SWEEP; seed += 1) {
      const input = buildInput(lcg(seed));
      if (input.waivers.length === 0 || !hasUnusableRequiredFact(input)) continue;
      waived += 1;
      const result = evaluatePolicy(input);
      if (!result.ok) throw new Error("unexpected rejection");
      expect(result.record.decision).not.toBe("ALLOW");
      const withoutWaiver = evaluatePolicy({ ...input, waivers: [] });
      if (!withoutWaiver.ok) throw new Error("unexpected rejection");
      expect(withoutWaiver.record.decision).not.toBe("ALLOW");
    }
    expect(waived).toBeGreaterThan(0);
  });

  it("produces deep-frozen records and an identical trace for an identical seed", () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const first = evaluatePolicy(buildInput(lcg(seed)));
      const second = evaluatePolicy(buildInput(lcg(seed)));
      if (!first.ok || !second.ok) throw new Error("unexpected rejection");
      expect(first.record).toEqual(second.record);
      expect(Object.isFrozen(first.record)).toBe(true);
      expect(Object.isFrozen(first.record.inputFacts)).toBe(true);
      expect(Object.isFrozen(first.record.riskAssessment)).toBe(true);
    }
  });
});

const baseApproval = (over: Partial<ApprovalDecisionRecord> = {}): ApprovalDecisionRecord => ({
  actor: "human:root", actorKind: "HUMAN", applicablePolicyRef: hash("33"),
  approvalRef: "approval:1", approvedNodeScope: [NODE], budgetRef: hash("44"),
  criteriaRef: hash("55"), decision: null, decisionReason: null,
  dependencyChanges: { additions: [], challenges: [], removals: [] },
  exactRevisionHash: hash("11"), lifecycle: "PENDING", planQualityAssessmentRef: hash("66"),
  policyDecisionRef: null, riskTier: "R1", stepUpAuthRef: "stepup:1",
  truthClass: "HUMAN_APPROVED", validity: "CURRENT", ...over,
});

describe("approval invariants", () => {
  it("touches only the approvals the impact set or a successor linkage names", () => {
    let invalidated = 0;
    let untouched = 0;
    for (let seed = 0; seed < SWEEP; seed += 1) {
      const rand = lcg(seed);
      const approvals = [
        baseApproval({ approvalRef: "approval:1", approvedNodeScope: [NODE] }),
        baseApproval({
          approvalRef: "approval:2", approvedNodeScope: [OTHER], exactRevisionHash: hash("22"),
        }),
      ];
      const impactSet: ApprovalImpactSet = {
        canonicalizerVersion: "moe-canonical/1",
        changedNodeRefs: rand() < 0.5 ? [NODE] : [],
        changedRevisionHashes: rand() < 0.5 ? [hash("11")] : [],
      };
      const result = applyApprovalInvalidation({
        approvals, impactSet, successorLinks: [],
        supportedCanonicalizerVersions: ["moe-canonical/1"],
      });
      if (!result.ok) throw new Error("unexpected rejection");
      expect(result.value[1]).toEqual(approvals[1]);
      const touched = impactSet.changedNodeRefs.length > 0
        || impactSet.changedRevisionHashes.length > 0;
      expect(result.value[0]?.validity).toBe(touched ? "INVALIDATED" : "CURRENT");
      if (touched) invalidated += 1; else untouched += 1;
    }
    expect(invalidated).toBeGreaterThan(0);
    expect(untouched).toBeGreaterThan(0);
  });

  it("never admits a SYSTEM_POLICY record above R1 or claiming human truth", () => {
    const accepted = new Set<string>();
    for (const riskTier of POLICY_RISK_TIERS) {
      for (const truthClass of [...STRONG, ...WEAK] as const) {
        const record = baseApproval({
          actor: `policy:${hash("77")}`, actorKind: "SYSTEM_POLICY",
          policyDecisionRef: hash("88"), riskTier, stepUpAuthRef: null, truthClass,
        });
        const result = applyApprovalCommand(record, {
          decision: "APPROVE", decisionReason: "auto", kind: "approval.decide",
          stepUpAuthRef: null,
        });
        if (!result.ok) {
          expect(result.error.code).toBe("INPUT_INVALID");
          continue;
        }
        accepted.add(`${riskTier}:${truthClass}`);
        expect(result.value.truthClass).toBe("DAEMON_VERIFIED");
        expect(["R0", "R1"]).toContain(result.value.riskTier);
      }
    }
    expect([...accepted].sort()).toEqual(["R0:DAEMON_VERIFIED", "R1:DAEMON_VERIFIED"]);
  });
});
