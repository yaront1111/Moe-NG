import { describe, expect, it } from "vitest";

import { analyzeGraphStructure } from "./analyze-graph.js";
import { analyzeHardEdgeCounterfactuals } from "./hard-edge-counterfactual.js";
import {
  ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  ABSOLUTE_MAX_GRAPH_NODES,
  ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  MAX_GRAPH_KEY_CODE_UNITS,
} from "./graph-policy.js";
import type {
  GraphEdge,
  GraphSnapshot,
  ValidatedGraph,
} from "./graph-model.js";
import {
  devAdvisoryEdge,
  devChain,
  devHardEdge,
  devNode,
  devReversedOrder,
  devSnapshot,
} from "./test-fixtures.js";
import { validateGraphSnapshot } from "./validate-graph.js";

function mustValidate(
  snapshot: GraphSnapshot,
  policyOverride?: unknown,
): ValidatedGraph {
  const result = validateGraphSnapshot(snapshot, policyOverride);
  if (!result.ok) {
    throw new Error(`fixture failed validation: ${JSON.stringify(result.issues)}`);
  }
  return result.graph;
}

describe("hard-edge counterfactual review", () => {
  it("reports the middle of a four-node chain as the largest stage reduction", () => {
    const graph = mustValidate(devChain(4));
    const result = analyzeHardEdgeCounterfactuals(graph);

    expect(result.sourceGraphStructuralStageCount).toBe(4);
    expect(result.sourceGraphExecutionBearingHardRootCount).toBe(1);
    expect(result.edges.map((edge) => ({
      edgeKey: edge.edgeKey,
      reduction: edge.structuralStageReduction,
    }))).toEqual([
      { edgeKey: "dev-edge-1-2", reduction: 1 },
      { edgeKey: "dev-edge-2-3", reduction: 2 },
      { edgeKey: "dev-edge-3-4", reduction: 1 },
    ]);
    expect(result.edges.every(
      (edge) => edge.completionClosureIntactWithoutEdge === false,
    )).toBe(true);
  });

  it("does not invent a benefit when another diamond branch keeps the stage count", () => {
    const graph = mustValidate(devSnapshot(
      [
        devNode("dev-a"),
        devNode("dev-b"),
        devNode("dev-c"),
        devNode("dev-done"),
      ],
      [
        devHardEdge("dev-ab", "dev-a", "dev-b"),
        devHardEdge("dev-ac", "dev-a", "dev-c"),
        devHardEdge("dev-bd", "dev-b", "dev-done"),
        devHardEdge("dev-cd", "dev-c", "dev-done"),
      ],
      "dev-done",
    ));

    const result = analyzeHardEdgeCounterfactuals(graph);
    expect(result.sourceGraphStructuralStageCount).toBe(3);
    expect(result.edges.every(
      (edge) => edge.structuralStageReduction === 0,
    )).toBe(true);
  });

  it("recognizes a parallel alternate HARD path but keeps necessity UNKNOWN", () => {
    const graph = mustValidate(devSnapshot(
      [devNode("dev-a"), devNode("dev-done")],
      [
        devHardEdge("dev-a", "dev-a", "dev-done"),
        devHardEdge("dev-b", "dev-a", "dev-done"),
      ],
      "dev-done",
    ));

    const result = analyzeHardEdgeCounterfactuals(graph);
    expect(result.edges).toHaveLength(2);
    for (const edge of result.edges) {
      expect(edge.alternateHardPathPresent).toBe(true);
      expect(edge.completionClosureIntactWithoutEdge).toBe(true);
      expect(edge.structuralStageReduction).toBe(0);
      expect(edge.dependencyNecessity).toBe("UNKNOWN");
      expect(edge.requiresSemanticProof).toBe(true);
      expect(edge.reviewOnly).toBe(true);
      expect(edge).not.toHaveProperty("safeToRemove");
    }
    expect(result.durationEstimate).toBeNull();
  });

  it("matches existing redundancy candidates for a multi-hop alternate path", () => {
    const graph = mustValidate(devSnapshot(
      [devNode("dev-a"), devNode("dev-b"), devNode("dev-done")],
      [
        devHardEdge("dev-ab", "dev-a", "dev-b"),
        devHardEdge("dev-ac", "dev-a", "dev-done"),
        devHardEdge("dev-bc", "dev-b", "dev-done"),
      ],
      "dev-done",
    ));
    const counterfactuals = analyzeHardEdgeCounterfactuals(graph);
    const alternateEdgeKeys = counterfactuals.edges
      .filter((edge) => edge.alternateHardPathPresent)
      .map((edge) => edge.edgeKey);
    const redundancyEdgeKeys = analyzeGraphStructure(graph)
      .structuralRedundancyCandidates
      .map((edge) => edge.edgeKey);
    expect(alternateEdgeKeys).toEqual(["dev-ac"]);
    expect(alternateEdgeKeys).toEqual(redundancyEdgeKeys);
  });

  it("reports the exact newly hard-rooted execution node after chain removal", () => {
    const result = analyzeHardEdgeCounterfactuals(mustValidate(devChain(3)));
    expect(result.edges.map((edge) => edge.newlyHardRootedExecutionNodeKeys)).toEqual([
      ["dev-node-2"],
      ["dev-node-3"],
    ]);
    expect(result.edges.map(
      (edge) => edge.executionBearingHardRootCountWithoutEdge,
    )).toEqual([2, 2]);
  });

  it("excludes ADVISORY edges from removal counterfactuals", () => {
    const graph = mustValidate(devSnapshot(
      [devNode("dev-a"), devNode("dev-done")],
      [
        devHardEdge("dev-hard", "dev-a", "dev-done"),
        devAdvisoryEdge("dev-note", "dev-a", "dev-done"),
      ],
      "dev-done",
    ));
    expect(analyzeHardEdgeCounterfactuals(graph).edges.map(
      (edge) => edge.edgeKey,
    )).toEqual(["dev-hard"]);
  });

  it("weights non-execution-bearing nodes as zero and excludes them from root counts", () => {
    const graph = mustValidate(devSnapshot(
      [devNode("dev-a"), devNode("dev-note", false), devNode("dev-done")],
      [
        devHardEdge("dev-an", "dev-a", "dev-note"),
        devHardEdge("dev-nd", "dev-note", "dev-done"),
      ],
      "dev-done",
    ));
    const result = analyzeHardEdgeCounterfactuals(graph);
    expect(result.sourceGraphStructuralStageCount).toBe(2);
    expect(result.sourceGraphExecutionBearingHardRootCount).toBe(1);
    expect(result.edges[0]!.newlyHardRootedExecutionNodeKeys).toEqual([]);
    expect(result.edges[0]!.executionBearingHardRootCountWithoutEdge).toBe(1);
  });

  it("is byte-deterministic across input permutations", () => {
    const snapshot = devChain(4);
    const forward = analyzeHardEdgeCounterfactuals(mustValidate(snapshot));
    const reversed = analyzeHardEdgeCounterfactuals(
      mustValidate(devReversedOrder(snapshot)),
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it("rejects a structurally forged ValidatedGraph through runtime provenance", () => {
    const graph = mustValidate(devChain(2));
    const forged = { ...graph } as ValidatedGraph;
    expect(() => analyzeHardEdgeCounterfactuals(forged)).toThrow(
      /GRAPH_VALIDATION_PROVENANCE_INVALID/,
    );
  });

  it("deep-freezes results and never mutates the validated input", () => {
    const graph = mustValidate(devChain(3));
    const before = JSON.stringify(graph);
    const result = analyzeHardEdgeCounterfactuals(graph);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.edges)).toBe(true);
    expect(Object.isFrozen(result.edges[0])).toBe(true);
    expect(Object.isFrozen(result.edges[0]!.newlyHardRootedExecutionNodeKeys)).toBe(true);
    expect(() => {
      (result.edges as unknown as unknown[]).push({});
    }).toThrow();
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("returns one bounded review record per HARD edge at every absolute ceiling", () => {
    const maximumKey = (prefix: string): string =>
      prefix.padEnd(MAX_GRAPH_KEY_CODE_UNITS, "x");
    const nodes = Array.from(
      { length: ABSOLUTE_MAX_GRAPH_NODES },
      (_value, node) => devNode(maximumKey(`dev-max-${node}-`)),
    );
    const edges: GraphEdge[] = [];
    for (let gap = 1; edges.length < ABSOLUTE_MAX_GRAPH_HARD_EDGES; gap += 1) {
      for (
        let producer = 0;
        producer + gap < nodes.length &&
          edges.length < ABSOLUTE_MAX_GRAPH_HARD_EDGES;
        producer += 1
      ) {
        const consumer = producer + gap;
        edges.push(devHardEdge(
          maximumKey(`dev-max-edge-${gap}-${producer}-${consumer}-`),
          nodes[producer]!.nodeKey,
          nodes[consumer]!.nodeKey,
        ));
      }
    }
    const snapshot = devSnapshot(nodes, edges, nodes.at(-1)!.nodeKey);
    const graph = mustValidate(snapshot, {
      maxHardEdges: ABSOLUTE_MAX_GRAPH_HARD_EDGES,
      maxNodes: ABSOLUTE_MAX_GRAPH_NODES,
      maxTotalEdges: ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
    });
    const result = analyzeHardEdgeCounterfactuals(graph);
    expect(result.edges).toHaveLength(ABSOLUTE_MAX_GRAPH_HARD_EDGES);
    expect(JSON.stringify(result).length).toBeLessThan(250_000);
    expect(result.edges.every(
      (edge) => edge.dependencyNecessity === "UNKNOWN" && edge.reviewOnly,
    )).toBe(true);
  });
});
