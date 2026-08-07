import { describe, expect, it } from "vitest";
import type { DependencyContract, DependencyTruthClass } from "../dependencies/dependency-contract.js";
import {
  HASH_A, HASH_B, UNKNOWN_ESTIMATES, chain, codesOf, contractFor, counterfactualFor,
  diamond, entriesFor, entryFor, inputFor, predicate, recordsOf,
} from "./admission-fixtures.js";
import { REJECTED_NECESSITY_WITNESS_KINDS, admitGraph } from "./admission-pass.js";
import { evaluateNecessityClaim } from "./admission-necessity.js";
import type { AdmissionNecessityOutcome, AdmissionNecessityResult } from "./admission-necessity.js";
import {
  admitDependencyChallenge, isTimeChallengeSuppressed, validateIntentionalWait,
} from "./admission-wait.js";

const EDGE = "dev-edge-ab";
const COUNTEREXAMPLE = {
  edgeKey: EDGE,
  requiredEdgeFixtureRef: "fixture:required", requiredEdgeFixtureDigest: HASH_A,
  falseEdgeFixtureRef: "fixture:false", falseEdgeFixtureDigest: HASH_A,
  truthClass: "OBSERVED",
};

function contractWith(truthClass: DependencyTruthClass): DependencyContract {
  return contractFor("dev-node-a", "dev-node-b", {
    necessity: { failedConsumerCriterionRef: "criterion:dev-node-b", failureKind: "MISSING_ARTIFACT", truthClass },
  });
}

function evaluate(
  claimed: DependencyTruthClass,
  extra: Record<string, unknown> = {},
  contractTruth: DependencyTruthClass = claimed,
): AdmissionNecessityResult {
  return evaluateNecessityClaim(
    { edgeKey: EDGE, truthClass: claimed, ...extra },
    contractWith(contractTruth),
    counterfactualFor(chain(), EDGE),
  );
}

function outcomeOf(result: AdmissionNecessityResult): AdmissionNecessityOutcome {
  if (!result.ok) throw new Error(`unexpected malformed claim: ${result.issues.map((issue) => issue.code).join(",")}`);
  return result.outcome;
}

function issueCodes(result: { readonly ok: boolean }): readonly string[] {
  return (result as { readonly issues?: readonly { readonly code: string }[] }).issues?.map((issue) => issue.code) ?? [];
}

describe("admission necessity outcomes", () => {
  it("admits only on a daemon-verifiable witness", () => {
    const outcome = outcomeOf(evaluate("DAEMON_VERIFIED"));
    expect(outcome.kind).toBe("ADMISSIBLE");
    expect(outcome.code).toBe("ADMISSION_NECESSITY_ADMISSIBLE");
    expect(outcome.truthClass).toBe("DAEMON_VERIFIED");
  });

  it("holds an agent-reported claim for a human decision without upgrading its truth class", () => {
    const outcome = outcomeOf(evaluate("AGENT_REPORTED", { humanDecisionRef: "decision:42" }));
    expect(outcome.kind).toBe("HELD");
    expect(outcome.code).toBe("ADMISSION_HELD_FOR_HUMAN_DECISION");
    expect(outcome.truthClass).toBe("AGENT_REPORTED");
    const counterfactual = counterfactualFor(chain(), EDGE);
    expect(outcome.kind === "HELD" ? outcome.policySequenceConversion : null).toEqual({
      edgeKind: "POLICY_SEQUENCE",
      addedStructuralStages: counterfactual.structuralStageReduction,
      alternateHardPathPresent: counterfactual.alternateHardPathPresent,
      completionClosureIntactWithoutEdge: counterfactual.completionClosureIntactWithoutEdge,
      reviewOnly: true,
    });
  });

  it("refuses an agent-reported claim with no pending human decision", () => {
    expect(outcomeOf(evaluate("AGENT_REPORTED")).kind).toBe("REFUSED");
  });

  it.each(["OBSERVED", "HUMAN_APPROVED"] as const)("downgrades a %s claim to advisory", (truthClass) => {
    const outcome = outcomeOf(evaluate(truthClass));
    expect(outcome.kind).toBe("DOWNGRADED_ADVISORY");
    expect(outcome.truthClass).toBe(truthClass);
  });

  it("refuses an UNKNOWN claim", () => {
    expect(outcomeOf(evaluate("UNKNOWN")).kind).toBe("REFUSED");
  });

  it("fails closed to UNKNOWN when claim and contract disagree on the necessity truth class", () => {
    const outcome = outcomeOf(evaluate("DAEMON_VERIFIED", {}, "AGENT_REPORTED"));
    expect(outcome.kind).toBe("REFUSED");
    expect(outcome.truthClass).toBe("UNKNOWN");
  });

  it("carries no lifecycle machinery on a HELD outcome", () => {
    const outcome = outcomeOf(evaluate("AGENT_REPORTED", { humanDecisionRef: "decision:42" }));
    expect(Object.keys(outcome).sort()).toEqual([
      "code", "counterexample", "edgeKey", "humanDecisionRef", "kind",
      "policySequenceConversion", "structuralCounterfactual", "truthClass",
    ]);
    expect(Object.keys(outcome).filter((key) => /status|state|transition|recheck|schedul|blocker/iu.test(key))).toEqual([]);
    expect(Object.keys(outcome.kind === "HELD" ? outcome.policySequenceConversion : {})
      .filter((key) => /status|state|transition|recheck|schedul/iu.test(key))).toEqual([]);
  });

  it("reuses the landed structural counterfactual without redefining it", () => {
    const outcome = outcomeOf(evaluate("DAEMON_VERIFIED"));
    expect(outcome.structuralCounterfactual).toEqual(counterfactualFor(chain(), EDGE));
    expect(outcome.structuralCounterfactual.dependencyNecessity).toBe("UNKNOWN");
    expect(outcome.structuralCounterfactual.requiresSemanticProof).toBe(true);
  });
});

