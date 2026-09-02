import {
  ADMISSION_PURPOSES,
  createNodeDefinition,
  deriveNodeAuthoritySet,
  encodeGraphContent,
  snapshotIdentityHash,
  validateGraphSnapshot,
} from "@moe/scheduler";
import type {
  GraphContent,
  GraphRevisionContent,
  GraphSnapshot,
  NodeDefinition,
} from "@moe/scheduler";

import { createCompiledNodePlanning } from "./compiled-approval-authority-body.js";
import { COMPILED_PLAN_NODE_BUDGET } from "./compiled-authority-contracts.js";
import type {
  CompiledNodeInput,
  CompiledPlanInput,
} from "./compiled-authority-contracts.js";

const hex = (digit: string, width = 64): string => digit.repeat(width);
const NODE_METER = "runner.authorized_ms";
const NODE_PREDICATE_ENTRY: Record<string, unknown> = {
  parameterSchema: { digest: hex("b"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-a",
  proofRationale: "An artifact seal cannot become unsealed.",
  schemaId: "schema-a",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
};

function issuesOf(issues: readonly { code: string; layer: string }[]): string {
  return issues.map((issue) => `${issue.code}@${issue.layer}`).join(",");
}

export class CompiledPolicyAdmissionError extends Error {}

interface CompiledEdge {
  readonly consumerNodeKey: string;
  readonly edgeKey: string;
  readonly kind: "HARD";
  readonly producerNodeKey: string;
}

function contractOf(
  edge: CompiledEdge,
  bindingDigest: string,
  criterionRef: string,
): Record<string, unknown> {
  return {
    alternateProducers: [],
    alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
    consumer: { contractHash: hex("c"), criterionRef, kind: "PRECONDITION" },
    consumerNodeKey: edge.consumerNodeKey,
    consumptionHorizon: "RESULT_SEAL",
    edgeKind: "ARTIFACT_CONSUMPTION",
    graphBindingDigest: bindingDigest,
    invalidationFacts: [{
      sourceFactDigest: hex("e"),
      sourceFactRef: `fact-${edge.edgeKey}`,
      sourceFactVersion: 1,
    }],
    minimumQualifyingMilestone: "RESULT_SEALED",
    necessity: {
      failedConsumerCriterionRef: criterionRef,
      failureKind: "MISSING_ARTIFACT",
      truthClass: "OBSERVED",
    },
    producer: {
      artifactOrInterfaceRef: `artifact-${edge.producerNodeKey}`,
      digest: hex("f"),
      kind: "ARTIFACT_CONSUMPTION",
    },
    producerNodeKey: edge.producerNodeKey,
    recheckPredicateRef: "predicate-a",
    satisfactionPredicate: {
      parametersDigest: hex("1"),
      predicateRef: "predicate-a",
      schemaId: "schema-a",
      schemaVersion: 1,
    },
    satisfactionWitnesses: [{
      sourceOperationClass: "ARTIFACT_SEAL",
      witnessDigest: hex("2"),
      witnessRef: `witness-${edge.edgeKey}`,
      witnessVersion: 1,
    }],
    stability: "MONOTONIC",
    truthClass: "OBSERVED",
  };
}

function nodeDefinitionOf(
  input: CompiledPlanInput,
  node: CompiledNodeInput,
  incoming: readonly CompiledEdge[],
  bindingDigest: string,
): NodeDefinition {
  const criterionRef = node.criterionIds[0] ?? "criterion-unbound";
  const built = createNodeDefinition({
    ...createCompiledNodePlanning(input, node),
    draft: {
      admissionAmounts: [...ADMISSION_PURPOSES].sort().map((purpose, index) => ({
        meter: NODE_METER, purpose, quantity: index + 1,
      })),
      admissionGatePolicy: "HUMAN_APPROVAL",
      capability: node.capability,
      completionLinkage: node.nodeKey === input.completionNodeKey ? node.nodeKey : null,
      constraints: [],
      directHardDependencies: incoming.map((edge) => ({
        edgeKey: edge.edgeKey,
        requirement: {
          contract: contractOf(edge, bindingDigest, criterionRef),
          edgeKind: "ARTIFACT_CONSUMPTION",
        },
      })),
      joinRole: node.nodeKey === input.completionNodeKey ? "COMPLETION" : "NONE",
      nodeKey: node.nodeKey,
      objective: node.objective,
      policySliceHash: hex("3"),
      readScopes: [...node.readScopes],
      repositoryBaseTree: hex("4"),
      resources: [...node.resources],
      verificationRecipeRevisions: [...node.verificationRecipeRefs],
      writeScopes: [...node.writeScopes],
    },
    predicateRegistry: [NODE_PREDICATE_ENTRY],
  });
  if (!built.ok) {
    throw new CompiledPolicyAdmissionError(`node ${node.nodeKey}: ${issuesOf(built.issues)}`);
  }
  return built.value.definition;
}

function edgesOf(input: CompiledPlanInput): readonly CompiledEdge[] {
  const edges: CompiledEdge[] = [];
  const hasOutgoing = new Set<string>();
  for (const node of input.nodes) {
    for (const producer of [...node.dependsOn].sort()) {
      edges.push({
        consumerNodeKey: node.nodeKey,
        edgeKey: `dep-${producer}--${node.nodeKey}`,
        kind: "HARD",
        producerNodeKey: producer,
      });
      hasOutgoing.add(producer);
    }
  }
  for (const node of input.nodes) {
    if (node.nodeKey === input.completionNodeKey || hasOutgoing.has(node.nodeKey)) continue;
    edges.push({
      consumerNodeKey: input.completionNodeKey,
      edgeKey: `dep-${node.nodeKey}--${input.completionNodeKey}`,
      kind: "HARD",
      producerNodeKey: node.nodeKey,
    });
  }
  return edges.sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
}

export function createCompiledPolicyAuthorityBody(input: CompiledPlanInput): GraphContent {
  const edges = edgesOf(input);
  const snapshot: GraphSnapshot = {
    completionNodeKey: input.completionNodeKey,
    edges,
    nodes: input.nodes.map((node) => ({ executionBearing: true, nodeKey: node.nodeKey })),
  };
  const validated = validateGraphSnapshot(snapshot);
  if (!validated.ok) {
    throw new CompiledPolicyAdmissionError(
      validated.issues.map((issue) => issue.code).join(","),
    );
  }
  const bindingDigest = snapshotIdentityHash(validated.graph);
  const definitions = input.nodes.map((node) => nodeDefinitionOf(
    input,
    node,
    edges.filter((edge) => edge.consumerNodeKey === node.nodeKey),
    bindingDigest,
  ));
  const derived = deriveNodeAuthoritySet(snapshot, definitions);
  if (!derived.ok) throw new CompiledPolicyAdmissionError(issuesOf(derived.issues));
  const content: GraphRevisionContent = {
    author: input.authorRef,
    completionNode: input.completionNodeKey,
    decompositionBudget: COMPILED_PLAN_NODE_BUDGET,
    nodeAuthority: { authorities: derived.value, definitions },
    parentRevision: null,
    policyRevision: "pol-000000000001",
    repositoryBaseTree: hex("4", 40),
    snapshot,
  };
  const encoded = encodeGraphContent(content);
  if (!encoded.ok) throw new CompiledPolicyAdmissionError(issuesOf(encoded.issues));
  return encoded.value;
}
