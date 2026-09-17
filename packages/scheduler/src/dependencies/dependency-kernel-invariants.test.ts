import { describe, expect, it } from "vitest";
import { analyzeGraphStructure } from "../analyze-graph.js";
import { validateGraphSnapshot } from "../validate-graph.js";
import { assessContractRedundancy, validateDependencyChallenge } from "./dependency-analysis.js";
import { DEPENDENCY_GATES, type DependencyContract } from "./dependency-contract.js";
import { isWithinHorizon } from "./dependency-witness.js";
const A = "a".repeat(64);
const B = "b".repeat(64);
function contract(): DependencyContract {
  return {
    producerNodeKey: "producer-a", consumerNodeKey: "consumer-b", edgeKind: "ARTIFACT_CONSUMPTION",
    graphBindingDigest: A,
    producer: { kind: "ARTIFACT_CONSUMPTION", artifactOrInterfaceRef: "artifact:x", digest: B },
    consumer: { kind: "PRECONDITION", criterionRef: "criterion:x", contractHash: A },
    minimumQualifyingMilestone: "RESULT_SEALED",
    satisfactionPredicate: { predicateRef: "predicate:sealed", schemaId: "moe.predicate.sealed", schemaVersion: 1, parametersDigest: B },
    stability: "REVOCABLE",
    satisfactionWitnesses: [{ witnessRef: "witness:x", witnessVersion: 2, witnessDigest: A, sourceOperationClass: "ARTIFACT_SEAL" }],
    consumptionHorizon: "RESULT_SEAL",
    necessity: { failedConsumerCriterionRef: "criterion:x", failureKind: "MISSING_ARTIFACT", truthClass: "DAEMON_VERIFIED" },
    alternativeRuling: { kind: "NOT_APPLICABLE", reason: "no compatible substitute" },
    alternateProducers: ["producer-backup"], truthClass: "DAEMON_VERIFIED",
    invalidationFacts: [{ sourceFactRef: "fact:x", sourceFactVersion: 2, sourceFactDigest: A }],
    recheckPredicateRef: "predicate:sealed",
  };
}
function codesOf(result: unknown): readonly string[] {
  return (result as { issues?: readonly { code: string }[] }).issues?.map((issue) => issue.code) ?? [];
}
describe("dependency consumption horizons", () => {
  it("defines one total order with equality inside the horizon", () => {
    expect(DEPENDENCY_GATES).toHaveLength(11);
    for (let gate = 0; gate < DEPENDENCY_GATES.length; gate += 1) {
      for (let horizon = 0; horizon < DEPENDENCY_GATES.length; horizon += 1) {
        expect(
          isWithinHorizon(DEPENDENCY_GATES[gate], DEPENDENCY_GATES[horizon]),
          `${DEPENDENCY_GATES[gate]} <= ${DEPENDENCY_GATES[horizon]}`,
        ).toBe(gate <= horizon);
      }
    }
    expect(isWithinHorizon("UNKNOWN_GATE", "GOAL_COMPLETION")).toBe(false);
    expect(isWithinHorizon("MATERIALIZATION_SEAL", "UNKNOWN_GATE")).toBe(false);
  });
});
function structuralCandidate() {
  const validated = validateGraphSnapshot({
    nodes: ["producer-a", "middle", "consumer-b"].map((nodeKey) => ({ nodeKey, executionBearing: true })),
    edges: [
      { edgeKey: "direct", producerNodeKey: "producer-a", consumerNodeKey: "consumer-b", kind: "HARD" },
      { edgeKey: "first", producerNodeKey: "producer-a", consumerNodeKey: "middle", kind: "HARD" },
      { edgeKey: "last", producerNodeKey: "middle", consumerNodeKey: "consumer-b", kind: "HARD" },
    ],
    completionNodeKey: "consumer-b",
  });
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error("fixture validation failed");
  const candidates = analyzeGraphStructure(validated.graph).structuralRedundancyCandidates;
  expect(candidates).toHaveLength(1);
  return candidates[0]!;
}
function assessmentInput() {
  return { structuralCandidate: structuralCandidate(), directContract: contract(),
    alternatePathContracts: [{ ...contract(), consumerNodeKey: "middle" }, { ...contract(), producerNodeKey: "middle" }] };
}
function challenge(subject: Record<string, unknown>, status: Record<string, unknown> = { kind: "OPEN" }) {
  return { challengeRef: "challenge:1", subject,
    binding: { graphEpoch: 4, sourceFactVersions: [{ sourceFactRef: "fact:b", version: 2 }, { sourceFactRef: "fact:a", version: 1 }] },
    status, successorPlanningRunRef: "planning:next", successorPlanningRunVersion: 1 };
}
const discovery = { kind: "MISSING_EDGE_DISCOVERY", producerNodeKey: "producer-a", consumerNodeKey: "consumer-b",
  holdNodeKey: "consumer-b", edgeHash: A, truthClass: "AGENT_REPORTED", callerLeaseRef: "lease:1", callerLeaseVersion: 3 };
