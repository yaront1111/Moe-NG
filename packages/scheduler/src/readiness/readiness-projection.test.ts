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

import { validateGraphSnapshot } from "../validate-graph.js";
import { projectReadiness } from "./readiness-projection.js";
import {
  DEV_ADVISORY,
  DEV_CAPABILITY,
  DEV_DONE,
  DEV_READY,
  DEV_RESOURCE,
  devAllTrueFacts,
  devBundle,
  devBundles,
  devBundlesWith,
  devEdgeFacts,
  devFact,
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

  it("refuses a graph this runtime did not validate, before reading its nodes", () => {
    const forged = {
      completionNodeKey: DEV_READY,
      edges: [],
      graphIdentity: "forged",
      nodes: [{ nodeKey: DEV_READY, executionBearing: true }],
    } as unknown as Parameters<typeof projectReadiness>[0];
    const result = projectReadiness(forged, devInput());
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "GRAPH_VALIDATION_PROVENANCE_INVALID",
    ]);
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

/**
 * REGISTER ITEM 9 — the edgeKey tie-break must be code-point ordered.
 *
 * `localeCompare` is not a stable total order: its result depends on the host's
 * ICU data and default collation, so two machines can order the same readiness
 * set differently. canonical-bytes.ts:57-64 states the same thing about paths
 * and adds the part that makes it dangerous — "that failure never reproduces
 * locally". A green suite on one host is exactly what this defect looks like.
 *
 * THE FIXTURE MUST PROVE ITSELF. A pair whose collation order and code-unit
 * order AGREE passes before and after the fix, and whether they agree is itself
 * host-dependent — the very property under test. So the divergence is asserted
 * on the host actually running this, and the assertion fails loudly rather than
 * quietly certifying nothing.
 */
const TIE_CONSUMER = "dev-tie-done";

/** Code units: "B" 0x42 sorts before "a" 0x61. Most collations order "a" first. */
const TIE_EDGE_UPPER = "dev-edge-Beta";
const TIE_EDGE_LOWER = "dev-edge-alpha";

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tieGraph(edgeKeys: readonly string[]) {
  const producers = edgeKeys.map((_, index) => `dev-tie-producer-${String(index)}`);
  const validated = validateGraphSnapshot({
    completionNodeKey: TIE_CONSUMER,
    nodes: [
      ...producers.map((nodeKey) => ({ nodeKey, executionBearing: true })),
      { nodeKey: TIE_CONSUMER, executionBearing: true },
    ],
    edges: edgeKeys.map((edgeKey, index) => ({
      edgeKey,
      kind: "HARD" as const,
      producerNodeKey: producers[index]!,
      consumerNodeKey: TIE_CONSUMER,
    })),
  });
  expect(validated.ok, "tie-break fixture graph must validate").toBe(true);
  if (!validated.ok) {
    throw new Error("unreachable");
  }
  return { graph: validated.graph, producers };
}

/** Every hard edge UNSATISFIED, so the consumer collects one reason per edge. */
function tieReasons(edgeKeys: readonly string[]) {
  const { graph, producers } = tieGraph(edgeKeys);
  const result = projectReadiness(graph, {
    hardEdgeFacts: edgeKeys.map((edgeKey) => ({ edgeKey, state: "UNSATISFIED" })),
    nodeFacts: [...producers, TIE_CONSUMER].map((nodeKey) => devBundle(nodeKey)),
  });
  expect(result.ok, JSON.stringify("issues" in result ? result.issues : [])).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  const node = result.projection.nodes.find((entry) => entry.nodeKey === TIE_CONSUMER);
  expect(node, `${TIE_CONSUMER} must be projected`).toBeDefined();
  return node!.reasons;
}

describe("edgeKey tie-break is code-point ordered, not locale ordered", () => {
  it("uses a fixture whose collation order and code-unit order genuinely disagree", () => {
    // Guard, not decoration: without it a host whose ICU matches code units
    // makes every assertion below pass against the UNFIXED comparator.
    expect(Math.sign(TIE_EDGE_LOWER.localeCompare(TIE_EDGE_UPPER))).not.toBe(
      byCodeUnit(TIE_EDGE_LOWER, TIE_EDGE_UPPER),
    );
    expect(byCodeUnit(TIE_EDGE_UPPER, TIE_EDGE_LOWER)).toBe(-1);
  });

  it("orders two reasons equal in layer and code by edgeKey code units", () => {
    const reasons = tieReasons([TIE_EDGE_LOWER, TIE_EDGE_UPPER]);
    // The pair collides at every level ABOVE the tie-break, so nothing but the
    // edgeKey comparison can decide this order.
    expect(reasons.map((entry) => entry.layer)).toEqual(["LOGICAL", "LOGICAL"]);
    expect(reasons.map((entry) => entry.code)).toEqual([
      "HARD_DEPENDENCY_UNSATISFIED",
      "HARD_DEPENDENCY_UNSATISFIED",
    ]);
    expect(reasons.map((entry) => entry.edgeKey)).toEqual([TIE_EDGE_UPPER, TIE_EDGE_LOWER]);
  });
});

/**
 * TOTALITY, not one lucky pair — and read the next paragraph before trusting
 * what these three tests prove, because it is narrower than it looks.
 *
 * MEASURED: frontier.ts:219-221 ALREADY sorts each blocked node's reasons by
 * edgeKey, in the same code-unit form. Since `Array.prototype.sort` is stable,
 * that canonical order survives the (layer, code) regrouping here even if the
 * edgeKey tie-break did nothing. Replacing the tie-break with `return 0` is
 * therefore an EQUIVALENT MUTANT through this entry point: all of these stay
 * green. Do not read that as vacuity and do not "simplify" the tie-break away —
 * replacing it with `localeCompare` reddens the sequence test below, which is
 * the regression that actually happened and the one being locked out. The
 * tie-break is a defensive invariant that keeps this comparator correct on its
 * own terms rather than by coupling to a sort two modules upstream.
 *
 * So what IS witnessed here: the projection is deterministic end to end. The
 * same reason set is projected from every permutation of its inputs and must
 * come back identical — no second copy of the comparator lives in this file.
 */
const TIE_EDGE_UPPER_A = "dev-edge-Alpha";
const TIE_UNKNOWN_EDGE = "dev-edge-Unknown";

/** Code units at index 9: "A" 0x41 < "B" 0x42 < "a" 0x61. Collation disagrees. */
const TIE_SORTED_EDGES = [TIE_EDGE_UPPER_A, TIE_EDGE_UPPER, TIE_EDGE_LOWER] as const;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]));
}

