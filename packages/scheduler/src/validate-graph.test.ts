import { describe, expect, it } from "vitest";

import { validateGraphSnapshot } from "./validate-graph.js";
import {
  ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  DEFAULT_MAX_HARD_EDGES,
  DEFAULT_MAX_NODES,
} from "./graph-policy.js";
import type { GraphEdge, GraphIssueCode, GraphNode } from "./graph-model.js";
import {
  DEVELOPMENT_ONLY_EDGE_PREFIX,
  DEVELOPMENT_ONLY_NODE_PREFIX,
  devHardEdge,
  devNode,
  devSnapshot,
} from "./test-fixtures.js";

function codesOf(issues: readonly { readonly code: GraphIssueCode }[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("validateGraphSnapshot — fail-closed rejection (required test 7)", () => {
  it("rejects a missing endpoint with no partial analysis", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-a"), devNode("dev-b")],
        [devHardEdge("dev-e", "dev-a", "dev-ghost")],
        "dev-b",
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(codesOf(result.issues)).toContain("GRAPH_MISSING_ENDPOINT");
    expect(result).not.toHaveProperty("graph");
  });

  it("rejects a self-edge", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-a")],
        [devHardEdge("dev-e", "dev-a", "dev-a")],
        "dev-a",
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toContain("GRAPH_SELF_EDGE");
    }
  });

  it("rejects duplicate node and edge identifiers", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-a"), devNode("dev-a"), devNode("dev-b")],
        [
          devHardEdge("dev-e", "dev-a", "dev-b"),
          devHardEdge("dev-e", "dev-a", "dev-b"),
        ],
        "dev-b",
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toContain("GRAPH_DUPLICATE_NODE");
      expect(codesOf(result.issues)).toContain("GRAPH_DUPLICATE_EDGE");
    }
  });

  it("rejects a HARD cycle (completion at a terminal node outside the cycle)", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-a"), devNode("dev-b"), devNode("dev-c"), devNode("dev-done")],
        [
          devHardEdge("dev-ab", "dev-a", "dev-b"),
          devHardEdge("dev-bc", "dev-b", "dev-c"),
          devHardEdge("dev-ca", "dev-c", "dev-a"),
          devHardEdge("dev-cd", "dev-c", "dev-done"),
        ],
        "dev-done",
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toEqual(["GRAPH_CYCLE"]);
    }
  });

  it("rejects malformed / sparse records without throwing", () => {
    const sparseNodes = [devNode("dev-a")] as unknown as GraphNode[];
    // Simulate a sparse array hole.
    (sparseNodes as unknown[])[2] = undefined;
    const result = validateGraphSnapshot(
      devSnapshot(sparseNodes, [], "dev-a"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toContain("GRAPH_MALFORMED_NODE");
    }
  });
});

describe("validateGraphSnapshot — completion closure (required test 8)", () => {
  it("rejects an orphan execution-bearing node", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-orphan"), devNode("dev-real"), devNode("dev-done")],
        [devHardEdge("dev-e", "dev-real", "dev-done")],
        "dev-done",
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toEqual(["COMPLETION_CLOSURE_INCOMPLETE"]);
      expect(result.issues[0]!.nodeKeys).toEqual(["dev-orphan"]);
    }
  });

  it("accepts an advisory-only node that is not required for closure only when it is non-execution", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [
          devNode("dev-real"),
          devNode("dev-done"),
          devNode("dev-note", false),
        ],
        [
          devHardEdge("dev-e", "dev-real", "dev-done"),
          {
            edgeKey: "dev-adv",
            producerNodeKey: "dev-note",
            consumerNodeKey: "dev-done",
            kind: "ADVISORY",
          },
        ],
        "dev-done",
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects when only an advisory edge connects an execution node to completion", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-real"), devNode("dev-done")],
        [
          {
            edgeKey: "dev-adv",
            producerNodeKey: "dev-real",
            consumerNodeKey: "dev-done",
            kind: "ADVISORY",
          },
        ],
        "dev-done",
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toEqual(["COMPLETION_CLOSURE_INCOMPLETE"]);
    }
  });
});

