import { describe, expect, it } from "vitest";
import { analyzeGraphStructure } from "../analyze-graph.js";
import { analyzeHardEdgeCounterfactuals } from "../hard-edge-counterfactual.js";
import { assessContractRedundancy } from "../dependencies/dependency-analysis.js";
import { devHardEdge, devNode, devSnapshot } from "../test-fixtures.js";
import type { GraphSnapshot } from "../graph-model.js";
import {
  HASH_A, HASH_B, INTERFACE_RULING, OTHER_BINDING, UNKNOWN_ESTIMATES, chain,
  codesOf as codes, contractFor, diamond, entriesFor, entryFor, inputFor, predicate,
  recordsOf, validatedGraph as validated,
} from "./admission-fixtures.js";
import {
  REJECTED_NECESSITY_WITNESS_KINDS, admitGraph, checkExpansionLineage,
} from "./admission-pass.js";
import type { AdmissionResult } from "./admission-model.js";

describe("admission step 1 — structural members are reused, never re-coded", () => {
  it.each([
    ["GRAPH_SELF_EDGE", devSnapshot([devNode("dev-node-a")], [devHardEdge("dev-edge-aa", "dev-node-a", "dev-node-a")], "dev-node-a")],
    ["GRAPH_MISSING_ENDPOINT", devSnapshot([devNode("dev-node-a")], [devHardEdge("dev-edge-ab", "dev-node-a", "dev-node-b")], "dev-node-a")],
    ["GRAPH_DUPLICATE_NODE", devSnapshot([devNode("dev-node-a"), devNode("dev-node-a")], [], "dev-node-a")],
    ["GRAPH_COMPLETION_NOT_TERMINAL", devSnapshot(
      [devNode("dev-node-a"), devNode("dev-node-b")],
      [devHardEdge("dev-edge-ab", "dev-node-a", "dev-node-b")], "dev-node-a")],
  ])("passes %s through from validateGraphSnapshot", (code, snapshot) => {
    const result = admitGraph(inputFor(snapshot as GraphSnapshot, { contracts: [] }));
    expect(codes(result)).toContain(code);
    expect(codes(result).filter((issue) => issue.startsWith("ADMISSION_"))).toEqual([]);
  });

  it("passes GRAPH_CYCLE through without an admission-local cycle code", () => {
    const cyclic = devSnapshot(
      [devNode("dev-node-a"), devNode("dev-node-b"), devNode("dev-node-c")],
      [devHardEdge("dev-edge-ab", "dev-node-a", "dev-node-b"), devHardEdge("dev-edge-ba", "dev-node-b", "dev-node-a"),
        devHardEdge("dev-edge-bc", "dev-node-b", "dev-node-c")],
      "dev-node-c",
    );
    expect(codes(admitGraph(inputFor(cyclic, { contracts: [] })))).toContain("GRAPH_CYCLE");
  });

  it("refuses a baseline snapshot describing a different node set", () => {
    const other = devSnapshot([devNode("dev-node-a"), devNode("dev-node-z")],
      [devHardEdge("dev-edge-az", "dev-node-a", "dev-node-z")], "dev-node-z");
    expect(codes(admitGraph(inputFor(chain(), { sequentialBaselineSnapshot: other })))).toContain("ADMISSION_CROSS_SNAPSHOT_INPUT");
  });

  it("refuses contracts bound to two different graphs", () => {
    const snapshot = chain();
    const contracts = entriesFor(snapshot);
    contracts[1] = entryFor(snapshot.edges[1]!, { graphBindingDigest: OTHER_BINDING });
    expect(codes(admitGraph(inputFor(snapshot, { contracts })))).toContain("ADMISSION_CROSS_SNAPSHOT_INPUT");
  });

  it("refuses a contract whose endpoints disagree with its edge", () => {
    const snapshot = chain();
    const contracts = [entryFor(snapshot.edges[0]!), entryFor({ ...snapshot.edges[1]!, producerNodeKey: "dev-node-a" })];
    expect(codes(admitGraph(inputFor(snapshot, { contracts })))).toContain("ADMISSION_CONTRACT_INCOMPATIBLE");
  });

  it("refuses an advisory-kind contract declared for a HARD edge", () => {
    const snapshot = chain();
    const contracts = entriesFor(snapshot);
    contracts[0] = { edgeKey: "dev-edge-ab", edgeKind: "PREFERRED_ORDER" };
    expect(codes(admitGraph(inputFor(snapshot, { contracts })))).toContain("ADMISSION_CONTRACT_INCOMPATIBLE");
  });

  it("refuses a contract whose invalidation fact is older than the declared current version", () => {
    const result = admitGraph(inputFor(chain(), {
      currentSourceFactVersions: [{ sourceFactRef: "fact:dev-node-a", version: 4 }],
    }));
    expect(codes(result)).toContain("ADMISSION_STALE_FACT");
  });

  it("refuses two contracts claiming the same edge", () => {
    const snapshot = chain();
    const contracts = [...entriesFor(snapshot), entryFor(snapshot.edges[0]!)];
    expect(codes(admitGraph(inputFor(snapshot, { contracts })))).toContain("ADMISSION_DUPLICATE_CONTRACT");
  });

  it("passes the kernel dependency codes through instead of re-coding an invalid contract", () => {
    const snapshot = chain();
    const contracts = entriesFor(snapshot);
    contracts[0] = { edgeKey: "dev-edge-ab", edgeKind: "ARTIFACT_CONSUMPTION" };
    const result = admitGraph(inputFor(snapshot, { contracts }));
    expect(codes(result)).toContain("DEPENDENCY_HARD_CONTRACT_REQUIRED");
    expect((result as Extract<AdmissionResult, { readonly ok: false }>).issues
      .find((issue) => issue.code === "DEPENDENCY_HARD_CONTRACT_REQUIRED")?.edgeKeys).toEqual(["dev-edge-ab"]);
  });

  it("passes the kernel registry code through instead of coercing a malformed registry to empty", () => {
    expect(codes(admitGraph(inputFor(chain(), { predicateRegistry: null }))))
      .toContain("DEPENDENCY_PREDICATE_REGISTRY_MALFORMED");
  });

  it("refuses a structurally hostile top-level input", () => {
    expect(codes(admitGraph({ proposedSnapshot: chain(), contracts: "not-an-array" }))).toEqual(["ADMISSION_INPUT_MALFORMED"]);
  });
});

