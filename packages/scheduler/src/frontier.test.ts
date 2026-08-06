import { describe, expect, it } from "vitest";

import { partitionFrontier } from "./frontier.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import type { GraphSnapshot, ValidatedGraph } from "./graph-model.js";
import {
  devAdvisoryEdge,
  devAllAvailable,
  devHardEdge,
  devNode,
  devSnapshot,
} from "./test-fixtures.js";

function mustValidate(snapshot: GraphSnapshot): ValidatedGraph {
  const result = validateGraphSnapshot(snapshot);
  if (!result.ok) {
    throw new Error(`fixture failed validation: ${JSON.stringify(result.issues)}`);
  }
  return result.graph;
}

const pairSnapshot = devSnapshot(
  [devNode("dev-a"), devNode("dev-b")],
  [devHardEdge("dev-ab", "dev-a", "dev-b")],
  "dev-b",
);

describe("partitionFrontier — HARD dependency gating (required test 4)", () => {
  it("blocks the consumer until its HARD dependency is SATISFIED", () => {
    const graph = mustValidate(pairSnapshot);
    const blockedResult = partitionFrontier(graph, {
      hardEdgeFacts: [{ edgeKey: "dev-ab", state: "UNSATISFIED" }],
      nodeAvailabilityFacts: devAllAvailable(pairSnapshot),
    });
    expect(blockedResult.ok).toBe(true);
    if (blockedResult.ok) {
      expect(blockedResult.partition.logicalReady).toEqual(["dev-a"]);
      expect(blockedResult.partition.blocked.map((b) => b.nodeKey)).toEqual([
        "dev-b",
      ]);
      expect(blockedResult.partition.blocked[0]!.reasons[0]!.code).toBe(
        "HARD_DEPENDENCY_UNSATISFIED",
      );
      expect(blockedResult.partition.blocked[0]!.reasons[0]!.edgeKey).toBe(
        "dev-ab",
      );
    }

    const readyResult = partitionFrontier(graph, {
      hardEdgeFacts: [{ edgeKey: "dev-ab", state: "SATISFIED" }],
      nodeAvailabilityFacts: devAllAvailable(pairSnapshot),
    });
    expect(readyResult.ok).toBe(true);
    if (readyResult.ok) {
      expect(readyResult.partition.logicalReady).toEqual(["dev-a", "dev-b"]);
      expect(readyResult.partition.dispatchable).toEqual(["dev-a", "dev-b"]);
    }
  });
});

describe("partitionFrontier — UNKNOWN never satisfies (required test 5)", () => {
  it("keeps a node visibly blocked as UNKNOWN", () => {
    const graph = mustValidate(pairSnapshot);
    const result = partitionFrontier(graph, {
      hardEdgeFacts: [{ edgeKey: "dev-ab", state: "UNKNOWN" }],
      nodeAvailabilityFacts: devAllAvailable(pairSnapshot),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.partition.logicalReady).toEqual(["dev-a"]);
      expect(result.partition.blocked[0]!.reasons[0]!.code).toBe(
        "HARD_DEPENDENCY_UNKNOWN",
      );
    }
  });
});

