/**
 * DEVELOPMENT_ONLY fixtures for the admission tests, mirroring the existing
 * `../test-fixtures.ts` precedent. Synthetic `dev-` shapes only; these are not a
 * BENCH-S* corpus and carry no authority.
 */
import { analyzeHardEdgeCounterfactuals } from "../hard-edge-counterfactual.js";
import { validateGraphSnapshot } from "../validate-graph.js";
import type { DependencyContract } from "../dependencies/dependency-contract.js";
import type { GraphEdge, GraphSnapshot, ValidatedGraph } from "../graph-model.js";
import type { HardEdgeCounterfactual } from "../hard-edge-counterfactual-model.js";
import { devHardEdge, devNode, devSnapshot } from "../test-fixtures.js";
import type { AdmissionRecords, AdmissionResult } from "./admission-model.js";

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const BINDING = "c".repeat(64);
export const OTHER_BINDING = "d".repeat(64);
export const INTERFACE_RULING = { kind: "INTERFACE_AVAILABLE", ref: "interface:x", digest: HASH_A } as const;
export const UNKNOWN_ESTIMATES = {
  proposedDuration: { value: null, truthClass: "UNKNOWN" }, sequentialBaselineDuration: { value: null, truthClass: "UNKNOWN" },
  proposedCost: { value: null, truthClass: "UNKNOWN" }, sequentialBaselineCost: { value: null, truthClass: "UNKNOWN" },
} as const;

export function predicate(parametersDigest: string) {
  return { predicateRef: "predicate:sealed", schemaId: "moe.predicate.sealed", schemaVersion: 1, parametersDigest };
}

export function contractFor(
  producerNodeKey: string,
  consumerNodeKey: string,
  overrides: Partial<DependencyContract> = {},
): DependencyContract {
  return {
    producerNodeKey,
    consumerNodeKey,
    edgeKind: "ARTIFACT_CONSUMPTION",
    graphBindingDigest: BINDING,
    producer: { kind: "ARTIFACT_CONSUMPTION", artifactOrInterfaceRef: "artifact:shared", digest: HASH_B },
    consumer: { kind: "PRECONDITION", criterionRef: `criterion:${consumerNodeKey}`, contractHash: HASH_A },
    minimumQualifyingMilestone: "RESULT_SEALED",
    satisfactionPredicate: predicate(HASH_B),
    stability: "REVOCABLE",
    satisfactionWitnesses: [{ witnessRef: `witness:${producerNodeKey}`, witnessVersion: 1, witnessDigest: HASH_A, sourceOperationClass: "ARTIFACT_SEAL" }],
    consumptionHorizon: "RESULT_SEAL",
    necessity: { failedConsumerCriterionRef: `criterion:${consumerNodeKey}`, failureKind: "MISSING_ARTIFACT", truthClass: "DAEMON_VERIFIED" },
    alternativeRuling: { kind: "NOT_APPLICABLE", reason: "no compatible substitute" },
    alternateProducers: [],
    truthClass: "DAEMON_VERIFIED",
    invalidationFacts: [{ sourceFactRef: `fact:${producerNodeKey}`, sourceFactVersion: 1, sourceFactDigest: HASH_A }],
    recheckPredicateRef: "predicate:sealed",
    ...overrides,
  } as DependencyContract;
}

export function entryFor(edge: GraphEdge, overrides: Partial<DependencyContract> = {}): Record<string, unknown> {
  const contract = contractFor(edge.producerNodeKey, edge.consumerNodeKey, overrides);
  return {
    edgeKey: edge.edgeKey,
    edgeKind: contract.edgeKind,
    contract,
    necessityWitness: { edgeKey: edge.edgeKey, truthClass: contract.necessity.truthClass },
  };
}

export function entriesFor(snapshot: GraphSnapshot, overrides: Partial<DependencyContract> = {}): Record<string, unknown>[] {
  return snapshot.edges.filter((edge) => edge.kind === "HARD").map((edge) => entryFor(edge, overrides));
}

/** dev-node-a -> dev-node-b -> dev-node-c, completion dev-node-c. */
export function chain(): GraphSnapshot {
  return devSnapshot(
    [devNode("dev-node-a"), devNode("dev-node-b"), devNode("dev-node-c")],
    [devHardEdge("dev-edge-ab", "dev-node-a", "dev-node-b"), devHardEdge("dev-edge-bc", "dev-node-b", "dev-node-c")],
    "dev-node-c",
  );
}

/** dev-node-a -> b -> c plus the direct dev-edge-ac shortcut. */
export function diamond(): GraphSnapshot {
  const base = chain();
  return devSnapshot(base.nodes, [...base.edges, devHardEdge("dev-edge-ac", "dev-node-a", "dev-node-c")], "dev-node-c");
}

export function inputFor(snapshot: GraphSnapshot, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposedSnapshot: snapshot,
    sequentialBaselineSnapshot: snapshot,
    contracts: entriesFor(snapshot),
    ...overrides,
  };
}

export function codesOf(result: AdmissionResult): readonly string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

export function recordsOf(result: AdmissionResult): AdmissionRecords {
  if (!result.ok) throw new Error(`unexpected admission refusal: ${codesOf(result).join(",")}`);
  return result.records;
}

export function validatedGraph(snapshot: GraphSnapshot): ValidatedGraph {
  const result = validateGraphSnapshot(snapshot);
  if (!result.ok) throw new Error(`fixture is not a valid graph: ${codesOf(result).join(",")}`);
  return result.graph;
}

export function counterfactualFor(snapshot: GraphSnapshot, edgeKey: string): HardEdgeCounterfactual {
  const found = analyzeHardEdgeCounterfactuals(validatedGraph(snapshot)).edges.find((edge) => edge.edgeKey === edgeKey);
  if (found === undefined) throw new Error(`fixture has no HARD edge ${edgeKey}`);
  return found;
}
