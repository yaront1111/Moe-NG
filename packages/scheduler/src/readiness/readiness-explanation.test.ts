/**
 * RED-first contract for design 8.2's explanation vocabulary (DoD 2).
 *
 * The explanation layer EXPLAINS a decision the projection already made. It
 * must never recompute readiness: a second derivation could disagree with the
 * first and both would look correct in isolation.
 */
import { describe, expect, it } from "vitest";

import { explainReadiness } from "./readiness-explanation.js";
import { projectReadiness } from "./readiness-projection.js";
import { LEGAL_CHOICES } from "./readiness-model.js";
import type { ValidatedGraph } from "../graph-model.js";
import {
  DEV_ADVISORY,
  DEV_CAPABILITY,
  DEV_CONSUMER,
  DEV_DONE,
  DEV_FREE,
  DEV_PRODUCER,
  DEV_READY,
  DEV_RESOURCE,
  devBundle,
  devBundlesWith,
  devChainGraph,
  devChainInput,
  devFact,
  devFactsWith,
  devGraph,
  devInput,
  devWait,
} from "./test-fixtures.js";

function explain(input: unknown = devInput(), graph: ValidatedGraph = devGraph()) {
  const projected = projectReadiness(graph, input);
  expect(projected.ok).toBe(true);
  if (!projected.ok) {
    throw new Error("unreachable");
  }
  return {
    projection: projected.projection,
    report: explainReadiness(graph, projected.projection),
  };
}

function classOf(input: unknown, nodeKey: string): string {
  const entry = explain(input).report.entries.find((item) => item.nodeKey === nodeKey);
  expect(entry, `node ${nodeKey} must be explained`).toBeDefined();
  return entry!.readinessClass;
}

/** All-true facts with `code` confirmed false; `recoveryRef` controls the producer arm. */
function blockedOn(code: string, recoveryRef: string | null = `recovery:${code}`) {
  return devBundle(
    DEV_CAPABILITY,
    devFactsWith(code, devFact(code, "CONFIRMED_FALSE", { recoveryRef })),
  );
}

describe("READY_NOW is reachable only by a dispatchable node", () => {
  it("classifies the dispatchable node READY_NOW and no one else", () => {
    const { projection, report } = explain();
    const readyNow = report.entries
      .filter((entry) => entry.readinessClass === "READY_NOW")
      .map((entry) => entry.nodeKey);
    expect(readyNow).toEqual([DEV_READY]);
    expect([...projection.dispatchable]).toEqual([DEV_READY]);
  });

  it.each([
    ["a confirmed-false admission fact", devInput({ nodeFacts: devBundlesWith(DEV_CAPABILITY, blockedOn("READINESS_CAPABILITY")) })],
    ["an unknown fact", devInput({ nodeFacts: devBundlesWith(DEV_CAPABILITY, devBundle(DEV_CAPABILITY, devFactsWith("READINESS_CONTEXT", null))) })],
    ["a current wait record", devInput({ nodeFacts: devBundlesWith(DEV_CAPABILITY, devBundle(DEV_CAPABILITY, undefined, { wait: devWait() })) })],
    ["a blocked hard dependency", devInput()],
  ])("never lets a non-dispatchable node reach READY_NOW with %s", (_label, input) => {
    const { projection, report } = explain(input);
    for (const entry of report.entries) {
      if (entry.readinessClass === "READY_NOW") {
        expect(projection.dispatchable).toContain(entry.nodeKey);
      }
    }
    const notDispatchable = report.entries.filter(
      (entry) => !projection.dispatchable.includes(entry.nodeKey),
    );
    expect(notDispatchable.every((entry) => entry.readinessClass !== "READY_NOW")).toBe(true);
  });
});

