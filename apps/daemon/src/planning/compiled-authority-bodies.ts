/**
 * The N-NODE planning-authority producer for compiled (PRD-derived) plans.
 *
 * A NEW producer beside `journey-authority-bodies.ts`, never an edit to it: the
 * journey producer is the parity anchor for the demo seed and the control room's
 * dev payload and hard-fails on more than one node BY DESIGN. This one compiles
 * an agent-submitted structure into sealed bodies through the same production
 * codecs (`createNodeDefinition`, `deriveNodeAuthoritySet`, `encodeGraphContent`,
 * `createPlanRevision`, `createAcceptanceContract`), so every derived member is
 * re-derived and re-refused by the seam that later consumes it. Refusals are
 * RESULTS with codes, not throws — a compile dispatcher parks on them.
 *
 * Same no-clock/no-random discipline as the journey producer: two compiles over
 * one input are byte-identical, which is what makes the dispatcher's derived
 * commandIds crash-restart idempotent.
 */
import { createAcceptanceContract, createPlanRevision } from "@moe/core";
import {
  ADMISSION_PURPOSES,
  createNodeDefinition,
  deriveNodeAuthoritySet,
  encodeGraphContent,
  snapshotIdentityHash,
  validateGraphSnapshot,
} from "@moe/scheduler";
import type {
  GraphContent, GraphRevisionContent, GraphSnapshot, NodeDefinition,
} from "@moe/scheduler";

import { COMPILED_PLAN_NODE_BUDGET } from "./compiled-authority-contracts.js";
import type {
  CompiledNodeInput, CompiledPlanCode, CompiledPlanInput, CompiledPlanResult,
} from "./compiled-authority-contracts.js";

const LAYER = "COMPILED_PLAN_PRODUCER";
const hex = (digit: string, width = 64): string => digit.repeat(width);
const NODE_GRAPH_HASH = hex("a");
const NODE_GRAPH_REF = "graph-revision-a";
const NODE_METER = "runner.authorized_ms";

/** A MONOTONIC contract owes a matching registry proof (same entry the journey
 *  producer carries), else composeEdges refuses the silent REVOCABLE demotion. */