describe("validateGraphSnapshot — explicit limits (required test 9)", () => {
  function chainNodes(count: number): GraphNode[] {
    const nodes: GraphNode[] = [];
    for (let i = 1; i <= count; i += 1) {
      nodes.push(devNode(`${DEVELOPMENT_ONLY_NODE_PREFIX}${i}`));
    }
    return nodes;
  }

  const completion = `${DEVELOPMENT_ONLY_NODE_PREFIX}${DEFAULT_MAX_NODES}`;

  /**
   * Build a DAG on 24 nodes with EXACTLY `hardCount` forward HARD edges (i -> j
   * for i < j <= 24). Every node reaches the completion node (node-24 is a
   * consumer only, hence a terminal HARD sink). Requires 23 <= hardCount <= 253.
   */
  function graphWithHardEdges(hardCount: number): GraphEdge[] {
    const edges: GraphEdge[] = [];
    // First guarantee reachability: a chain 1->2->...->24 (23 edges).
    for (let i = 1; i < DEFAULT_MAX_NODES; i += 1) {
      edges.push(
        devHardEdge(
          `${DEVELOPMENT_ONLY_EDGE_PREFIX}chain-${i}`,
          `${DEVELOPMENT_ONLY_NODE_PREFIX}${i}`,
          `${DEVELOPMENT_ONLY_NODE_PREFIX}${i + 1}`,
        ),
      );
    }
    // Then add extra forward edges i -> j (j > i + 1) until the exact count.
    for (let i = 1; i <= DEFAULT_MAX_NODES && edges.length < hardCount; i += 1) {
      for (
        let j = i + 2;
        j <= DEFAULT_MAX_NODES && edges.length < hardCount;
        j += 1
      ) {
        edges.push(
          devHardEdge(
            `${DEVELOPMENT_ONLY_EDGE_PREFIX}x-${i}-${j}`,
            `${DEVELOPMENT_ONLY_NODE_PREFIX}${i}`,
            `${DEVELOPMENT_ONLY_NODE_PREFIX}${j}`,
          ),
        );
      }
    }
    return edges;
  }

  it("accepts a graph with exactly 64 HARD edges", () => {
    const edges = graphWithHardEdges(DEFAULT_MAX_HARD_EDGES);
    expect(edges.filter((e) => e.kind === "HARD")).toHaveLength(64);
    const result = validateGraphSnapshot(
      devSnapshot(chainNodes(DEFAULT_MAX_NODES), edges, completion),
      // Keep the total-edge cap out of the way; only exercise the hard cap.
      { maxTotalEdges: ABSOLUTE_MAX_GRAPH_TOTAL_EDGES },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a graph with 65 HARD edges", () => {
    const edges = graphWithHardEdges(DEFAULT_MAX_HARD_EDGES + 1);
    expect(edges.filter((e) => e.kind === "HARD")).toHaveLength(65);
    const result = validateGraphSnapshot(
      devSnapshot(chainNodes(DEFAULT_MAX_NODES), edges, completion),
      { maxTotalEdges: ABSOLUTE_MAX_GRAPH_TOTAL_EDGES },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toContain("GRAPH_HARD_EDGE_LIMIT_EXCEEDED");
    }
  });

  it("rejects one node over the limit", () => {
    const nodes = chainNodes(DEFAULT_MAX_NODES + 1);
    const completion = `${DEVELOPMENT_ONLY_NODE_PREFIX}${DEFAULT_MAX_NODES + 1}`;
    const edges: GraphEdge[] = [];
    for (let i = 1; i <= DEFAULT_MAX_NODES; i += 1) {
      edges.push(
        devHardEdge(
          `${DEVELOPMENT_ONLY_EDGE_PREFIX}${i}`,
          `${DEVELOPMENT_ONLY_NODE_PREFIX}${i}`,
          completion,
        ),
      );
    }
    const result = validateGraphSnapshot(devSnapshot(nodes, edges, completion));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toContain("GRAPH_NODE_LIMIT_EXCEEDED");
    }
  });

  it("rejects one hard edge over the limit under a small explicit policy", () => {
    const nodes = chainNodes(3);
    const edges: GraphEdge[] = [
      devHardEdge("dev-e1", "dev-node-1", "dev-node-3"),
      devHardEdge("dev-e2", "dev-node-2", "dev-node-3"),
    ];
    const result = validateGraphSnapshot(
      devSnapshot(nodes, edges, "dev-node-3"),
      { maxHardEdges: 1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toContain("GRAPH_HARD_EDGE_LIMIT_EXCEEDED");
    }
  });

  it("rejects a malformed (NaN) policy limit fail-closed", () => {
    const result = validateGraphSnapshot(
      devSnapshot([devNode("dev-a")], [], "dev-a"),
      { maxNodes: Number.NaN },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codesOf(result.issues)).toContain("GRAPH_MALFORMED_POLICY");
    }
  });
});