describe("admission step 2 — hard dependency proof", () => {
  it("refuses a HARD edge with no current typed contract", () => {
    const result = admitGraph(inputFor(chain(), { contracts: [entryFor(chain().edges[0]!)] }));
    expect(codes(result)).toContain("ADMISSION_HARD_DEPENDENCY_UNPROVEN");
    expect((result as Extract<AdmissionResult, { readonly ok: false }>).issues
      .find((issue) => issue.code === "ADMISSION_HARD_DEPENDENCY_UNPROVEN")?.edgeKeys).toEqual(["dev-edge-bc"]);
  });

  it.each([...REJECTED_NECESSITY_WITNESS_KINDS])("rejects %s as proof of a hard dependency", (kind) => {
    const snapshot = chain();
    const contracts = entriesFor(snapshot).map((entry) => ({ ...entry, necessityWitness: { kind } }));
    expect(codes(admitGraph(inputFor(snapshot, { contracts })))).toContain("ADMISSION_HARD_DEPENDENCY_UNPROVEN");
  });

  it("never emits the frontier readiness codes for an unproven dependency", () => {
    const emitted = codes(admitGraph(inputFor(chain(), { contracts: [] })));
    expect(emitted).not.toContain("HARD_DEPENDENCY_UNSATISFIED");
    expect(emitted).not.toContain("HARD_DEPENDENCY_UNKNOWN");
  });
});