const NODE_PREDICATE_ENTRY: Record<string, unknown> = {
  parameterSchema: { digest: hex("b"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-a",
  proofRationale: "An artifact seal cannot become unsealed.",
  schemaId: "schema-a",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
};

function refused(code: CompiledPlanCode, detail: string): CompiledPlanResult {
  return Object.freeze({ code, detail, layer: LAYER, ok: false });
}

function issuesOf(issues: readonly { code: string; layer: string }[]): string {
  return issues.map((issue) => `${issue.code}@${issue.layer}`).join(",");
}

const KEY = /^[a-z0-9][a-z0-9-]{0,120}$/u;
function nonEmptyStrings(value: readonly string[]): boolean {
  return value.every((entry) => typeof entry === "string" && entry.length > 0);
}

/** Structure admission: everything the codecs below do NOT already own. */
function shapeRefusal(input: CompiledPlanInput): CompiledPlanResult | null {
  if (input.nodes.length === 0) return refused("COMPILED_PLAN_MALFORMED", "no nodes");
  if (input.nodes.length > COMPILED_PLAN_NODE_BUDGET) {
    return refused(
      "COMPILED_PLAN_BUDGET_EXCEEDED",
      `${input.nodes.length} nodes exceed the compile budget of ${COMPILED_PLAN_NODE_BUDGET}`,
    );
  }
  if (input.criteria.length === 0) return refused("COMPILED_PLAN_MALFORMED", "no criteria");
  const nodeKeys = new Set<string>();
  for (const node of input.nodes) {
    if (!KEY.test(node.nodeKey) || nodeKeys.has(node.nodeKey)) {
      return refused("COMPILED_PLAN_MALFORMED", `node key ${node.nodeKey}`);
    }
    nodeKeys.add(node.nodeKey);
    if (node.objective.length === 0 || node.capability.length === 0
      || !nonEmptyStrings(node.readScopes) || !nonEmptyStrings(node.writeScopes)
      || !nonEmptyStrings(node.resources) || !nonEmptyStrings(node.verificationRecipeRefs)
      || node.verificationRecipeRefs.length === 0) {
      return refused("COMPILED_PLAN_MALFORMED", `node ${node.nodeKey}`);
    }
  }
  if (!nodeKeys.has(input.completionNodeKey)) {
    return refused("COMPILED_PLAN_MALFORMED", "completion node is not a listed node");
  }
  const criterionIds = new Set(input.criteria.map((criterion) => criterion.criterionId));
  if (criterionIds.size !== input.criteria.length) {
    return refused("COMPILED_PLAN_MALFORMED", "duplicate criterion id");
  }
  const covered = new Set<string>();
  for (const node of input.nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodeKeys.has(dependency) || dependency === node.nodeKey) {
        return refused("COMPILED_PLAN_MALFORMED", `dependsOn ${dependency} of ${node.nodeKey}`);
      }
      // The completion node must stay TERMINAL (GRAPH_COMPLETION_NOT_TERMINAL):
      // nothing may build on top of the delivery that completes the goal.
      if (dependency === input.completionNodeKey) {
        return refused(
          "COMPILED_PLAN_MALFORMED",
          `node ${node.nodeKey} depends on the completion node`,
        );
      }
    }
    for (const criterionId of node.criterionIds) {
      if (!criterionIds.has(criterionId)) {
        return refused(
          "COMPILED_PLAN_CRITERION_UNBOUND",
          `node ${node.nodeKey} cites unknown criterion ${criterionId}`,
        );
      }
      covered.add(criterionId);
    }
  }
  for (const criterion of input.criteria) {
    if (!covered.has(criterion.criterionId)) {
      return refused(
        "COMPILED_PLAN_CRITERION_UNBOUND",
        `criterion ${criterion.criterionId} is satisfied by no node`,
      );
    }
  }
  if (input.knownCapabilities !== null) {
    const known = new Set(input.knownCapabilities);
    for (const node of input.nodes) {
      if (!known.has(node.capability)) {
        return refused(
          "COMPILED_PLAN_CAPABILITY_UNCATALOGED",
          `no verification command for capability ${node.capability} (node ${node.nodeKey})`,
        );
      }
    }
  }
  return null;
}

/** The definition's own planning pair — same fixed-point separation the journey
 *  producer documents: these bind a DIFFERENT graph than the compiled one. */
function nodePlanning(input: CompiledPlanInput, node: CompiledNodeInput): Record<string, unknown> {
  const plan = createPlanRevision({
    affectedCriterionIds: [...node.criterionIds],
    affectedNodeIds: [node.nodeKey],
    approvalState: "APPROVED",
    authorRef: input.authorRef,
    graphBinding: { graphContentHash: NODE_GRAPH_HASH, graphRevisionRef: NODE_GRAPH_REF },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: `${input.idPrefix}-${node.nodeKey}-plan`,
    steps: [{ description: node.objective, kind: "IMPLEMENTATION", stepId: "step-a" }],
    verificationRecipeRefs: [...node.verificationRecipeRefs],
  });
  if (!plan.ok) throw new Error(`compiled node plan refused: ${plan.code}@${plan.layer}`);
  const accepted = createAcceptanceContract({
    applicability: {
      graphContentHash: NODE_GRAPH_HASH, graphRevisionRef: NODE_GRAPH_REF,
      nodeIds: [node.nodeKey], nodeKind: "LEAF",
    },
    authorRef: input.authorRef,
    contractId: `${input.idPrefix}-${node.nodeKey}-contract`,
    obligations: node.criterionIds.map((criterionId) => ({
      criterionId,
      evidenceRequirements: [{
        evidenceRef: `${criterionId}-evidence`, kind: "VERIFICATION_RECEIPT",
        requirementId: `${criterionId}-requirement`,
      }],
      statement: statementOf(input, criterionId),
      verificationRecipeRefs: [...node.verificationRecipeRefs],
    })),
  });
  if (!accepted.ok) {
    throw new Error(`compiled node acceptance refused: ${accepted.code}@${accepted.layer}`);
  }
  return { acceptanceContract: accepted.contract, planRevision: plan.revision };
}

