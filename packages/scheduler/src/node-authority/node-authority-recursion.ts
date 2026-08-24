/**
 * Design line 255's RECURSIVE execution-contract identity: one `nodeAuthorityHash` per node of a
 * validated graph, from the node's own admitted body and, transitively, every HARD predecessor's.
 *
 * COMPOSES, NEVER REIMPLEMENTS: `validateGraphSnapshot` judges the graph, `admitNodeDefinition`
 * each body, `snapshotIdentityHash` the structural binding. This module decides only what no
 * single body can see — that the body set and the graph are one node set, that every HARD edge
 * has exactly one contract filed on its consumer, that each contract is bound to THIS structure,
 * and that facts shared across bodies agree. NO CALLER HASH HAS AUTHORITY: predecessor hashes
 * come from this module's own map, and the codec already refuses a body that states one.
 * Derivation is ITERATIVE (Kahn), so a deep chain costs a loop step, not a stack frame. The layer
 * constant stays MODULE-PRIVATE — the security roster counts exported `*_LAYER(S)`.
 */
import { createHash } from "node:crypto";

import { snapshotIdentityHash } from "../graph-content-format.js";
import { buildHardGraphIndex } from "../graph-internal.js";
import { topologicalOrder } from "../graph-traversal.js";
import { validateGraphSnapshot } from "../validate-graph.js";
import { admitNodeDefinition } from "./node-authority-codec.js";
import { canonicalText, compareStrings, deepFreeze } from "./node-authority-contract.js";
import type { GraphEdge, ValidatedGraph } from "../graph-model.js";
import type { NodeAuthorityLayer, NodeDefinition } from "./node-authority-contract.js";

/** Separate from the body digest domain so the two rotate apart. */
const RECURSION_DIGEST_DOMAIN = "MOE-NODE-AUTHORITY-RECURSIVE/2";
const LAYER_NAMES = Object.freeze(["NODE_AUTHORITY_RECURSION", "GRAPH_SNAPSHOT"] as const);
const RECURSION_LAYER = "NODE_AUTHORITY_RECURSION";
const GRAPH_LAYER = "GRAPH_SNAPSHOT";

/** A foreign authority's own layer travels out unchanged beside this module's two. */
export type NodeAuthorityRecursionLayer = (typeof LAYER_NAMES)[number] | NodeAuthorityLayer;

export const NODE_AUTHORITY_RECURSION_CODES = Object.freeze([
  "NODE_AUTHORITY_RECURSION_BINDING_MISMATCH", "NODE_AUTHORITY_RECURSION_COMPLETION_LINKAGE_INVALID",
  "NODE_AUTHORITY_RECURSION_CONTRACT_DUPLICATE", "NODE_AUTHORITY_RECURSION_CONTRACT_FORBIDDEN",
  "NODE_AUTHORITY_RECURSION_CONTRACT_MISSING", "NODE_AUTHORITY_RECURSION_CYCLE",
  "NODE_AUTHORITY_RECURSION_ENDPOINT_MISMATCH", "NODE_AUTHORITY_RECURSION_MALFORMED",
  "NODE_AUTHORITY_RECURSION_NODE_DUPLICATE", "NODE_AUTHORITY_RECURSION_NODE_EXTRA",
  "NODE_AUTHORITY_RECURSION_NODE_MISSING", "NODE_AUTHORITY_RECURSION_REPOSITORY_BASE_CONFLICT",
  "NODE_AUTHORITY_RECURSION_WITNESS_CONFLICT",
] as const);
export type NodeAuthorityRecursionCode = (typeof NODE_AUTHORITY_RECURSION_CODES)[number];

export interface NodeAuthorityRecursionIssue {
  readonly code: NodeAuthorityRecursionCode | string;
  readonly layer: NodeAuthorityRecursionLayer; readonly message: string;
}
export interface NodeAuthorityEntry { readonly nodeAuthorityHash: string;
  readonly nodeKey: string }
export type NodeAuthorityRecursionResult =
  | { readonly definitions: readonly NodeDefinition[]; readonly hardEdgeCount: number; readonly ok: true;
    readonly value: readonly NodeAuthorityEntry[] }
  | { readonly issues: readonly NodeAuthorityRecursionIssue[]; readonly ok: false };

/** Design-255's field roster. `nodeKey` is PAIRED with the hash, never hashed; `schemaVersion`
 * rides the domain tag; dependencies enter through the graph-ordered incoming section. */
const PREIMAGE_KEYS: readonly string[] = Object.freeze([
  "admissionAmounts", "admissionGatePolicy", "capability", "completionLinkage", "constraints",
  "criterionBindings", "joinRole", "objective", "planExecutionContentDigest", "policySliceHash",
  "readScopes", "repositoryBaseTree", "resources", "verificationRecipeRevisions", "writeScopes",
]);

const refuse = (code: NodeAuthorityRecursionCode, message: string): NodeAuthorityRecursionResult =>
  Object.freeze({
    issues: Object.freeze([Object.freeze({ code, layer: RECURSION_LAYER, message })]),
    ok: false as const,
  });

