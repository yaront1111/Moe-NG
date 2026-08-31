import {
  ABSOLUTE_MAX_GRAPH_HARD_EDGES, ABSOLUTE_MAX_GRAPH_NODES,
  ABSOLUTE_MAX_GRAPH_TOTAL_EDGES, admitNodeDefinition, deriveNodeAuthoritySet,
  encodeGraphContent, snapshotIdentityHash, validateGraphSnapshot,
  type GraphContent, type GraphRevisionContent, type NodeDefinition,
} from "@moe/scheduler";

import type {
  V2CompilerGraphAuthority, V2CompilerGraphAuthorityReader,
  V2CompilerGraphAuthorityRequest, V2CompilerNodeAdmissionAuthority,
  V2CompilerNodeAdmissionAuthorityReader, V2CompilerNodeAuthorityRequest,
  V2CompilerNodeDefinitionReader, V2SchedulerDependency,
} from "./authority-contracts.js";
import {
  v2CompilerRefusal, type V2CompiledCriterionBinding, type V2CompiledNode,
  type V2CompilerRefusal,
} from "./contracts.js";
import { qualifiedIdentity, schedulerRecipeIdentities,
  schedulerResourceIdentities } from "./material-identity.js";
import type { NodeFact } from "./topology.js";
import { budgetBindingDigest, nodeAdmissionRequest,
  nodeIntentAuthority } from "./scheduler-node-intent.js";
import { exact, materialDigest, snapshotCompilerInput } from "./snapshot.js";

const POLICY = Object.freeze({ maxHardEdges: ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  maxNodes: ABSOLUTE_MAX_GRAPH_NODES, maxTotalEdges: ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  minGatedDescendantsForReview: 1 });
const GRAPH_AUTHORITY_KEYS = Object.freeze([
  "author", "decompositionBudget", "parentRevision", "policyRevision", "repositoryBaseTree",
]);
const ADMISSION_KEYS = Object.freeze([
  "admissionAmounts", "admissionGatePolicy", "budgetBindingDigest",
]);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const refuse = (code: Parameters<typeof v2CompilerRefusal>[0]): V2CompilerRefusal =>
  v2CompilerRefusal(code, "V2_COMPILER_SCHEDULER_AUTHORITY");

export interface SchedulerAuthorityDependencies {
  readonly readGraphAuthority: V2CompilerGraphAuthorityReader;
  readonly readNodeAdmissionAuthority: V2CompilerNodeAdmissionAuthorityReader;
  readonly readNodeDefinition: V2CompilerNodeDefinitionReader;
}
export interface SchedulerAuthorityBinding {
  readonly canonicalBytesBase64: string;
  readonly content: GraphRevisionContent;
  readonly graphContentHash: string;
  readonly schemaVersion: GraphContent["schemaVersion"];
  readonly snapshotIdentity: string;
}
type Result = Readonly<{ binding: SchedulerAuthorityBinding; ok: true }> | V2CompilerRefusal;

function graphStructure(nodes: readonly NodeFact[]) {
  const consumers = new Set(nodes.flatMap((node) => node.dependencyIds));
  const sinks = nodes.filter((node) => !consumers.has(node.nodeId)
    && node.authorityKind === "VERIFIER").map((node) => node.nodeId).sort(compare);
  if (sinks.length === 0) return undefined;
  const completionNodeKey = sinks[0]!;
  const edges = nodes.flatMap((node) => node.dependencyIds.map((producerNodeKey) => ({
    consumerNodeKey: node.nodeId,
    edgeKey: qualifiedIdentity("hard-edge", [producerNodeKey, node.nodeId]),
    kind: "HARD" as const, producerNodeKey,
  })));
  for (const sink of sinks.slice(1)) edges.push({
    consumerNodeKey: completionNodeKey,
    edgeKey: qualifiedIdentity("completion-edge", [sink, completionNodeKey]),
    kind: "HARD", producerNodeKey: sink,
  });
  if (edges.length > ABSOLUTE_MAX_GRAPH_HARD_EDGES) return undefined;
  edges.sort((left, right) => compare(left.edgeKey, right.edgeKey));
  return Object.freeze({ completionNodeKey, edges: Object.freeze(edges),
    nodes: Object.freeze(nodes.map((node) => Object.freeze({
      executionBearing: true as const, nodeKey: node.nodeId,
    })).sort((left, right) => compare(left.nodeKey, right.nodeKey))) });
}

