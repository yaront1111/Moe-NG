import { describe, expect, it } from "vitest";

import { analyzeGraphStructure } from "./analyze-graph.js";
import {
  ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  ABSOLUTE_MAX_GRAPH_NODES,
  ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  MAX_GRAPH_KEY_CODE_UNITS,
} from "./graph-policy.js";
import type { GraphEdge, GraphNode } from "./graph-model.js";
import { validateGraphSnapshot } from "./validate-graph.js";

function paddedKey(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(3, "0")}`.padEnd(
    MAX_GRAPH_KEY_CODE_UNITS,
    "x",
  );
}

describe("immutable parser and materialization ceilings", () => {
  it("rejects policy input above every absolute ceiling", () => {
    const snapshot = {
      completionNodeKey: "dev-done",
      edges: [],
      nodes: [{ executionBearing: true, nodeKey: "dev-done" }],
    };
    expect(validateGraphSnapshot(snapshot, {
      maxNodes: ABSOLUTE_MAX_GRAPH_NODES + 1,
    }).ok).toBe(false);
    expect(validateGraphSnapshot(snapshot, {
      maxHardEdges: ABSOLUTE_MAX_GRAPH_HARD_EDGES + 1,
    }).ok).toBe(false);
    expect(validateGraphSnapshot(snapshot, {
      maxTotalEdges: ABSOLUTE_MAX_GRAPH_TOTAL_EDGES + 1,
    }).ok).toBe(false);
  });

  it("rejects unknown policy keys instead of widening a misspelled limit", () => {
    const snapshot = {
      completionNodeKey: "dev-done",
      edges: [],
      nodes: [{ executionBearing: true, nodeKey: "dev-done" }],
    };
    const result = validateGraphSnapshot(snapshot, {
      maxNodes: 1,
      maxTotlEdges: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual([
        "GRAPH_MALFORMED_POLICY",
      ]);
    }
  });

  it("bounds a high-reference raised-policy analysis to a reviewable payload", () => {
    const nodes: GraphNode[] = Array.from(
      { length: ABSOLUTE_MAX_GRAPH_NODES },
      (_, index) => ({
        executionBearing: true,
        nodeKey: paddedKey("n", index),
      }),
    );
    const edges: GraphEdge[] = [];
    for (let index = 0; index < nodes.length - 1; index += 1) {
      edges.push({
        consumerNodeKey: nodes[index + 1]!.nodeKey,
        edgeKey: paddedKey("c", index),
        kind: "HARD",
        producerNodeKey: nodes[index]!.nodeKey,
      });
    }
    for (let index = 2; index < nodes.length; index += 1) {
      edges.push({
        consumerNodeKey: nodes[index]!.nodeKey,
        edgeKey: paddedKey("s", index),
        kind: "HARD",
        producerNodeKey: nodes[0]!.nodeKey,
      });
    }
    expect(edges.length).toBeLessThanOrEqual(ABSOLUTE_MAX_GRAPH_TOTAL_EDGES);
    const validated = validateGraphSnapshot(
      {
        completionNodeKey: nodes.at(-1)!.nodeKey,
        edges,
        nodes,
      },
      {
        maxHardEdges: ABSOLUTE_MAX_GRAPH_HARD_EDGES,
        maxNodes: ABSOLUTE_MAX_GRAPH_NODES,
        maxTotalEdges: ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
      },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }
    const analysis = analyzeGraphStructure(validated.graph);
    expect(analysis.structuralRedundancyCandidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(analysis).length).toBeLessThan(2_000_000);
  });
});