describe("UNBLOCK_NEXT needs BOTH arms of its conjunction", () => {
  it("classifies exactly one remaining confirmation with a known producer as UNBLOCK_NEXT", () => {
    const input = devInput({
      nodeFacts: devBundlesWith(DEV_CAPABILITY, blockedOn("READINESS_CAPABILITY")),
    });
    const entry = explain(input).report.entries.find((item) => item.nodeKey === DEV_CAPABILITY);
    expect(entry!.readinessClass).toBe("UNBLOCK_NEXT");
    expect(entry!.remainingCount).toBe(1);
  });

  it("refuses UNBLOCK_NEXT when exactly one remains but its producer is unknown", () => {
    const input = devInput({
      nodeFacts: devBundlesWith(DEV_CAPABILITY, blockedOn("READINESS_CAPABILITY", null)),
    });
    expect(classOf(input, DEV_CAPABILITY)).toBe("UNSAFE_OR_UNKNOWN");
  });

  it("refuses UNBLOCK_NEXT when two remain even though both producers are known", () => {
    const twoRemaining = devBundle(
      DEV_CAPABILITY,
      [
        ...devFactsWith("READINESS_CAPABILITY", devFact("READINESS_CAPABILITY", "CONFIRMED_FALSE"))
          .filter((entry) => entry["code"] !== "READINESS_CONTEXT"),
        devFact("READINESS_CONTEXT", "CONFIRMED_FALSE"),
      ],
    );
    const input = devInput({ nodeFacts: devBundlesWith(DEV_CAPABILITY, twoRemaining) });
    const entry = explain(input).report.entries.find((item) => item.nodeKey === DEV_CAPABILITY);
    expect(entry!.readinessClass).toBe("UNSAFE_OR_UNKNOWN");
    expect(entry!.remainingCount).toBe(2);
    expect(entry!.reasons.map((reason) => reason.code).sort()).toEqual([
      "READINESS_CAPABILITY",
      "READINESS_CONTEXT",
    ]);
    expect(entry!.reasons.every((reason) => reason.recoveryRef !== null)).toBe(true);
  });
});

describe("INTENTIONAL_WAIT requires a CURRENT wait record", () => {
  it("classifies a node with a current wait record as INTENTIONAL_WAIT", () => {
    const bundle = devBundle(DEV_CAPABILITY, undefined, { wait: devWait() });
    expect(classOf(devInput({ nodeFacts: devBundlesWith(DEV_CAPABILITY, bundle) }), DEV_CAPABILITY))
      .toBe("INTENTIONAL_WAIT");
  });

  it("does not grant INTENTIONAL_WAIT on an expired wait record", () => {
    const expired = devBundle(
      DEV_CAPABILITY,
      devFactsWith("READINESS_CAPABILITY", devFact("READINESS_CAPABILITY", "CONFIRMED_FALSE")),
      { wait: devWait("MATERIALIZATION_SEAL", "MATERIALIZATION_SEAL") },
    );
    expect(classOf(devInput({ nodeFacts: devBundlesWith(DEV_CAPABILITY, expired) }), DEV_CAPABILITY))
      .toBe("UNBLOCK_NEXT");
  });
});

describe("UNSAFE_OR_UNKNOWN absorbs unresolvable truth", () => {
  it.each([
    ["a missing fact", devFactsWith("READINESS_CONTEXT", null)],
    ["a stale fact", devFactsWith(
      "READINESS_CONTEXT",
      devFact("READINESS_CONTEXT", "CONFIRMED_TRUE", { horizonGate: "MATERIALIZATION_SEAL" }),
    )],
    ["an incompatible fact", devFactsWith(
      "READINESS_CONTEXT",
      devFact("READINESS_CONTEXT", "PROBABLY"),
    )],
  ])("classifies %s as UNSAFE_OR_UNKNOWN", (_label, facts) => {
    const input = devInput({
      nodeFacts: devBundlesWith(DEV_CAPABILITY, devBundle(DEV_CAPABILITY, facts)),
    });
    expect(classOf(input, DEV_CAPABILITY)).toBe("UNSAFE_OR_UNKNOWN");
  });

  it("gives an advisory node no execution authority and no READY_NOW", () => {
    expect(classOf(devInput(), DEV_ADVISORY)).toBe("UNSAFE_OR_UNKNOWN");
  });
});

describe("ordering: UI optimism cannot place a node nearer to ready", () => {
  it("sorts every one-step item ahead of a multi-predicate node", () => {
    const { report } = explain();
    const order = report.entries.map((entry) => entry.nodeKey);
    expect(order).toEqual([DEV_READY, DEV_CAPABILITY, DEV_RESOURCE, DEV_ADVISORY, DEV_DONE]);
    const oneStep = report.entries.filter((entry) => entry.readinessClass === "UNBLOCK_NEXT");
    expect(oneStep.map((entry) => entry.nodeKey)).toEqual([DEV_CAPABILITY, DEV_RESOURCE]);
    expect(order.indexOf(DEV_DONE)).toBeGreaterThan(order.indexOf(DEV_RESOURCE));
  });

  it("never orders an UNSAFE_OR_UNKNOWN node nearer to ready than a one-step node", () => {
    const input = devInput({
      nodeFacts: devBundlesWith(
        DEV_READY,
        devBundle(DEV_READY, devFactsWith("READINESS_CONTEXT", null)),
      ),
    });
    const { report } = explain(input);
    const order = report.entries.map((entry) => entry.nodeKey);
    expect(classOf(input, DEV_READY)).toBe("UNSAFE_OR_UNKNOWN");
    for (const entry of report.entries) {
      if (entry.readinessClass === "UNBLOCK_NEXT") {
        expect(order.indexOf(entry.nodeKey)).toBeLessThan(order.indexOf(DEV_READY));
      }
    }
  });
});