/** BYTE-EQUAL from the approved revision — the acceptance-binding fence compares
 *  statements byte-for-byte at finalize, so no prettifying, ever. */
function statementOf(input: CompiledPlanInput, criterionId: string): string {
  const criterion = input.criteria.find((entry) => entry.criterionId === criterionId);
  if (criterion === undefined) throw new Error(`unknown criterion ${criterionId}`);
  return criterion.statement;
}

function nodeDefinitionOf(
  input: CompiledPlanInput,
  node: CompiledNodeInput,
  incoming: readonly CompiledEdge[],
  bindingDigest: string,
): NodeDefinition {
  const criterionRef = node.criterionIds[0] ?? "criterion-unbound";
  const built = createNodeDefinition({
    ...nodePlanning(input, node),
    draft: {
      admissionAmounts: [...ADMISSION_PURPOSES].sort().map((purpose, index) => ({
        meter: NODE_METER, purpose, quantity: index + 1,
      })),
      admissionGatePolicy: "HUMAN_APPROVAL",
      capability: node.capability,
      completionLinkage: node.nodeKey === input.completionNodeKey ? node.nodeKey : null,
      constraints: [],
      // The consumer files each of its incoming HARD edges' contracts — the
      // shape closeContracts demands (one contract per hard edge, on the
      // consumer's body, binding digest matching the snapshot identity).
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
    throw new AdmissionError(`node ${node.nodeKey}: ${issuesOf(built.issues)}`);
  }
  return built.value.definition;
}

class AdmissionError extends Error {}

interface CompiledEdge {
  readonly consumerNodeKey: string;
  readonly edgeKey: string;
  readonly kind: "HARD";
  readonly producerNodeKey: string;
}

/**
 * HARD edges, because completion closure demands them: every execution-bearing
 * node must be a HARD ancestor of the completion node (reverse BFS —
 * COMPLETION_CLOSURE_INCOMPLETE otherwise), so `dependsOn` compiles to hard
 * producer→consumer edges and every node left without an outgoing hard edge
 * gains a synthetic edge into the completion node. Deterministic keys.
 */
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

/**
 * The 17-key hard contract for one edge, filed on the CONSUMER's body. Every
 * digest-shaped field the runtime does not yet produce carries the same fixed
 * placeholders the journey producer documents (policySliceHash precedent); the
 * LOAD-BEARING fields — endpoints, binding digest, the consumer's criterion —
 * are derived from the compiled structure.
 */
function contractOf(
  edge: CompiledEdge, bindingDigest: string, criterionRef: string,
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
      sourceFactDigest: hex("e"), sourceFactRef: `fact-${edge.edgeKey}`, sourceFactVersion: 1,
    }],
    minimumQualifyingMilestone: "RESULT_SEALED",
    necessity: {
      failedConsumerCriterionRef: criterionRef, failureKind: "MISSING_ARTIFACT",
      truthClass: "OBSERVED",
    },
    producer: {
      artifactOrInterfaceRef: `artifact-${edge.producerNodeKey}`, digest: hex("f"),
      kind: "ARTIFACT_CONSUMPTION",
    },
    producerNodeKey: edge.producerNodeKey,
    recheckPredicateRef: "predicate-a",
    satisfactionPredicate: {
      parametersDigest: hex("1"), predicateRef: "predicate-a", schemaId: "schema-a",
      schemaVersion: 1,
    },
    satisfactionWitnesses: [{
      sourceOperationClass: "ARTIFACT_SEAL", witnessDigest: hex("2"),
      witnessRef: `witness-${edge.edgeKey}`, witnessVersion: 1,
    }],
    stability: "MONOTONIC",
    truthClass: "OBSERVED",
  };
}

