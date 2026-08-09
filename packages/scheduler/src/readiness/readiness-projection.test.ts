/**
 * RED-first contract for the three-layer projection.
 *
 * THE CENTRAL TENSION: graph-model.ts:252-260 tells the caller to withhold the
 * ENTIRE frontier partition when either availability value is unknown for any
 * node, so analysis widths stay UNKNOWN. DoD 3 forbids unknown facts from
 * hiding structurally ready work. Both hold at once only because logicalReady
 * is a function of hard-edge satisfaction ALONE — frontier.ts:388 pushes a node
 * into logicalReady before it ever consults an availability boolean — so
 * withholding the partition withholds the admission and dispatch layers only.
 */
import { describe, expect, it } from "vitest";

import { projectReadiness } from "./readiness-projection.js";
import {
  DEV_ADVISORY,
  DEV_CAPABILITY,
  DEV_DONE,
  DEV_READY,
  DEV_RESOURCE,
  devBundle,
  devBundles,
  devBundlesWith,
  devEdgeFacts,
  devFactsWith,
  devGraph,
  devInput,
} from "./test-fixtures.js";

function project(input: unknown = devInput()) {
  const result = projectReadiness(devGraph(), input);
  expect(result.ok, JSON.stringify("issues" in result ? result.issues : [])).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result.projection;
}

function nodeOf(projection: ReturnType<typeof project>, nodeKey: string) {
  const found = projection.nodes.find((entry) => entry.nodeKey === nodeKey);
  expect(found, `node ${nodeKey} must be projected`).toBeDefined();
  return found!;
}

describe("three layers never collapse", () => {
  it("reports three layers that genuinely differ, as proper subsets", () => {
    const projection = project();
    expect([...projection.logicalReady]).toEqual([DEV_CAPABILITY, DEV_READY, DEV_RESOURCE]);
    expect([...projection.admissionReady]).toEqual([DEV_READY, DEV_RESOURCE]);
    expect([...projection.dispatchable]).toEqual([DEV_READY]);
    for (const key of projection.dispatchable) {
      expect(projection.admissionReady).toContain(key);
    }
    for (const key of projection.admissionReady) {
      expect(projection.logicalReady).toContain(key);
    }
    expect(projection.dispatchable.length).toBeLessThan(projection.admissionReady.length);
    expect(projection.admissionReady.length).toBeLessThan(projection.logicalReady.length);
  });

  it("agrees with partitionFrontier's own three sets when nothing is unknown", () => {
    const projection = project();
    expect(projection.partition).not.toBeNull();
    expect([...projection.partition!.logicalReady]).toEqual([...projection.logicalReady]);
    expect([...projection.partition!.admissionReady]).toEqual([...projection.admissionReady]);
    expect([...projection.partition!.dispatchable]).toEqual([...projection.dispatchable]);
    expect(projection.withheld).toBeNull();
  });

  it("changes only the dispatch layer when a resource is confirmed unavailable", () => {
    const allConfirmed = project(devInput({
      nodeFacts: devBundlesWith(DEV_RESOURCE, devBundle(DEV_RESOURCE)),
    }));
    const resourceHeld = project();
    expect([...allConfirmed.logicalReady]).toEqual([...resourceHeld.logicalReady]);
    expect(allConfirmed.dispatchable).toContain(DEV_RESOURCE);
    expect(resourceHeld.dispatchable).not.toContain(DEV_RESOURCE);
    expect(resourceHeld.admissionReady).toContain(DEV_RESOURCE);
    expect(nodeOf(resourceHeld, DEV_RESOURCE).logical).toBe("CONFIRMED_TRUE");
    expect(nodeOf(resourceHeld, DEV_RESOURCE).dispatch).toBe("CONFIRMED_FALSE");
  });
});

