import type {
  GraphEdge,
  GraphIssue,
  GraphIssueCode,
  GraphNode,
  TraversalCounter,
} from "./graph-model.js";

/** Minimal structural view usable both pre- and post-validation. */
export interface GraphStructureView {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly completionNodeKey: string;
}

/** Deterministic ascending string comparison (code-unit order). */
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
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
 * traversal is reproducible regardless of input ordering. Built in O(V + E).
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

function bump(counter: TraversalCounter | undefined, nodes: number, edges: number): void {
  if (counter !== undefined) {
    counter.nodeVisits += nodes;
    counter.edgeVisits += edges;
  }
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

export interface TopoResult {
  /** Node indices in a deterministic topological order (ties by node key). */
  readonly order: readonly number[];
  /** True when the HARD subgraph is acyclic (every node ordered). */
  readonly acyclic: boolean;
}

/**
 * Minimal iterative binary min-heap over node indices. Because node indices are
 * assigned in ascending node-key order, popping the smallest index yields
 * ascending-key tie-breaking. Heap ops are O(log V); no recursion.
 */
class IndexMinHeap {
  private readonly heap: number[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(value: number): void {
    const heap = this.heap;
    heap.push(value);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (heap[parent]! <= heap[child]!) {
        break;
      }
      const tmp = heap[parent]!;
      heap[parent] = heap[child]!;
      heap[child] = tmp;
      child = parent;
    }
  }

  pop(): number {
    const heap = this.heap;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let parent = 0;
      const size = heap.length;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < size && heap[left]! < heap[smallest]!) {
          smallest = left;
        }
        if (right < size && heap[right]! < heap[smallest]!) {
          smallest = right;
        }
        if (smallest === parent) {
          break;
        }
        const tmp = heap[parent]!;
        heap[parent] = heap[smallest]!;
        heap[smallest] = tmp;
        parent = smallest;
      }
    }
    return top;
  }
}

/**
 * Kahn topological sort over HARD edges, iterative (no recursion). Ready nodes
 * are drawn from a min-heap keyed by node index, so ties break by ascending
 * node key and the order is deterministic. Each node is popped once and each
 * HARD edge is relaxed once (O((V + E) log V)); descendant histories are never
 * rescanned.
 */
export function topologicalOrder(
  index: HardGraphIndex,
  counter?: TraversalCounter,
): TopoResult {
  const n = index.nodeKeys.length;
  const indegree: number[] = new Array<number>(n).fill(0);
  for (let node = 0; node < n; node += 1) {
    indegree[node] = index.hardIn[node]!.length;
  }
  const ready = new IndexMinHeap();
  for (let node = 0; node < n; node += 1) {
    if (indegree[node] === 0) {
      ready.push(node);
    }
  }

  const order: number[] = [];
  while (ready.size > 0) {
    const node = ready.pop();
    order.push(node);
    bump(counter, 1, 0);
    for (const arc of index.hardOut[node]!) {
      const next = arc.nodeIndex;
      indegree[next] = indegree[next]! - 1;
      if (indegree[next] === 0) {
        ready.push(next);
      }
      bump(counter, 0, 1);
    }
  }

  return { order, acyclic: order.length === n };
}

export function edgeKeysOf(edges: readonly GraphEdge[]): string[] {
  return edges.map((edge) => edge.edgeKey);
}
