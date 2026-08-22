/**
 * The recursive node-authority derivation of design line 255.
 *
 * Every fixture is built by PRODUCTION code: the graph through `validateGraphSnapshot`, the
 * bodies through `createNodeDefinition`, the planning identities through `@moe/core`, and the
 * structural binding through `snapshotIdentityHash`. Nothing here reimplements a rule it then
 * checks — a helper that recomputed a preimage would agree with a broken production one.
 *
 * Refusal arms pin the LITERAL code and the LITERAL layer. Three authorities can answer on this
 * seam — the graph validator, the node-authority codec, and this module — and a test that only
 * asserts "refused" cannot tell which one did.
 */
import { createAcceptanceContract, createPlanRevision } from "@moe/core";
import { describe, expect, it } from "vitest";

import { snapshotIdentityHash } from "../graph-content-format.js";
import { validateGraphSnapshot } from "../validate-graph.js";
import { ADMISSION_PURPOSES } from "../budget/budget-reservation.js";
import { createNodeDefinition } from "./node-authority-codec.js";
import {
  NODE_AUTHORITY_RECURSION_CODES,
  deriveNodeAuthoritySet,
} from "./node-authority-recursion.js";
import type { NodeAuthorityRecursionResult } from "./node-authority-recursion.js";

const hex = (digit: string): string => digit.repeat(64);
const RECURSION_LAYER = "NODE_AUTHORITY_RECURSION";
const GRAPH_LAYER = "GRAPH_SNAPSHOT";
const HEX_64 = /^[0-9a-f]{64}$/u;
const PURPOSE_ORDER = Object.freeze([...ADMISSION_PURPOSES].sort());

type Json = Record<string, unknown>;

/** A -HARD-> B -HARD-> C(completion), plus one ADVISORY A -> C that carries no contract. */
const snapshotDraft = (): Json => ({
  completionNodeKey: "node-c",
  edges: [
    { consumerNodeKey: "node-b", edgeKey: "edge-ab", kind: "HARD", producerNodeKey: "node-a" },
    { consumerNodeKey: "node-c", edgeKey: "edge-bc", kind: "HARD", producerNodeKey: "node-b" },
    { consumerNodeKey: "node-c", edgeKey: "edge-ac", kind: "ADVISORY", producerNodeKey: "node-a" },
  ],
  nodes: [
    { executionBearing: true, nodeKey: "node-a" },
    { executionBearing: true, nodeKey: "node-b" },
    { executionBearing: true, nodeKey: "node-c" },
  ],
});

function bindingDigest(draft: Json = snapshotDraft()): string {
  const validated = validateGraphSnapshot(draft);
  if (!validated.ok) throw new Error(`graph fixture refused: ${validated.issues[0]?.code ?? "?"}`);
  return snapshotIdentityHash(validated.graph);
}

const BINDING = bindingDigest();

const planDraft = (patch: Json = {}): Json => ({
  affectedCriterionIds: ["criterion-a"],
  affectedNodeIds: ["node-a", "node-b", "node-c"],
  approvalState: "APPROVED",
  authorRef: "principal-a",
  graphBinding: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null,
  rejectionRef: null,
  revisionId: "plan-revision-a",
  steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-a" }],
  verificationRecipeRefs: ["recipe-a", "recipe-b"],
  ...patch,
});

const acceptanceDraft = (
  nodeIds: string[] = ["node-a", "node-b", "node-c"], patch: Json = {},
): Json => ({
  applicability: {
    graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a",
    nodeIds, nodeKind: "LEAF",
  },
  authorRef: "principal-a",
  contractId: "acceptance-contract-a",
  obligations: [{
    criterionId: "criterion-a",
    evidenceRequirements: [
      { evidenceRef: "artifact-a", kind: "ARTIFACT", requirementId: "requirement-a" },
    ],
    statement: "The node ships its focused verification.",
    verificationRecipeRefs: ["recipe-a"],
  }],
  ...patch,
});