describe("admission step 3 — minimum qualifying milestone", () => {
  it("refuses a full-ACCEPTED dependency when an interface alternative qualifies earlier", () => {
    const result = admitGraph(inputFor(chain(), {
      contracts: entriesFor(chain(), {
        minimumQualifyingMilestone: "ACCEPTED", alternativeRuling: INTERFACE_RULING,
      }),
    }));
    expect(codes(result)).toContain("ADMISSION_MINIMUM_MILESTONE_OVERSTATED");
  });

  it("admits an earlier milestone alongside an interface alternative", () => {
    const result = admitGraph(inputFor(chain(), {
      contracts: entriesFor(chain(), { alternativeRuling: { kind: "FIXTURE_AVAILABLE", ref: "fixture:x", digest: HASH_A } }),
    }));
    expect(codes(result)).not.toContain("ADMISSION_MINIMUM_MILESTONE_OVERSTATED");
  });

  it("admits ACCEPTED when no earlier alternative was ruled available", () => {
    const result = admitGraph(inputFor(chain(), { contracts: entriesFor(chain(), { minimumQualifyingMilestone: "ACCEPTED" }) }));
    expect(codes(result)).toEqual([]);
  });
});

describe("admission step 4 — contract-level semantic reduction", () => {
  it("refuses a proposed edge only under full contract identity", () => {
    const result = admitGraph(inputFor(diamond()));
    expect(codes(result)).toContain("ADMISSION_EDGE_SEMANTICALLY_REDUNDANT");
    expect((result as Extract<AdmissionResult, { readonly ok: false }>).issues
      .find((issue) => issue.code === "ADMISSION_EDGE_SEMANTICALLY_REDUNDANT")?.edgeKeys).toEqual(["dev-edge-ac"]);
  });

  it("records — never refuses — a partial predicate equivalence and passes the kernel assessment through", () => {
    const snapshot = diamond();
    const contracts = snapshot.edges.map((edge) => edge.edgeKey === "dev-edge-bc"
      ? entryFor(edge, { satisfactionPredicate: predicate(HASH_A) }) : entryFor(edge));
    const records = recordsOf(admitGraph(inputFor(snapshot, { contracts })));
    const reduction = records.reduction.find((entry) => entry.edgeKey === "dev-edge-ac");
    expect(reduction?.outcome).toBe("PARTIAL_EQUIVALENCE");
    expect(reduction?.reviewOnly).toBe(true);
    const analysis = analyzeGraphStructure(validated(snapshot));
    const expected = assessContractRedundancy({
      structuralCandidate: analysis.structuralRedundancyCandidates[0],
      directContract: contractFor("dev-node-a", "dev-node-c"),
      alternatePathContracts: [contractFor("dev-node-a", "dev-node-b"),
        contractFor("dev-node-b", "dev-node-c", { satisfactionPredicate: predicate(HASH_A) })],
    });
    expect(reduction?.assessment).toEqual((expected as { readonly assessment: unknown }).assessment);
  });

  it("keeps a direct artifact edge the intermediate path does not reproduce", () => {
    const snapshot = diamond();
    const contracts = snapshot.edges.map((edge) => edge.edgeKey === "dev-edge-ac"
      ? entryFor(edge, { producer: { kind: "ARTIFACT_CONSUMPTION", artifactOrInterfaceRef: "artifact:direct", digest: HASH_B } })
      : entryFor(edge));
    const records = recordsOf(admitGraph(inputFor(snapshot, { contracts })));
    expect(records.reduction.find((entry) => entry.edgeKey === "dev-edge-ac")?.outcome).toBe("PARTIAL_EQUIVALENCE");
  });
});

describe("admission step 5 — completion closure is reused", () => {
  it("passes COMPLETION_CLOSURE_INCOMPLETE through", () => {
    const orphaned = devSnapshot(
      [devNode("dev-node-a"), devNode("dev-node-b"), devNode("dev-node-c")],
      [devHardEdge("dev-edge-ac", "dev-node-a", "dev-node-c")], "dev-node-c",
    );
    expect(codes(admitGraph(inputFor(orphaned, { contracts: [] })))).toContain("COMPLETION_CLOSURE_INCOMPLETE");
  });
});