function readGraphAuthority(reader: V2CompilerGraphAuthorityReader,
  request: V2CompilerGraphAuthorityRequest): V2CompilerGraphAuthority | undefined {
  let value: unknown;
  try { value = reader(request); } catch { return undefined; }
  const snapshot = snapshotCompilerInput(value);
  return snapshot.ok && exact(snapshot.value, GRAPH_AUTHORITY_KEYS)
    && materialDigest(snapshot.value["policyRevision"])
    ? snapshot.value as unknown as V2CompilerGraphAuthority : undefined;
}

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const sameAmounts = (left: NodeDefinition["admissionAmounts"],
  right: NodeDefinition["admissionAmounts"]): boolean => left.length === right.length
  && left.every((value, index) => value.meter === right[index]?.meter
    && value.purpose === right[index]?.purpose && value.quantity === right[index]?.quantity);

function definitionMatches(definition: NodeDefinition, request: V2CompilerNodeAuthorityRequest): boolean {
  const expectedCriteria = request.criterionBindings.map((item) => item.criterionId).sort(compare);
  const expectedEdges = request.directHardDependencies.map((item) => item.edgeKey).sort(compare);
  return sameAmounts(definition.admissionAmounts, request.admissionAmounts)
    && definition.admissionGatePolicy === request.admissionGatePolicy
    && definition.nodeKey === request.nodeKey && definition.capability === request.capability
    && definition.repositoryBaseTree === request.repositoryBaseTree
    && definition.objective === request.objective
    && definition.policySliceHash === request.policySliceHash
    && definition.joinRole === request.joinRole
    && definition.completionLinkage === request.completionLinkage
    && same(definition.constraints, request.constraints)
    && same(definition.readScopes, request.readScopes)
    && same(definition.writeScopes, request.writeScopes)
    && same(definition.resources, request.resources)
    && same(definition.verificationRecipeRevisions, request.verificationRecipeRevisions)
    && same(definition.criterionBindings.map((item) => item.criterionId), expectedCriteria)
    && same(definition.directHardDependencies.map((item) => item.edgeKey), expectedEdges);
}

function readAdmission(reader: V2CompilerNodeAdmissionAuthorityReader,
  request: ReturnType<typeof nodeAdmissionRequest>): V2CompilerNodeAdmissionAuthority | undefined {
  let value: unknown;
  try { value = reader(request); } catch { return undefined; }
  const snapshot = snapshotCompilerInput(value);
  return snapshot.ok && exact(snapshot.value, ADMISSION_KEYS)
    && snapshot.value["budgetBindingDigest"] === request.budgetBindingDigest
    ? snapshot.value as unknown as V2CompilerNodeAdmissionAuthority : undefined;
}

function readDefinition(reader: V2CompilerNodeDefinitionReader,
  request: V2CompilerNodeAuthorityRequest): NodeDefinition | undefined {
  let value: unknown;
  try { value = reader(request); } catch { return undefined; }
  const snapshot = snapshotCompilerInput(value);
  if (!snapshot.ok) return undefined;
  const admitted = admitNodeDefinition(snapshot.value);
  return admitted.ok && definitionMatches(admitted.value.definition, request)
    ? admitted.value.definition : undefined;
}

