import { encodeGraphContent } from "@moe/scheduler";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";

const MAX_CONTEXT_BYTES = 16_000;
interface ContextNode {
  readonly nodeKey: string;
  readonly criterionIds: readonly string[];
  readonly dependsOn: readonly string[];
}
interface ContextIdentity {
  readonly advisoryOnly: true;
  readonly goalRef: string | null;
  readonly planningRunRef: string | null;
  readonly graphContentHash: string | null;
  readonly assignedNodeKey: string | null;
}
export type CompiledPlanContext = ContextIdentity & (
  | { readonly completeness: "COMPLETE"; readonly nodes: readonly ContextNode[] }
  | { readonly completeness: "UNKNOWN"; readonly reason: string; readonly nodes: readonly [] }
);
const boundedRef = (value: string | undefined): string | null =>
  value !== undefined && value.length > 0 && value.length <= 512 ? value : null;

/**
 * An advisory projection of ONE admitted graph, never a join by reusable node keys across goals.
 * COMPLETE covers its sealed ownership/dependency map only; it grants no acceptance, scope change,
 * or proof that a phase is finished. Unknown maps omit every row rather than present a partial
 * denominator. The existing graph codec owns structural validation and digest identity.
 */
export function compiledPlanContext(graph: ActiveCompiledGraph, assignedNodeKey: string): CompiledPlanContext {
  const identity: ContextIdentity = { advisoryOnly: true, assignedNodeKey: boundedRef(assignedNodeKey),
    goalRef: boundedRef(graph.goalRef), planningRunRef: boundedRef(graph.planningRunRef), graphContentHash: null };
  const unknown = (reason: string): CompiledPlanContext => Object.freeze({ ...identity,
    completeness: "UNKNOWN", reason, nodes: Object.freeze([] as const) });
  if (identity.goalRef === null || identity.planningRunRef === null || identity.assignedNodeKey === null) {
    return unknown("SEALED_PLAN_IDENTITY_MISSING");
  }
  try {
    const encoded = encodeGraphContent(graph.content);
    if (!encoded.ok) return unknown("SEALED_GRAPH_UNREADABLE");
    const { snapshot, nodeAuthority } = graph.content;
    const keys = snapshot.nodes.filter((node) => node.executionBearing).map((node) => node.nodeKey).sort();
    if (!keys.includes(assignedNodeKey) || new Set(keys).size !== keys.length) {
      return unknown("SEALED_NODE_JOIN_MISSING");
    }
    const owners = new Set<string>();
    const nodes: ContextNode[] = [];
    for (const nodeKey of keys) {
      const definitions = nodeAuthority.definitions.filter((definition) => definition.nodeKey === nodeKey);
      if (definitions.length !== 1) return unknown("SEALED_NODE_JOIN_MISSING");
      const criterionIds = definitions[0]!.criterionBindings.map((binding) => binding.criterionId).sort();
      if (criterionIds.length === 0) return unknown("SEALED_CRITERIA_MISSING");
      for (const criterionId of criterionIds) {
        if (owners.has(criterionId)) return unknown("CRITERION_OWNER_AMBIGUOUS");
        owners.add(criterionId);
      }
      const dependsOn = snapshot.edges.filter((edge) => edge.consumerNodeKey === nodeKey)
        .map((edge) => edge.producerNodeKey).sort();
      if (dependsOn.some((producer) => !keys.includes(producer))) return unknown("SEALED_DEPENDENCY_JOIN_MISSING");
      nodes.push(Object.freeze({ nodeKey, criterionIds: Object.freeze(criterionIds), dependsOn: Object.freeze(dependsOn) }));
    }
    const result: CompiledPlanContext = Object.freeze({ ...identity, graphContentHash: encoded.value.graphContentHash,
      completeness: "COMPLETE", nodes: Object.freeze(nodes) });
    return Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_CONTEXT_BYTES
      ? result : unknown("SEALED_PLAN_CONTEXT_TOO_LARGE");
  } catch {
    return unknown("SEALED_GRAPH_UNREADABLE");
  }
}
