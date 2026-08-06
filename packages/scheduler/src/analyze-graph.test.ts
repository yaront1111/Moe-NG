import { describe, expect, it } from "vitest";

import { analyzeGraphStructure } from "./analyze-graph.js";
import { partitionFrontier } from "./frontier.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import type { FrontierPartition, ValidatedGraph } from "./graph-model.js";
import {
  devAllAvailable,
  devChain,
  devHardEdge,
  devNode,
  devSnapshot,
  devUniformEdgeFacts,
} from "./test-fixtures.js";

function mustValidate(snapshot: Parameters<typeof validateGraphSnapshot>[0]): ValidatedGraph {
  const result = validateGraphSnapshot(snapshot);
  if (!result.ok) {
    throw new Error(`fixture failed validation: ${JSON.stringify(result.issues)}`);
  }
  return result.graph;
}

function mustPartition(
  graph: ValidatedGraph,
  cursor: Parameters<typeof partitionFrontier>[1],
): FrontierPartition {
  const result = partitionFrontier(graph, cursor);
  if (!result.ok) {
    throw new Error(`frontier failed: ${JSON.stringify(result.issues)}`);
  }
  return result.partition;
}

describe("analyzeGraphStructure — single execution node (required test 1)", () => {
  it("reports stage count 1 and ready width 1", () => {
    const graph = mustValidate(
      devSnapshot([devNode("dev-solo")], [], "dev-solo"),
    );
    const frontier = mustPartition(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: devAllAvailable(
        devSnapshot([devNode("dev-solo")], [], "dev-solo"),
      ),
    });
    const analysis = analyzeGraphStructure(graph, frontier);
    expect(analysis.structuralStageCount).toBe(1);
    expect(analysis.readyWidth).toBe(1);
    expect(analysis.structuralCriticalPathNodeKeys).toEqual(["dev-solo"]);
    expect(analysis.durationEstimate).toBeNull();
  });

  it("readyWidth is null (UNKNOWN, never 0) when no frontier is supplied", () => {
    const graph = mustValidate(
      devSnapshot([devNode("dev-solo")], [], "dev-solo"),
    );
    expect(analyzeGraphStructure(graph).readyWidth).toBeNull();
  });
});

describe("analyzeGraphStructure — six-node chain (required test 2)", () => {
  it("reports stage count 6, ready width 1, deterministic critical path", () => {
    const snapshot = devChain(6);
    const graph = mustValidate(snapshot);
    const frontier = mustPartition(graph, {
      hardEdgeFacts: devUniformEdgeFacts(snapshot, "UNSATISFIED"),
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    });
    const analysis = analyzeGraphStructure(graph, frontier);
    expect(analysis.structuralStageCount).toBe(6);
    expect(analysis.readyWidth).toBe(1);
    expect(analysis.structuralCriticalPathNodeKeys).toEqual([
      "dev-node-1",
      "dev-node-2",
      "dev-node-3",
      "dev-node-4",
      "dev-node-5",
      "dev-node-6",
    ]);
  });
});

describe("analyzeGraphStructure — fan-in join (required test 3)", () => {
  it("reports ready width 3 and stage count 2", () => {
    const snapshot = devSnapshot(
      [
        devNode("dev-child-a"),
        devNode("dev-child-b"),
        devNode("dev-child-c"),
        devNode("dev-done"),
      ],
      [
        devHardEdge("dev-ea", "dev-child-a", "dev-done"),
        devHardEdge("dev-eb", "dev-child-b", "dev-done"),
        devHardEdge("dev-ec", "dev-child-c", "dev-done"),
      ],
      "dev-done",
    );
    const graph = mustValidate(snapshot);
    const frontier = mustPartition(graph, {
      hardEdgeFacts: devUniformEdgeFacts(snapshot, "UNSATISFIED"),
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    });
    const analysis = analyzeGraphStructure(graph, frontier);
    expect(analysis.readyWidth).toBe(3);
    expect(analysis.structuralStageCount).toBe(2);
    expect(analysis.rootNodeKeys).toEqual([
      "dev-child-a",
      "dev-child-b",
      "dev-child-c",
    ]);
    expect(analysis.leafNodeKeys).toEqual(["dev-done"]);
  });
});