describe("every blocked or idle node exposes typed reasons and provenance", () => {
  it("names the source ref, version and digest of the fact that refused", () => {
    const { report } = explain();
    const entry = report.entries.find((item) => item.nodeKey === DEV_CAPABILITY);
    expect(entry!.reasons).toHaveLength(1);
    expect(entry!.reasons[0]!.code).toBe("READINESS_CAPABILITY");
    expect(entry!.reasons[0]!.layer).toBe("ADMISSION");
    expect(entry!.reasons[0]!.provenance).toEqual({
      sourceFactRef: "fact:READINESS_CAPABILITY",
      sourceFactVersion: 3,
      sourceFactDigest: "a".repeat(64),
    });
  });

  it("leaves no blocked or idle node without a reason", () => {
    const { projection, report } = explain();
    for (const entry of report.entries) {
      if (!projection.dispatchable.includes(entry.nodeKey)) {
        expect(entry.reasons.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("a failed predecessor names contract, descendants and legal choices", () => {
  it("names the exact failed contract, the affected descendants and the legal choices", () => {
    const { report } = explain(devChainInput(), devChainGraph());
    const consumer = report.entries.find((entry) => entry.nodeKey === DEV_CONSUMER);
    expect(consumer!.failedContracts).toEqual([
      { edgeKey: "dev-edge-produce", producerNodeKey: DEV_PRODUCER },
    ]);
    expect([...consumer!.affectedDescendants]).toEqual([DEV_DONE]);
    expect([...consumer!.legalChoices]).toEqual([...LEGAL_CHOICES]);
    expect(consumer!.readinessClass).toBe("UNBLOCK_NEXT");
  });

  it("keeps unrelated work eligible", () => {
    const { projection, report } = explain(devChainInput(), devChainGraph());
    const readyNow = report.entries
      .filter((entry) => entry.readinessClass === "READY_NOW")
      .map((entry) => entry.nodeKey);
    expect(readyNow).toEqual([DEV_FREE, DEV_PRODUCER]);
    expect([...projection.dispatchable]).toEqual([DEV_FREE, DEV_PRODUCER]);
    for (const key of readyNow) {
      const entry = report.entries.find((item) => item.nodeKey === key);
      expect(entry!.failedContracts).toEqual([]);
      expect(entry!.legalChoices).toEqual([]);
    }
  });
});

describe("the explanation layer decides nothing", () => {
  it("returns frozen entries whose reasons are the projection's own", () => {
    const { projection, report } = explain();
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.entries)).toBe(true);
    const done = report.entries.find((entry) => entry.nodeKey === DEV_DONE);
    expect(Object.isFrozen(done!.reasons)).toBe(true);
    const projected = projection.nodes.find((entry) => entry.nodeKey === DEV_DONE);
    expect(done!.reasons).toEqual(projected!.reasons);
  });

  it("refuses to explain a projection computed over a different graph", () => {
    const other = explain(devChainInput(), devChainGraph()).projection;
    expect(() => explainReadiness(devGraph(), other)).toThrowError(
      /FRONTIER_GRAPH_IDENTITY_MISMATCH/u,
    );
  });

  it("refuses a graph this runtime did not validate", () => {
    const { projection } = explain();
    const forged = {
      completionNodeKey: DEV_READY,
      edges: [],
      graphIdentity: projection.graphIdentity,
      nodes: [],
    } as unknown as ValidatedGraph;
    expect(() => explainReadiness(forged, projection)).toThrowError(
      /GRAPH_VALIDATION_PROVENANCE_INVALID/u,
    );
  });

  it("explains every projected node exactly once", () => {
    const { projection, report } = explain();
    expect(report.entries).toHaveLength(projection.nodes.length);
    expect(new Set(report.entries.map((entry) => entry.nodeKey)).size).toBe(projection.nodes.length);
    expect(report.graphIdentity).toBe(projection.graphIdentity);
  });
});