function nodeRequest(node: NodeFact, compiled: V2CompiledNode,
  criteria: readonly V2CompiledCriterionBinding[], graphId: string,
  contractBinding: V2CompilerGraphAuthorityRequest["contractBinding"],
  structure: NonNullable<ReturnType<typeof graphStructure>>, snapshotIdentity: string,
  graphAuthority: V2CompilerGraphAuthority,
  admission: V2CompilerNodeAdmissionAuthority): V2CompilerNodeAuthorityRequest {
  const directHardDependencies: V2SchedulerDependency[] = structure.edges
    .filter((edge) => edge.consumerNodeKey === node.nodeId)
    .map(({ consumerNodeKey, edgeKey, producerNodeKey }) =>
      Object.freeze({ consumerNodeKey, edgeKey, producerNodeKey }));
  const criterionBindings = criteria.filter((criterion) => node.authorityKind === "BUILDER"
    ? criterion.ownerNodeId === node.nodeId : criterion.verifierNodeId === node.nodeId);
  const intent = nodeIntentAuthority(node, compiled, criteria, graphId, contractBinding);
  return Object.freeze({ admissionAmounts: admission.admissionAmounts,
    admissionGatePolicy: admission.admissionGatePolicy, authorityKind: node.authorityKind,
    budgetBindings: compiled.budgetBindings, capability: node.capabilityId,
    completionLinkage: node.nodeId === structure.completionNodeKey ? node.nodeId : null,
    constraints: intent.constraints, contractBinding,
    criterionBindings: Object.freeze(criterionBindings),
    directHardDependencies: Object.freeze(directHardDependencies), graphId,
    joinRole: node.nodeId === structure.completionNodeKey ? "COMPLETION" : "NONE",
    nodeKey: node.nodeId, objective: intent.objective,
    policySliceHash: graphAuthority.policyRevision,
    readScopes: node.capabilityBinding.readScopes,
    repositoryBaseTree: graphAuthority.repositoryBaseTree,
    requiredImageDigests: node.capabilityBinding.requiredImageDigests,
    requiredToolDigests: node.capabilityBinding.requiredToolDigests,
    resources: schedulerResourceIdentities(node.capabilityBinding, compiled.buildRecipe),
    roles: node.capabilityBinding.roles, snapshotIdentity,
    verificationRecipeRevisions: schedulerRecipeIdentities(node.capabilityBinding),
    writeScopes: node.capabilityBinding.writeScopes });
}

export function bindSchedulerAuthority(dependencies: SchedulerAuthorityDependencies,
  graphId: string, contractBinding: V2CompilerGraphAuthorityRequest["contractBinding"],
  facts: readonly NodeFact[], nodes: readonly V2CompiledNode[],
  criteria: readonly V2CompiledCriterionBinding[]): Result {
  const structure = graphStructure(facts);
  if (structure === undefined) return v2CompilerRefusal(
    "V2_COMPILER_GRAPH_LIMIT_EXCEEDED", "V2_COMPILER_TOPOLOGY",
  );
  const validated = validateGraphSnapshot(structure, POLICY);
  if (!validated.ok) return refuse("V2_COMPILER_SCHEDULER_GRAPH_INVALID");
  const graphRequest = Object.freeze({ contractBinding, graphId, snapshot: structure });
  const graphAuthority = readGraphAuthority(dependencies.readGraphAuthority, graphRequest);
  if (graphAuthority === undefined) return refuse("V2_COMPILER_GRAPH_AUTHORITY_UNAVAILABLE");
  const identity = snapshotIdentityHash(validated.graph);
  const compiledById = new Map(nodes.map((node) => [node.nodeId, node]));
  const definitions: NodeDefinition[] = [];
  for (const fact of facts) {
    const compiled = compiledById.get(fact.nodeId);
    if (compiled === undefined) return refuse("V2_COMPILER_NODE_AUTHORITY_INVALID");
    const admissionRequest = nodeAdmissionRequest(fact, compiled, graphId,
      contractBinding, graphAuthority.policyRevision);
    const admission = readAdmission(dependencies.readNodeAdmissionAuthority, admissionRequest);
    if (admission === undefined || admission.budgetBindingDigest !== budgetBindingDigest(compiled)) {
      return refuse("V2_COMPILER_NODE_AUTHORITY_INVALID");
    }
    const request = nodeRequest(fact, compiled, criteria, graphId, contractBinding,
      structure, identity, graphAuthority, admission);
    const definition = readDefinition(dependencies.readNodeDefinition, request);
    if (definition === undefined) return refuse("V2_COMPILER_NODE_AUTHORITY_INVALID");
    definitions.push(definition);
  }
  const derived = deriveNodeAuthoritySet(structure, definitions, POLICY);
  if (!derived.ok) return refuse("V2_COMPILER_NODE_AUTHORITY_INVALID");
  const encoded = encodeGraphContent({ ...graphAuthority,
    completionNode: structure.completionNodeKey,
    nodeAuthority: { authorities: derived.value, definitions: derived.definitions },
    snapshot: structure }, POLICY);
  if (!encoded.ok) return refuse("V2_COMPILER_SCHEDULER_GRAPH_INVALID");
  return Object.freeze({ binding: Object.freeze({
    canonicalBytesBase64: Buffer.from(encoded.value.bytes).toString("base64"),
    content: encoded.value.content, graphContentHash: encoded.value.graphContentHash,
    schemaVersion: encoded.value.schemaVersion,
    snapshotIdentity: encoded.value.snapshotIdentity,
  }), ok: true as const });
}