/** One node carrying reasons at all three layers, plus a layer+code collision. */
function mixedReasons(edgeOrder: readonly string[], factsReversed = false) {
  const { graph, producers } = tieGraph(edgeOrder);
  // Both codes must be REMOVED before being re-added as CONFIRMED_FALSE: a
  // bundle carrying the same code twice is refused as malformed, never sorted.
  const refused = ["READINESS_CAPABILITY", "READINESS_NO_PAUSE"];
  const facts = [
    ...devAllTrueFacts().filter((entry) => !refused.includes(String(entry["code"]))),
    devFact("READINESS_CAPABILITY", "CONFIRMED_FALSE"),
    devFact("READINESS_NO_PAUSE", "CONFIRMED_FALSE"),
  ];
  const result = projectReadiness(graph, {
    hardEdgeFacts: edgeOrder.map((edgeKey) => ({
      edgeKey,
      state: edgeKey === TIE_UNKNOWN_EDGE ? "UNKNOWN" : "UNSATISFIED",
    })),
    nodeFacts: [
      ...producers.map((nodeKey) => devBundle(nodeKey)),
      devBundle(TIE_CONSUMER, factsReversed ? [...facts].reverse() : facts),
    ],
  });
  expect(result.ok, JSON.stringify("issues" in result ? result.issues : [])).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  const node = result.projection.nodes.find((entry) => entry.nodeKey === TIE_CONSUMER);
  expect(node, `${TIE_CONSUMER} must be projected`).toBeDefined();
  return node!.reasons.map((entry) => `${entry.layer}|${entry.code}|${String(entry.edgeKey)}`);
}

describe("readiness reason ordering is a total order", () => {
  const ALL_EDGES = [TIE_UNKNOWN_EDGE, ...TIE_SORTED_EDGES] as const;

  it("orders across layer, then code, then edgeKey, in exactly that sequence", () => {
    const ordered = mixedReasons(ALL_EDGES);
    expect(ordered).toEqual([
      // LOGICAL first; UNKNOWN before UNSATISFIED by code units ("K" < "S").
      `LOGICAL|HARD_DEPENDENCY_UNKNOWN|${TIE_UNKNOWN_EDGE}`,
      // Layer AND code collide here, so only the edgeKey tie-break can order them.
      `LOGICAL|HARD_DEPENDENCY_UNSATISFIED|${TIE_EDGE_UPPER_A}`,
      `LOGICAL|HARD_DEPENDENCY_UNSATISFIED|${TIE_EDGE_UPPER}`,
      `LOGICAL|HARD_DEPENDENCY_UNSATISFIED|${TIE_EDGE_LOWER}`,
      "ADMISSION|READINESS_CAPABILITY|null",
      "DISPATCH|READINESS_NO_PAUSE|null",
    ]);
  });

  it("returns the identical sequence from every permutation of its inputs", () => {
    const orders = permutations(ALL_EDGES);
    // Hand-written, not derived from `orders`: a sweep that silently produced
    // zero or one case would otherwise pass while testing nothing. 4! = 24.
    expect(orders.length).toBe(24);
    const expected = mixedReasons(ALL_EDGES);
    expect(expected.length).toBe(6);
    for (const order of orders) {
      expect(mixedReasons(order), `edge order ${order.join(",")}`).toEqual(expected);
    }
    // Fact order is an input too: reversing it must not move a reason either.
    expect(mixedReasons(ALL_EDGES, true)).toEqual(expected);
  });

  it("leaves no two reasons comparing equal, so stability cannot leak input order", () => {
    const ordered = mixedReasons(ALL_EDGES);
    // Fixture guard: every entry differs in at least one of layer, code or
    // edgeKey, so the permutation check above is exercising distinct keys
    // rather than quietly comparing a set that could never have reordered.
    expect(new Set(ordered).size).toBe(ordered.length);
    expect(ordered.length).toBe(6);
  });
});
