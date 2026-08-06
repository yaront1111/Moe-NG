/**
 * DEVELOPMENT_ONLY fixtures for the structural graph kernel tests.
 *
 * These are synthetic, development-only graph shapes. They are NOT, and must
 * never be confused with, any BENCH-S* confirmatory benchmark corpus. All
 * identifiers carry the `dev-` prefix to make that explicit.
 */

import type {
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  HardEdgeFact,
  HardEdgeSatisfaction,
  NodeAvailabilityFact,
} from "./graph-model.js";

export const DEVELOPMENT_ONLY_NODE_PREFIX = "dev-node-" as const;
export const DEVELOPMENT_ONLY_EDGE_PREFIX = "dev-edge-" as const;

export function devNode(
  nodeKey: string,
  executionBearing = true,
): GraphNode {
  return { nodeKey, executionBearing };
}

export function devHardEdge(
  edgeKey: string,
  producerNodeKey: string,
  consumerNodeKey: string,
): GraphEdge {
  return { edgeKey, producerNodeKey, consumerNodeKey, kind: "HARD" };
}

export function devAdvisoryEdge(
  edgeKey: string,
  producerNodeKey: string,
  consumerNodeKey: string,
): GraphEdge {
  return { edgeKey, producerNodeKey, consumerNodeKey, kind: "ADVISORY" };
}

export function devSnapshot(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  completionNodeKey: string,
): GraphSnapshot {
  return { nodes, edges, completionNodeKey };
}

/** A straight HARD chain dev-node-1 -> ... -> dev-node-N, completion = last. */
export function devChain(length: number): GraphSnapshot {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 1; i <= length; i += 1) {
    nodes.push(devNode(`${DEVELOPMENT_ONLY_NODE_PREFIX}${i}`));
    if (i > 1) {
      edges.push(
        devHardEdge(
          `${DEVELOPMENT_ONLY_EDGE_PREFIX}${i - 1}-${i}`,
          `${DEVELOPMENT_ONLY_NODE_PREFIX}${i - 1}`,
          `${DEVELOPMENT_ONLY_NODE_PREFIX}${i}`,
        ),
      );
    }
  }
  return devSnapshot(nodes, edges, `${DEVELOPMENT_ONLY_NODE_PREFIX}${length}`);
}

/** Availability facts: all nodes admission-eligible and dispatch-available. */
export function devAllAvailable(
  snapshot: GraphSnapshot,
): NodeAvailabilityFact[] {
  return snapshot.nodes.map((node) => ({
    nodeKey: node.nodeKey,
    admissionEligible: true,
    dispatchAvailable: true,
  }));
}

/** Edge facts: every HARD edge set to a single uniform satisfaction state. */
export function devUniformEdgeFacts(
  snapshot: GraphSnapshot,
  state: HardEdgeSatisfaction,
): HardEdgeFact[] {
  return snapshot.edges
    .filter((edge) => edge.kind === "HARD")
    .map((edge) => ({ edgeKey: edge.edgeKey, state }));
}

/** Deterministic-but-shuffled copy of a snapshot (reversed node/edge order). */
export function devReversedOrder(snapshot: GraphSnapshot): GraphSnapshot {
  return {
    nodes: [...snapshot.nodes].reverse(),
    edges: [...snapshot.edges].reverse(),
    completionNodeKey: snapshot.completionNodeKey,
  };
}
