import {
  bit,
  buildHardGraphIndex,
  deepFreeze,
  topologicalOrder,
} from "./graph-internal.js";
import { findRedundancyCandidates } from "./redundancy.js";
import type {
  CriticalPathEdge,
  FrontierPartition,
  GraphStructuralAnalysis,
  NodeStructuralFacts,
  StructuralDiagnostic,
  TraversalCounter,
  ValidatedGraph,
} from "./graph-model.js";

/** Materialize a bitmask into ascending-key node-key list (nodeKeys is sorted). */
function maskToKeys(mask: bigint, nodeKeys: readonly string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < nodeKeys.length; i += 1) {
    if ((mask & bit(i)) !== 0n) {
      keys.push(nodeKeys[i]!);
    }
  }
  return keys;
}

function popcount(mask: bigint, n: number): number {
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    if ((mask & bit(i)) !== 0n) {
      count += 1;
    }
  }
  return count;
}

/**
 * Pure structural analysis of an already-validated graph. Deterministic and
 * side-effect-free. Reports exact structural facts; it never edits the graph,
 * removes an edge, infers semantic dependency truth, or claims a speedup. All
 * outputs are deeply frozen and deterministically ordered.
 *
 * `readyWidth` is taken from the supplied frontier partition (its logically
 * ready set); when no frontier is supplied it is `null` (UNKNOWN), never 0.
 */