function challengeContext(openChallenges: unknown[] = []) {
  return { callerLease: { nodeKey: "consumer-b", leaseRef: "lease:1", leaseVersion: 3 },
    currentHardContracts: [{ edgeKey: "direct", contractHash: A }], openChallenges };
}
describe("contract redundancy remains advisory", () => {
  it("layers typed facts over the existing structural candidate without removal authority", () => {
    const direct = contract();
    const input = { ...assessmentInput(), directContract: direct };
    const result = assessContractRedundancy(input);
    expect(result).toMatchObject({ ok: true, assessment: { kind: "REDUNDANCY_CANDIDATE", requiresSemanticProof: true } });
    expect(JSON.stringify(result)).not.toMatch(/safeToRemove|removal|activation/u);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.assessment.structuralCandidate.alternateHardPathEdgeKeys)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });
  it("refuses hostile assessment input without invoking traps", () => {
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(() => assessContractRedundancy(revoked.proxy)).not.toThrow();
    expect(codesOf(assessContractRedundancy(revoked.proxy))).toEqual(["DEPENDENCY_ANALYSIS_MALFORMED"]);
    const forged = { ...assessmentInput(), structuralCandidate: { ...structuralCandidate(),
      alternateHardPathNodeKeys: ["producer-a", "consumer-b"], alternateHardPathEdgeKeys: ["direct"] },
      alternatePathContracts: [contract()] };
    expect(codesOf(assessContractRedundancy(forged))).toEqual(["DEPENDENCY_ANALYSIS_MALFORMED"]);
    const crossGraph = assessmentInput();
    crossGraph.alternatePathContracts[0] = { ...crossGraph.alternatePathContracts[0]!, graphBindingDigest: B };
    expect(codesOf(assessContractRedundancy(crossGraph))).toEqual(["DEPENDENCY_ANALYSIS_PATH_MISMATCH"]);
  });
});
describe("dependency challenge bindings", () => {
  it("accepts lifecycle-derived statuses with deterministic successor/dedup bindings", () => {
    const statuses = [
      { kind: "OPEN" }, { kind: "MAPPED_TO_EXISTING_CONTRACT" }, { kind: "RESOLVED_BY_SUPERSESSION" },
      { kind: "CLOSED_NO_CHANGE" }, { kind: "SUPERSEDED" },
    ];
    for (const status of statuses) {
      const result = validateDependencyChallenge(challenge(discovery, status), challengeContext());
      expect(result.ok, status.kind).toBe(true);
      if (result.ok) {
        expect(result.challenge.successorPlanningRunRef).toBe("planning:next");
        expect(Object.isFrozen(result.challenge.binding.sourceFactVersions)).toBe(true);
      }
    }
    const existing = { kind: "EXISTING_EDGE_NECESSITY", edgeKey: "direct", contractHash: A,
      blockerKind: "SEMANTIC_PREREQUISITE" };
    expect(validateDependencyChallenge(challenge(existing), challengeContext()).ok).toBe(true);
    const forward = validateDependencyChallenge(challenge(discovery), challengeContext());
    const reversedInput = challenge(discovery);
    reversedInput.binding.sourceFactVersions.reverse();
    const reversed = validateDependencyChallenge(reversedInput, challengeContext());
    expect(forward.ok && reversed.ok && forward.challenge.dedupKey).toBe(reversed.ok ? reversed.challenge.dedupKey : "");
  });
  it("deduplicates the same discovery and refuses foreign or mutual hidden holds", () => {
    const first = validateDependencyChallenge(challenge(discovery), challengeContext());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const same = [{ kind: "MISSING_EDGE_DISCOVERY", producerNodeKey: "producer-a", consumerNodeKey: "consumer-b",
      challengeRef: "challenge:old", dedupKey: first.challenge.dedupKey }];
    expect(validateDependencyChallenge(
      challenge(discovery, { kind: "DEDUPLICATED", existingChallengeRef: "challenge:old" }), challengeContext(same),
    ).ok).toBe(true);
    expect(validateDependencyChallenge(challenge({ ...discovery, edgeHash: B }), challengeContext(same)).ok).toBe(true);
    const foreign = challenge({ ...discovery, holdNodeKey: "foreign" });
    expect(codesOf(validateDependencyChallenge(foreign, challengeContext()))).toEqual(["DEPENDENCY_CHALLENGE_FOREIGN_HOLD"]);
    const inverse = [{ kind: "MISSING_EDGE_DISCOVERY", producerNodeKey: "consumer-b", consumerNodeKey: "producer-a",
      challengeRef: "challenge:inverse", dedupKey: "dedup:inverse" }];
    expect(codesOf(validateDependencyChallenge(challenge(discovery), challengeContext(inverse)))).toEqual([
      "DEPENDENCY_CHALLENGE_MUTUAL_HOLD",
    ]);
  });
  it("requires an existing current hard contract for semantic prerequisites", () => {
    const existing = { kind: "EXISTING_EDGE_NECESSITY", edgeKey: "missing", contractHash: A,
      blockerKind: "SEMANTIC_PREREQUISITE" };
    expect(codesOf(validateDependencyChallenge(challenge(existing), challengeContext()))).toEqual([
      "DEPENDENCY_CHALLENGE_CONTRACT_NOT_CURRENT",
    ]);
    const current = { ...existing, edgeKey: "direct" };
    expect(codesOf(validateDependencyChallenge(
      challenge(current, { kind: "DEDUPLICATED", existingChallengeRef: "challenge:ghost" }), challengeContext(),
    ))).toEqual(["DEPENDENCY_CHALLENGE_DEDUP_REQUIRED"]);
    const ambiguous = challengeContext();
    ambiguous.currentHardContracts.push({ edgeKey: "direct", contractHash: B });
    expect(codesOf(validateDependencyChallenge(challenge({ ...existing, edgeKey: "direct" }), ambiguous))).toEqual([
      "DEPENDENCY_CHALLENGE_MALFORMED",
    ]);
    const revoked = Proxy.revocable(challenge(discovery), {}); revoked.revoke();
    expect(() => validateDependencyChallenge(revoked.proxy, challengeContext())).not.toThrow();
  });
});
describe("repeated dependency invariants", () => {
  it("never launders removal authority across fresh assessments", () => {
    for (let index = 0; index < 96; index += 1) {
      const assessment = assessContractRedundancy(assessmentInput());
      expect(assessment.ok && assessment.assessment.requiresSemanticProof).toBe(true);
      expect(Object.isFrozen(assessment)).toBe(true);
    }
    const input = challenge(discovery);
    expect(JSON.stringify(validateDependencyChallenge(input, challengeContext()))).toBe(
      JSON.stringify(validateDependencyChallenge(input, challengeContext())),
    );
  });
});