describe("admission step 6 — baseline comparison", () => {
  it("derives every structural field from analyzeGraphStructure and leaves widths UNKNOWN", () => {
    const snapshot = chain();
    const records = recordsOf(admitGraph(inputFor(snapshot)));
    const analysis = analyzeGraphStructure(validated(snapshot));
    expect(records.baseline.proposed.structuralStageCount).toBe(analysis.structuralStageCount);
    expect(records.baseline.proposed.criticalPathHardEdgeCount).toBe(analysis.criticalPathHardEdges.length);
    expect(records.baseline.proposed.maxHardDescendantCount)
      .toBe(Math.max(...analysis.nodes.map((node) => node.hardDescendantCount)));
    expect(records.baseline.proposed.logicalReadyWidth).toBeNull();
    expect(records.baseline.proposed.admissionReadyWidth).toBeNull();
    expect(records.baseline.proposed.dispatchableWidth).toBeNull();
    expect(records.baseline.durationEstimate).toBeNull();
  });

  it("reports UNKNOWN estimates as null rather than zero when none are supplied", () => {
    const records = recordsOf(admitGraph(inputFor(chain())));
    expect(records.baseline.estimates.proposedDuration).toEqual({ value: null, truthClass: "UNKNOWN" });
    expect(records.baseline.estimates.sequentialBaselineCost).toEqual({ value: null, truthClass: "UNKNOWN" });
  });

  it("validates caller-supplied truth-classed estimates and keeps them unmodified", () => {
    const estimates = { ...UNKNOWN_ESTIMATES, proposedDuration: { value: 12, truthClass: "AGENT_REPORTED" },
      sequentialBaselineDuration: { value: 30, truthClass: "AGENT_REPORTED" } };
    const records = recordsOf(admitGraph(inputFor(chain(), { estimates })));
    expect(records.baseline.estimates).toEqual(estimates);
  });

  it("refuses an UNKNOWN estimate that carries a number", () => {
    const result = admitGraph(inputFor(chain(), {
      estimates: { ...UNKNOWN_ESTIMATES, proposedDuration: { value: 0, truthClass: "UNKNOWN" } },
    }));
    expect(codes(result)).toContain("ADMISSION_ESTIMATE_MALFORMED");
  });
});

describe("admission step 7 — interface-first records", () => {
  it("composes landed diagnostics with the kernel ruling and design-404 stub constraints", () => {
    const snapshot = chain();
    const records = recordsOf(admitGraph(inputFor(snapshot, {
      contracts: entriesFor(snapshot, { alternativeRuling: INTERFACE_RULING }),
    })));
    const analysis = analyzeGraphStructure(validated(snapshot));
    expect(records.interfaceFirst.map((entry) => entry.diagnostic)).toEqual([...analysis.diagnostics]);
    const record = records.interfaceFirst[0];
    expect(record?.alternativeRuling).toEqual(INTERFACE_RULING);
    expect(record?.stubConstraints).toEqual({
      nonProduction: true,
      approvedInterfaceContractHash: HASH_A,
      approvedInterfaceRef: "interface:x",
      approvedInterfaceDigest: HASH_A,
      requiredConformanceRecipes: ["PRODUCER", "CONSUMER"],
      replacedAndVerifiedAtIntegration: true,
    });
  });

  it("emits no stub constraints when no alternative was ruled available", () => {
    const records = recordsOf(admitGraph(inputFor(chain())));
    expect(records.interfaceFirst[0]?.stubConstraints).toBeNull();
    expect(records.interfaceFirst[0]?.reviewOnly).toBe(true);
  });
});

