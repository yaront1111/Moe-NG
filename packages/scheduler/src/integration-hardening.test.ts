import { describe, expect, it } from "vitest";

import { analyzeGraphStructure } from "./analyze-graph.js";
import { partitionFrontier } from "./frontier.js";
import {
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_TOTAL_EDGES,
} from "./graph-policy.js";
import type {
  FrontierPartition,
  GraphPolicy,
  GraphSnapshot,
  ValidatedGraph,
} from "./graph-model.js";
import {
  devAllAvailable,
  devHardEdge,
  devNode,
  devSnapshot,
  devUniformEdgeFacts,
} from "./test-fixtures.js";
import { validateGraphSnapshot } from "./validate-graph.js";

function requireGraph(snapshot: GraphSnapshot): ValidatedGraph {
  const result = validateGraphSnapshot(snapshot);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("fixture graph did not validate");
  }
  return result.graph;
}

function requireFrontier(graph: ValidatedGraph, snapshot: GraphSnapshot): FrontierPartition {
  const result = partitionFrontier(graph, {
    hardEdgeFacts: devUniformEdgeFacts(snapshot, "SATISFIED"),
    nodeAvailabilityFacts: devAllAvailable(snapshot),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("fixture frontier did not partition");
  }
  return result.partition;
}

describe("opaque validation provenance", () => {
  it("rejects a structurally forged ValidatedGraph", () => {
    const snapshot = devSnapshot([devNode("dev-done")], [], "dev-done");
    const graph = requireGraph(snapshot);
    const forged = { ...graph } as ValidatedGraph;

    const frontier = partitionFrontier(forged, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    });
    expect(frontier.ok).toBe(false);
    if (!frontier.ok) {
      expect(frontier.issues.map((issue) => issue.code)).toContain(
        "GRAPH_VALIDATION_PROVENANCE_INVALID",
      );
    }
    expect(() => analyzeGraphStructure(forged)).toThrow(
      /GRAPH_VALIDATION_PROVENANCE_INVALID/,
    );
  });

  it("rejects a forged or cross-graph frontier even when its identity string matches", () => {
    const snapshotA = devSnapshot([devNode("dev-a")], [], "dev-a");
    const graphA = requireGraph(snapshotA);
    const frontierA = requireFrontier(graphA, snapshotA);
    const forgedFrontier = {
      ...frontierA,
      logicalReady: ["dev-forged-1", "dev-forged-2"],
    } as FrontierPartition;
    expect(() => analyzeGraphStructure(graphA, forgedFrontier)).toThrow(
      /FRONTIER_VALIDATION_PROVENANCE_INVALID/,
    );

    const snapshotB = devSnapshot(
      [devNode("dev-b"), devNode("dev-done")],
      [devHardEdge("dev-b-done", "dev-b", "dev-done")],
      "dev-done",
    );
    const graphB = requireGraph(snapshotB);
    const frontierB = requireFrontier(graphB, snapshotB);
    const forgedGraphA = { ...graphA, graphIdentity: graphB.graphIdentity } as ValidatedGraph;
    expect(() => analyzeGraphStructure(forgedGraphA, frontierB)).toThrow(
      /GRAPH_VALIDATION_PROVENANCE_INVALID/,
    );
  });
});

describe("resource preflight", () => {
  it("rejects an over-limit sparse node array before reading any element", () => {
    let elementRead = false;
    const nodes: unknown[] = [];
    nodes.length = DEFAULT_MAX_NODES + 1;
    Object.defineProperty(nodes, 0, {
      get() {
        elementRead = true;
        throw new Error("node element must not be read");
      },
    });
    const result = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [],
      nodes,
    } as unknown as GraphSnapshot);
    expect(elementRead).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "GRAPH_NODE_LIMIT_EXCEEDED",
      );
    }
  });

  it("rejects an over-limit sparse edge array before reading any element", () => {
    let elementRead = false;
    const edges: unknown[] = [];
    edges.length = DEFAULT_MAX_TOTAL_EDGES + 1;
    Object.defineProperty(edges, 0, {
      get() {
        elementRead = true;
        throw new Error("edge element must not be read");
      },
    });
    const result = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges,
      nodes: [devNode("dev-done")],
    } as unknown as GraphSnapshot);
    expect(elementRead).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "GRAPH_TOTAL_EDGE_LIMIT_EXCEEDED",
      );
    }
  });

  it("returns a malformed-policy result for null or unbounded runtime overrides", () => {
    const snapshot = devSnapshot([devNode("dev-done")], [], "dev-done");
    const nullResult = validateGraphSnapshot(
      snapshot,
      null as unknown as Partial<GraphPolicy>,
    );
    expect(nullResult.ok).toBe(false);
    if (!nullResult.ok) {
      expect(nullResult.issues.map((issue) => issue.code)).toEqual([
        "GRAPH_MALFORMED_POLICY",
      ]);
    }
    const unbounded = validateGraphSnapshot(snapshot, {
      maxNodes: Number.MAX_SAFE_INTEGER,
      maxTotalEdges: Number.MAX_SAFE_INTEGER,
    });
    expect(unbounded.ok).toBe(false);
    if (!unbounded.ok) {
      expect(unbounded.issues.map((issue) => issue.code)).toEqual([
        "GRAPH_MALFORMED_POLICY",
      ]);
    }
  });

  it("rejects mismatched frontier collection lengths before reading elements", () => {
    const snapshot = devSnapshot([devNode("dev-done")], [], "dev-done");
    const graph = requireGraph(snapshot);
    let edgeRead = false;
    const edgeFacts: unknown[] = [];
    edgeFacts.length = 1;
    Object.defineProperty(edgeFacts, 0, {
      get() {
        edgeRead = true;
        throw new Error("edge fact must not be read");
      },
    });
    const edgeResult = partitionFrontier(graph, {
      hardEdgeFacts: edgeFacts,
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    } as never);
    expect(edgeRead).toBe(false);
    expect(edgeResult.ok).toBe(false);

    let nodeRead = false;
    const nodeFacts: unknown[] = [];
    nodeFacts.length = 2;
    Object.defineProperty(nodeFacts, 0, {
      get() {
        nodeRead = true;
        throw new Error("node fact must not be read");
      },
    });
    const nodeResult = partitionFrontier(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: nodeFacts,
    } as never);
    expect(nodeRead).toBe(false);
    expect(nodeResult.ok).toBe(false);
  });

  it("preserves typed unknown-fact diagnostics for bounded extras", () => {
    const snapshot = devSnapshot([devNode("dev-done")], [], "dev-done");
    const graph = requireGraph(snapshot);
    const result = partitionFrontier(graph, {
      hardEdgeFacts: [{ edgeKey: "dev-unknown", state: "SATISFIED" }],
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "FRONTIER_EDGE_FACT_UNKNOWN_EDGE",
      );
    }
  });
});
