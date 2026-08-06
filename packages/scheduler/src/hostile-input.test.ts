import { describe, expect, it } from "vitest";

import { partitionFrontier } from "./frontier.js";
import type { FrontierCursor, GraphSnapshot, ValidatedGraph } from "./graph-model.js";
import { devNode, devSnapshot } from "./test-fixtures.js";
import { validateGraphSnapshot } from "./validate-graph.js";

function oneNodeGraph(): ValidatedGraph {
  const result = validateGraphSnapshot(
    devSnapshot([devNode("dev-done")], [], "dev-done"),
  );
  if (!result.ok) {
    throw new Error("fixture graph did not validate");
  }
  return result.graph;
}

describe("hostile graph input", () => {
  it("rejects unknown snapshot, node, and edge fields", () => {
    const extraSnapshot = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [],
      nodes: [devNode("dev-done")],
      typo: true,
    });
    expect(extraSnapshot.ok).toBe(false);

    const extraNode = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [],
      nodes: [{ executionBearing: true, nodeKey: "dev-done", typo: true }],
    });
    expect(extraNode.ok).toBe(false);

    const extraEdge = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [{
        consumerNodeKey: "dev-done",
        edgeKey: "dev-a-done",
        kind: "HARD",
        producerNodeKey: "dev-a",
        typo: true,
      }],
      nodes: [devNode("dev-a"), devNode("dev-done")],
    });
    expect(extraEdge.ok).toBe(false);
  });

  it("rejects oversized identifiers before canonical identity amplification", () => {
    const oversized = `dev-${"x".repeat(256 * 1024)}`;
    const result = validateGraphSnapshot({
      completionNodeKey: oversized,
      edges: [],
      nodes: [{ executionBearing: true, nodeKey: oversized }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        "GRAPH_MALFORMED_SNAPSHOT",
      );
    }
  });

  it("rejects keys that cannot safely cross canonical JSON and text boundaries", () => {
    for (const invalidKey of [
      "dev-\ud800",
      "dev-\0done",
      "dev-\u0085done",
      "dev-\u200bdone",
      "dev-\u2028done",
      "dev-\u202edone",
      "dev-\u2067done",
      "dev-\ufeffdone",
    ]) {
      const result = validateGraphSnapshot({
        completionNodeKey: invalidKey,
        edges: [],
        nodes: [{ executionBearing: true, nodeKey: invalidKey }],
      });
      expect(result.ok).toBe(false);
    }
  });

  it("accepts opaque ASCII machine identifiers without treating them as labels", () => {
    const key = "goal_1/node:task@rev+2~x";
    const result = validateGraphSnapshot({
      completionNodeKey: key,
      edges: [],
      nodes: [{ executionBearing: true, nodeKey: key }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(partitionFrontier(result.graph, {
        hardEdgeFacts: [],
        nodeAvailabilityFacts: [{
          admissionEligible: true,
          dispatchAvailable: true,
          nodeKey: key,
        }],
      }).ok).toBe(true);
    }
  });

  it("rejects expando and symbol properties on graph collection arrays", () => {
    const nodes = [devNode("dev-done")];
    Object.defineProperty(nodes, "typo", { value: true });
    expect(validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [],
      nodes,
    }).ok).toBe(false);

    const edges: unknown[] = [];
    Object.defineProperty(edges, Symbol("hidden"), { value: true });
    expect(validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges,
      nodes: [devNode("dev-done")],
    }).ok).toBe(false);
  });

  it("turns throwing snapshot and node accessors into fail-closed issues", () => {
    const snapshot = { completionNodeKey: "dev-done", edges: [] } as Record<
      string,
      unknown
    >;
    Object.defineProperty(snapshot, "nodes", {
      get() {
        throw new Error("hostile snapshot getter");
      },
    });
    expect(() => validateGraphSnapshot(snapshot as unknown as GraphSnapshot)).not.toThrow();
    expect(validateGraphSnapshot(snapshot as unknown as GraphSnapshot).ok).toBe(false);

    const node = { executionBearing: true } as Record<string, unknown>;
    Object.defineProperty(node, "nodeKey", {
      get() {
        throw new Error("hostile node getter");
      },
    });
    const nodeResult = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [],
      nodes: [node],
    } as unknown as GraphSnapshot);
    expect(nodeResult.ok).toBe(false);
    if (!nodeResult.ok) {
      expect(nodeResult.issues.map((issue) => issue.code)).toContain(
        "GRAPH_MALFORMED_NODE",
      );
    }
  });

  it("rejects edge accessors without invoking them", () => {
    let kindReads = 0;
    const edge = {
      consumerNodeKey: "dev-done",
      edgeKey: "dev-a-done",
      producerNodeKey: "dev-a",
    } as Record<string, unknown>;
    Object.defineProperty(edge, "kind", {
      get() {
        kindReads += 1;
        return kindReads === 1 ? "HARD" : "BOGUS";
      },
    });
    const result = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [edge],
      nodes: [devNode("dev-a"), devNode("dev-done")],
    } as unknown as GraphSnapshot);
    expect(result.ok).toBe(false);
    expect(kindReads).toBe(0);
  });

  it("rejects proxies, revoked values, inherited slots, and inherited records", () => {
    const lengthProxy = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("hostile length");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const lengthResult = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [],
      nodes: lengthProxy,
    });
    expect(lengthResult.ok).toBe(false);

    const revokedPolicy = Proxy.revocable({}, {});
    revokedPolicy.revoke();
    expect(() =>
      validateGraphSnapshot(
        devSnapshot([devNode("dev-done")], [], "dev-done"),
        revokedPolicy.proxy,
      )
    ).not.toThrow();

    const inheritedNodes: unknown[] = [];
    inheritedNodes.length = 1;
    Object.setPrototypeOf(inheritedNodes, { 0: devNode("dev-done") });
    const inheritedArrayResult = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [],
      nodes: inheritedNodes,
    });
    expect(inheritedArrayResult.ok).toBe(false);

    const inheritedNode = Object.create({
      executionBearing: true,
      nodeKey: "dev-done",
    }) as unknown;
    const inheritedRecordResult = validateGraphSnapshot({
      completionNodeKey: "dev-done",
      edges: [],
      nodes: [inheritedNode],
    });
    expect(inheritedRecordResult.ok).toBe(false);
  });
});