function graphContentOf(input: CompiledPlanInput): GraphContent {
  const edges = edgesOf(input);
  const snapshot: GraphSnapshot = {
    completionNodeKey: input.completionNodeKey,
    edges,
    nodes: input.nodes.map((node) => ({ executionBearing: true, nodeKey: node.nodeKey })),
  };
  // The STRUCTURE-ONLY identity every hard contract must bind — derived from the
  // validated snapshot itself, never spelled.
  const validated = validateGraphSnapshot(snapshot);
  if (!validated.ok) {
    throw new AdmissionError(validated.issues.map((issue) => issue.code).join(","));
  }
  const bindingDigest = snapshotIdentityHash(validated.graph);
  const definitions = input.nodes.map((node) => nodeDefinitionOf(
    input, node,
    edges.filter((edge) => edge.consumerNodeKey === node.nodeKey),
    bindingDigest,
  ));
  const derived = deriveNodeAuthoritySet(snapshot, definitions);
  if (!derived.ok) throw new AdmissionError(issuesOf(derived.issues));
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
  if (!encoded.ok) throw new AdmissionError(issuesOf(encoded.issues));
  return encoded.value;
}

export function compiledPlanAuthority(input: CompiledPlanInput): CompiledPlanResult {
  const shape = shapeRefusal(input);
  if (shape !== null) return shape;
  try {
    const graph = graphContentOf(input);
    const hash = graph.graphContentHash;
    const planRevision = createPlanRevision({
      affectedCriterionIds: input.criteria.map((criterion) => criterion.criterionId),
      affectedNodeIds: input.nodes.map((node) => node.nodeKey),
      approvalState: "PENDING_APPROVAL",
      authorRef: input.authorRef,
      graphBinding: { graphContentHash: hash, graphRevisionRef: input.graphRevisionRef },
      parentRevisionId: null,
      rejectionRef: null,
      revisionId: `${input.idPrefix}-revision`,
      steps: input.nodes.map((node, index) => ({
        description: node.objective, kind: "IMPLEMENTATION",
        stepId: `step-${String(index + 1).padStart(5, "0")}`,
      })),
      verificationRecipeRefs: [`${input.idPrefix}-recipe`],
    });
    if (!planRevision.ok) {
      return refused(
        "COMPILED_PLAN_ADMISSION_REFUSED", `${planRevision.code}@${planRevision.layer}`,
      );
    }
    const acceptance = createAcceptanceContract({
      applicability: {
        graphContentHash: hash, graphRevisionRef: input.graphRevisionRef,
        nodeIds: input.nodes.map((node) => node.nodeKey), nodeKind: "LEAF",
      },
      authorRef: input.authorRef,
      contractId: `${input.idPrefix}-contract`,
      obligations: input.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        evidenceRequirements: [{
          evidenceRef: `${criterion.criterionId}-evidence`, kind: "VERIFICATION_RECEIPT",
          requirementId: `${criterion.criterionId}-requirement`,
        }],
        statement: criterion.statement,
        verificationRecipeRefs: [`${input.idPrefix}-recipe`],
      })),
    });
    if (!acceptance.ok) {
      return refused(
        "COMPILED_PLAN_ADMISSION_REFUSED", `${acceptance.code}@${acceptance.layer}`,
      );
    }
    const revision = planRevision.revision as unknown as Record<string, unknown>;
    return Object.freeze({
      authority: {
        acceptanceContract: acceptance.contract as unknown as Record<string, unknown>,
        planRevision: revision,
      },
      graphContentBytesBase64: Buffer.from(graph.bytes).toString("base64"),
      graphContentHash: hash,
      ok: true as const,
      submissionHash: revision["planHash"] as string,
    });
  } catch (error) {
    if (error instanceof AdmissionError) {
      return refused("COMPILED_PLAN_ADMISSION_REFUSED", error.message);
    }
    throw error;
  }
}