export function analyzeGraphStructure(
  graph: ValidatedGraph,
  frontier?: FrontierPartition,
  counter?: TraversalCounter,
): GraphStructuralAnalysis {
  // Bind the frontier to THIS graph: a partition computed for another graph must
  // never be used to report readiness here. Fail closed on identity mismatch.
  if (frontier !== undefined && frontier.graphIdentity !== graph.graphIdentity) {
    throw new Error(
      "analyzeGraphStructure: frontier partition graphIdentity does not match the graph — a partition may only be analysed against the graph it was computed over",
    );
  }
  const index = buildHardGraphIndex(graph, counter);
  const n = index.nodeKeys.length;
  const topo = topologicalOrder(index, counter);
  // Defensive fail-closed guard: a ValidatedGraph is acyclic by construction, so
  // this only triggers if the precondition was violated (e.g. a caller cast a
  // hand-built graph past validateGraphSnapshot). We refuse to emit a silently
  // truncated analysis over a cyclic graph.
  if (!topo.acyclic) {
    throw new Error(
      "analyzeGraphStructure: ValidatedGraph precondition violated — the HARD subgraph is cyclic; only validateGraphSnapshot may produce a ValidatedGraph",
    );
  }
  const order = topo.order;

  // Ancestor masks (forward topo) and descendant masks (reverse topo). Each HARD
  // edge is relaxed exactly once per direction; descendant histories are never
  // rescanned per node.
  const ancestorMask = new Array<bigint>(n).fill(0n);
  for (const u of order) {
    let mask = 0n;
    for (const arc of index.hardIn[u]!) {
      mask |= bit(arc.nodeIndex) | ancestorMask[arc.nodeIndex]!;
      if (counter !== undefined) {
        counter.edgeVisits += 1;
      }
    }
    ancestorMask[u] = mask;
    if (counter !== undefined) {
      counter.nodeVisits += 1;
    }
  }
  const descendantMask = new Array<bigint>(n).fill(0n);
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const u = order[i]!;
    let mask = 0n;
    for (const arc of index.hardOut[u]!) {
      mask |= bit(arc.nodeIndex) | descendantMask[arc.nodeIndex]!;
      if (counter !== undefined) {
        counter.edgeVisits += 1;
      }
    }
    descendantMask[u] = mask;
    if (counter !== undefined) {
      counter.nodeVisits += 1;
    }
  }

  // Longest HARD path by execution-bearing-node count (stage count) + a
  // deterministic critical path via parent pointers.
  const bestExec = new Array<number>(n).fill(0);
  const parent = new Array<number>(n).fill(-1);
  for (const u of order) {
    let bestPredVal = 0;
    let bestPred = -1;
    for (const arc of index.hardIn[u]!) {
      const value = bestExec[arc.nodeIndex]!;
      if (value > bestPredVal) {
        bestPredVal = value;
        bestPred = arc.nodeIndex;
      }
      if (counter !== undefined) {
        counter.edgeVisits += 1;
      }
    }
    bestExec[u] = (index.executionBearing[u] ? 1 : 0) + bestPredVal;
    parent[u] = bestPred;
    if (counter !== undefined) {
      counter.nodeVisits += 1;
    }
  }
  let stageCount = 0;
  let endpoint = -1;
  for (let i = 0; i < n; i += 1) {
    // nodeKeys is ascending, so the first index achieving the max is the
    // smallest-key endpoint — documented tie-break.
    if (bestExec[i]! > stageCount) {
      stageCount = bestExec[i]!;
      endpoint = i;
    }
  }
  const criticalPathIndices: number[] = [];
  if (endpoint !== -1) {
    let cursor = endpoint;
    while (cursor !== -1) {
      criticalPathIndices.push(cursor);
      cursor = parent[cursor]!;
    }
    criticalPathIndices.reverse();
  }
  const criticalPathNodeKeys = criticalPathIndices.map(
    (i) => index.nodeKeys[i]!,
  );

  // HARD edges along the critical path + how many descendants each gates.
  const criticalPathHardEdges: CriticalPathEdge[] = [];
  for (let step = 1; step < criticalPathIndices.length; step += 1) {
    const consumer = criticalPathIndices[step]!;
    const producer = criticalPathIndices[step - 1]!;
    const arc = index.hardIn[consumer]!.find((a) => a.nodeIndex === producer);
    if (arc === undefined) {
      continue;
    }
    criticalPathHardEdges.push({
      edgeKey: arc.edgeKey,
      producerNodeKey: index.nodeKeys[producer]!,
      consumerNodeKey: index.nodeKeys[consumer]!,
      gatedDescendantCount: popcount(descendantMask[consumer]!, n),
    });
  }

  // Review-only anti-serialization diagnostics for serial bottlenecks.
  const diagnostics: StructuralDiagnostic[] = [];
  for (const edge of criticalPathHardEdges) {
    if (edge.gatedDescendantCount >= graph.policy.minGatedDescendantsForReview) {
      diagnostics.push({
        code: "INTERFACE_FIRST_REVIEW_REQUIRED",
        edgeKey: edge.edgeKey,
        gatedDescendantCount: edge.gatedDescendantCount,
        reviewOnly: true,
      });
    }
  }
  diagnostics.sort((a, b) =>
    a.edgeKey < b.edgeKey ? -1 : a.edgeKey > b.edgeKey ? 1 : 0,
  );

  // Per-node facts, roots, leaves.
  const nodes: NodeStructuralFacts[] = [];
  const rootNodeKeys: string[] = [];
  const leafNodeKeys: string[] = [];
  for (let i = 0; i < n; i += 1) {
    if (index.hardIn[i]!.length === 0) {
      rootNodeKeys.push(index.nodeKeys[i]!);
    }
    if (index.hardOut[i]!.length === 0) {
      leafNodeKeys.push(index.nodeKeys[i]!);
    }
    nodes.push({
      nodeKey: index.nodeKeys[i]!,
      hardAncestorKeys: maskToKeys(ancestorMask[i]!, index.nodeKeys),
      hardDescendantKeys: maskToKeys(descendantMask[i]!, index.nodeKeys),
      blockedDescendantCount: popcount(descendantMask[i]!, n),
    });
  }

  const structuralRedundancyCandidates = findRedundancyCandidates(
    graph,
    index,
    descendantMask,
  );

  const analysis: GraphStructuralAnalysis = {
    topologicalOrder: order.map((i) => index.nodeKeys[i]!),
    hardEdgeCount: index.hardEdgeCount,
    structuralStageCount: stageCount,
    structuralCriticalPathNodeKeys: criticalPathNodeKeys,
    criticalPathHardEdges,
    nodes,
    rootNodeKeys,
    leafNodeKeys,
    readyWidth: frontier === undefined ? null : frontier.logicalReady.length,
    structuralRedundancyCandidates,
    diagnostics,
    durationEstimate: null,
  };
  return deepFreeze(analysis);
}