describe("admission step 8 — limits and expansion lineage", () => {
  it("passes the landed node limit through without an admission-local code", () => {
    const nodes = Array.from({ length: 25 }, (_value, index) => devNode(`dev-node-${index + 1}`));
    const snapshot = devSnapshot(nodes, [], "dev-node-25");
    const emitted = codes(admitGraph(inputFor(snapshot, { contracts: [] })));
    expect(emitted).toContain("GRAPH_NODE_LIMIT_EXCEEDED");
    expect(emitted.filter((code) => code.startsWith("ADMISSION_"))).toEqual([]);
  });

  it("passes the landed hard-edge limit through under an explicit policy", () => {
    const emitted = codes(admitGraph(inputFor(chain(), {
      contracts: [],
      policyOverride: { maxNodes: 24, maxHardEdges: 1, maxTotalEdges: 64, minGatedDescendantsForReview: 1 },
    })));
    expect(emitted).toContain("GRAPH_HARD_EDGE_LIMIT_EXCEEDED");
    expect(emitted.filter((code) => code.startsWith("ADMISSION_"))).toEqual([]);
  });

  it.each([
    ["ADMISSION_EXPANSION_DEPTH_EXCEEDED", { expansionDepth: 4, childWidth: 2, nodesAddedInExpansion: 2 }],
    ["ADMISSION_EXPANSION_CHILD_WIDTH_EXCEEDED", { expansionDepth: 1, childWidth: 7, nodesAddedInExpansion: 2 }],
    ["ADMISSION_EXPANSION_FANOUT_EXCEEDED", { expansionDepth: 1, childWidth: 2, nodesAddedInExpansion: 10 }],
  ])("refuses expansion lineage with %s", (code, expansionLineage) => {
    expect(codes(admitGraph(inputFor(chain(), { expansionLineage })))).toContain(code);
  });

  it("records the R2 raise reference for lineage inside the limits", () => {
    const lineage = { expansionDepth: 3, childWidth: 6, nodesAddedInExpansion: 9 };
    const records = recordsOf(admitGraph(inputFor(chain(), { expansionLineage: lineage })));
    expect(records.expansion).toEqual({
      facts: lineage,
      limits: { maxExpansionDepth: 3, maxChildWidth: 6, maxNodesPerExpansion: 9 },
      raiseReference: { kind: "R2_EXPANSION_LIMIT_RAISE", reviewOnly: true },
    });
  });

  it("exposes the lineage checker as a pure function over caller-supplied facts", () => {
    expect(checkExpansionLineage({ expansionDepth: 3, childWidth: 6, nodesAddedInExpansion: 9 })).toEqual([]);
    expect(checkExpansionLineage({ expansionDepth: 1, childWidth: 1, nodesAddedInExpansion: -1 })
      .map((issue) => issue.code)).toEqual(["ADMISSION_EXPANSION_LINEAGE_MALFORMED"]);
  });
});

describe("admission J6 / CORE-S13 shapes", () => {
  const naked = devSnapshot(
    [devNode("dev-node-a"), devNode("dev-node-b"), devNode("dev-node-c"), devNode("dev-node-d")],
    [devHardEdge("dev-edge-ab", "dev-node-a", "dev-node-b"), devHardEdge("dev-edge-bc", "dev-node-b", "dev-node-c"),
      devHardEdge("dev-edge-cd", "dev-node-c", "dev-node-d")],
    "dev-node-d",
  );

  it("refuses a naked A->B->C->D chain justified only by prose order", () => {
    const contracts = entriesFor(naked).map((entry) => ({ ...entry, necessityWitness: { kind: "PROSE_ORDER" } }));
    expect(codes(admitGraph(inputFor(naked, { contracts })))).toContain("ADMISSION_HARD_DEPENDENCY_UNPROVEN");
    // Corrected-frontier evidence: cutting the middle edge splits the 4-stage
    // chain into two 2-stage halves, so the serialization cost is 2 stages.
    const counterfactuals = analyzeHardEdgeCounterfactuals(validated(naked));
    const middle = counterfactuals.edges.find((edge) => edge.edgeKey === "dev-edge-bc");
    expect(middle?.structuralStageReduction).toBe(2);
    expect(middle?.completionClosureIntactWithoutEdge).toBe(false);
  });

  it("admits the interface-first variant with the milestone edge retained", () => {
    const records = recordsOf(admitGraph(inputFor(naked, {
      contracts: entriesFor(naked, { alternativeRuling: INTERFACE_RULING }),
    })));
    expect(records.counterfactuals.edges.map((edge) => edge.edgeKey))
      .toEqual(["dev-edge-ab", "dev-edge-bc", "dev-edge-cd"]);
    expect(records.counterfactuals.edges.every((edge) => edge.dependencyNecessity === "UNKNOWN")).toBe(true);
  });
});

describe("admission determinism", () => {
  it("returns byte-identical deeply frozen results for identical inputs", () => {
    const first = admitGraph(inputFor(chain()));
    const second = admitGraph(inputFor(chain()));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(recordsOf(first).baseline.proposed)).toBe(true);
  });
});