describe("admission counterexample evidence shape", () => {
  it("validates an optional counterexample without changing the outcome or its truth class", () => {
    const outcome = outcomeOf(evaluate("AGENT_REPORTED", { counterexample: COUNTEREXAMPLE }));
    expect(outcome.kind).toBe("REFUSED");
    expect(outcome.truthClass).toBe("AGENT_REPORTED");
    expect(outcome.counterexample).toEqual(COUNTEREXAMPLE);
  });

  it("never upgrades an admitted outcome because a counterexample was supplied", () => {
    const withBundle = outcomeOf(evaluate("AGENT_REPORTED", { counterexample: COUNTEREXAMPLE }));
    const withoutBundle = outcomeOf(evaluate("AGENT_REPORTED"));
    expect(withBundle.kind).toBe(withoutBundle.kind);
    expect(withoutBundle.counterexample).toBeNull();
  });

  it("refuses a counterexample whose fixture digest is not a digest", () => {
    const result = evaluate("DAEMON_VERIFIED", { counterexample: { ...COUNTEREXAMPLE, falseEdgeFixtureDigest: "nope" } });
    expect(result.ok).toBe(false);
    expect(issueCodes(result)).toEqual(["ADMISSION_NECESSITY_CLAIM_MALFORMED"]);
  });

  it("refuses a counterexample matched to a different edge", () => {
    expect(issueCodes(evaluate("DAEMON_VERIFIED", { counterexample: { ...COUNTEREXAMPLE, edgeKey: "dev-edge-bc" } })))
      .toEqual(["ADMISSION_NECESSITY_CLAIM_MALFORMED"]);
  });

  it("refuses a claim whose edge does not match the supplied structural counterfactual", () => {
    const result = evaluateNecessityClaim(
      { edgeKey: "dev-edge-bc", truthClass: "DAEMON_VERIFIED" },
      contractWith("DAEMON_VERIFIED"),
      counterfactualFor(chain(), EDGE),
    );
    expect(issueCodes(result)).toEqual(["ADMISSION_NECESSITY_CLAIM_MALFORMED"]);
  });
});

describe("admission positive-control matrix (design 409, test-time only)", () => {
  it("flips the structural counterfactual evidence for every known-required edge", () => {
    for (const edgeKey of ["dev-edge-ab", "dev-edge-bc"]) {
      const counterfactual = counterfactualFor(chain(), edgeKey);
      expect(counterfactual.structuralStageReduction > 0 || !counterfactual.completionClosureIntactWithoutEdge).toBe(true);
    }
  });

  it.each([...REJECTED_NECESSITY_WITNESS_KINDS])("matches a %s false-edge control against its typed-contract positive control", (kind) => {
    const snapshot = chain();
    expect(codesOf(admitGraph(inputFor(snapshot)))).toEqual([]);
    const falseEdges = entriesFor(snapshot).map((entry) => ({ ...entry, necessityWitness: { kind } }));
    expect(codesOf(admitGraph(inputFor(snapshot, { contracts: falseEdges }))))
      .toContain("ADMISSION_HARD_DEPENDENCY_UNPROVEN");
  });
});

function waitRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    waitRef: "wait:1", ownerNodeKey: "dev-node-b", reason: "awaiting the upstream evidence seal",
    predicate: predicate(HASH_B), affectedScope: ["dev-node-b", "dev-node-c"],
    recheckAtGate: "RESULT_SEAL", deadlineGate: "EVIDENCE_SEAL",
    escalation: { kind: "ESCALATE_TO_HUMAN", ref: "escalation:1" },
    binding: { graphIdentity: "dev-graph-1", sourceFactVersions: [{ sourceFactRef: "fact:dev-node-a", version: 1 }] },
    ...overrides,
  };
}

function challengeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    challengeRef: "challenge:1",
    subject: { kind: "EXISTING_EDGE_NECESSITY", edgeKey: "dev-edge-ab", contractHash: HASH_A, blockerKind: "SEMANTIC_PREREQUISITE" },
    binding: { graphEpoch: 1, sourceFactVersions: [{ sourceFactRef: "fact:dev-node-a", version: 1 }] },
    status: { kind: "OPEN" }, successorPlanningRunRef: "run:1", successorPlanningRunVersion: 1,
    ...overrides,
  };
}

const CHALLENGE_CONTEXT = {
  callerLease: { nodeKey: "dev-node-b", leaseRef: "lease:1", leaseVersion: 1 },
  currentHardContracts: [{ edgeKey: "dev-edge-ab", contractHash: HASH_A }],
  openChallenges: [],
};