describe("hostile frontier input", () => {
  it("rejects unknown cursor and fact fields", () => {
    const graph = oneNodeGraph();
    const extraCursor = partitionFrontier(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: [
        { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-done" },
      ],
      typo: true,
    });
    expect(extraCursor.ok).toBe(false);

    const extraNodeFact = partitionFrontier(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: [{
        admissionEligible: true,
        dispatchAvailable: true,
        nodeKey: "dev-done",
        typo: true,
      }],
    });
    expect(extraNodeFact.ok).toBe(false);

    const edgeSnapshot = devSnapshot(
      [devNode("dev-a"), devNode("dev-done")],
      [{
        consumerNodeKey: "dev-done",
        edgeKey: "dev-a-done",
        kind: "HARD",
        producerNodeKey: "dev-a",
      }],
      "dev-done",
    );
    const edgeValidation = validateGraphSnapshot(edgeSnapshot);
    if (!edgeValidation.ok) {
      throw new Error("fixture graph did not validate");
    }
    const extraEdgeFact = partitionFrontier(edgeValidation.graph, {
      hardEdgeFacts: [{ edgeKey: "dev-a-done", state: "SATISFIED", typo: true }],
      nodeAvailabilityFacts: [
        { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-a" },
        { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-done" },
      ],
    });
    expect(extraEdgeFact.ok).toBe(false);
  });

  it("rejects unsafe keys and expando properties in frontier collections", () => {
    const graph = oneNodeGraph();
    const nodeAvailabilityFacts = [
      { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-done" },
    ];
    Object.defineProperty(nodeAvailabilityFacts, "typo", { value: true });
    expect(partitionFrontier(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts,
    }).ok).toBe(false);

    const unsafeNodeResult = partitionFrontier(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: [{
        admissionEligible: true,
        dispatchAvailable: true,
        nodeKey: "dev-\u202edone",
      }],
    });
    expect(unsafeNodeResult.ok).toBe(false);

    const edgeValidation = validateGraphSnapshot(devSnapshot(
      [devNode("dev-a"), devNode("dev-done")],
      [{
        consumerNodeKey: "dev-done",
        edgeKey: "dev-a-done",
        kind: "HARD",
        producerNodeKey: "dev-a",
      }],
      "dev-done",
    ));
    if (!edgeValidation.ok) {
      throw new Error("fixture graph did not validate");
    }
    const hardEdgeFacts = [{ edgeKey: "dev-a-done", state: "SATISFIED" }];
    Object.defineProperty(hardEdgeFacts, Symbol("hidden"), { value: true });
    expect(partitionFrontier(edgeValidation.graph, {
      hardEdgeFacts,
      nodeAvailabilityFacts: [
        { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-a" },
        { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-done" },
      ],
    }).ok).toBe(false);

    expect(partitionFrontier(edgeValidation.graph, {
      hardEdgeFacts: [{ edgeKey: "dev-\u200ba-done", state: "SATISFIED" }],
      nodeAvailabilityFacts: [
        { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-a" },
        { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-done" },
      ],
    }).ok).toBe(false);
  });

  it("turns throwing cursor and fact accessors into fail-closed issues", () => {
    const graph = oneNodeGraph();
    const cursor = { nodeAvailabilityFacts: [] } as Record<string, unknown>;
    Object.defineProperty(cursor, "hardEdgeFacts", {
      get() {
        throw new Error("hostile cursor getter");
      },
    });
    expect(() => partitionFrontier(graph, cursor as unknown as FrontierCursor)).not.toThrow();
    expect(partitionFrontier(graph, cursor as unknown as FrontierCursor).ok).toBe(false);

    const fact = {
      admissionEligible: true,
      dispatchAvailable: true,
    } as Record<string, unknown>;
    Object.defineProperty(fact, "nodeKey", {
      get() {
        throw new Error("hostile fact getter");
      },
    });
    const factResult = partitionFrontier(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: [fact],
    } as unknown as FrontierCursor);
    expect(factResult.ok).toBe(false);
    if (!factResult.ok) {
      expect(factResult.issues.map((issue) => issue.code)).toContain(
        "FRONTIER_MALFORMED_CURSOR",
      );
    }
  });

  it("rejects satisfaction accessors without invoking them", () => {
    const snapshot = devSnapshot(
      [devNode("dev-a"), devNode("dev-done")],
      [{
        consumerNodeKey: "dev-done",
        edgeKey: "dev-a-done",
        kind: "HARD",
        producerNodeKey: "dev-a",
      }],
      "dev-done",
    );
    const validated = validateGraphSnapshot(snapshot);
    if (!validated.ok) {
      throw new Error("fixture graph did not validate");
    }
    let stateReads = 0;
    const edgeFact = { edgeKey: "dev-a-done" } as Record<string, unknown>;
    Object.defineProperty(edgeFact, "state", {
      get() {
        stateReads += 1;
        return stateReads === 1 ? "SATISFIED" : "BOGUS";
      },
    });
    const result = partitionFrontier(validated.graph, {
      hardEdgeFacts: [edgeFact],
      nodeAvailabilityFacts: [
        { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-a" },
        { admissionEligible: true, dispatchAvailable: true, nodeKey: "dev-done" },
      ],
    } as unknown as FrontierCursor);
    expect(result.ok).toBe(false);
    expect(stateReads).toBe(0);
  });

  it("rejects proxied and inherited frontier containers", () => {
    const graph = oneNodeGraph();
    const factArrayProxy = new Proxy([], {});
    const proxyResult = partitionFrontier(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: factArrayProxy,
    });
    expect(proxyResult.ok).toBe(false);

    const inheritedFacts: unknown[] = [];
    inheritedFacts.length = 1;
    Object.setPrototypeOf(inheritedFacts, {
      0: {
        admissionEligible: true,
        dispatchAvailable: true,
        nodeKey: "dev-done",
      },
    });
    const inheritedResult = partitionFrontier(graph, {
      hardEdgeFacts: [],
      nodeAvailabilityFacts: inheritedFacts,
    });
    expect(inheritedResult.ok).toBe(false);
  });
});
