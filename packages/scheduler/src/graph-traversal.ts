/**
 * Traversal algorithms over an already-built HARD-edge index: deterministic
 * ordering support, Kahn topological sort, and Tarjan cycle-core detection.
 * Split out of graph-internal.ts, which remains the internal import facade and
 * owns index construction. The HardGraphIndex reference here is TYPE-ONLY so
 * the runtime import direction stays one-way (graph-internal -> graph-traversal).
 */
import type { TraversalCounter } from "./graph-model.js";
import type { HardGraphIndex } from "./graph-internal.js";

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

export function bump(counter: TraversalCounter | undefined, nodes: number, edges: number): void {
  if (counter !== undefined) {
    counter.nodeVisits += nodes;
    counter.edgeVisits += edges;
  }
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

export interface CycleCore {
  /** Node indices that lie on at least one HARD cycle (deterministic). */
  readonly nodeIndices: readonly number[];
  /** HARD edge keys whose endpoints belong to the same cyclic SCC. */
  readonly edgeKeys: readonly string[];
}

/**
 * Identify the EXACT cycle members (and their edges) of a cyclic HARD subgraph
 * via strongly-connected components — not source/sink peeling, which would also
 * report acyclic bridge nodes/edges connecting two distinct cycles. A node is on
 * a cycle iff it belongs to an SCC of size >= 2 (self-loops are rejected earlier
 * as GRAPH_SELF_EDGE, so size >= 2 is exact). A HARD edge is cyclic iff its
 * producer and consumer share such an SCC; cross-SCC bridge edges are excluded.
 *
 * Uses an ITERATIVE (explicit-stack) Tarjan pass — no recursion — in O(V + E).
 * Deterministic: the outer scan and every adjacency walk follow ascending
 * indices / the sorted HARD arcs, and the results are sorted.
 */
export function findCycleCore(index: HardGraphIndex): CycleCore {
  const n = index.nodeKeys.length;
  const vindex = new Array<number>(n).fill(-1);
  const lowlink = new Array<number>(n).fill(0);
  const onStack = new Uint8Array(n);
  const sccId = new Array<number>(n).fill(-1);
  const sccSize: number[] = [];
  const tarjan: number[] = [];
  let counter = 0;

  interface Frame {
    readonly node: number;
    arc: number;
  }

  for (let start = 0; start < n; start += 1) {
    if (vindex[start] !== -1) {
      continue;
    }
    const callStack: Frame[] = [{ node: start, arc: 0 }];
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const v = frame.node;
      if (frame.arc === 0) {
        vindex[v] = counter;
        lowlink[v] = counter;
        counter += 1;
        tarjan.push(v);
        onStack[v] = 1;
      }
      const arcs = index.hardOut[v]!;
      let recursed = false;
      while (frame.arc < arcs.length) {
        const w = arcs[frame.arc]!.nodeIndex;
        frame.arc += 1;
        if (vindex[w] === -1) {
          callStack.push({ node: w, arc: 0 });
          recursed = true;
          break;
        } else if (onStack[w] === 1) {
          lowlink[v] = Math.min(lowlink[v]!, vindex[w]!);
        }
      }
      if (recursed) {
        continue;
      }
      if (lowlink[v] === vindex[v]) {
        const id = sccSize.length;
        let size = 0;
        for (;;) {
          const w = tarjan.pop()!;
          onStack[w] = 0;
          sccId[w] = id;
          size += 1;
          if (w === v) {
            break;
          }
        }
        sccSize.push(size);
      }
      callStack.pop();
      const parent = callStack[callStack.length - 1];
      if (parent !== undefined) {
        lowlink[parent.node] = Math.min(lowlink[parent.node]!, lowlink[v]!);
      }
    }
  }

  const core: number[] = [];
  for (let node = 0; node < n; node += 1) {
    if (sccSize[sccId[node]!]! >= 2) {
      core.push(node);
    }
  }
  const edgeKeys: string[] = [];
  for (let node = 0; node < n; node += 1) {
    const id = sccId[node]!;
    if (sccSize[id]! < 2) {
      continue;
    }
    for (const arc of index.hardOut[node]!) {
      if (sccId[arc.nodeIndex] === id) {
        edgeKeys.push(arc.edgeKey);
      }
    }
  }
  return {
    nodeIndices: core,
    edgeKeys: edgeKeys.sort(compareStrings),
  };
}