describe("partitionFrontier — ADVISORY never blocks (required test 6)", () => {
  it("treats an advisory edge as non-blocking", () => {
    const snapshot = devSnapshot(
      [devNode("dev-a"), devNode("dev-b")],
      [
        devHardEdge("dev-ab", "dev-a", "dev-b"),
        devAdvisoryEdge("dev-adv", "dev-b", "dev-a"),
      ],
      "dev-b",
    );
    const graph = mustValidate(snapshot);
    const result = partitionFrontier(graph, {
      // Only the HARD edge carries a fact; the advisory edge carries none.
      hardEdgeFacts: [{ edgeKey: "dev-ab", state: "SATISFIED" }],
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // dev-a has an advisory in-edge but is still logically ready.
      expect(result.partition.logicalReady).toEqual(["dev-a", "dev-b"]);
    }
  });
});

describe("partitionFrontier — three distinct readiness layers", () => {
  it("nests dispatchable ⊆ admissionReady ⊆ logicalReady without collapsing", () => {
    const graph = mustValidate(pairSnapshot);
    const result = partitionFrontier(graph, {
      hardEdgeFacts: [{ edgeKey: "dev-ab", state: "SATISFIED" }],
      nodeAvailabilityFacts: [
        { nodeKey: "dev-a", admissionEligible: true, dispatchAvailable: false },
        { nodeKey: "dev-b", admissionEligible: false, dispatchAvailable: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.partition.logicalReady).toEqual(["dev-a", "dev-b"]);
      expect(result.partition.admissionReady).toEqual(["dev-a"]);
      expect(result.partition.dispatchable).toEqual([]);
    }
  });
});

describe("partitionFrontier — fail closed on incomplete facts", () => {
  it("rejects a missing HARD edge fact", () => {
    const graph = mustValidate(pairSnapshot);
    const result = partitionFrontier(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: devAllAvailable(pairSnapshot),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain(
        "FRONTIER_EDGE_FACT_MISSING",
      );
    }
  });

  it("rejects a missing node availability fact", () => {
    const graph = mustValidate(pairSnapshot);
    const result = partitionFrontier(graph, {
      hardEdgeFacts: [{ edgeKey: "dev-ab", state: "SATISFIED" }],
      nodeAvailabilityFacts: [
        { nodeKey: "dev-a", admissionEligible: true, dispatchAvailable: true },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain(
        "FRONTIER_NODE_FACT_MISSING",
      );
    }
  });
});

describe("removing a supplied HARD edge changes facts (required test 13)", () => {
  it("does not manufacture the missing dependency", () => {
    // Full graph: dev-a -> dev-b -> dev-c and a redundant dev-a -> dev-c.
    const full = devSnapshot(
      [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")],
      [
        devHardEdge("dev-ab", "dev-a", "dev-b"),
        devHardEdge("dev-bc", "dev-b", "dev-c"),
        devHardEdge("dev-ac", "dev-a", "dev-c"),
      ],
      "dev-c",
    );
    const fullGraph = mustValidate(full);
    const fullFrontier = partitionFrontier(fullGraph, {
      hardEdgeFacts: [
        { edgeKey: "dev-ab", state: "SATISFIED" },
        { edgeKey: "dev-bc", state: "SATISFIED" },
        { edgeKey: "dev-ac", state: "UNSATISFIED" },
      ],
      nodeAvailabilityFacts: devAllAvailable(full),
    });
    expect(fullFrontier.ok).toBe(true);
    if (fullFrontier.ok) {
      // dev-c is blocked because its supplied dev-ac edge is UNSATISFIED.
      expect(fullFrontier.partition.blocked.map((b) => b.nodeKey)).toEqual([
        "dev-c",
      ]);
    }

    // Remove the genuinely supplied dev-ac edge. dev-c now depends only on dev-bc.
    const reduced = devSnapshot(
      [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")],
      [
        devHardEdge("dev-ab", "dev-a", "dev-b"),
        devHardEdge("dev-bc", "dev-b", "dev-c"),
      ],
      "dev-c",
    );
    const reducedGraph = mustValidate(reduced);
    const reducedFrontier = partitionFrontier(reducedGraph, {
      hardEdgeFacts: [
        { edgeKey: "dev-ab", state: "SATISFIED" },
        { edgeKey: "dev-bc", state: "SATISFIED" },
      ],
      nodeAvailabilityFacts: devAllAvailable(reduced),
    });
    expect(reducedFrontier.ok).toBe(true);
    if (reducedFrontier.ok) {
      // Readiness changed: dev-c is now logically ready; the kernel never
      // re-invents the removed dev-ac dependency.
      expect(reducedFrontier.partition.logicalReady).toEqual([
        "dev-a",
        "dev-b",
        "dev-c",
      ]);
      expect(reducedFrontier.partition.blocked).toEqual([]);
    }
  });
});