describe("analyzeGraphStructure — critical-path tie-break (required test 11)", () => {
  it("breaks equal critical paths by ascending nodeKey", () => {
    // dev-a -> dev-b -> dev-d and dev-a -> dev-c -> dev-d; both length 3.
    const snapshot = devSnapshot(
      [devNode("dev-a"), devNode("dev-b"), devNode("dev-c"), devNode("dev-d")],
      [
        devHardEdge("dev-ab", "dev-a", "dev-b"),
        devHardEdge("dev-ac", "dev-a", "dev-c"),
        devHardEdge("dev-bd", "dev-b", "dev-d"),
        devHardEdge("dev-cd", "dev-c", "dev-d"),
      ],
      "dev-d",
    );
    const graph = mustValidate(snapshot);
    const analysis = analyzeGraphStructure(graph);
    expect(analysis.structuralStageCount).toBe(3);
    // Documented tie-break: smaller-key predecessor (dev-b) wins over dev-c.
    expect(analysis.structuralCriticalPathNodeKeys).toEqual([
      "dev-a",
      "dev-b",
      "dev-d",
    ]);
  });
});

describe("analyzeGraphStructure — redundancy candidate (required test 12)", () => {
  it("reports a candidate but never authorizes removal", () => {
    // dev-a -> dev-b -> dev-c plus a direct dev-a -> dev-c edge.
    const snapshot = devSnapshot(
      [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")],
      [
        devHardEdge("dev-ab", "dev-a", "dev-b"),
        devHardEdge("dev-bc", "dev-b", "dev-c"),
        devHardEdge("dev-ac", "dev-a", "dev-c"),
      ],
      "dev-c",
    );
    const graph = mustValidate(snapshot);
    const analysis = analyzeGraphStructure(graph);
    expect(analysis.structuralRedundancyCandidates).toHaveLength(1);
    const candidate = analysis.structuralRedundancyCandidates[0]!;
    expect(candidate.edgeKey).toBe("dev-ac");
    expect(candidate.requiresSemanticProof).toBe(true);
    expect(candidate.alternateHardPathNodeKeys).toEqual([
      "dev-a",
      "dev-b",
      "dev-c",
    ]);
    expect(candidate.alternateHardPathEdgeKeys).toEqual(["dev-ab", "dev-bc"]);
    // The kernel never deletes the edge: it remains in the validated graph.
    expect(graph.edges.some((edge) => edge.edgeKey === "dev-ac")).toBe(true);
    expect(analysis.hardEdgeCount).toBe(3);
  });

  it("distinguishes parallel HARD edges via the alternate edge key", () => {
    const snapshot = devSnapshot(
      [devNode("dev-a"), devNode("dev-b")],
      [
        devHardEdge("dev-e1", "dev-a", "dev-b"),
        devHardEdge("dev-e2", "dev-a", "dev-b"),
      ],
      "dev-b",
    );
    const graph = mustValidate(snapshot);
    const analysis = analyzeGraphStructure(graph);
    const byKey = new Map(
      analysis.structuralRedundancyCandidates.map((c) => [c.edgeKey, c]),
    );
    // Each parallel edge is a candidate whose witness names the OTHER edge, so
    // the alternate is machine-distinguishable from the flagged edge.
    expect(byKey.get("dev-e1")!.alternateHardPathEdgeKeys).toEqual(["dev-e2"]);
    expect(byKey.get("dev-e2")!.alternateHardPathEdgeKeys).toEqual(["dev-e1"]);
  });
});

describe("analyzeGraphStructure — fail-closed on a cyclic precondition violation", () => {
  it("throws rather than silently truncating if handed a cyclic graph", () => {
    // Bypass validateGraphSnapshot via a cast to violate the ValidatedGraph
    // precondition; analyze must refuse rather than emit a truncated result.
    const cyclic = {
      nodes: [devNode("dev-a"), devNode("dev-b")],
      edges: [
        devHardEdge("dev-ab", "dev-a", "dev-b"),
        devHardEdge("dev-ba", "dev-b", "dev-a"),
      ],
      completionNodeKey: "dev-b",
      policy: {
        maxNodes: 24,
        maxHardEdges: 64,
        minGatedDescendantsForReview: 1,
      },
    } as unknown as ValidatedGraph;
    expect(() => analyzeGraphStructure(cyclic)).toThrow(/cyclic/);
  });
});
