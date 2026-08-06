import { describe, expect, it } from "vitest";

import { validateGraphSnapshot } from "./validate-graph.js";
import {
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

  it("rejects a HARD cycle", () => {
    const result = validateGraphSnapshot(
      devSnapshot(
        [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")],
        [
          devHardEdge("dev-ab", "dev-a", "dev-b"),
          devHardEdge("dev-bc", "dev-b", "dev-c"),
          devHardEdge("dev-ca", "dev-c", "dev-a"),
        ],
        "dev-c",
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

  it("accepts exactly the 24-node / 64-hard-edge boundary", () => {
    const nodes = chainNodes(DEFAULT_MAX_NODES);
    const edges: GraphEdge[] = [];
    // A star: node-1 fans HARD edges to the completion node (node-24). Keep
    // within 64 hard edges. Every non-completion node points at completion.
    const completion = `${DEVELOPMENT_ONLY_NODE_PREFIX}${DEFAULT_MAX_NODES}`;
    let e = 0;
    for (let i = 1; i < DEFAULT_MAX_NODES; i += 1) {
      e += 1;
      edges.push(
        devHardEdge(
          `${DEVELOPMENT_ONLY_EDGE_PREFIX}${e}`,
          `${DEVELOPMENT_ONLY_NODE_PREFIX}${i}`,
          completion,
        ),
      );
    }
    expect(edges.length).toBeLessThanOrEqual(DEFAULT_MAX_HARD_EDGES);
    const result = validateGraphSnapshot(
      devSnapshot(nodes, edges, completion),
    );
    expect(result.ok).toBe(true);
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
      expect(codesOf(result.issues)).toContain("GRAPH_MALFORMED_SNAPSHOT");
    }
  });
});