describe("validateGraphSnapshot — issue payload, order, and freezing characterization", () => {
  /**
   * One bounded snapshot that trips several record-local and reference-level
   * integrity findings together. It pins the exact issue objects AND their
   * canonical order, which is deliberately NOT the accumulation order: the two
   * GRAPH_MISSING_ENDPOINT findings are accumulated zghost-first and reported
   * ghost-first, so a lost sort cannot pass silently.
   */
  const multiIssueSnapshot = {
    completionNodeKey: "dev-b",
    edges: [
      { consumerNodeKey: "dev-b", edgeKey: "dev-e1", kind: "HARD", producerNodeKey: "dev-a" },
      { consumerNodeKey: "dev-b", edgeKey: "dev-e1", kind: "HARD", producerNodeKey: "dev-a" },
      { consumerNodeKey: "dev-a", edgeKey: "dev-e2", kind: "HARD", producerNodeKey: "dev-a" },
      { consumerNodeKey: "dev-b", edgeKey: "dev-e4", kind: "HARD", producerNodeKey: "dev-zghost" },
      { consumerNodeKey: "dev-b", edgeKey: "dev-e3", kind: "HARD", producerNodeKey: "dev-ghost" },
      {},
    ],
    nodes: [
      { executionBearing: true, nodeKey: "dev-a" },
      { executionBearing: true, nodeKey: "dev-a" },
      { executionBearing: true, nodeKey: "dev-b" },
    ],
  };

  it("reports the complete issue objects in canonical order", () => {
    const result = validateGraphSnapshot(multiIssueSnapshot);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual([
      {
        code: "GRAPH_DUPLICATE_EDGE",
        message: 'duplicate edgeKey "dev-e1"',
        nodeKeys: [],
        edgeKeys: ["dev-e1"],
      },
      {
        code: "GRAPH_DUPLICATE_NODE",
        message: 'duplicate nodeKey "dev-a"',
        nodeKeys: ["dev-a"],
        edgeKeys: [],
      },
      {
        code: "GRAPH_MALFORMED_EDGE",
        message: "edge at index 5 is malformed, sparse, or missing required fields",
        nodeKeys: [],
        edgeKeys: [],
      },
      {
        code: "GRAPH_MISSING_ENDPOINT",
        message: 'edge "dev-e3" references unknown node(s)',
        nodeKeys: ["dev-ghost"],
        edgeKeys: ["dev-e3"],
      },
      {
        code: "GRAPH_MISSING_ENDPOINT",
        message: 'edge "dev-e4" references unknown node(s)',
        nodeKeys: ["dev-zghost"],
        edgeKeys: ["dev-e4"],
      },
      {
        code: "GRAPH_SELF_EDGE",
        message: 'edge "dev-e2" connects node "dev-a" to itself',
        nodeKeys: ["dev-a"],
        edgeKeys: ["dev-e2"],
      },
    ]);
    expect(result).not.toHaveProperty("graph");
  });

  it("deep-freezes the failure envelope, issues array, issues, and key arrays", () => {
    const result = validateGraphSnapshot(multiIssueSnapshot);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
    for (const issue of result.issues) {
      expect(Object.isFrozen(issue)).toBe(true);
      expect(Object.isFrozen(issue.nodeKeys)).toBe(true);
      expect(Object.isFrozen(issue.edgeKeys)).toBe(true);
    }
    expect(() => {
      (result.issues as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (result.issues[0] as { code: string }).code = "mutated";
    }).toThrow();
    expect(() => {
      (result.issues[0]!.edgeKeys as unknown as unknown[]).push("dev-x");
    }).toThrow();
  });

  it("sorts the completion-terminality edge keys and skips topology entirely", () => {
    // dev-x / dev-y are execution-bearing and unreachable from completion; the
    // closure traversal must never run while an integrity issue is outstanding.
    const result = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [
        { consumerNodeKey: "dev-done", edgeKey: "dev-ad", kind: "HARD", producerNodeKey: "dev-a" },
        { consumerNodeKey: "dev-x", edgeKey: "dev-z", kind: "HARD", producerNodeKey: "dev-done" },
        { consumerNodeKey: "dev-y", edgeKey: "dev-b", kind: "HARD", producerNodeKey: "dev-done" },
      ],
      nodes: [
        { executionBearing: true, nodeKey: "dev-a" },
        { executionBearing: true, nodeKey: "dev-done" },
        { executionBearing: true, nodeKey: "dev-x" },
        { executionBearing: true, nodeKey: "dev-y" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual([
      {
        code: "GRAPH_COMPLETION_NOT_TERMINAL",
        message:
          'completion node "dev-done" has outgoing HARD edge(s); it must be a terminal HARD sink',
        nodeKeys: ["dev-done"],
        edgeKeys: ["dev-b", "dev-z"],
      },
    ]);
  });

  it("claims no endpoint or completion fact while any node record is untrustworthy", () => {
    // Node 0 is malformed, so nodeKeys is not a trustworthy declaration set:
    // neither the unknown edge endpoint nor the absent completion node may be
    // reported, or the caller would chase findings caused by the bad record.
    const result = validateGraphSnapshot({
      completionNodeKey: "dev-ghost",
      edges: [
        { consumerNodeKey: "dev-ghost", edgeKey: "dev-e", kind: "HARD", producerNodeKey: "dev-a" },
      ],
      nodes: [{}, { executionBearing: true, nodeKey: "dev-a" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual([
      {
        code: "GRAPH_MALFORMED_NODE",
        message: "node at index 0 is malformed, sparse, or missing required fields",
        nodeKeys: [],
        edgeKeys: [],
      },
    ]);
  });

  it("refuses over-limit raw slot counts before any element is inspected", () => {
    // Both collections carry malformed elements; neither may be reported,
    // because the raw-length ceilings refuse the snapshot first.
    const result = validateGraphSnapshot(
      {
        completionNodeKey: "dev-a",
        edges: [{}],
        nodes: [{ executionBearing: true, nodeKey: "dev-a" }, 99],
      },
      { maxNodes: 1, maxTotalEdges: 0 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual([
      {
        code: "GRAPH_NODE_LIMIT_EXCEEDED",
        message: "graph declares 2 node slots; policy limit is 1",
        nodeKeys: [],
        edgeKeys: [],
      },
      {
        code: "GRAPH_TOTAL_EDGE_LIMIT_EXCEEDED",
        message: "graph declares 1 total edge slots; policy limit is 0",
        nodeKeys: [],
        edgeKeys: [],
      },
    ]);
  });
});
