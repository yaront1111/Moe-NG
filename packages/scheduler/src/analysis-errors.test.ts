import { expect, it } from "vitest";

import { analyzeGraphStructure } from "./analyze-graph.js";
import { GraphAnalysisError } from "./graph-analysis-error.js";
import type { ValidatedGraph } from "./graph-model.js";

it("throws a stable code-bearing error for invalid analysis provenance", () => {
  const forged = {
    completionNodeKey: "dev-done",
    edges: [],
    graphIdentity: "forged",
    nodes: [{ executionBearing: true, nodeKey: "dev-done" }],
    policy: {
      maxHardEdges: 64,
      maxNodes: 24,
      maxTotalEdges: 64,
      minGatedDescendantsForReview: 1,
    },
  } as unknown as ValidatedGraph;

  try {
    analyzeGraphStructure(forged);
    throw new Error("expected analysis to reject forged provenance");
  } catch (error) {
    expect(error).toBeInstanceOf(GraphAnalysisError);
    expect(error).toMatchObject({
      code: "GRAPH_VALIDATION_PROVENANCE_INVALID",
      name: "GraphAnalysisError",
    });
  }
});
