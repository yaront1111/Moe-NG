import { describe, expect, it } from "vitest";

import { analyzeGraphStructure } from "./analyze-graph.js";
import { partitionFrontier } from "./frontier.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import {
  DEFAULT_MAX_TOTAL_EDGES,
} from "./graph-policy.js";
import type {
  GraphEdge,
  GraphIssueCode,
  GraphSnapshot,
  ValidatedGraph,
} from "./graph-model.js";
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

function codesOf(issues: readonly { readonly code: GraphIssueCode }[]): string[] {
  return issues.map((i) => i.code);
}

// --- BLOCKER 1: non-execution nodes never receive execution authority ---
describe("BLOCKER 1 — non-execution nodes are excluded from the frontier", () => {
  const snapshot = devSnapshot(
    [
      devNode("dev-work", true),
      devNode("dev-done", true),
      devNode("dev-note", false), // advisory/organizational, no execution authority
    ],
    [
      devHardEdge("dev-wd", "dev-work", "dev-done"),
      devAdvisoryEdge("dev-nd", "dev-note", "dev-done"),
    ],
    "dev-done",
  );

  it("keeps a non-executable root out of logicalReady / admissionReady / dispatchable", () => {
    const graph = mustValidate(snapshot);
    const result = partitionFrontier(graph, {
      hardEdgeFacts: [{ edgeKey: "dev-wd", state: "UNSATISFIED" }],
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // dev-note has no incoming HARD dep but is non-executable — must not appear.
      expect(result.partition.logicalReady).not.toContain("dev-note");
      expect(result.partition.admissionReady).not.toContain("dev-note");
      expect(result.partition.dispatchable).not.toContain("dev-note");
      expect(result.partition.blocked.map((b) => b.nodeKey)).not.toContain(
        "dev-note",
      );
      // Only the executable root dev-work is ready.
      expect(result.partition.logicalReady).toEqual(["dev-work"]);
    }
  });

  it("counts only executable nodes in readyWidth", () => {
    const graph = mustValidate(snapshot);
    const frontier = partitionFrontier(graph, {
      hardEdgeFacts: [{ edgeKey: "dev-wd", state: "SATISFIED" }],
      nodeAvailabilityFacts: devAllAvailable(snapshot),
    });
    expect(frontier.ok).toBe(true);
    if (frontier.ok) {
      const analysis = analyzeGraphStructure(graph, frontier.partition);
      // dev-work + dev-done are executable and ready; dev-note excluded.
      expect(analysis.readyWidth).toBe(2);
    }
  });
});

// --- MAJOR 2: graph identity binds cursor/partition to their graph ---
describe("MAJOR 2 — frontier partition is bound to its graph identity", () => {
  const graphA = devSnapshot(
    [devNode("dev-a"), devNode("dev-b")],
    [devHardEdge("dev-ab", "dev-a", "dev-b")],
    "dev-b",
  );
  const graphB = devSnapshot(
    [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")],
    [
      devHardEdge("dev-ab", "dev-a", "dev-b"),
      devHardEdge("dev-bc", "dev-b", "dev-c"),
    ],
    "dev-c",
  );

  it("rejects analysing graph A with graph B's frontier partition", () => {
    const validA = mustValidate(graphA);
    const validB = mustValidate(graphB);
    const partitionB = partitionFrontier(validB, {
      hardEdgeFacts: [
        { edgeKey: "dev-ab", state: "SATISFIED" },
        { edgeKey: "dev-bc", state: "SATISFIED" },
      ],
      nodeAvailabilityFacts: devAllAvailable(graphB),
    });
    expect(partitionB.ok).toBe(true);
    if (partitionB.ok) {
      expect(() =>
        analyzeGraphStructure(validA, partitionB.partition),
      ).toThrow(/identity/i);
    }
  });

  it("distinct graphs have distinct identities; same graph is stable", () => {
    const validA = mustValidate(graphA);
    const validA2 = mustValidate(graphA);
    const validB = mustValidate(graphB);
    expect(validA.graphIdentity).toBe(validA2.graphIdentity);
    expect(validA.graphIdentity).not.toBe(validB.graphIdentity);
  });
});

// --- MAJOR 3: completion node must be a terminal HARD sink ---
describe("MAJOR 3 — completion node must be a terminal HARD sink", () => {
  it("rejects an outgoing HARD edge from the completion node", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-a"), devNode("dev-done"), devNode("dev-after")],
        [
          devHardEdge("dev-ad", "dev-a", "dev-done"),
          devHardEdge("dev-da", "dev-done", "dev-after"),
        ],
        "dev-done",
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toContain("GRAPH_COMPLETION_NOT_TERMINAL");
      const issue = result.issues.find(
        (i) => i.code === "GRAPH_COMPLETION_NOT_TERMINAL",
      )!;
      expect(issue.nodeKeys).toContain("dev-done");
      expect(issue.edgeKeys).toContain("dev-da");
    }
  });

  it("allows an outgoing ADVISORY edge from the completion node", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-a"), devNode("dev-done"), devNode("dev-note", false)],
        [
          devHardEdge("dev-ad", "dev-a", "dev-done"),
          devAdvisoryEdge("dev-dn", "dev-done", "dev-note"),
        ],
        "dev-done",
      ),
    );
    expect(result.ok).toBe(true);
  });
});