/** A foreign verdict, unchanged. `layer` is the source's own where it has one; the graph
 * validator carries none, so its codes travel under this module's graph layer literal. */
const passthrough = (layer: NodeAuthorityRecursionLayer,
  issues: readonly { readonly code: string; readonly layer?: string; readonly message?: string }[],
): NodeAuthorityRecursionResult => Object.freeze({
  issues: Object.freeze(issues.map((issue) => Object.freeze({
    code: issue.code, layer: (issue.layer ?? layer) as NodeAuthorityRecursionLayer,
    message: issue.message ?? issue.code,
  }))),
  ok: false as const,
});

/** Length-framed: no field can shift across a boundary to forge another node's preimage. */
const frame = (value: string): string => `${value.length}:${value}`;
/** The staged readers return either their product or a refusal; this tells them apart. */
const failed = (v: unknown): v is NodeAuthorityRecursionResult =>
  typeof v === "object" && v !== null && "ok" in v;

function admitBodies(input: unknown): NodeAuthorityRecursionResult | readonly NodeDefinition[] {
  if (!Array.isArray(input)) return refuse("NODE_AUTHORITY_RECURSION_MALFORMED", "not an array");
  const definitions: NodeDefinition[] = [];
  for (const body of input) {
    const admitted = admitNodeDefinition(body);
    if (!admitted.ok) return passthrough(RECURSION_LAYER, admitted.issues);
    definitions.push(admitted.value.definition);
  }
  return definitions;
}

/** Exactly one admitted body per snapshot node, and no body the snapshot does not carry. */
function indexBodies(graph: ValidatedGraph, definitions: readonly NodeDefinition[],
): NodeAuthorityRecursionResult | Map<string, NodeDefinition> {
  const keys = new Set(graph.nodes.map((node) => node.nodeKey));
  const byKey = new Map<string, NodeDefinition>();
  for (const definition of definitions) {
    const key = definition.nodeKey;
    if (byKey.has(key)) {
      return refuse("NODE_AUTHORITY_RECURSION_NODE_DUPLICATE", `two bodies claim node "${key}"`);
    }
    if (!keys.has(key)) {
      return refuse("NODE_AUTHORITY_RECURSION_NODE_EXTRA", `body "${key}" is not in the snapshot`);
    }
    byKey.set(key, definition);
  }
  const absent = graph.nodes.find((node) => !byKey.has(node.nodeKey));
  return absent === undefined ? byKey : refuse("NODE_AUTHORITY_RECURSION_NODE_MISSING",
    `no admitted body for node "${absent.nodeKey}"`);
}

interface ContractView {
  readonly canonical: string; readonly consumerNodeKey: string;
  readonly graphBindingDigest: string; readonly predicateRef: string;
  readonly producerNodeKey: string; readonly witnesses: readonly (readonly [string, string])[];
}

function viewOf(entry: NodeDefinition["directHardDependencies"][number]): ContractView {
  const contract = entry.contract as unknown as Readonly<Record<string, unknown>>;
  const predicate = contract["satisfactionPredicate"] as Record<string, unknown>;
  return Object.freeze({
    canonical: canonicalText(entry.contract),
    consumerNodeKey: String(contract["consumerNodeKey"]),
    graphBindingDigest: String(contract["graphBindingDigest"]),
    predicateRef: String(predicate["predicateRef"]),
    producerNodeKey: String(contract["producerNodeKey"]),
    witnesses: (contract["satisfactionWitnesses"] as readonly Record<string, unknown>[]).map(
      (witness) => Object.freeze([String(witness["witnessRef"]),
        `${String(witness["witnessDigest"])}/${String(witness["witnessVersion"])}`] as const)),
  });
}

/** Every HARD edge has exactly one contract, filed on its CONSUMER's body and bound to this
 * graph's identity; no advisory or unknown edge has one; witnesses agree across bodies. */
