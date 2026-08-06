import { analyzeGraphStructure } from "./analyze-graph.js";
import { GraphAnalysisError } from "./graph-analysis-error.js";
import {
  buildHardGraphIndex,
  deepFreeze,
  topologicalOrder,
  type GraphStructureView,
  type HardGraphIndex,
} from "./graph-internal.js";
import type {
  HardEdgeCounterfactual,
  HardEdgeCounterfactualAnalysis,
} from "./hard-edge-counterfactual-model.js";
import type { GraphKey, ValidatedGraph } from "./graph-model.js";

/**
 * Analyze each validated source-graph HARD edge by removing only that edge.
 *
 * The result is structural review evidence, never permission to change the
 * graph. An alternate path can carry different artifacts or invalidation
 * semantics; `dependencyNecessity` therefore remains UNKNOWN even when the
 * topology looks redundant. The immutable parser ceilings bound both the
 * existing baseline analysis and each per-HARD-edge traversal; this function
 * makes no whole-routine linearity claim.
 */
export function analyzeHardEdgeCounterfactuals(
  graph: ValidatedGraph,
): HardEdgeCounterfactualAnalysis {
  // Reuse the supported analysis boundary for exact runtime provenance and the
  // validated source-graph baseline. A forged graph fails first.
  const baseline = analyzeGraphStructure(graph);
  const baselineIndex = buildHardGraphIndex(graph);
  const baselineRoots = executionBearingHardRoots(baselineIndex);
  const baselineRootSet = new Set<GraphKey>(baselineRoots);
  const records: HardEdgeCounterfactual[] = [];

  for (const removedEdge of graph.edges) {
    if (removedEdge.kind !== "HARD") {
      continue;
    }
    const view: GraphStructureView = {
      nodes: graph.nodes,
      edges: graph.edges.filter((edge) => edge.edgeKey !== removedEdge.edgeKey),
      completionNodeKey: graph.completionNodeKey,
    };
    const index = buildHardGraphIndex(view);
    const stageCount = structuralStageCount(index);
    const counterfactualRoots = executionBearingHardRoots(index);
    const producer = index.indexOf.get(removedEdge.producerNodeKey)!;
    const consumer = index.indexOf.get(removedEdge.consumerNodeKey)!;
    records.push({
      edgeKey: removedEdge.edgeKey,
      producerNodeKey: removedEdge.producerNodeKey,
      consumerNodeKey: removedEdge.consumerNodeKey,
      structuralStageCountWithoutEdge: stageCount,
      structuralStageReduction:
        baseline.structuralStageCount - stageCount,
      executionBearingHardRootCountWithoutEdge: counterfactualRoots.length,
      newlyHardRootedExecutionNodeKeys: counterfactualRoots.filter(
        (nodeKey) => !baselineRootSet.has(nodeKey),
      ),
      alternateHardPathPresent: hardPathExists(index, producer, consumer),
      completionClosureIntactWithoutEdge: completionClosureIntact(index),
      dependencyNecessity: "UNKNOWN",
      requiresSemanticProof: true,
      reviewOnly: true,
    });
  }

  records.sort((left, right) =>
    left.edgeKey < right.edgeKey ? -1 : left.edgeKey > right.edgeKey ? 1 : 0,
  );
  return deepFreeze({
    graphIdentity: graph.graphIdentity,
    sourceGraphStructuralStageCount: baseline.structuralStageCount,
    sourceGraphExecutionBearingHardRootCount: baselineRoots.length,
    edges: records,
    durationEstimate: null,
  });
}

function structuralStageCount(index: HardGraphIndex): number {
  const topo = topologicalOrder(index);
  if (!topo.acyclic) {
    throw new GraphAnalysisError(
      "GRAPH_ANALYSIS_CYCLE_PRECONDITION_INVALID",
      "removing a HARD edge unexpectedly produced a cyclic graph",
    );
  }
  const best = new Array<number>(index.nodeKeys.length).fill(0);
  let maximum = 0;
  for (const node of topo.order) {
    let predecessorMaximum = 0;
    for (const arc of index.hardIn[node]!) {
      predecessorMaximum = Math.max(
        predecessorMaximum,
        best[arc.nodeIndex]!,
      );
    }
    best[node] = predecessorMaximum + (index.executionBearing[node] ? 1 : 0);
    maximum = Math.max(maximum, best[node]!);
  }
  return maximum;
}

function executionBearingHardRoots(index: HardGraphIndex): GraphKey[] {
  const roots: GraphKey[] = [];
  for (let node = 0; node < index.nodeKeys.length; node += 1) {
    if (index.executionBearing[node] && index.hardIn[node]!.length === 0) {
      roots.push(index.nodeKeys[node]!);
    }
  }
  return roots;
}

function hardPathExists(
  index: HardGraphIndex,
  start: number,
  target: number,
): boolean {
  const seen = new Uint8Array(index.nodeKeys.length);
  const queue: number[] = [start];
  seen[start] = 1;
  let head = 0;
  while (head < queue.length) {
    const node = queue[head]!;
    head += 1;
    for (const arc of index.hardOut[node]!) {
      if (arc.nodeIndex === target) {
        return true;
      }
      if (seen[arc.nodeIndex] === 0) {
        seen[arc.nodeIndex] = 1;
        queue.push(arc.nodeIndex);
      }
    }
  }
  return false;
}

function completionClosureIntact(index: HardGraphIndex): boolean {
  const reachesCompletion = new Uint8Array(index.nodeKeys.length);
  const queue: number[] = [index.completionIndex];
  reachesCompletion[index.completionIndex] = 1;
  let head = 0;
  while (head < queue.length) {
    const node = queue[head]!;
    head += 1;
    for (const arc of index.hardIn[node]!) {
      if (reachesCompletion[arc.nodeIndex] === 0) {
        reachesCompletion[arc.nodeIndex] = 1;
        queue.push(arc.nodeIndex);
      }
    }
  }
  return index.nodeKeys.every(
    (_nodeKey, node) =>
      !index.executionBearing[node] || reachesCompletion[node] === 1,
  );
}