describe("unknown facts never hide structurally ready work", () => {
  it("keeps every logically ready node reported when one node's budget fact is UNKNOWN", () => {
    const unknownBudget = devBundle(
      DEV_CAPABILITY,
      devFactsWith("READINESS_DOWNSTREAM_PROOF_BUDGET", null),
    );
    const projection = project(devInput({
      nodeFacts: devBundlesWith(DEV_CAPABILITY, unknownBudget),
    }));

    // DoD 3: the unrelated nodes AND the unknown node keep their structural
    // logical readiness — it never consulted an availability boolean.
    expect([...projection.logicalReady]).toEqual([DEV_CAPABILITY, DEV_READY, DEV_RESOURCE]);
    expect(nodeOf(projection, DEV_READY).logical).toBe("CONFIRMED_TRUE");
    expect(nodeOf(projection, DEV_CAPABILITY).logical).toBe("CONFIRMED_TRUE");

    // The unknown node gains no admission or dispatch authority...
    expect(projection.admissionReady).not.toContain(DEV_CAPABILITY);
    expect(projection.dispatchable).not.toContain(DEV_CAPABILITY);

    // ...and no availability boolean was fabricated for it: UNKNOWN, not false.
    expect(nodeOf(projection, DEV_CAPABILITY).admission).toBe("UNKNOWN");
    expect(nodeOf(projection, DEV_CAPABILITY).dispatch).toBe("UNKNOWN");

    // The partition itself is withheld, so analysis widths stay UNKNOWN.
    expect(projection.partition).toBeNull();
    expect(projection.withheld).toBe("AVAILABILITY_UNKNOWN");
  });

  it("still reports the confirmed members of the weaker layers while withheld", () => {
    const projection = project(devInput({
      nodeFacts: devBundlesWith(
        DEV_CAPABILITY,
        devBundle(DEV_CAPABILITY, devFactsWith("READINESS_CONTEXT", null)),
      ),
    }));
    expect(projection.withheld).toBe("AVAILABILITY_UNKNOWN");
    expect([...projection.dispatchable]).toEqual([DEV_READY]);
    expect([...projection.admissionReady]).toEqual([DEV_READY, DEV_RESOURCE]);
  });

  it("does not withhold on an advisory node's unknown facts, which count no width", () => {
    const projection = project(devInput({
      nodeFacts: devBundlesWith(
        DEV_ADVISORY,
        devBundle(DEV_ADVISORY, devFactsWith("READINESS_CONTEXT", null)),
      ),
    }));
    expect(projection.withheld).toBeNull();
    expect(projection.partition).not.toBeNull();
  });

  it("reports an UNKNOWN hard edge as UNKNOWN logical readiness, never as confirmed-false", () => {
    const projection = project(devInput({
      hardEdgeFacts: devEdgeFacts("UNSATISFIED", { "dev-edge-ready": "UNKNOWN" }),
    }));
    expect(nodeOf(projection, DEV_DONE).logical).toBe("UNKNOWN");
    expect(nodeOf(projection, DEV_DONE).admission).toBe("UNKNOWN");
    expect(nodeOf(projection, DEV_DONE).dispatch).toBe("UNKNOWN");
  });

  it("reports an all-unsatisfied blocked node as confirmed-false on every layer", () => {
    const projection = project();
    expect(nodeOf(projection, DEV_DONE).logical).toBe("CONFIRMED_FALSE");
    expect(nodeOf(projection, DEV_DONE).admission).toBe("CONFIRMED_FALSE");
    expect(nodeOf(projection, DEV_DONE).dispatch).toBe("CONFIRMED_FALSE");
  });
});

describe("non-execution-bearing nodes receive no execution authority", () => {
  it("never admits or dispatches an advisory node whose every fact is confirmed", () => {
    const projection = project();
    const advisory = nodeOf(projection, DEV_ADVISORY);
    expect(advisory.executionBearing).toBe(false);
    expect(advisory.logical).toBe("CONFIRMED_FALSE");
    expect(advisory.admission).toBe("CONFIRMED_FALSE");
    expect(advisory.dispatch).toBe("CONFIRMED_FALSE");
    expect(projection.logicalReady).not.toContain(DEV_ADVISORY);
    expect(projection.admissionReady).not.toContain(DEV_ADVISORY);
    expect(projection.dispatchable).not.toContain(DEV_ADVISORY);
    expect(advisory.reasons.map((reason) => reason.code)).toContain(
      "READINESS_NOT_EXECUTION_BEARING",
    );
  });
});

