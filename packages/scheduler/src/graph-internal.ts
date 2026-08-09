import { bump, compareStrings } from "./graph-traversal.js";
import type {
  GraphEdge,
  GraphIssue,
  GraphIssueCode,
  GraphNode,
  TraversalCounter,
} from "./graph-model.js";

// The traversal algorithms live in graph-traversal.ts to keep both files under
// the per-file source cap. This module stays the internal import facade: every
// name that was reachable through "./graph-internal.js" before the split is
// still reachable through it, so no consumer had to change.
export { compareStrings, findCycleCore, topologicalOrder } from "./graph-traversal.js";
export type { CycleCore, TopoResult } from "./graph-traversal.js";

/** Minimal structural view usable both pre- and post-validation. */
export interface GraphStructureView {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly completionNodeKey: string;
}

/** Single-bit mask for a node index, used by bitset ancestry/descendancy. */
export function bit(i: number): bigint {
  return 1n << BigInt(i);
}

/** Copy then sort ascending by string value. Never mutates the input. */
export function sortedCopy(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings);
}

export function makeIssue(
  code: GraphIssueCode,
  message: string,
  nodeKeys: readonly string[],
  edgeKeys: readonly string[],
): GraphIssue {
  return Object.freeze({
    code,
    message,
    nodeKeys: Object.freeze([...nodeKeys]),
    edgeKeys: Object.freeze([...edgeKeys]),
  });
}

/** Deterministic issue ordering: by code, node keys, edge keys, then message. */
export function sortIssues(issues: readonly GraphIssue[]): GraphIssue[] {
  const keyOf = (issue: GraphIssue): string =>
    JSON.stringify([issue.code, issue.nodeKeys, issue.edgeKeys, issue.message]);
  return [...issues].sort((left, right) => compareStrings(keyOf(left), keyOf(right)));
}

/**
 * Recursively freeze a value so returned structures cannot be mutated to affect
 * future calls. Handles plain objects and arrays; primitives pass through.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export interface HardArc {
  readonly edgeKey: string;
  readonly nodeIndex: number;
}

/**
 * A once-built, index-addressed view of a validated graph's HARD-edge
 * structure. All per-node arrays are deterministically ordered so downstream
 * traversal is reproducible regardless of input ordering. Raw index population
 * visits V + E items; deterministic adjacency sorting adds comparison cost.
 */
export interface HardGraphIndex {
  /** Node keys in ascending order; array index is the canonical node index. */
  readonly nodeKeys: readonly string[];
  readonly indexOf: ReadonlyMap<string, number>;
  readonly executionBearing: readonly boolean[];
  readonly completionIndex: number;
  /** HARD out-arcs per node (to consumer), ordered by (consumer key, edge key). */
  readonly hardOut: readonly (readonly HardArc[])[];
  /** HARD in-arcs per node (from producer), ordered by (producer key, edge key). */
  readonly hardIn: readonly (readonly HardArc[])[];
  readonly hardEdgeCount: number;
}

/**
 * Build the HARD-edge index of an already-validated graph. ADVISORY edges are
 * organizational overlay: they never participate in topology, readiness,
 * closure, ancestry, or critical-path structure.
 */
export function buildHardGraphIndex(
  graph: GraphStructureView,
  counter?: TraversalCounter,
): HardGraphIndex {
  const nodeKeys = graph.nodes.map((node) => node.nodeKey);
  const indexOf = new Map<string, number>();
  const executionBearing: boolean[] = [];
  for (let i = 0; i < graph.nodes.length; i += 1) {
    const node = graph.nodes[i]!;
    indexOf.set(node.nodeKey, i);
    executionBearing.push(node.executionBearing);
  }
  bump(counter, graph.nodes.length, 0);

  const outArcs: HardArc[][] = nodeKeys.map(() => []);
  const inArcs: HardArc[][] = nodeKeys.map(() => []);
  let hardEdgeCount = 0;
  for (const edge of graph.edges) {
    if (edge.kind !== "HARD") {
      continue;
    }
    const from = indexOf.get(edge.producerNodeKey)!;
    const to = indexOf.get(edge.consumerNodeKey)!;
    outArcs[from]!.push({ edgeKey: edge.edgeKey, nodeIndex: to });
    inArcs[to]!.push({ edgeKey: edge.edgeKey, nodeIndex: from });
    hardEdgeCount += 1;
  }
  bump(counter, 0, graph.edges.length);

  const arcOrder = (a: HardArc, b: HardArc): number => {
    const byNode = compareStrings(nodeKeys[a.nodeIndex]!, nodeKeys[b.nodeIndex]!);
    return byNode !== 0 ? byNode : compareStrings(a.edgeKey, b.edgeKey);
  };
  for (const arcs of outArcs) {
    arcs.sort(arcOrder);
  }
  for (const arcs of inArcs) {
    arcs.sort(arcOrder);
  }

  return {
    nodeKeys,
    indexOf,
    executionBearing,
    completionIndex: indexOf.get(graph.completionNodeKey)!,
    hardOut: outArcs,
    hardIn: inArcs,
    hardEdgeCount,
  };
}

export function edgeKeysOf(edges: readonly GraphEdge[]): string[] {
  return edges.map((edge) => edge.edgeKey);
}

/** Length-frame a token so concatenation is collision-free (no forged boundary). */
function frame(token: string): string {
  return `${token.length}:${token}`;
}

/**
 * Deterministic, collision-free canonical identity of a graph's STRUCTURE
 * (nodes, edges, completion — not policy). Assumes nodes/edges are already
 * sorted (as in a ValidatedGraph). Every variable-length key is length-framed,
 * so no key value can forge a field boundary; identical structure always yields
 * the identical string. No hashing / Node crypto is used.
 */
export function computeGraphIdentity(view: GraphStructureView): string {
  const parts: string[] = ["MOE-GRAPH-IDENTITY/1", `N${view.nodes.length}`];
  for (const node of view.nodes) {
    parts.push(frame(node.nodeKey) + (node.executionBearing ? "1" : "0"));
  }
  parts.push(`E${view.edges.length}`);
  for (const edge of view.edges) {
    parts.push(
      frame(edge.edgeKey) +
        frame(edge.producerNodeKey) +
        frame(edge.consumerNodeKey) +
        (edge.kind === "HARD" ? "H" : "A"),
    );
  }
  parts.push("C" + frame(view.completionNodeKey));
  // "\n" is a safe joiner: every token between joins is length-framed or a fixed
  // prefix, so the newline cannot be confused with framed content.
  return parts.join("\n");
}
