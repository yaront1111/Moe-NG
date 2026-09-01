import {
  admitSourceSnapshotRef, encodeSourceSnapshot, type SourceSnapshot,
} from "@moe/core";
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
  V2CompilerNodeDefinitionReader, V2CompilerPublishedSourceSnapshotReader,
  V2SchedulerDependency,
} from "./authority-contracts.js";
import {
  v2CompilerRefusal, type V2CompiledCriterionBinding, type V2CompiledMaterialDigest,
  type V2CompiledNode, type V2CompilerRefusal,
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
const PUBLISHED_SOURCE_SNAPSHOT_KEYS = Object.freeze(["ok", "snapshot"]);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const refuse = (code: Parameters<typeof v2CompilerRefusal>[0]): V2CompilerRefusal =>
  v2CompilerRefusal(code, "V2_COMPILER_SCHEDULER_AUTHORITY");

export interface SchedulerAuthorityDependencies {
  readonly projectId: string;
  readonly readGraphAuthority: V2CompilerGraphAuthorityReader;
  readonly readNodeAdmissionAuthority: V2CompilerNodeAdmissionAuthorityReader;
  readonly readNodeDefinition: V2CompilerNodeDefinitionReader;
  readonly readPublishedSourceSnapshot: V2CompilerPublishedSourceSnapshotReader;
}
export interface SchedulerAuthorityBinding {
  readonly canonicalBytesBase64: string;
  readonly content: GraphRevisionContent;
  readonly graphContentHash: string;
  readonly schemaVersion: GraphContent["schemaVersion"];
  readonly snapshotIdentity: string;
}
type Result = Readonly<{ binding: SchedulerAuthorityBinding; ok: true }> | V2CompilerRefusal;

function graphStructure(nodes: readonly NodeFact[], completionNodeKey: string) {
  const edges = nodes.flatMap((node) => node.dependencyIds.map((producerNodeKey) => ({
    consumerNodeKey: node.nodeId,
    edgeKey: qualifiedIdentity("hard-edge", [producerNodeKey, node.nodeId]),
    kind: "HARD" as const, producerNodeKey,
  })));
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

function materialDigestUnbound(): V2CompilerRefusal {
  return v2CompilerRefusal(
    "V2_COMPILER_MATERIAL_DIGEST_UNBOUND", "V2_COMPILER_MATERIAL_BINDING",
  );
}

function bindPublishedSourceSnapshots(
  dependencies: SchedulerAuthorityDependencies,
  materialDigests: readonly V2CompiledMaterialDigest[],
  repositoryBaseTree: string,
): V2CompilerRefusal | undefined {
  const digests = [...new Set(materialDigests
    .filter(({ kind }) => kind === "SOURCE_SNAPSHOT")
    .map(({ digest }) => digest))].sort(compare);
  for (const sourceSnapshotDigest of digests) {
    const admittedRef = admitSourceSnapshotRef({
      projectId: dependencies.projectId,
      sourceSnapshotDigest,
    });
    if (!admittedRef.ok) return materialDigestUnbound();
    let value: unknown;
    try {
      value = dependencies.readPublishedSourceSnapshot(admittedRef.ref);
    } catch {
      return materialDigestUnbound();
    }
    const captured = snapshotCompilerInput(value);
    if (!captured.ok || !exact(captured.value, PUBLISHED_SOURCE_SNAPSHOT_KEYS)
      || captured.value["ok"] !== true) return materialDigestUnbound();
    const snapshotValue = captured.value["snapshot"];
    const encoded = encodeSourceSnapshot(snapshotValue);
    if (!encoded.ok) return materialDigestUnbound();
    const snapshot = snapshotValue as SourceSnapshot;
    if (snapshot.projectId !== dependencies.projectId
      || snapshot.sourceSnapshotDigest !== sourceSnapshotDigest
      || snapshot.repositoryBaseTree !== repositoryBaseTree) return materialDigestUnbound();
  }
  return undefined;
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
  graphId: string, completionNodeKey: string,
  contractBinding: V2CompilerGraphAuthorityRequest["contractBinding"],
  facts: readonly NodeFact[], materialDigests: readonly V2CompiledMaterialDigest[],
  nodes: readonly V2CompiledNode[],
  criteria: readonly V2CompiledCriterionBinding[]): Result {
  const completion = facts.find((fact) => fact.nodeId === completionNodeKey);
  if (completion?.authorityKind !== "VERIFIER") return v2CompilerRefusal(
    "V2_COMPILER_COMPLETION_NODE_INVALID", "V2_COMPILER_TOPOLOGY",
  );
  const structure = graphStructure(facts, completionNodeKey);
  if (structure === undefined) return v2CompilerRefusal(
    "V2_COMPILER_GRAPH_LIMIT_EXCEEDED", "V2_COMPILER_TOPOLOGY",
  );
  const validated = validateGraphSnapshot(structure, POLICY);
  if (!validated.ok) {
    const codes = new Set(validated.issues.map(({ code }) => code));
    if (codes.has("GRAPH_COMPLETION_NOT_TERMINAL")) return v2CompilerRefusal(
      "V2_COMPILER_COMPLETION_NODE_INVALID", "V2_COMPILER_TOPOLOGY",
    );
    if (codes.has("COMPLETION_CLOSURE_INCOMPLETE")) return v2CompilerRefusal(
      "V2_COMPILER_COMPLETION_CLOSURE_INCOMPLETE", "V2_COMPILER_TOPOLOGY",
    );
    return refuse("V2_COMPILER_SCHEDULER_GRAPH_INVALID");
  }
  const graphRequest = Object.freeze({
    contractBinding, graphId, projectId: dependencies.projectId, snapshot: structure,
  });
  const graphAuthority = readGraphAuthority(dependencies.readGraphAuthority, graphRequest);
  if (graphAuthority === undefined) return refuse("V2_COMPILER_GRAPH_AUTHORITY_UNAVAILABLE");
  const sourceBinding = bindPublishedSourceSnapshots(
    dependencies, materialDigests, graphAuthority.repositoryBaseTree,
  );
  if (sourceBinding !== undefined) return sourceBinding;
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