describe("fail-closed refusals", () => {
  function refusalCodes(input: unknown): string[] {
    const result = projectReadiness(devGraph(), input);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    return result.issues.map((issue) => issue.code);
  }

  it("refuses a missing node fact bundle", () => {
    const nodeFacts = devBundles().filter((entry) => entry["nodeKey"] !== DEV_READY);
    expect(refusalCodes(devInput({ nodeFacts }))).toContain("READINESS_NODE_FACTS_MISSING");
  });

  it("refuses a duplicate node fact bundle", () => {
    const nodeFacts = [...devBundles(), devBundle(DEV_READY)];
    expect(refusalCodes(devInput({ nodeFacts }))).toContain("READINESS_NODE_FACTS_DUPLICATE");
  });

  it("refuses a bundle for a node outside the graph", () => {
    const nodeFacts = [...devBundles(), devBundle("dev-stranger")];
    expect(refusalCodes(devInput({ nodeFacts }))).toContain("READINESS_NODE_FACTS_UNKNOWN_NODE");
  });

  it.each([
    ["a malformed bundle", { nodeFacts: [...devBundles().slice(1), { nodeKey: DEV_READY }] }],
    ["a malformed input record", { extra: 1 }],
    ["a non-array nodeFacts", { nodeFacts: 7 }],
  ])("refuses %s with READINESS_INPUT_MALFORMED", (_label, override) => {
    expect(refusalCodes(devInput(override))).toContain("READINESS_INPUT_MALFORMED");
  });

  it("passes a frontier refusal through under its own landed code", () => {
    const codes = refusalCodes(devInput({ hardEdgeFacts: [] }));
    expect(codes).toContain("FRONTIER_EDGE_FACT_MISSING");
    expect(codes.every((code) => !code.startsWith("READINESS_"))).toBe(true);
  });

  it("reports the graph identity the projection was computed over", () => {
    const projection = project();
    expect(projection.graphIdentity).toBe(devGraph().graphIdentity);
  });
});

describe("immutability", () => {
  it("returns a deeply frozen projection", () => {
    const projection = project();
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.logicalReady)).toBe(true);
    expect(Object.isFrozen(projection.nodes)).toBe(true);
    expect(Object.isFrozen(nodeOf(projection, DEV_DONE).reasons)).toBe(true);
    expect(Object.isFrozen(nodeOf(projection, DEV_DONE).reasons[0])).toBe(true);
  });

  it("names the exact offending hard edge and producer on a blocked node", () => {
    const projection = project();
    const done = nodeOf(projection, DEV_DONE);
    const logical = done.reasons.filter((reason) => reason.layer === "LOGICAL");
    expect(logical.map((reason) => reason.edgeKey)).toEqual([
      "dev-edge-capability",
      "dev-edge-ready",
      "dev-edge-resource",
    ]);
    expect(logical.every((reason) => reason.code === "HARD_DEPENDENCY_UNSATISFIED")).toBe(true);
    expect(logical.map((reason) => reason.recoveryRef)).toEqual([
      DEV_CAPABILITY,
      DEV_READY,
      DEV_RESOURCE,
    ]);
  });

  it("carries source ref, version and digest on a caller-fact reason", () => {
    const projection = project();
    const reason = nodeOf(projection, DEV_CAPABILITY).reasons.find(
      (entry) => entry.code === "READINESS_CAPABILITY",
    );
    expect(reason?.confidence).toBe("CONFIRMED_FALSE");
    expect(reason?.provenance).toEqual({
      sourceFactRef: "fact:READINESS_CAPABILITY",
      sourceFactVersion: 3,
      sourceFactDigest: "a".repeat(64),
    });
  });
});