function closeContracts(graph: ValidatedGraph, byKey: Map<string, NodeDefinition>,
  binding: string): NodeAuthorityRecursionResult | Map<string, ContractView> {
  const edges = new Map<string, GraphEdge>(graph.edges.map((edge) => [edge.edgeKey, edge]));
  const filed = new Map<string, ContractView>();
  const seals = new Map<string, string>();
  for (const [nodeKey, definition] of byKey) {
    for (const entry of definition.directHardDependencies) {
      const edge = edges.get(entry.edgeKey);
      if (edge === undefined || edge.kind !== "HARD") {
        return refuse("NODE_AUTHORITY_RECURSION_CONTRACT_FORBIDDEN",
          `edge "${entry.edgeKey}" is not a HARD edge of this snapshot`);
      }
      if (filed.has(entry.edgeKey)) {
        return refuse("NODE_AUTHORITY_RECURSION_CONTRACT_DUPLICATE",
          `edge "${entry.edgeKey}" carries more than one contract`);
      }
      const view = viewOf(entry);
      if (view.consumerNodeKey !== nodeKey || view.consumerNodeKey !== edge.consumerNodeKey
        || view.producerNodeKey !== edge.producerNodeKey) {
        return refuse("NODE_AUTHORITY_RECURSION_ENDPOINT_MISMATCH",
          `contract on "${entry.edgeKey}" does not match the snapshot endpoints`);
      }
      if (view.graphBindingDigest !== binding) {
        return refuse("NODE_AUTHORITY_RECURSION_BINDING_MISMATCH",
          `contract on "${entry.edgeKey}" is bound to another graph structure`);
      }
      for (const [ref, seal] of view.witnesses) {
        if ((seals.get(ref) ?? seal) !== seal) {
          return refuse("NODE_AUTHORITY_RECURSION_WITNESS_CONFLICT",
            `witness "${ref}" is stated with two different seals`);
        }
        seals.set(ref, seal);
      }
      filed.set(entry.edgeKey, view);
    }
  }
  const orphan = graph.edges.find((edge) => edge.kind === "HARD" && !filed.has(edge.edgeKey));
  return orphan === undefined ? filed : refuse("NODE_AUTHORITY_RECURSION_CONTRACT_MISSING",
    `HARD edge "${orphan.edgeKey}" has no admitted contract`);
}

/** Facts that must agree across the whole set, and the one linkage only the graph can settle. */
function agree(graph: ValidatedGraph, byKey: Map<string, NodeDefinition>,
): NodeAuthorityRecursionResult | null {
  let base: string | null = null;
  for (const definition of byKey.values()) {
    if (base !== null && definition.repositoryBaseTree !== base) {
      return refuse("NODE_AUTHORITY_RECURSION_REPOSITORY_BASE_CONFLICT",
        "the bodies state two different repository base trees");
    }
    base = definition.repositoryBaseTree;
    const completes = definition.nodeKey === graph.completionNodeKey;
    if (completes !== (definition.joinRole === "COMPLETION")) {
      return refuse("NODE_AUTHORITY_RECURSION_COMPLETION_LINKAGE_INVALID",
        `node "${definition.nodeKey}" states a join role the graph does not support`);
    }
  }
  return null;
}

function preimage(definition: NodeDefinition, incoming: readonly string[]): string {
  const body = definition as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of PREIMAGE_KEYS) projected[key] = body[key];
  return `${RECURSION_DIGEST_DOMAIN}\n${frame(canonicalText(projected))}${incoming.join("")}`;
}

export function deriveNodeAuthoritySet(
  snapshotInput: unknown, bodiesInput: unknown, policyOverride?: unknown,
): NodeAuthorityRecursionResult {
  const validated = validateGraphSnapshot(snapshotInput, policyOverride);
  if (!validated.ok) return passthrough(GRAPH_LAYER, validated.issues);
  const { graph } = validated;
  const admitted = admitBodies(bodiesInput);
  if (failed(admitted)) return admitted;
  const byKey = indexBodies(graph, admitted);
  if (failed(byKey)) return byKey;
  const filed = closeContracts(graph, byKey, snapshotIdentityHash(graph));
  if (failed(filed)) return filed;
  const disagreement = agree(graph, byKey);
  if (disagreement !== null) return disagreement;
  const index = buildHardGraphIndex(graph);
  const ordered = topologicalOrder(index);
  if (!ordered.acyclic) {
    // Defensive only: `validateGraphSnapshot` returns ok solely for an acyclic HARD subgraph, so
    // no input reaching here can trip this. It refuses rather than throwing all the same.
    return refuse("NODE_AUTHORITY_RECURSION_CYCLE", "the HARD subgraph is cyclic");
  }
  const edges = new Map<string, GraphEdge>(graph.edges.map((edge) => [edge.edgeKey, edge]));
  const hashes = new Map<string, string>();
  for (const position of ordered.order) {
    const nodeKey = index.nodeKeys[position] as string;
    const incoming = (index.hardIn[position] ?? []).map((arc) => {
      const edge = edges.get(arc.edgeKey) as GraphEdge;
      const view = filed.get(arc.edgeKey) as ContractView;
      return [edge.edgeKey, edge.kind, view.predicateRef, view.canonical,
        hashes.get(edge.producerNodeKey) as string].map(frame).join("");
    });
    hashes.set(nodeKey, createHash("sha256")
      .update(preimage(byKey.get(nodeKey) as NodeDefinition, incoming), "utf8").digest("hex"));
  }
  const value = [...hashes.entries()]
    .map(([nodeKey, nodeAuthorityHash]) => ({ nodeAuthorityHash, nodeKey }))
    .sort((left, right) => compareStrings(left.nodeKey, right.nodeKey));
  const definitions = deepFreeze(Object.freeze(
    value.map(({ nodeKey }) => byKey.get(nodeKey) as NodeDefinition)));
  return Object.freeze({ definitions, hardEdgeCount: index.hardEdgeCount, ok: true as const,
    value: deepFreeze(Object.freeze(value)) });
}