describe("admission intentional waits", () => {
  it("validates an intentional wait and keeps every declared field", () => {
    const result = validateIntentionalWait(waitRecord());
    expect(result.ok).toBe(true);
    expect(result.ok ? result.wait.ownerNodeKey : null).toBe("dev-node-b");
    expect(result.ok ? result.wait.escalation.kind : null).toBe("ESCALATE_TO_HUMAN");
    expect(result.ok ? result.wait.affectedScope : null).toEqual(["dev-node-b", "dev-node-c"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("refuses a recheck gate beyond the wait deadline", () => {
    expect(issueCodes(validateIntentionalWait(waitRecord({ recheckAtGate: "GOAL_COMPLETION", deadlineGate: "RESULT_SEAL" }))))
      .toEqual(["ADMISSION_WAIT_HORIZON_INVALID"]);
  });

  it.each([
    ["an empty scope", { affectedScope: [] }],
    ["duplicate scope entries", { affectedScope: ["dev-node-b", "dev-node-b"] }],
    ["a blank reason", { reason: "" }],
    ["an unknown escalation kind", { escalation: { kind: "IGNORE_IT", ref: "escalation:1" } }],
    ["an unknown gate", { deadlineGate: "NOT_A_GATE" }],
  ])("refuses a wait with %s", (_label, overrides) => {
    expect(issueCodes(validateIntentionalWait(waitRecord(overrides)))).toEqual(["ADMISSION_WAIT_MALFORMED"]);
  });

  it("suppresses a time-only challenge inside the deadline but never against new evidence", () => {
    const validated = validateIntentionalWait(waitRecord());
    const wait = validated.ok ? validated.wait : null;
    expect(isTimeChallengeSuppressed(wait, "RESULT_SEAL", false)).toBe(true);
    expect(isTimeChallengeSuppressed(wait, "RESULT_SEAL", true)).toBe(false);
    expect(isTimeChallengeSuppressed(wait, "GOAL_COMPLETION", false)).toBe(false);
    expect(isTimeChallengeSuppressed(wait, "RESULT_SEAL", "maybe")).toBe(false);
    expect(isTimeChallengeSuppressed({ deadlineGate: "RESULT_SEAL" }, "RESULT_SEAL", false)).toBe(false);
  });
});

describe("admission bounded blocker challenges", () => {
  it("admits a semantic-prerequisite challenge against a current hard contract", () => {
    const result = admitDependencyChallenge(challengeRecord(), CHALLENGE_CONTEXT);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.record.reviewOnly : null).toBe(true);
    expect(result.ok ? result.record.challenge.dedupKey.length : 0).toBeGreaterThan(0);
  });

  it("passes the kernel challenge codes through instead of re-coding them", () => {
    expect(issueCodes(admitDependencyChallenge(challengeRecord(), { ...CHALLENGE_CONTEXT, currentHardContracts: [] })))
      .toEqual(["DEPENDENCY_CHALLENGE_CONTRACT_NOT_CURRENT"]);
    const foreign = challengeRecord({
      subject: {
        kind: "MISSING_EDGE_DISCOVERY", producerNodeKey: "dev-node-a", consumerNodeKey: "dev-node-c",
        holdNodeKey: "dev-node-c", edgeHash: HASH_A, truthClass: "AGENT_REPORTED",
        callerLeaseRef: "lease:1", callerLeaseVersion: 1,
      },
    });
    expect(issueCodes(admitDependencyChallenge(foreign, CHALLENGE_CONTEXT))).toEqual(["DEPENDENCY_CHALLENGE_FOREIGN_HOLD"]);
  });
});

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

const TRUTH_CLASSES = ["OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN"] as const;
const REMOVAL_KEY = /"(?:remove|removal|delete|drop|prune|rewrite|mutate|apply)[A-Za-z]*"\s*:/u;

describe("seeded admission invariants", () => {
  it("never exposes a field that could be read as edge-removal authority", () => {
    const next = xorshift32(0x5eed0001);
    for (let index = 0; index < 64; index += 1) {
      const snapshot = next() % 2 === 0 ? chain() : diamond();
      expect(REMOVAL_KEY.test(JSON.stringify(admitGraph(inputFor(snapshot))))).toBe(false);
    }
  });

  it("never admits a hard edge from an AGENT_REPORTED necessity across truth-class permutations", () => {
    const next = xorshift32(0x5eed0002);
    let agentCases = 0;
    for (let index = 0; index < 96; index += 1) {
      const claimed = TRUTH_CLASSES[next() % TRUTH_CLASSES.length]!;
      const contracted = TRUTH_CLASSES[next() % TRUTH_CLASSES.length]!;
      const held = next() % 2 === 0 ? { humanDecisionRef: "decision:1" } : {};
      const result = evaluateNecessityClaim(
        { edgeKey: EDGE, truthClass: claimed, ...held },
        contractWith(contracted),
        counterfactualFor(chain(), EDGE),
      );
      expect(result.ok).toBe(true);
      const outcome = result.ok ? result.outcome : null;
      if (claimed === "AGENT_REPORTED" || contracted === "AGENT_REPORTED") {
        agentCases += 1;
        expect(outcome?.kind).not.toBe("ADMISSIBLE");
      }
      if (outcome?.kind === "ADMISSIBLE") expect(outcome.truthClass).toBe("DAEMON_VERIFIED");
    }
    expect(agentCases).toBeGreaterThan(0);
  });

  it("never refuses on partial contract equivalence and never fabricates a zero estimate", () => {
    const facets = [
      { satisfactionPredicate: predicate(HASH_A) },
      { producer: { kind: "ARTIFACT_CONSUMPTION", artifactOrInterfaceRef: "artifact:other", digest: HASH_B } },
      { consumptionHorizon: "EVIDENCE_SEAL" },
    ] as const;
    const next = xorshift32(0x5eed0003);
    for (let index = 0; index < 48; index += 1) {
      const snapshot = diamond();
      const facet = facets[next() % facets.length]!;
      const contracts = snapshot.edges.map((edge) => edge.edgeKey === "dev-edge-bc" ? entryFor(edge, facet) : entryFor(edge));
      const records = recordsOf(admitGraph(inputFor(snapshot, { contracts, estimates: UNKNOWN_ESTIMATES })));
      expect(records.reduction.find((entry) => entry.edgeKey === "dev-edge-ac")?.outcome).toBe("PARTIAL_EQUIVALENCE");
      expect(records.baseline.estimates.proposedDuration.value).toBeNull();
      expect(records.baseline.estimates.proposedCost.value).toBeNull();
    }
  });

  it("returns deterministic frozen results and refuses hostile inputs", () => {
    const hostile: unknown[] = [null, 42, "graph", [], Object.create(null) as unknown, { nodes: [] }];
    const next = xorshift32(0x5eed0004);
    for (let index = 0; index < 48; index += 1) {
      const snapshot = next() % 2 === 0 ? chain() : diamond();
      const first = admitGraph(inputFor(snapshot));
      expect(JSON.stringify(first)).toBe(JSON.stringify(admitGraph(inputFor(snapshot))));
      expect(Object.isFrozen(first)).toBe(true);
      const junk = hostile[next() % hostile.length];
      const refused = admitGraph(next() % 2 === 0
        ? inputFor(snapshot, { proposedSnapshot: junk })
        : inputFor(snapshot, { contracts: junk }));
      expect(refused.ok).toBe(false);
    }
  });

  it("keeps every refusal code inside the admission or landed vocabularies", () => {
    const next = xorshift32(0x5eed0005);
    for (let index = 0; index < 32; index += 1) {
      const snapshot = next() % 2 === 0 ? chain() : diamond();
      const contracts = entriesFor(snapshot).slice(0, next() % 3);
      for (const code of codesOf(admitGraph(inputFor(snapshot, { contracts })))) {
        expect(/^(?:ADMISSION_|GRAPH_|COMPLETION_|DEPENDENCY_)/u.test(code)).toBe(true);
      }
    }
  });
});
