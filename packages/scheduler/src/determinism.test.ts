import { describe, expect, it } from "vitest";

import { analyzeGraphStructure } from "./analyze-graph.js";
import { partitionFrontier } from "./frontier.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import type { GraphSnapshot, ValidatedGraph } from "./graph-model.js";
import {
  devAllAvailable,
  devHardEdge,
  devNode,
  devReversedOrder,
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

describe("determinism — shuffled input yields byte-equivalent output (required test 10)", () => {
  const snapshot = devSnapshot(
    [
      devNode("dev-a"),
      devNode("dev-b"),
      devNode("dev-c"),
      devNode("dev-d"),
      devNode("dev-done"),
    ],
    [
      devHardEdge("dev-ab", "dev-a", "dev-b"),
      devHardEdge("dev-ac", "dev-a", "dev-c"),
      devHardEdge("dev-bd", "dev-b", "dev-d"),
      devHardEdge("dev-cd", "dev-c", "dev-d"),
      devHardEdge("dev-ddone", "dev-d", "dev-done"),
    ],
    "dev-done",
  );

  it("produces identical analysis JSON regardless of node/edge order", () => {
    const forward = mustValidate(snapshot);
    const reversed = mustValidate(devReversedOrder(snapshot));

    const analysisForward = analyzeGraphStructure(forward);
    const analysisReversed = analyzeGraphStructure(reversed);
    expect(JSON.stringify(analysisReversed)).toBe(
      JSON.stringify(analysisForward),
    );
  });

  it("produces identical frontier JSON regardless of fact order", () => {
    const graph = mustValidate(snapshot);
    const factsForward = {
      hardEdgeFacts: devUniformEdgeFacts(snapshot, "SATISFIED"),
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    };
    const factsReversed = {
      hardEdgeFacts: [...factsForward.hardEdgeFacts].reverse(),
      nodeAvailabilityFacts: [...factsForward.nodeAvailabilityFacts].reverse(),
    };
    const forward = partitionFrontier(graph, factsForward);
    const reversed = partitionFrontier(graph, factsReversed);
    expect(forward.ok && reversed.ok).toBe(true);
    if (forward.ok && reversed.ok) {
      expect(JSON.stringify(reversed.partition)).toBe(
        JSON.stringify(forward.partition),
      );
    }
  });
});