// --- MAJOR 4: total-edge cap for advisory (and all) relations ---
describe("MAJOR 4 — total-edge policy cap (provisional 64, separate from hard cap)", () => {
  function mixedEdges(total: number): GraphEdge[] {
    // node-1 is the producer for every edge into completion (dev-done); half
    // HARD, half ADVISORY, all distinct keys. All producers are execution nodes.
    const edges: GraphEdge[] = [];
    for (let i = 0; i < total; i += 1) {
      const key = `dev-e${i}`;
      edges.push(
        i % 2 === 0
          ? devHardEdge(key, `dev-p${i}`, "dev-done")
          : devAdvisoryEdge(key, `dev-p${i}`, "dev-done"),
      );
    }
    return edges;
  }
  function mixedNodes(total: number): GraphSnapshot["nodes"] {
    const nodes = [devNode("dev-done", true)];
    for (let i = 0; i < total; i += 1) {
      // Even index producers feed a HARD edge (must be executable & reach done);
      // odd producers are advisory-only, so non-executable is fine.
      nodes.push(devNode(`dev-p${i}`, i % 2 === 0));
    }
    return nodes;
  }

  it(`accepts exactly ${DEFAULT_MAX_TOTAL_EDGES} total edges`, () => {
    const total = DEFAULT_MAX_TOTAL_EDGES;
    const snapshot = devSnapshot(
      mixedNodes(total),
      mixedEdges(total),
      "dev-done",
    );
    // Keep hard-edge and node caps out of the way; only exercise total-edge cap.
    const result = validateGraphSnapshot(snapshot, {
      maxNodes: total + 1,
      maxHardEdges: total,
    });
    expect(result.ok).toBe(true);
  });

  it(`rejects ${DEFAULT_MAX_TOTAL_EDGES + 1} total edges with a stable code`, () => {
    const total = DEFAULT_MAX_TOTAL_EDGES + 1;
    const snapshot = devSnapshot(
      mixedNodes(total),
      mixedEdges(total),
      "dev-done",
    );
    const result = validateGraphSnapshot(snapshot, {
      maxNodes: total + 1,
      maxHardEdges: total,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toContain(
        "GRAPH_TOTAL_EDGE_LIMIT_EXCEEDED",
      );
    }
  });
});

// --- MINOR 5: cycle diagnostics name only actual cycle members/edges ---
describe("MINOR 5 — cycle diagnostics identify the cycle core, not downstream", () => {
  it("reports a,b and the cyclic edges, not the downstream tail", () => {
    // dev-a <-> dev-b (2-cycle), and dev-b -> dev-tail (downstream, acyclic).
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-a"), devNode("dev-b"), devNode("dev-tail")],
        [
          devHardEdge("dev-ab", "dev-a", "dev-b"),
          devHardEdge("dev-ba", "dev-b", "dev-a"),
          devHardEdge("dev-bt", "dev-b", "dev-tail"),
        ],
        "dev-tail",
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycle = result.issues.find((i) => i.code === "GRAPH_CYCLE")!;
      expect(cycle.nodeKeys).toEqual(["dev-a", "dev-b"]);
      expect(cycle.nodeKeys).not.toContain("dev-tail");
      expect([...cycle.edgeKeys].sort()).toEqual(["dev-ab", "dev-ba"]);
      expect(cycle.edgeKeys).not.toContain("dev-bt");
    }
  });

  it("reports only true SCC members for two cycles joined by an acyclic path", () => {
    // Cycle1 dev-a<->dev-b, bridge dev-b->dev-m->dev-c, cycle2 dev-c<->dev-d,
    // dev-d->dev-done. dev-m and the bridge edges are on NO cycle.
    const result = validateGraphSnapshot(
      devSnapshot(
        [
          devNode("dev-a"),
          devNode("dev-b"),
          devNode("dev-m"),
          devNode("dev-c"),
          devNode("dev-d"),
          devNode("dev-done"),
        ],
        [
          devHardEdge("dev-ab", "dev-a", "dev-b"),
          devHardEdge("dev-ba", "dev-b", "dev-a"),
          devHardEdge("dev-bm", "dev-b", "dev-m"),
          devHardEdge("dev-mc", "dev-m", "dev-c"),
          devHardEdge("dev-cd", "dev-c", "dev-d"),
          devHardEdge("dev-dc", "dev-d", "dev-c"),
          devHardEdge("dev-dd", "dev-d", "dev-done"),
        ],
        "dev-done",
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycle = result.issues.find((i) => i.code === "GRAPH_CYCLE")!;
      // Exactly the two SCCs' members — not the bridge node dev-m.
      expect(cycle.nodeKeys).toEqual(["dev-a", "dev-b", "dev-c", "dev-d"]);
      expect(cycle.nodeKeys).not.toContain("dev-m");
      // Exactly the intra-SCC edges — not the bridge edges dev-bm / dev-mc.
      expect([...cycle.edgeKeys].sort()).toEqual([
        "dev-ab",
        "dev-ba",
        "dev-cd",
        "dev-dc",
      ]);
      expect(cycle.edgeKeys).not.toContain("dev-bm");
      expect(cycle.edgeKeys).not.toContain("dev-mc");
    }
  });
});

// --- MINOR: graph identity is invariant under input reordering ---
describe("graphIdentity is invariant under node/edge input order", () => {
  it("yields the same identity for a shuffled snapshot", () => {
    const snapshot = devSnapshot(
      [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")],
      [
        devHardEdge("dev-ab", "dev-a", "dev-b"),
        devHardEdge("dev-bc", "dev-b", "dev-c"),
      ],
      "dev-c",
    );
    const forward = mustValidate(snapshot);
    const reversed = mustValidate({
      nodes: [...snapshot.nodes].reverse(),
      edges: [...snapshot.edges].reverse(),
      completionNodeKey: snapshot.completionNodeKey,
    });
    expect(reversed.graphIdentity).toBe(forward.graphIdentity);
  });
});
