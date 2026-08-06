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

describe("complexity — CORE traversal is single-pass, no descendant rescans (required test 15)", () => {
  // Scope of the claim (see TraversalCounter docs): the counter instruments ONLY
  // the core single-pass work — HARD-index build, Kahn topo, closure reverse-BFS,
  // the ancestor/descendant/stage DP, and the frontier partition. It does NOT
  // count the redundancy witness BFS, sorting, or bitset/popcount work, which are
  // NOT claimed linear — they are bounded by the node/total-edge policy caps. So
  // this proves the core path never rescans descendant histories (no O(V*E)); it
  // is not a linearity claim about the whole kernel.
  it("keeps the core instrumented work near-linear in graph size", () => {
    const n = 20;
    const work = totalTraversalWork(n);
    // A single graph has V = n nodes and E = n - 1 hard edges. A naive per-node
    // descendant rescan would be O(V*E) ~ 400*k for n=20; the linear bound below
    // (well under that) proves the core path does not rescan histories.
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
