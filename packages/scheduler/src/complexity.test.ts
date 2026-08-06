import { describe, expect, it } from "vitest";

import { analyzeGraphStructure } from "./analyze-graph.js";
import { partitionFrontier } from "./frontier.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import { createTraversalCounter } from "./graph-model.js";
import type { GraphSnapshot, ValidatedGraph } from "./graph-model.js";
import {
  devAllAvailable,
  devChain,
  devUniformEdgeFacts,
} from "./test-fixtures.js";

function mustValidate(snapshot: GraphSnapshot): ValidatedGraph {
  const result = validateGraphSnapshot(snapshot);
  if (!result.ok) {
    throw new Error(`fixture failed validation: ${JSON.stringify(result.issues)}`);
  }
  return result.graph;
}

/** Total instrumented traversal work across validate + analyze + frontier. */
function totalTraversalWork(length: number): number {
  const snapshot = devChain(length);
  const counter = createTraversalCounter();
  const result = validateGraphSnapshot(snapshot, undefined, counter);
  if (!result.ok) {
    throw new Error("chain fixture failed validation");
  }
  const partition = partitionFrontier(
    result.graph,
    {
      hardEdgeFacts: devUniformEdgeFacts(snapshot, "SATISFIED"),
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    },
    counter,
  );
  if (!partition.ok) {
    throw new Error("chain fixture frontier failed");
  }
  analyzeGraphStructure(result.graph, partition.partition, counter);
  return counter.nodeVisits + counter.edgeVisits;
}

describe("complexity — linear traversal, no descendant rescans (required test 15)", () => {
  it("keeps instrumented work near-linear in graph size", () => {
    const n = 20;
    const work = totalTraversalWork(n);
    // A single graph has V = n nodes and E = n - 1 hard edges. Validation
    // (index + topo + closure), analysis (index + topo + three DP passes), and
    // the frontier partition each make a bounded number of single passes. A
    // naive per-node descendant rescan would be O(V*E) ~ 400*k for n=20; the
    // linear bound below (well under that) proves we do not rescan histories.
    const v = n;
    const e = n - 1;
    expect(work).toBeLessThanOrEqual(20 * (v + e));
  });

  it("scales linearly (doubling size roughly doubles, never quadruples) work", () => {
    const small = totalTraversalWork(10);
    const large = totalTraversalWork(20);
    // Linear growth ~2x; a quadratic algorithm would grow ~4x. Require < 3x to
    // exclude quadratic behavior with margin for fixed per-call overhead.
    expect(large).toBeLessThan(small * 3);
  });

  it("exposes the counter for callers to assert single-pass behavior", () => {
    const graph = mustValidate(devChain(5));
    const counter = createTraversalCounter();
    analyzeGraphStructure(graph, undefined, counter);
    expect(counter.nodeVisits).toBeGreaterThan(0);
    expect(counter.edgeVisits).toBeGreaterThan(0);
    // 5 nodes, 4 hard edges: index(5,4) + topo(5,4) + 3 DP passes(5 each,4 each).
    expect(counter.nodeVisits).toBeLessThanOrEqual(6 * 5);
    expect(counter.edgeVisits).toBeLessThanOrEqual(6 * 4);
  });
});