const registryEntry = (): Json => ({
  parameterSchema: { digest: hex("b"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-a",
  proofRationale: "An artifact seal cannot become unsealed.",
  schemaId: "schema-a",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
});

interface ContractOptions {
  readonly binding?: string;
  readonly consumer?: string;
  readonly producer?: string;
  readonly witnessDigest?: string;
  readonly witnessVersion?: number;
}

const dependencyContract = (options: ContractOptions = {}): Json => ({
  alternateProducers: [] as string[],
  alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
  consumer: { contractHash: hex("c"), criterionRef: "criterion-a", kind: "PRECONDITION" },
  consumerNodeKey: options.consumer ?? "node-b",
  consumptionHorizon: "RESULT_SEAL",
  edgeKind: "ARTIFACT_CONSUMPTION",
  graphBindingDigest: options.binding ?? BINDING,
  invalidationFacts: [{ sourceFactDigest: hex("e"), sourceFactRef: "fact-a", sourceFactVersion: 1 }],
  minimumQualifyingMilestone: "RESULT_SEALED",
  necessity: {
    failedConsumerCriterionRef: "criterion-a", failureKind: "MISSING_ARTIFACT",
    truthClass: "OBSERVED",
  },
  producer: { artifactOrInterfaceRef: "artifact-a", digest: hex("f"), kind: "ARTIFACT_CONSUMPTION" },
  producerNodeKey: options.producer ?? "node-a",
  recheckPredicateRef: "predicate-a",
  satisfactionPredicate: {
    parametersDigest: hex("1"), predicateRef: "predicate-a", schemaId: "schema-a",
    schemaVersion: 1,
  },
  satisfactionWitnesses: [{
    sourceOperationClass: "ARTIFACT_SEAL", witnessDigest: options.witnessDigest ?? hex("2"),
    witnessRef: "witness-a", witnessVersion: options.witnessVersion ?? 1,
  }],
  stability: "MONOTONIC",
  truthClass: "OBSERVED",
});

const requirementFor = (options: ContractOptions = {}): Json => ({
  contract: dependencyContract(options), edgeKind: "ARTIFACT_CONSUMPTION",
});

const admissionAmounts = (): Json[] =>
  PURPOSE_ORDER.map((purpose, index) => ({
    meter: "runner.authorized_ms", purpose, quantity: index + 1,
  }));

interface NodeOptions {
  readonly acceptancePatch?: Json;
  readonly capability?: string;
  readonly edges?: Json[];
  readonly joinRole?: string;
  readonly linkage?: string | null;
  readonly objective?: string;
  /** Merged last, so a sweep can move ONE design-255 field without a bespoke knob per field. */
  readonly patch?: Json;
  readonly planPatch?: Json;
  readonly repositoryBaseTree?: string;
}

const nodeDraft = (nodeKey: string, options: NodeOptions = {}): Json => ({
  admissionAmounts: admissionAmounts(),
  admissionGatePolicy: "POLICY_ALLOWANCE",
  capability: options.capability ?? "capability-implement",
  completionLinkage: options.linkage === undefined
    ? (nodeKey === "node-c" ? "node-c" : null) : options.linkage,
  constraints: ["constraint-a"],
  directHardDependencies: options.edges ?? [],
  joinRole: options.joinRole ?? (nodeKey === "node-c" ? "COMPLETION" : "NONE"),
  nodeKey,
  objective: options.objective ?? `Land ${nodeKey}.`,
  policySliceHash: hex("3"),
  readScopes: ["services/api/src"],
  repositoryBaseTree: options.repositoryBaseTree ?? hex("4"),
  resources: ["resource-a"],
  verificationRecipeRevisions: ["recipe-a"],
  writeScopes: ["services/api/src/node"],
  ...options.patch,
});

function bodyOrThrow(nodeKey: string, options: NodeOptions = {}, nodeIds?: string[]): unknown {
  const plan = createPlanRevision(planDraft(options.planPatch ?? {}));
  if (!plan.ok) throw new Error(`plan fixture refused: ${plan.code}`);
  const acceptance = createAcceptanceContract(acceptanceDraft(nodeIds, options.acceptancePatch));
  if (!acceptance.ok) throw new Error(`acceptance fixture refused: ${acceptance.code}`);
  const built = createNodeDefinition({
    acceptanceContract: acceptance.contract,
    draft: nodeDraft(nodeKey, options),
    planRevision: plan.revision,
    predicateRegistry: [registryEntry()],
  });
  if (!built.ok) {
    throw new Error(built.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return built.value.definition;
}

/** The three admitted bodies of the default graph, edges wired to their CONSUMER's body. */
function bodies(overrides: Readonly<Record<string, NodeOptions>> = {}): unknown[] {
  return [
    bodyOrThrow("node-a", overrides["node-a"] ?? {}),
    bodyOrThrow("node-b", overrides["node-b"] ?? {
      edges: [{ edgeKey: "edge-ab", requirement: requirementFor() }],
    }),
    bodyOrThrow("node-c", overrides["node-c"] ?? {
      edges: [{
        edgeKey: "edge-bc",
        requirement: requirementFor({ consumer: "node-c", producer: "node-b" }),
      }],
    }),
  ];
}

function derived(snapshot: Json = snapshotDraft(), input: unknown[] = bodies()) {
  return deriveNodeAuthoritySet(snapshot, input);
}

function acceptedOrThrow(
  snapshot: Json = snapshotDraft(), input: unknown[] = bodies(),
): Extract<NodeAuthorityRecursionResult, { ok: true }> {
  const result = deriveNodeAuthoritySet(snapshot, input);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return result;
}

const hashOf = (
  result: Extract<NodeAuthorityRecursionResult, { ok: true }>, nodeKey: string,
): string => {
  const entry = result.value.find((item) => item.nodeKey === nodeKey);
  if (entry === undefined) throw new Error(`no authority entry for ${nodeKey}`);
  return entry.nodeAuthorityHash;
};

function expectRefusal(result: NodeAuthorityRecursionResult, code: string, layer: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  expect({ code: result.issues[0]?.code, layer: result.issues[0]?.layer }).toEqual({ code, layer });
}

describe("node authority recursion — accepted control", () => {
  it("returns exactly one deeply frozen entry per validated snapshot node", () => {
    const result = acceptedOrThrow();
    expect(result.value.map((entry) => entry.nodeKey)).toEqual(["node-a", "node-b", "node-c"]);
    expect(result.hardEdgeCount).toBe(2);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value[0])).toBe(true);
  });

  it("derives a 64-hex hash for every node", () => {
    for (const entry of acceptedOrThrow().value) {
      expect(entry.nodeAuthorityHash).toMatch(HEX_64);
    }
  });

  it("is deterministic across two calls over equal inputs", () => {
    expect(acceptedOrThrow().value).toEqual(acceptedOrThrow().value);
  });

  it("gives the three nodes three distinct hashes", () => {
    const hashes = acceptedOrThrow().value.map((entry) => entry.nodeAuthorityHash);
    expect(new Set(hashes).size).toBe(3);
  });
});

describe("node authority recursion — propagation", () => {
  it("changes a node and every descendant when an ancestor body changes", () => {
    const base = acceptedOrThrow();
    const moved = acceptedOrThrow(snapshotDraft(), bodies({
      "node-a": { objective: "A different objective for node-a." },
    }));
    expect(hashOf(moved, "node-a")).not.toBe(hashOf(base, "node-a"));
    expect(hashOf(moved, "node-b")).not.toBe(hashOf(base, "node-b"));
    expect(hashOf(moved, "node-c")).not.toBe(hashOf(base, "node-c"));
  });

  it("leaves ancestors untouched when only a descendant body changes", () => {
    const base = acceptedOrThrow();
    const moved = acceptedOrThrow(snapshotDraft(), bodies({
      "node-c": {
        edges: [{
          edgeKey: "edge-bc",
          requirement: requirementFor({ consumer: "node-c", producer: "node-b" }),
        }],
        linkage: "node-c", objective: "A different objective for node-c.",
      },
    }));
    expect(hashOf(moved, "node-a")).toBe(hashOf(base, "node-a"));
    expect(hashOf(moved, "node-b")).toBe(hashOf(base, "node-b"));
    expect(hashOf(moved, "node-c")).not.toBe(hashOf(base, "node-c"));
  });
});

describe("node authority recursion — refusals", () => {
  it("advertises a nonempty closed code roster", () => {
    expect(NODE_AUTHORITY_RECURSION_CODES.length).toBeGreaterThan(0);
  });

  it("passes a graph refusal through with the graph's own code", () => {
    const cyclic = snapshotDraft();
    (cyclic["edges"] as Json[]).push({
      consumerNodeKey: "node-a", edgeKey: "edge-ca", kind: "HARD", producerNodeKey: "node-c",
    });
    const result = deriveNodeAuthoritySet(cyclic, bodies());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a cyclic snapshot was admitted");
    expect(result.issues[0]?.layer).toBe(GRAPH_LAYER);
    expect(result.issues[0]?.code.startsWith("GRAPH_")).toBe(true);
  });

  it("refuses a body set that is missing a snapshot node", () => {
    expectRefusal(
      derived(snapshotDraft(), bodies().slice(0, 2)),
      "NODE_AUTHORITY_RECURSION_NODE_MISSING", RECURSION_LAYER,
    );
  });

  it("refuses two bodies claiming the same node", () => {
    expectRefusal(
      derived(snapshotDraft(), [...bodies(), bodyOrThrow("node-a")]),
      "NODE_AUTHORITY_RECURSION_NODE_DUPLICATE", RECURSION_LAYER,
    );
  });

  it("refuses a body for a node the snapshot does not carry", () => {
    const stranger = bodyOrThrow("node-z", {}, ["node-a", "node-b", "node-c", "node-z"]);
    expectRefusal(
      derived(snapshotDraft(), [...bodies(), stranger]),
      "NODE_AUTHORITY_RECURSION_NODE_EXTRA", RECURSION_LAYER,
    );
  });

  it("refuses a HARD edge that no admitted body contracts for", () => {
    expectRefusal(
      derived(snapshotDraft(), bodies({ "node-b": {} })),
      "NODE_AUTHORITY_RECURSION_CONTRACT_MISSING", RECURSION_LAYER,
    );
  });

  it("refuses a contract filed against an ADVISORY edge", () => {
    expectRefusal(
      derived(snapshotDraft(), bodies({
        "node-c": {
          edges: [
            { edgeKey: "edge-ac", requirement: requirementFor({ consumer: "node-c" }) },
            {
              edgeKey: "edge-bc",
              requirement: requirementFor({ consumer: "node-c", producer: "node-b" }),
            },
          ],
          linkage: "node-c",
        },
      })),
      "NODE_AUTHORITY_RECURSION_CONTRACT_FORBIDDEN", RECURSION_LAYER,
    );
  });

  it("refuses a contract whose endpoints disagree with the snapshot edge", () => {
    expectRefusal(
      derived(snapshotDraft(), bodies({
        "node-b": {
          edges: [{ edgeKey: "edge-ab", requirement: requirementFor({ producer: "node-c" }) }],
        },
      })),
      "NODE_AUTHORITY_RECURSION_ENDPOINT_MISMATCH", RECURSION_LAYER,
    );
  });

  it("refuses a graphBindingDigest that is not the structural snapshot identity", () => {
    expectRefusal(
      derived(snapshotDraft(), bodies({
        "node-b": {
          edges: [{ edgeKey: "edge-ab", requirement: requirementFor({ binding: hex("9") }) }],
        },
      })),
      "NODE_AUTHORITY_RECURSION_BINDING_MISMATCH", RECURSION_LAYER,
    );
  });

  it("refuses two admitted contracts that disagree about one witness", () => {
    expectRefusal(
      derived(snapshotDraft(), bodies({
        "node-c": {
          edges: [{
            edgeKey: "edge-bc",
            requirement: requirementFor({
              consumer: "node-c", producer: "node-b", witnessVersion: 7,
            }),
          }],
          linkage: "node-c",
        },
      })),
      "NODE_AUTHORITY_RECURSION_WITNESS_CONFLICT", RECURSION_LAYER,
    );
  });

  it("refuses bodies that disagree about the repository base tree", () => {
    expectRefusal(
      derived(snapshotDraft(), bodies({ "node-a": { repositoryBaseTree: hex("7") } })),
      "NODE_AUTHORITY_RECURSION_REPOSITORY_BASE_CONFLICT", RECURSION_LAYER,
    );
  });

  it("refuses a completion node that does not carry the COMPLETION join role", () => {
    expectRefusal(
      derived(snapshotDraft(), bodies({
        "node-c": {
          edges: [{
            edgeKey: "edge-bc",
            requirement: requirementFor({ consumer: "node-c", producer: "node-b" }),
          }],
          joinRole: "NONE", linkage: null,
        },
      })),
      "NODE_AUTHORITY_RECURSION_COMPLETION_LINKAGE_INVALID", RECURSION_LAYER,
    );
  });

  it("passes a body refusal through with the codec's own code and layer", () => {
    expectRefusal(
      derived(snapshotDraft(), [...bodies().slice(0, 2), "not-a-record"]),
      "NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
    );
  });

  it("preserves a SECOND codec layer, so the passthrough is not one hard-coded pair", () => {
    expectRefusal(
      derived(snapshotDraft(), [...bodies().slice(0, 2), { nodeKey: "node-c" }]),
      "NODE_AUTHORITY_UNSUPPORTED_SCHEMA", "NODE_AUTHORITY_SCHEMA",
    );
  });

  it("refuses a malformed body list outright", () => {
    expectRefusal(
      deriveNodeAuthoritySet(snapshotDraft(), "not-an-array" as unknown as unknown[]),
      "NODE_AUTHORITY_RECURSION_MALFORMED", RECURSION_LAYER,
    );
  });
});

/**
 * A FAN-IN graph: node-a and node-b each feed the completion node and neither has an incoming
 * edge, so their bodies differ in exactly one thing — the nodeKey. Design 255 PAIRS that key with
 * the hash rather than hashing it, so the two hashes must be identical. This is the only honest
 * form of that claim: a whole-graph rename is NOT invariant, because the contracts carry the
 * endpoint keys and the graphBindingDigest covers the structure, and both enter the preimage
 * through the incoming section.
 */
const fanInDraft = (): Json => ({
  completionNodeKey: "node-c",
  edges: [
    { consumerNodeKey: "node-c", edgeKey: "edge-ac", kind: "HARD", producerNodeKey: "node-a" },
    { consumerNodeKey: "node-c", edgeKey: "edge-bc", kind: "HARD", producerNodeKey: "node-b" },
  ],
  nodes: [
    { executionBearing: true, nodeKey: "node-a" },
    { executionBearing: true, nodeKey: "node-b" },
    { executionBearing: true, nodeKey: "node-c" },
  ],
});

function fanInBodies(): unknown[] {
  const binding = bindingDigest(fanInDraft());
  return [
    // Identical in every projected field; the default objective embeds the key, so it is pinned.
    bodyOrThrow("node-a", { objective: "Land the sibling." }),
    bodyOrThrow("node-b", { objective: "Land the sibling." }),
    bodyOrThrow("node-c", {
      edges: [
        {
          edgeKey: "edge-ac",
          requirement: requirementFor({ binding, consumer: "node-c", producer: "node-a" }),
        },
        {
          edgeKey: "edge-bc",
          requirement: requirementFor({ binding, consumer: "node-c", producer: "node-b" }),
        },
      ],
    }),
  ];
}

describe("node authority recursion — the nodeKey is paired, not hashed", () => {
  it("gives two sibling nodes that differ ONLY in nodeKey the identical hash", () => {
    const result = acceptedOrThrow(fanInDraft(), fanInBodies());
    expect(result.hardEdgeCount).toBe(2);
    expect(hashOf(result, "node-a")).toBe(hashOf(result, "node-b"));
  });

  it("still separates the completion node, which differs in more than its key", () => {
    const result = acceptedOrThrow(fanInDraft(), fanInBodies());
    expect(hashOf(result, "node-c")).not.toBe(hashOf(result, "node-a"));
  });
});

describe("node authority recursion — deliberately unreachable branches", () => {
  /**
   * Two codes in the roster cannot be reached THROUGH this module's entry point, and both are
   * kept as fail-closed defences rather than deleted. Each is disclosed with the upstream that
   * answers first, and the tests below MEASURE that upstream rather than asserting the claim.
   */
  it("cannot reach CYCLE, because the graph validator refuses a cyclic snapshot first", () => {
    const cyclic = snapshotDraft();
    (cyclic["edges"] as Json[]).push({
      consumerNodeKey: "node-a", edgeKey: "edge-ca", kind: "HARD", producerNodeKey: "node-c",
    });
    const result = deriveNodeAuthoritySet(cyclic, bodies());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a cyclic snapshot was admitted");
    expect(result.issues[0]?.layer).toBe(GRAPH_LAYER);
  });

  it("cannot reach CONTRACT_DUPLICATE, because the codec refuses a duplicate edge key", () => {
    expect(() => bodies({
      "node-b": {
        edges: [
          { edgeKey: "edge-ab", requirement: requirementFor() },
          { edgeKey: "edge-ab", requirement: requirementFor() },
        ],
      },
    })).toThrow("NODE_AUTHORITY_DUPLICATE_EDGE@NODE_AUTHORITY_DEPENDENCIES");
  });

  it("advertises every code it can reach, plus exactly those two", () => {
    const unreachable = ["NODE_AUTHORITY_RECURSION_CONTRACT_DUPLICATE",
      "NODE_AUTHORITY_RECURSION_CYCLE"];
    expect(unreachable.every((code) => NODE_AUTHORITY_RECURSION_CODES.includes(
      code as (typeof NODE_AUTHORITY_RECURSION_CODES)[number]))).toBe(true);
    expect(NODE_AUTHORITY_RECURSION_CODES.length).toBe(13);
  });
});

/**
 * THE FIELD ROSTER, ASSERTED RATHER THAN NARRATED. One case per design-255 field the node section
 * of the preimage covers: move exactly that field and the node's hash must move with it. Without
 * this sweep a field can be dropped from the projection and every other test stays green — which
 * is precisely what drill G1 demonstrated on the first pass.
 *
 * `repositoryBaseTree` moves on ALL bodies because the module requires them to agree, and the
 * three derived-identity cases move a PLANNING record, which every body shares.
 */
const FIELD_CASES: readonly (readonly [string, () => unknown[]])[] = Object.freeze([
  ["admissionAmounts", (): unknown[] => bodies({
    "node-a": { patch: { admissionAmounts: admissionAmounts().map((amount) => ({
      ...amount, quantity: (amount["quantity"] as number) + 40,
    })) } },
  })],
  ["admissionGatePolicy", (): unknown[] => bodies({
    "node-a": { patch: { admissionGatePolicy: "HUMAN_APPROVAL" } },
  })],
  ["capability", (): unknown[] => bodies({ "node-a": { capability: "capability-verify" } })],
  ["joinRole+completionLinkage", (): unknown[] => bodies({
    "node-a": { joinRole: "JOIN", linkage: "node-c" },
  })],
  ["constraints", (): unknown[] => bodies({
    "node-a": { patch: { constraints: ["constraint-a", "constraint-z"] } },
  })],
  ["criterionBindings", (): unknown[] => bodies({
    "node-a": { acceptancePatch: { obligations: [{
      criterionId: "criterion-a",
      evidenceRequirements: [
        { evidenceRef: "artifact-b", kind: "ARTIFACT", requirementId: "requirement-a" },
      ],
      statement: "The node ships a DIFFERENT focused verification.",
      verificationRecipeRefs: ["recipe-a"],
    }] } },
  })],
  ["objective", (): unknown[] => bodies({ "node-a": { objective: "A different objective." } })],
  ["planExecutionContentDigest", (): unknown[] => bodies({
    "node-a": { planPatch: { steps: [
      { description: "Land the node differently.", kind: "ANALYSIS", stepId: "step-a" },
    ] } },
  })],
  ["policySliceHash", (): unknown[] => bodies({
    "node-a": { patch: { policySliceHash: hex("5") } },
  })],
  ["readScopes", (): unknown[] => bodies({
    "node-a": { patch: { readScopes: ["services/api/docs", "services/api/src"] } },
  })],
  ["repositoryBaseTree", (): unknown[] => bodies({
    "node-a": { repositoryBaseTree: hex("7") },
    "node-b": {
      edges: [{ edgeKey: "edge-ab", requirement: requirementFor() }],
      repositoryBaseTree: hex("7"),
    },
    "node-c": {
      edges: [{
        edgeKey: "edge-bc",
        requirement: requirementFor({ consumer: "node-c", producer: "node-b" }),
      }],
      repositoryBaseTree: hex("7"),
    },
  })],
  ["resources", (): unknown[] => bodies({ "node-a": { patch: { resources: ["resource-b"] } } })],
  ["verificationRecipeRevisions", (): unknown[] => bodies({
    "node-a": { patch: { verificationRecipeRevisions: ["recipe-a", "recipe-b"] } },
  })],
  ["writeScopes", (): unknown[] => bodies({
    "node-a": { patch: { writeScopes: ["services/api/src/other"] } },
  })],
]);

describe("node authority recursion — every hashed field is load-bearing", () => {
  const base = acceptedOrThrow();

  it("generates one case per field of the node section", () => {
    expect(FIELD_CASES.length).toBe(14);
    expect(new Set(FIELD_CASES.map(([name]) => name)).size).toBe(FIELD_CASES.length);
  });

  for (const [field, build] of FIELD_CASES) {
    it(`moves node-a's hash when ${field} moves`, () => {
      expect(hashOf(acceptedOrThrow(snapshotDraft(), build()), "node-a"))
        .not.toBe(hashOf(base, "node-a"));
    });
  }

  /**
   * `completionLinkage` needs its own pair. The sweep case above moves the role AND the linkage
   * together — the codec couples them (NONE demands null, JOIN demands non-null, COMPLETION
   * demands the nodeKey) — so on its own it cannot tell which of the two the preimage covers.
   * Both bodies here are JOIN; only the linkage differs.
   */
  it("moves the hash when only completionLinkage moves", () => {
    const toB = acceptedOrThrow(snapshotDraft(), bodies({
      "node-a": { joinRole: "JOIN", linkage: "node-b" },
    }));
    const toC = acceptedOrThrow(snapshotDraft(), bodies({
      "node-a": { joinRole: "JOIN", linkage: "node-c" },
    }));
    expect(hashOf(toB, "node-a")).not.toBe(hashOf(toC, "node-a"));
  });

  /**
   * `joinRole` CANNOT be isolated, and that is a property of the admission rules rather than a
   * gap here. The codec determines the legal linkage from the role, and this module requires the
   * COMPLETION role to sit on the graph's completion node — so no two admissible bodies for one
   * node differ in the role ALONE. Dropping `joinRole` from the projection is therefore an
   * equivalent mutant: it is kept because design 255 names join/completion linkage, and the
   * linkage half above is what carries the assertion.
   */
  it("cannot construct two admissible bodies differing only in joinRole", () => {
    expect(() => bodies({ "node-a": { joinRole: "JOIN", linkage: null } }))
      .toThrow("NODE_AUTHORITY_JOIN_LINKAGE_INVALID@NODE_AUTHORITY_ADMISSION");
    expectRefusal(
      derived(snapshotDraft(), bodies({ "node-a": { joinRole: "COMPLETION", linkage: "node-a" } })),
      "NODE_AUTHORITY_RECURSION_COMPLETION_LINKAGE_INVALID", RECURSION_LAYER,
    );
  });
});
