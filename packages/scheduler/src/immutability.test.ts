import { describe, expect, it } from "vitest";

import { analyzeGraphStructure } from "./analyze-graph.js";
import { partitionFrontier } from "./frontier.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import type { GraphSnapshot, ValidatedGraph } from "./graph-model.js";
import {
  devAllAvailable,
  devHardEdge,
  devNode,
  devSnapshot,
  devUniformEdgeFacts,
} from "./test-fixtures.js";

function mustValidate(snapshot: GraphSnapshot): ValidatedGraph {
  const result = validateGraphSnapshot(snapshot);
  if (!result.ok) {
    throw new Error(`fixture failed validation: ${JSON.stringify(result.issues)}`);
  }
  return result.graph;
}

const snapshot = devSnapshot(
  [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")],
  [
    devHardEdge("dev-ab", "dev-a", "dev-b"),
    devHardEdge("dev-bc", "dev-b", "dev-c"),
  ],
  "dev-c",
);

describe("immutability — outputs cannot be mutated (required test 14)", () => {
  it("freezes the whole result envelope, not just the payload", () => {
    const result = validateGraphSnapshot(snapshot);
    expect(Object.isFrozen(result)).toBe(true);
    const frontier = partitionFrontier(mustValidate(snapshot), {
      hardEdgeFacts: devUniformEdgeFacts(snapshot, "UNSATISFIED"),
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    });
    expect(Object.isFrozen(frontier)).toBe(true);
  });

  it("freezes the validated graph and its arrays", () => {
    const graph = mustValidate(snapshot);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.isFrozen(graph.edges)).toBe(true);
    expect(() => {
      (graph.nodes as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (graph.nodes[0] as { nodeKey: string }).nodeKey = "mutated";
    }).toThrow();
  });

  it("does not let mutation attempts affect a second analysis call", () => {
    const graph = mustValidate(snapshot);
    const first = analyzeGraphStructure(graph);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.topologicalOrder)).toBe(true);
    expect(Object.isFrozen(first.nodes)).toBe(true);
    expect(() => {
      (first.topologicalOrder as unknown as unknown[]).push("dev-x");
    }).toThrow();
    const second = analyzeGraphStructure(graph);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("freezes the frontier partition and blocked reasons", () => {
    const graph = mustValidate(snapshot);
    const result = partitionFrontier(graph, {
      hardEdgeFacts: devUniformEdgeFacts(snapshot, "UNSATISFIED"),
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.partition)).toBe(true);
      expect(Object.isFrozen(result.partition.logicalReady)).toBe(true);
      expect(Object.isFrozen(result.partition.blocked)).toBe(true);
      if (result.partition.blocked.length > 0) {
        expect(Object.isFrozen(result.partition.blocked[0]!.reasons)).toBe(true);
      }
    }
  });

  it("copies inputs so caller mutation after the call is inert", () => {
    const mutableNodes = [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")];
    const mutableEdges = [
      devHardEdge("dev-ab", "dev-a", "dev-b"),
      devHardEdge("dev-bc", "dev-b", "dev-c"),
    ];
    const graph = mustValidate(
      devSnapshot(mutableNodes, mutableEdges, "dev-c"),
    );
    // Mutate the caller's arrays after validation.
    mutableNodes.push(devNode("dev-injected"));
    mutableEdges.length = 0;
    // The validated graph is unaffected.
    expect(graph.nodes.map((n) => n.nodeKey)).toEqual([
      "dev-a",
      "dev-b",
      "dev-c",
    ]);
    expect(graph.edges).toHaveLength(2);
  });
});
