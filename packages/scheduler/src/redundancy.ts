import {
  bit,
  compareStrings,
  type HardGraphIndex,
} from "./graph-internal.js";
import type {
  RedundancyCandidate,
  ValidatedGraph,
} from "./graph-model.js";

interface WitnessPath {
  readonly nodeIndices: readonly number[];
  readonly edgeKeys: readonly string[];
}

/**
 * A direct HARD edge `producer -> consumer` is a redundancy CANDIDATE when
 * another HARD path connects the same endpoints. This is never authorization to
 * remove the edge: the alternate path may not carry the same artifact/predicate,
 * which only semantic proof (unavailable to this structural kernel) could
 * establish. `requiresSemanticProof` is therefore always `true`.
 *
 * Detection is O(1) per producer out-arc via precomputed descendant masks; the
 * witness reconstruction is a bounded BFS that runs only when a candidate
 * exists. Results are sorted by `edgeKey` for determinism.
 */
export function findRedundancyCandidates(
  graph: ValidatedGraph,
  index: HardGraphIndex,
  descendantMask: readonly bigint[],
): RedundancyCandidate[] {
  const candidates: RedundancyCandidate[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "HARD") {
      continue;
    }
    const producer = index.indexOf.get(edge.producerNodeKey)!;
    const consumer = index.indexOf.get(edge.consumerNodeKey)!;
    let alternate = -1;
    let firstEdgeKey = "";
    for (const arc of index.hardOut[producer]!) {
      if (arc.edgeKey === edge.edgeKey) {
        continue;
      }
      if (
        arc.nodeIndex === consumer ||
        (descendantMask[arc.nodeIndex]! & bit(consumer)) !== 0n
      ) {
        // hardOut is (consumer-key, edge-key) sorted, so the first reaching arc
        // is the smallest-key alternate — deterministic.
        alternate = arc.nodeIndex;
        firstEdgeKey = arc.edgeKey;
        break;
      }
    }
    if (alternate === -1) {
      continue;
    }
    const tail = reconstructPath(index, descendantMask, alternate, consumer);
    candidates.push({
      edgeKey: edge.edgeKey,
      producerNodeKey: edge.producerNodeKey,
      consumerNodeKey: edge.consumerNodeKey,
      alternateHardPathNodeKeys: [
        edge.producerNodeKey,
        ...tail.nodeIndices.map((i) => index.nodeKeys[i]!),
      ],
      alternateHardPathEdgeKeys: [firstEdgeKey, ...tail.edgeKeys],
      requiresSemanticProof: true,
    });
  }
  candidates.sort((a, b) => compareStrings(a.edgeKey, b.edgeKey));
  return candidates;
}

/**
 * Deterministic shortest HARD path from `start` to `target` (smallest-key
 * neighbour first), returned as node indices and the traversed edge keys,
 * including both endpoints. Bounded BFS; runs only for an actual candidate.
 */
function reconstructPath(
  index: HardGraphIndex,
  descendantMask: readonly bigint[],
  start: number,
  target: number,
): WitnessPath {
  if (start === target) {
    return { nodeIndices: [start], edgeKeys: [] };
  }
  const n = index.nodeKeys.length;
  const prev = new Array<number>(n).fill(-2);
  const prevEdge = new Array<string>(n).fill("");
  prev[start] = -1;
  const queue: number[] = [start];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head]!;
    head += 1;
    if (node === target) {
      break;
    }
    for (const arc of index.hardOut[node]!) {
      const next = arc.nodeIndex;
      if (prev[next] !== -2) {
        continue;
      }
      // Descend only where the target remains reachable, keeping the path short.
      if (next !== target && (descendantMask[next]! & bit(target)) === 0n) {
        continue;
      }
      prev[next] = node;
      prevEdge[next] = arc.edgeKey;
      queue.push(next);
    }
  }
  const nodeIndices: number[] = [];
  const edgeKeys: string[] = [];
  let cursor = target;
  while (cursor !== -1 && cursor !== -2) {
    nodeIndices.push(cursor);
    if (prev[cursor]! >= 0) {
      edgeKeys.push(prevEdge[cursor]!);
    }
    cursor = prev[cursor]!;
  }
  nodeIndices.reverse();
  edgeKeys.reverse();
  return { nodeIndices, edgeKeys };
}
