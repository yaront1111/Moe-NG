import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GRAPH_CONTENT_ISSUE_CODES,
  GRAPH_CONTENT_LAYERS,
  GRAPH_CONTENT_SCHEMA_VERSION,
  GRAPH_REVISION_CONTENT_KEYS,
  MAX_GRAPH_CONTENT_BYTES,
  decodeGraphContent,
  encodeGraphContent,
} from "./graph-content.js";
import type {
  GraphContentIssue,
  GraphContentResult,
  GraphRevisionContent,
} from "./graph-content.js";
import { GRAPH_CONTENT_HASH_DOMAIN } from "./graph-content-fields.js";
import { GRAPH_CONTENT_ISSUE_LAYER } from "./graph-content-issues.js";
import {
  SCHEMA_TAG as SCHEMA_TAG_PRODUCTION,
  SNAPSHOT_IDENTITY_DOMAIN,
} from "./graph-content-format.js";
import { validateGraphSnapshot } from "./validate-graph.js";
import { ABSOLUTE_MAX_GRAPH_NODES } from "./graph-policy.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "./graph-model.js";
import {
  devAdvisoryEdge,
  devHardEdge,
  devNode,
  devSnapshot,
} from "./test-fixtures.js";
import { createAcceptanceContract, createPlanRevision } from "@moe/core";
import { ADMISSION_PURPOSES } from "./budget/budget-reservation.js";
import { snapshotIdentityHash } from "./graph-content-format.js";
import { createNodeDefinition } from "./node-authority/node-authority-codec.js";
import {
  NODE_AUTHORITY_LIMITS,
  canonicalText,
} from "./node-authority/node-authority-contract.js";
import { deriveNodeAuthoritySet } from "./node-authority/node-authority-recursion.js";

/**
 * WHERE THE COMPLETION NODE LIVES, decided once and recorded here because two
 * statements of one fact are how they start disagreeing.
 *
 * `completionNodeKey` is ALREADY inside the canonical node/edge set: the graph
 * kernel frames it into `graphIdentity` (`graph-internal.ts`, the `"C" + frame(...)`
 * token) and the codec serializes it inside the snapshot. Design 197 nevertheless
 * names "completion node" as its own `GraphRevisionContent` field, so it IS
 * declared as one — as the AUTHOR'S DECLARATION of which node completes the
 * revision — and the codec refuses any disagreement with the graph the kernel
 * accepted under `GRAPH_CONTENT_COMPLETION_DRIFT` / `GRAPH_CONTENT_IDENTITY`.
 * There is therefore exactly one authority (the validated graph) and one place
 * that reconciles the declaration against it.
 *
 * HONEST CONSEQUENCE, stated so no later reader mistakes it for an oversight:
 * because the declaration is pinned equal to the graph's own value, that field's
 * contribution to the digest is functionally determined by the snapshot field.
 * Its per-field sweep case below therefore CO-VARIES with the snapshot by
 * construction — the kernel makes an independent variation unrepresentable — and
 * the field's real authority is pinned by the dedicated drift-refusal case, not
 * by its hash-difference case. The mutation drills in step 7 target
 * independently-variable fields, where a dropped field is genuinely observable.
 */

// --- fixtures ----------------------------------------------------------------

/**
 * Three nodes, two HARD edges into the completion node plus one ADVISORY edge.
 * Deliberately shaped so a mutation can flip the advisory edge, re-point it, or
 * add a fourth node WITHOUT breaking completion closure — a mutation that makes
 * the graph invalid would prove nothing about identity.
 */
function baseNodes(): GraphNode[] {
  return [devNode("dev-a"), devNode("dev-b"), devNode("dev-c")];
}

function baseEdges(): GraphEdge[] {
  return [
    devHardEdge("dev-e1", "dev-a", "dev-c"),
    devHardEdge("dev-e2", "dev-b", "dev-c"),
    devAdvisoryEdge("dev-e3", "dev-a", "dev-b"),
  ];
}

function baseSnapshot(): GraphSnapshot {
  return devSnapshot(baseNodes(), baseEdges(), "dev-c");
}

// --- node authority fixtures (design 255) ------------------------------------

/**
 * Mirrored minimally from `node-authority-recursion.test.ts`, whose builders are
 * not exported. Every body is built by PRODUCTION code — `createPlanRevision`,
 * `createAcceptanceContract`, `createNodeDefinition` — and every authority hash
 * by `deriveNodeAuthoritySet`, so nothing here restates a rule it then checks.
 */
type Json = Record<string, unknown>;

const hex = (digit: string): string => digit.repeat(64);
const PURPOSE_ORDER = Object.freeze([...ADMISSION_PURPOSES].sort());

const planDraft = (nodeIds: readonly string[]): Json => ({
  affectedCriterionIds: ["criterion-a"],
  affectedNodeIds: [...nodeIds],
  approvalState: "APPROVED",
  authorRef: "principal-a",
  graphBinding: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null,
  rejectionRef: null,
  revisionId: "plan-revision-a",
  steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-a" }],
  verificationRecipeRefs: ["recipe-a", "recipe-b"],
});

const acceptanceDraft = (nodeIds: readonly string[]): Json => ({
  applicability: {
    graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a",
    nodeIds: [...nodeIds], nodeKind: "LEAF",
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
  readonly binding: string;
  readonly consumer: string;
  readonly contractHash?: string;
  readonly producer: string;
  readonly witnessDigest?: string;
}

const dependencyContract = (options: ContractOptions): Json => ({
  alternateProducers: [] as string[],
  alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
  consumer: {
    contractHash: options.contractHash ?? hex("c"),
    criterionRef: "criterion-a",
    kind: "PRECONDITION",
  },
  consumerNodeKey: options.consumer,
  consumptionHorizon: "RESULT_SEAL",
  edgeKind: "ARTIFACT_CONSUMPTION",
  graphBindingDigest: options.binding,
  invalidationFacts: [{ sourceFactDigest: hex("e"), sourceFactRef: "fact-a", sourceFactVersion: 1 }],
  minimumQualifyingMilestone: "RESULT_SEALED",
  necessity: {
    failedConsumerCriterionRef: "criterion-a", failureKind: "MISSING_ARTIFACT",
    truthClass: "OBSERVED",
  },
  producer: { artifactOrInterfaceRef: "artifact-a", digest: hex("f"), kind: "ARTIFACT_CONSUMPTION" },
  producerNodeKey: options.producer,
  recheckPredicateRef: "predicate-a",
  satisfactionPredicate: {
    parametersDigest: hex("1"), predicateRef: "predicate-a", schemaId: "schema-a",
    schemaVersion: 1,
  },
  satisfactionWitnesses: [{
    sourceOperationClass: "ARTIFACT_SEAL", witnessDigest: options.witnessDigest ?? hex("2"),
    witnessRef: "witness-a", witnessVersion: 1,
  }],
  stability: "MONOTONIC",
  truthClass: "OBSERVED",
});

const requirementFor = (options: ContractOptions): Json => ({
  contract: dependencyContract(options), edgeKind: "ARTIFACT_CONSUMPTION",
});

interface BodyOptions {
  readonly edges?: Json[];
  /** Merged last, so a case can move ONE design-255 field with no bespoke knob. */
  readonly patch?: Json;
  readonly scopeEntries?: number;
  /** Grows each read scope toward its own byte ceiling, for the boundary search. */
  readonly wideScopes?: boolean;
}

function nodeDraft(nodeKey: string, completion: string, options: BodyOptions = {}): Json {
  const pad = options.wideScopes === true ? "/".concat("s".repeat(960)) : "";
  const scopes = Array.from(
    { length: options.scopeEntries ?? 1 },
    (_unused, index) => `services/api/src/${index}${pad}`,
  );
  return {
    admissionAmounts: PURPOSE_ORDER.map((purpose, index) => ({
      meter: "runner.authorized_ms", purpose, quantity: index + 1,
    })),
    admissionGatePolicy: "POLICY_ALLOWANCE",
    capability: "capability-implement",
    completionLinkage: nodeKey === completion ? nodeKey : null,
    constraints: ["constraint-a"],
    directHardDependencies: options.edges ?? [],
    joinRole: nodeKey === completion ? "COMPLETION" : "NONE",
    nodeKey,
    objective: `Land ${nodeKey}.`,
    policySliceHash: hex("3"),
    readScopes: scopes,
    repositoryBaseTree: hex("4"),
    resources: ["resource-a"],
    verificationRecipeRevisions: ["recipe-a"],
    writeScopes: ["services/api/src/node"],
    ...options.patch,
  };
}

function bodyOrThrow(
  nodeKey: string, completion: string, nodeIds: readonly string[], options: BodyOptions = {},
): unknown {
  const plan = createPlanRevision(planDraft(nodeIds));
  if (!plan.ok) throw new Error(`plan fixture refused: ${plan.code}`);
  const acceptance = createAcceptanceContract(acceptanceDraft(nodeIds));
  if (!acceptance.ok) throw new Error(`acceptance fixture refused: ${acceptance.code}`);
  const built = createNodeDefinition({
    acceptanceContract: acceptance.contract,
    draft: nodeDraft(nodeKey, completion, options),
    planRevision: plan.revision,
    predicateRegistry: [registryEntry()],
  });
  if (!built.ok) {
    throw new Error(built.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return built.value.definition;
}

interface SnapshotShape {
  readonly completionNodeKey: string;
  readonly edges: readonly GraphEdge[];
  readonly nodes: readonly GraphNode[];
}

/**
 * One admitted body per node, carrying a contract for every HARD edge that ENTERS
 * it, in the canonical nodeKey order the codec's own reader requires.
 */
function definitionsFor(
  graph: SnapshotShape,
  binding: string,
  overrides: Readonly<Record<string, BodyOptions>> = {},
): unknown[] {
  const nodeIds = graph.nodes.map((node) => node.nodeKey);
  return [...nodeIds].sort().map((nodeKey) => bodyOrThrow(
    nodeKey, graph.completionNodeKey, nodeIds,
    {
      edges: graph.edges
        .filter((edge) => edge.kind === "HARD" && edge.consumerNodeKey === nodeKey)
        .map((edge) => ({
          edgeKey: edge.edgeKey,
          requirement: requirementFor({
            binding, consumer: edge.consumerNodeKey, producer: edge.producerNodeKey,
          }),
        })),
      ...overrides[nodeKey],
    },
  ));
}

/**
 * Shape-valid and semantically inert: the fixtures that feed the codec a snapshot
 * the KERNEL must refuse still have to clear the field reader, or every one of
 * them would report a field failure instead of the validator's own verdict.
 */
const inertSection = (): Json => ({
  authorities: [{ nodeAuthorityHash: hex("0"), nodeKey: "dev-a" }],
  definitions: [{ nodeKey: "dev-a" }],
});

const SECTION_CACHE = new Map<string, string>();

/**
 * The mandatory v3 section for a snapshot: production-built bodies and the
 * production-DERIVED authority set, never a hand-written hash. Cached by graph
 * identity because every accepted-path case in this file needs one, and handed
 * back as a fresh clone so a case that mutates it cannot poison a later one.
 */
function authorityFor(
  snapshot: unknown,
  policyOverride?: unknown,
  overrides: Readonly<Record<string, BodyOptions>> = {},
): Json {
  const validated = validateGraphSnapshot(snapshot, policyOverride);
  if (!validated.ok) return inertSection();
  const key = `${validated.graph.graphIdentity}|${JSON.stringify(overrides)}`;
  const cached = SECTION_CACHE.get(key);
  if (cached !== undefined) return JSON.parse(cached) as Json;
  const definitions = definitionsFor(
    validated.graph, snapshotIdentityHash(validated.graph), overrides,
  );
  const derived = deriveNodeAuthoritySet(snapshot, definitions, policyOverride);
  if (!derived.ok) {
    throw new Error(derived.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  const section = { authorities: derived.value, definitions };
  SECTION_CACHE.set(key, JSON.stringify(section));
  return JSON.parse(JSON.stringify(section)) as Json;
}

/**
 * The six non-snapshot design-197 fields. `parentRevision` is a PRESENT ref here
 * so the absent form is exercised as a deliberate variation rather than as the
 * default nobody ever varies.
 */
const BASE_TREE = "4".repeat(40);
const BASE_PARENT = "rev-000000000000";
const BASE_POLICY_REVISION = "pol-000000000001";
const BASE_AUTHOR = "human:architect-2cc07e26";
/** Design 405's default active-graph node allowance. */
const BASE_BUDGET = 24;

function contentOf(
  snapshot: unknown,
  patch: Partial<Record<string, unknown>> = {},
  policyOverride?: unknown,
): GraphRevisionContent {
  return {
    author: BASE_AUTHOR,
    completionNode: "dev-c",
    decompositionBudget: BASE_BUDGET,
    // Derived from the EFFECTIVE snapshot by the production composer, so a case
    // that patches the graph moves its bodies with it instead of falling out of
    // closure; a case that patches the section itself still wins, below.
    nodeAuthority: authorityFor(
      "snapshot" in patch ? patch["snapshot"] : snapshot, policyOverride,
    ),
    parentRevision: BASE_PARENT,
    policyRevision: BASE_POLICY_REVISION,
    repositoryBaseTree: BASE_TREE,
    snapshot,
    ...patch,
  } as unknown as GraphRevisionContent;
}

/**
 * Every pre-existing structural assertion in this file varies the SNAPSHOT only,
 * so it goes through this wrapper: the other six fields are held constant and any
 * hash difference it observes is attributable to structure alone.
 */
function encodeSnapshot(snapshot: unknown, policyOverride?: unknown): GraphContentResult {
  // The declaration is pinned equal to the graph's own completion node, so a
  // fixture that moves the completion node must move the declaration with it —
  // otherwise every such case would refuse as drift and prove nothing structural.
  const declared = (snapshot as { completionNodeKey?: unknown } | null | undefined)
    ?.completionNodeKey;
  const patch = typeof declared === "string" ? { completionNode: declared } : {};
  return encodeGraphContent(contentOf(snapshot, patch, policyOverride), policyOverride);
}

const DECODER = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();

function textOf(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

function okValue(result: GraphContentResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

function pairsOf(result: GraphContentResult): readonly (readonly [string, string])[] {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected a refusal, got an accepted value");
  }
  return result.issues.map(
    (issue: GraphContentIssue) => [issue.code, issue.layer] as const,
  );
}

const SCHEMA_TAG = "MOE-GRAPH-CONTENT/3";
const HASH_A = "a".repeat(64);

/**
 * The inert section spelled canonically, so a hand-built envelope still clears the
 * field reader and reaches the gate its case is actually about.
 */
const INERT_SECTION_JSON =
  `{"authorities":[{"nodeAuthorityHash":"${hex("0")}","nodeKey":"dev-a"}],`
  + `"definitions":[{"nodeKey":"dev-a"}]}`;

/** Canonical content JSON — alphabetical keys, no whitespace — around a raw snapshot. */
function contentJson(snapshotJson: string, completionNode = "dev-a"): string {
  return `{"author":"${BASE_AUTHOR}","completionNode":"${completionNode}",`
    + `"decompositionBudget":${BASE_BUDGET},"nodeAuthority":${INERT_SECTION_JSON},`
    + `"parentRevision":"${BASE_PARENT}",`
    + `"policyRevision":"${BASE_POLICY_REVISION}",`
    + `"repositoryBaseTree":"${BASE_TREE}","snapshot":${snapshotJson}}`;
}

/** A hand-built envelope, for refusals that must be reached before any encoder runs. */
function rawEnvelope(
  snapshotJson: string,
  extra = "",
  hash = HASH_A,
  schema = SCHEMA_TAG,
): string {
  return `{"schema":"${schema}","hash":"${hash}",`
    + `"content":${contentJson(snapshotJson)}${extra}}`;
}

const EMPTY_SNAPSHOT_JSON =
  "{\"nodes\":[],\"edges\":[],\"completionNodeKey\":\"dev-a\"}";

/** Every ordering of a 3-element list, so ordering coverage is exhaustive. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      out.push([items[index]!, ...tail]);
    }
  }
  return out;
}

// --- accepted encoding -------------------------------------------------------

describe("encodeGraphContent — accepted canonical identity", () => {
  it("returns a frozen envelope with a domain-separated lowercase sha-256 hash", () => {
    const value = okValue(encodeSnapshot(baseSnapshot()));

    expect(value.schemaVersion).toBe(GRAPH_CONTENT_SCHEMA_VERSION);
    expect(value.graphContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.content.snapshot)).toBe(true);
    expect(Object.isFrozen(value.content.snapshot.nodes)).toBe(true);
    expect(Object.isFrozen(value.content.snapshot.nodes[0])).toBe(true);
    expect(Object.isFrozen(value.content.snapshot.edges[0])).toBe(true);
  });

  it("is NOT the raw graphIdentity string — the hash is a digest over it", () => {
    const validated = validateGraphSnapshot(baseSnapshot());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const value = okValue(encodeSnapshot(baseSnapshot()));
    expect(value.graphContentHash).not.toBe(validated.graph.graphIdentity);
    expect(textOf(value.bytes)).not.toContain(validated.graph.graphIdentity);
  });

  it("emits canonical sorted snapshot content, not caller order", () => {
    const reversed = devSnapshot(
      [...baseNodes()].reverse(),
      [...baseEdges()].reverse(),
      "dev-c",
    );
    const value = okValue(encodeSnapshot(reversed));
    expect(value.content.snapshot.nodes.map((node) => node.nodeKey))
      .toEqual(["dev-a", "dev-b", "dev-c"]);
    expect(value.content.snapshot.edges.map((edge) => edge.edgeKey))
      .toEqual(["dev-e1", "dev-e2", "dev-e3"]);
  });

  it("serializes one fixed-key envelope with no whitespace", () => {
    const value = okValue(encodeSnapshot(baseSnapshot()));
    const text = textOf(value.bytes);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["schema", "hash", "content"]);
    const content = parsed["content"] as Record<string, unknown>;
    // Asserted against the production key list, not a hand-copied one, so a
    // field added to the contract without being serialized fails here.
    expect(Object.keys(content)).toEqual([...GRAPH_REVISION_CONTENT_KEYS]);
    expect(Object.keys(content["snapshot"] as Record<string, unknown>))
      .toEqual(["nodes", "edges", "completionNodeKey"]);
    expect(text).not.toMatch(/[\n\t]|: |, /u);
    expect(text.startsWith("{\"schema\":")).toBe(true);
    // The digest domains are digest-only: serializing one would make the wire
    // tag and the hash domain impossible to rotate independently.
    expect(text).toContain(SCHEMA_TAG);
    expect(text).not.toContain("MOE-GRAPH-CONTENT-HASH");
    expect(text).not.toContain("MOE-GRAPH-SNAPSHOT-IDENTITY");
  });

  it("hands back detached bytes a caller cannot use to corrupt a later call", () => {
    const first = okValue(encodeSnapshot(baseSnapshot()));
    // Non-empty typed arrays cannot be frozen (TypeError: Cannot freeze array
    // buffer views with elements), so the contract is "frozen envelope, COPIED
    // bytes". Detachment is what a freeze would otherwise have bought.
    first.bytes[0] = 0x00;
    const second = okValue(encodeSnapshot(baseSnapshot()));
    expect(second.bytes[0]).toBe("{".charCodeAt(0));
    expect(second.bytes).not.toBe(first.bytes);
    expect(second.bytes.buffer).not.toBe(first.bytes.buffer);
  });

  it("ignores caller mutation of the input arrays after the call returns", () => {
    const nodes = baseNodes();
    const snapshot = devSnapshot(nodes, baseEdges(), "dev-c");
    const value = okValue(encodeSnapshot(snapshot));
    const before = value.graphContentHash;
    nodes.push(devNode("dev-z"));
    expect(value.content.snapshot.nodes).toHaveLength(3);
    expect(value.graphContentHash).toBe(before);
  });
});

// --- ordering and structural sensitivity -------------------------------------

describe("encodeGraphContent — ordering is not content, structure is", () => {
  it("encodes every node/edge ordering to byte-identical output", () => {
    const orderings = permutations(baseNodes())
      .flatMap((nodes) => permutations(baseEdges()).map((edges) => ({ nodes, edges })));
    // 3! node orderings x 3! edge orderings. A sweep that produced zero cases
    // would pass every assertion below, so the count is asserted first.
    expect(orderings).toHaveLength(36);

    const expected = okValue(encodeSnapshot(baseSnapshot()));
    for (const { nodes, edges } of orderings) {
      const value = okValue(encodeSnapshot(devSnapshot(nodes, edges, "dev-c")));
      expect(textOf(value.bytes)).toBe(textOf(expected.bytes));
      expect(value.graphContentHash).toBe(expected.graphContentHash);
    }
  });

  const STRUCTURAL_MUTATIONS: readonly (readonly [string, () => GraphSnapshot])[] = [
    ["node execution bearing flipped", () => devSnapshot(
      [devNode("dev-a", false), devNode("dev-b"), devNode("dev-c")],
      baseEdges(), "dev-c")],
    ["advisory edge promoted to hard", () => devSnapshot(
      baseNodes(),
      [...baseEdges().slice(0, 2), devHardEdge("dev-e3", "dev-a", "dev-b")],
      "dev-c")],
    ["advisory edge re-pointed", () => devSnapshot(
      baseNodes(),
      [...baseEdges().slice(0, 2), devAdvisoryEdge("dev-e3", "dev-b", "dev-a")],
      "dev-c")],
    ["edge key renamed", () => devSnapshot(
      baseNodes(),
      [...baseEdges().slice(0, 2), devAdvisoryEdge("dev-e9", "dev-a", "dev-b")],
      "dev-c")],
    ["node added with a hard edge", () => devSnapshot(
      [...baseNodes(), devNode("dev-d")],
      [...baseEdges(), devHardEdge("dev-e4", "dev-d", "dev-c")],
      "dev-c")],
    ["completion node changed", () => devSnapshot(
      [devNode("dev-a"), devNode("dev-b")],
      [devHardEdge("dev-e1", "dev-a", "dev-b")],
      "dev-b")],
  ];

  it("gives every structurally distinct graph a distinct identity", () => {
    expect(STRUCTURAL_MUTATIONS.length).toBeGreaterThan(0);
    const base = okValue(encodeSnapshot(baseSnapshot()));
    const seen = new Map<string, string>([[base.graphContentHash, "base"]]);
    for (const [label, build] of STRUCTURAL_MUTATIONS) {
      const value = okValue(encodeSnapshot(build()));
      expect(value.graphContentHash).not.toBe(base.graphContentHash);
      expect(textOf(value.bytes)).not.toBe(textOf(base.bytes));
      const collision = seen.get(value.graphContentHash);
      expect(collision, `${label} collided with ${collision ?? ""}`).toBeUndefined();
      seen.set(value.graphContentHash, label);
    }
    expect(seen.size).toBe(STRUCTURAL_MUTATIONS.length + 1);
  });

  const POLICY_OVERRIDES: readonly (readonly [string, unknown])[] = [
    ["undefined", undefined],
    ["raised node ceiling", { maxNodes: ABSOLUTE_MAX_GRAPH_NODES }],
    ["raised edge ceilings", { maxHardEdges: 128, maxTotalEdges: 128 }],
    ["raised review threshold", { minGatedDescendantsForReview: 3 }],
  ];

  it("excludes policy from content identity exactly as graphIdentity does", () => {
    expect(POLICY_OVERRIDES.length).toBeGreaterThan(0);
    const expected = okValue(encodeSnapshot(baseSnapshot()));
    for (const [label, override] of POLICY_OVERRIDES) {
      const value = okValue(encodeSnapshot(baseSnapshot(), override));
      expect(value.graphContentHash, label).toBe(expected.graphContentHash);
      expect(textOf(value.bytes), label).toBe(textOf(expected.bytes));
    }
  });
});

// --- round trip --------------------------------------------------------------

describe("decodeGraphContent — accepted round trip", () => {
  it("returns the canonical snapshot and the same hash", () => {
    const encoded = okValue(encodeSnapshot(baseSnapshot()));
    const decoded = okValue(decodeGraphContent(encoded.bytes));

    expect(decoded.graphContentHash).toBe(encoded.graphContentHash);
    expect(decoded.content.snapshot).toEqual(encoded.content.snapshot);
    expect(decoded.schemaVersion).toBe(GRAPH_CONTENT_SCHEMA_VERSION);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.content.snapshot.nodes[0])).toBe(true);
  });

  it("re-encodes to the same bytes it accepted", () => {
    const encoded = okValue(encodeSnapshot(baseSnapshot()));
    const decoded = okValue(decodeGraphContent(encoded.bytes));
    expect(textOf(decoded.bytes)).toBe(textOf(encoded.bytes));
    const again = okValue(encodeSnapshot(decoded.content.snapshot));
    expect(again.graphContentHash).toBe(encoded.graphContentHash);
  });

  it("accepts a caller Buffer and detaches from the caller's memory", () => {
    const encoded = okValue(encodeSnapshot(baseSnapshot()));
    const caller = Buffer.from(encoded.bytes);
    const decoded = okValue(decodeGraphContent(caller));
    expect(decoded.graphContentHash).toBe(encoded.graphContentHash);
    // Buffer.prototype.slice aliases; a decoder that kept the caller's view
    // would change identity under the caller's feet.
    caller[10] = 0x20;
    expect(textOf(decoded.bytes)).toBe(textOf(encoded.bytes));
  });
});

// --- refusals ----------------------------------------------------------------

describe("decodeGraphContent — fails closed on exact code and layer", () => {
  function canonicalText(): string {
    return textOf(okValue(encodeSnapshot(baseSnapshot())).bytes);
  }

  const NOT_BYTES: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["undefined", undefined],
    ["string", "{}"],
    ["number", 7],
    ["plain object", {}],
    ["array of byte values", [123, 125]],
    ["ArrayBuffer", new ArrayBuffer(2)],
    ["DataView", new DataView(new ArrayBuffer(2))],
    ["Int8Array", new Int8Array(2)],
    ["proxy over bytes", new Proxy(new Uint8Array([1]), {})],
    ["record wearing a length", { length: 1, 0: 123 }],
  ];

  it("refuses every non-byte input as GRAPH_CONTENT_NOT_BYTES", () => {
    expect(NOT_BYTES.length).toBeGreaterThan(0);
    for (const [label, input] of NOT_BYTES) {
      expect(pairsOf(decodeGraphContent(input)), label)
        .toEqual([["GRAPH_CONTENT_NOT_BYTES", "GRAPH_CONTENT_CODEC"]]);
    }
  });

  it("refuses bytes past the ceiling before decoding them", () => {
    const oversized = new Uint8Array(MAX_GRAPH_CONTENT_BYTES + 1);
    expect(pairsOf(decodeGraphContent(oversized)))
      .toEqual([["GRAPH_CONTENT_TOO_LARGE", "GRAPH_CONTENT_CODEC"]]);
  });

  const UNREADABLE: readonly (readonly [string, Uint8Array])[] = [
    ["empty", new Uint8Array(0)],
    ["invalid utf-8 lead byte", new Uint8Array([0xff, 0xfe, 0xfd])],
    ["truncated utf-8 sequence", new Uint8Array([0x7b, 0xc3])],
    ["lone surrogate encoding", new Uint8Array([0xed, 0xa0, 0x80])],
    ["not json", ENCODER.encode("nope")],
    ["truncated json", ENCODER.encode("{\"schema\":")],
    ["trailing content after json", ENCODER.encode("{} {}")],
  ];

  it("refuses unreadable bytes as GRAPH_CONTENT_UNREADABLE", () => {
    expect(UNREADABLE.length).toBeGreaterThan(0);
    for (const [label, input] of UNREADABLE) {
      expect(pairsOf(decodeGraphContent(input)), label)
        .toEqual([["GRAPH_CONTENT_UNREADABLE", "GRAPH_CONTENT_CODEC"]]);
    }
  });

  const MALFORMED: readonly (readonly [string, string])[] = [
    ["json null", "null"],
    ["json array", "[]"],
    ["json scalar", "42"],
    ["missing hash", `{"schema":"${SCHEMA_TAG}","content":{}}`],
    ["missing content", `{"schema":"${SCHEMA_TAG}","hash":"${HASH_A}"}`],
    ["snapshot in place of content", `{"schema":"${SCHEMA_TAG}","hash":"${HASH_A}",`
      + `"snapshot":${EMPTY_SNAPSHOT_JSON}}`],
    ["extra envelope key", rawEnvelope(EMPTY_SNAPSHOT_JSON, ",\"extra\":1")],
    ["hash not hex", rawEnvelope(EMPTY_SNAPSHOT_JSON, "", "Z".repeat(64))],
    ["hash uppercase", rawEnvelope(EMPTY_SNAPSHOT_JSON, "", "A".repeat(64))],
    ["hash wrong length", rawEnvelope(EMPTY_SNAPSHOT_JSON, "", "a".repeat(63))],
    ["prototype pollution key",
      rawEnvelope(EMPTY_SNAPSHOT_JSON, ",\"__proto__\":{\"x\":1}")],
  ];

  it("refuses a malformed envelope as GRAPH_CONTENT_MALFORMED", () => {
    expect(MALFORMED.length).toBeGreaterThan(0);
    for (const [label, text] of MALFORMED) {
      expect(pairsOf(decodeGraphContent(ENCODER.encode(text))), label)
        .toEqual([["GRAPH_CONTENT_MALFORMED", "GRAPH_CONTENT_CODEC"]]);
    }
  });

  const UNSUPPORTED_TAGS: readonly (readonly [string, string])[] = [
    // The version-1 wire shape carried a structure-only hash under the name
    // `graphContentHash`, and version-2 authenticated no node body at all.
    // Reinterpreting either under version-3 rules is how a weaker identity would
    // survive disguised as content authority, so the tag bump is load-bearing and
    // this is the refusal that proves it.
    ["the retired version-1 tag", "MOE-GRAPH-CONTENT/1"],
    ["the retired version-2 tag", "MOE-GRAPH-CONTENT/2"],
    ["a future tag", "MOE-GRAPH-CONTENT/4"],
    ["the hash domain used as a wire tag", "MOE-GRAPH-CONTENT-HASH/3"],
  ];

  it("refuses an unsupported schema tag, version-1 bytes included", () => {
    expect(UNSUPPORTED_TAGS.length).toBeGreaterThan(0);
    for (const [label, tag] of UNSUPPORTED_TAGS) {
      const text = canonicalText().replace(`"${SCHEMA_TAG}"`, `"${tag}"`);
      expect(text, label).not.toBe(canonicalText());
      expect(pairsOf(decodeGraphContent(ENCODER.encode(text))), label)
        .toEqual([["GRAPH_CONTENT_UNSUPPORTED_SCHEMA", "GRAPH_CONTENT_CODEC"]]);
    }
  });

  it("preserves the graph validator's own code and layer, unrestamped", () => {
    // Scoped to the snapshot on purpose: `nodeAuthority` sorts BEFORE `snapshot`,
    // so an unscoped first-occurrence replace would now land on an embedded
    // contract's edgeKey and be answered by the composer instead of the kernel.
    const original = canonicalText();
    const at = original.indexOf("\"snapshot\":");
    expect(at).toBeGreaterThan(0);
    const text = original.slice(0, at)
      + original.slice(at).replace("\"dev-e2\"", "\"dev-e1\"");
    expect(text).not.toBe(original);
    const pairs = pairsOf(decodeGraphContent(ENCODER.encode(text)));
    expect(pairs.map(([code]) => code)).toContain("GRAPH_DUPLICATE_EDGE");
    for (const [code, layer] of pairs) {
      expect(layer).toBe("GRAPH_VALIDATION");
      // The codec must not restamp a structural failure as one of its own.
      expect(GRAPH_CONTENT_ISSUE_CODES).not.toContain(code);
    }
  });

  it("routes a structurally impossible snapshot to the validator, not the codec", () => {
    // The envelope is well formed, so the refusal must come from the graph
    // kernel with its own code — a codec-layer answer here would mean the
    // codec had taken over a judgement that is not its to make.
    expect(pairsOf(decodeGraphContent(ENCODER.encode(rawEnvelope("7")))))
      .toEqual([["GRAPH_MALFORMED_SNAPSHOT", "GRAPH_VALIDATION"]]);
  });

  it("refuses a digest that does not match the content it claims", () => {
    const encoded = okValue(encodeSnapshot(baseSnapshot()));
    const text = textOf(encoded.bytes).replace(encoded.graphContentHash, "b".repeat(64));
    expect(pairsOf(decodeGraphContent(ENCODER.encode(text))))
      .toEqual([["GRAPH_CONTENT_DIGEST_MISMATCH", "GRAPH_CONTENT_IDENTITY"]]);
  });

  it("refuses a swapped value whose bytes are still perfectly canonical", () => {
    // Same spelling, different content: re-encoding this input reproduces it
    // byte for byte, so ONLY the digest recomputation can catch it.
    const swapped = devSnapshot(
      [devNode("dev-a", false), devNode("dev-b"), devNode("dev-c")],
      baseEdges(), "dev-c",
    );
    const honest = okValue(encodeSnapshot(baseSnapshot()));
    const forged = okValue(encodeSnapshot(swapped));
    const text = textOf(forged.bytes).replace(
      forged.graphContentHash,
      honest.graphContentHash,
    );
    expect(pairsOf(decodeGraphContent(ENCODER.encode(text))))
      .toEqual([["GRAPH_CONTENT_DIGEST_MISMATCH", "GRAPH_CONTENT_IDENTITY"]]);
  });

  it("refuses every alternate spelling of correct content", () => {
    const canonical = canonicalText();
    // Each variant parses to the SAME content, so its digest recomputes
    // correctly and only the byte re-encode comparison can reject it.
    const variants: readonly (readonly [string, string])[] = [
      ["leading whitespace", ` ${canonical}`],
      ["trailing newline", `${canonical}\n`],
      ["spaced after colon", canonical.replace("{\"schema\":", "{\"schema\": ")],
      ["reordered envelope keys", canonical
        .replace(/^\{"schema":("[^"]*"),"hash":("[^"]*"),/u, "{\"hash\":$2,\"schema\":$1,")],
      ["duplicate schema key", canonical
        .replace("{\"schema\":", "{\"schema\":\"MOE-GRAPH-CONTENT/2\",\"schema\":")],
      ["escaped ascii key", canonical.replace("\"nodes\"", "\"\\u006eodes\"")],
    ];
    expect(variants.length).toBeGreaterThan(0);
    for (const [label, text] of variants) {
      expect(text, label).not.toBe(canonical);
      expect(pairsOf(decodeGraphContent(ENCODER.encode(text))), label)
        .toEqual([["GRAPH_CONTENT_NONCANONICAL", "GRAPH_CONTENT_IDENTITY"]]);
    }
  });

  it("refuses a single flipped raw byte", () => {
    const encoded = okValue(encodeSnapshot(baseSnapshot()));
    const mutated = new Uint8Array(encoded.bytes);
    mutated[mutated.length - 2] = 0x20;
    const pairs = pairsOf(decodeGraphContent(mutated));
    expect(pairs).toHaveLength(1);
    expect(GRAPH_CONTENT_ISSUE_CODES).toContain(pairs[0]![0]);
  });
});

// --- bounds and text handling ------------------------------------------------

describe("graph content bounds", () => {
  /**
   * MAX_GRAPH_CONTENT_BYTES is arithmetic derived from the kernel's absolute
   * ceilings. If that arithmetic is too tight the codec cannot decode a graph
   * the validator accepts — a ceiling nothing else would catch, because every
   * other fixture here is tiny.
   */
  it("encodes and decodes a graph at the kernel's absolute ceilings", () => {
    const longKey = (prefix: string, index: number): string => {
      const stem = `${prefix}${index}-`;
      return stem + "k".repeat(128 - stem.length);
    };
    const nodes = Array.from({ length: 64 }, (_unused, index) =>
      devNode(longKey("dev-n", index)));
    const completion = nodes[0]!.nodeKey;
    const edges: GraphEdge[] = nodes.slice(1).map((node, index) =>
      devHardEdge(longKey("dev-h", index), node.nodeKey, completion));
    while (edges.length < 128) {
      const index = edges.length;
      edges.push(devAdvisoryEdge(
        longKey("dev-x", index), nodes[1]!.nodeKey, nodes[2]!.nodeKey,
      ));
    }
    expect([nodes.length, edges.length]).toEqual([64, 128]);
    expect(nodes[0]!.nodeKey).toHaveLength(128);

    const policy = { maxNodes: 64, maxHardEdges: 128, maxTotalEdges: 128 };
    const encoded = okValue(encodeSnapshot(
      devSnapshot(nodes, edges, completion), policy,
    ));
    expect(encoded.bytes.length).toBeLessThanOrEqual(MAX_GRAPH_CONTENT_BYTES);
    // Not a vacuous headroom check: the worst case must genuinely be large.
    expect(encoded.bytes.length).toBeGreaterThan(60_000);
    const decoded = okValue(decodeGraphContent(encoded.bytes));
    expect(decoded.graphContentHash).toBe(encoded.graphContentHash);
  });

  it("refuses a deeply nested json bomb without throwing", () => {
    const depth = 200_000;
    const bomb = ENCODER.encode("[".repeat(depth) + "]".repeat(depth));
    const result = decodeGraphContent(bomb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either ceiling or parse refusal is correct; a THROW is not.
    expect(GRAPH_CONTENT_ISSUE_CODES).toContain(result.issues[0]?.code);
    expect(result.issues[0]?.layer).toBe("GRAPH_CONTENT_CODEC");
  });

  it("never normalizes a non-ascii key — it refuses it at the validator", () => {
    // A codec that NFC/NFD-normalized keys would give one graph two identities.
    const text = rawEnvelope("{\"nodes\":[{\"nodeKey\":\"dev-\\u00e9\","
      + "\"executionBearing\":true}],\"edges\":[],"
      + "\"completionNodeKey\":\"dev-\\u00e9\"}");
    const pairs = pairsOf(decodeGraphContent(ENCODER.encode(text)));
    for (const [code, layer] of pairs) {
      expect(layer).toBe("GRAPH_VALIDATION");
      expect(GRAPH_CONTENT_ISSUE_CODES).not.toContain(code);
    }
    expect(pairs.length).toBeGreaterThan(0);
  });
});

// --- hostile encode input ----------------------------------------------------

describe("encodeGraphContent — hostile input never reaches the hash", () => {
  const HOSTILE: readonly (readonly [string, () => unknown, string])[] = [
    ["proxy snapshot", () => new Proxy(baseSnapshot(), {}), "GRAPH_MALFORMED_SNAPSHOT"],
    ["proxy node list", () => devSnapshot(
      new Proxy(baseNodes(), {}) as GraphNode[], baseEdges(), "dev-c"),
      "GRAPH_MALFORMED_SNAPSHOT"],
    ["subclassed node list", () => devSnapshot(
      Object.setPrototypeOf(baseNodes(), Object.create(Array.prototype)) as GraphNode[],
      baseEdges(), "dev-c"), "GRAPH_MALFORMED_SNAPSHOT"],
    ["record wearing a length", () => ({
      nodes: { length: 1, 0: devNode("dev-a") },
      edges: [], completionNodeKey: "dev-a",
    }), "GRAPH_MALFORMED_SNAPSHOT"],
    ["extra envelope key", () => ({ ...baseSnapshot(), extra: 1 }),
      "GRAPH_MALFORMED_SNAPSHOT"],
    ["accessor node element", () => {
      const nodes = baseNodes();
      Object.defineProperty(nodes, "0", {
        get: () => devNode("dev-a"), configurable: true,
      });
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["accessor node key", () => {
      const nodes = baseNodes();
      nodes[0] = Object.defineProperty(
        { executionBearing: true } as unknown as GraphNode,
        "nodeKey",
        { get: () => "dev-a", enumerable: true },
      );
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["symbol key on a node", () => {
      const nodes = baseNodes();
      (nodes[0] as unknown as Record<symbol, unknown>)[Symbol("x")] = 1;
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["extra node key", () => {
      const nodes = baseNodes();
      nodes[0] = { ...devNode("dev-a"), extra: 1 } as unknown as GraphNode;
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["sparse node list", () => {
      const nodes: GraphNode[] = [devNode("dev-a")];
      nodes.length = 3;
      nodes[2] = devNode("dev-c");
      return devSnapshot(nodes, baseEdges(), "dev-c");
    }, "GRAPH_MALFORMED_NODE"],
    ["not an object", () => 7, "GRAPH_MALFORMED_SNAPSHOT"],
    ["null", () => null, "GRAPH_MALFORMED_SNAPSHOT"],
  ];

  it("refuses every hostile shape with the validator's own code", () => {
    expect(HOSTILE.length).toBeGreaterThan(0);
    for (const [label, build, code] of HOSTILE) {
      const result = encodeSnapshot(build());
      const pairs = pairsOf(result);
      expect(pairs.map(([issueCode]) => issueCode), label).toContain(code);
      for (const [, layer] of pairs) {
        expect(layer, label).toBe("GRAPH_VALIDATION");
      }
    }
  });

  it("refuses a malformed policy override at the validator's layer", () => {
    const pairs = pairsOf(encodeSnapshot(baseSnapshot(), { maxNodes: -1 }));
    expect(pairs).toEqual([["GRAPH_MALFORMED_POLICY", "GRAPH_VALIDATION"]]);
  });
});

// --- runtime bridges ---------------------------------------------------------

/**
 * Every non-test module here needs a committed one-line `.js` sibling: internal
 * imports are written with `.js` specifiers, and the plain-Node entrypoint smoke
 * worker resolves them literally. Vitest resolves the `.ts` directly and tsc
 * never looks at these files, so a missing or CRLF bridge is invisible to both
 * — this byte comparison is the only cheap guard.
 */
describe("runtime bridges", () => {
  it.each([
    ["graph-content", "graph-content.ts"],
    ["graph-content-fields", "graph-content-fields.ts"],
    ["graph-content-format", "graph-content-format.ts"],
    ["graph-content-issues", "graph-content-issues.ts"],
  ])("publishes the exact one-line LF bridge for %s", (name, target) => {
    const bridge = readFileSync(
      new URL(`./${name}.js`, import.meta.url),
      "utf8",
    );
    expect(bridge).toBe(`export * from "./${target}";\n`);
  });
});

// --- vocabulary --------------------------------------------------------------

describe("graph content vocabulary", () => {
  it("declares closed, frozen, sorted vocabularies", () => {
    expect(Object.isFrozen(GRAPH_CONTENT_ISSUE_CODES)).toBe(true);
    expect(Object.isFrozen(GRAPH_CONTENT_LAYERS)).toBe(true);
    expect([...GRAPH_CONTENT_ISSUE_CODES])
      .toEqual([...GRAPH_CONTENT_ISSUE_CODES].sort());
    expect([...GRAPH_CONTENT_LAYERS]).toEqual([...GRAPH_CONTENT_LAYERS].sort());
    expect(new Set(GRAPH_CONTENT_ISSUE_CODES).size)
      .toBe(GRAPH_CONTENT_ISSUE_CODES.length);
  });

  /**
   * A code the module declares but no path can emit is a guard this module only
   * claims to have. Every member below is produced by a real refusal above.
   */
  it("emits every declared codec code from a real path", () => {
    const canonical = textOf(okValue(encodeSnapshot(baseSnapshot())).bytes);
    const encoded = okValue(encodeSnapshot(baseSnapshot()));
    const produced = new Set<string>();
    const record = (result: GraphContentResult): void => {
      for (const [code] of pairsOf(result)) produced.add(code);
    };

    record(decodeGraphContent("not bytes"));
    record(decodeGraphContent(new Uint8Array(MAX_GRAPH_CONTENT_BYTES + 1)));
    record(decodeGraphContent(new Uint8Array([0xff])));
    record(decodeGraphContent(ENCODER.encode("[]")));
    record(decodeGraphContent(ENCODER.encode(
      canonical.replace(`"${SCHEMA_TAG}"`, "\"MOE-GRAPH-CONTENT/1\""))));
    record(decodeGraphContent(ENCODER.encode(
      textOf(encoded.bytes).replace(encoded.graphContentHash, "b".repeat(64)))));
    record(decodeGraphContent(ENCODER.encode(` ${canonical}`)));
    record(encodeGraphContent(contentOf(baseSnapshot(), { author: "" })));
    record(encodeGraphContent(contentOf(baseSnapshot(), { completionNode: "dev-a" })));
    record(encodeGraphContent(tampered((section) => {
      section.authorities[0]!.nodeAuthorityHash = hex("9");
    })));

    expect([...produced].sort()).toEqual([...GRAPH_CONTENT_ISSUE_CODES]);
  });

  it("binds every declared code to exactly one declared layer, both ways", () => {
    // Bidirectional on purpose: iterating the table alone would shrink with it, so
    // a code dropped from the table AND from its own roster would stay green while
    // `refuse` started answering `undefined` for it.
    const table = GRAPH_CONTENT_ISSUE_LAYER as Readonly<Record<string, string>>;
    expect(Object.keys(table).sort()).toEqual([...GRAPH_CONTENT_ISSUE_CODES]);
    for (const code of GRAPH_CONTENT_ISSUE_CODES) {
      expect(GRAPH_CONTENT_LAYERS, code).toContain(table[code]);
    }
    // And the table is the layer a real refusal actually carries, not a parallel
    // opinion: every pair produced above agrees with it.
    const observed = pairsOf(decodeGraphContent("not bytes"))
      .concat(pairsOf(encodeGraphContent(contentOf(baseSnapshot(), { author: "" }))));
    expect(observed.length).toBe(2);
    for (const [code, layer] of observed) expect(table[code]).toBe(layer);

    // The other direction of the same claim: a layer this codec does NOT own must
    // travel out unrestamped and stay OUTSIDE the roster, or the constant would be
    // advertising authority over a verdict it never reached.
    const foreign = pairsOf(encodeGraphContent(tampered((section) => {
      section.definitions.push(bodyOrThrow("dev-z", "dev-c", ["dev-a", "dev-b", "dev-c", "dev-z"]) as Json);
      section.authorities.push({ nodeAuthorityHash: hex("8"), nodeKey: "dev-z" });
    })));
    expect(foreign.length).toBe(1);
    expect(GRAPH_CONTENT_LAYERS).not.toContain(foreign[0]![1]);
    expect(Object.values(table)).not.toContain(foreign[0]![1]);
  });

  it("uses every declared layer", () => {
    const used = new Set<string>();
    for (const [, layer] of pairsOf(decodeGraphContent(null))) used.add(layer);
    const encoded = okValue(encodeSnapshot(baseSnapshot()));
    for (const [, layer] of pairsOf(decodeGraphContent(ENCODER.encode(
      textOf(encoded.bytes).replace(encoded.graphContentHash, "b".repeat(64)))))) {
      used.add(layer);
    }
    for (const [, layer] of pairsOf(encodeSnapshot(null))) used.add(layer);
    expect([...used].sort()).toEqual([...GRAPH_CONTENT_LAYERS]);
  });
});

// --- the seven-field contract (design 197) -----------------------------------

/**
 * The frozen expectation. Hand-written ON PURPOSE and compared against the
 * production list: a copy of the production array would agree with any future
 * edit, so an added or removed field would pass silently. This is the one place
 * in the file where duplicating the names is the point.
 */
const EXPECTED_CONTENT_KEYS = Object.freeze([
  "author",
  "completionNode",
  "decompositionBudget",
  "nodeAuthority",
  "parentRevision",
  "policyRevision",
  "repositoryBaseTree",
  "snapshot",
] as const);

describe("GraphRevisionContent — the eight design-197/255 fields", () => {
  it("declares exactly the eight fields, frozen and canonically ordered", () => {
    expect([...GRAPH_REVISION_CONTENT_KEYS]).toEqual([...EXPECTED_CONTENT_KEYS]);
    expect(GRAPH_REVISION_CONTENT_KEYS).toHaveLength(8);
    expect(Object.isFrozen(GRAPH_REVISION_CONTENT_KEYS)).toBe(true);
    expect([...GRAPH_REVISION_CONTENT_KEYS])
      .toEqual([...GRAPH_REVISION_CONTENT_KEYS].sort());
    expect(new Set(GRAPH_REVISION_CONTENT_KEYS).size)
      .toBe(GRAPH_REVISION_CONTENT_KEYS.length);
  });

  it("accepts a well-formed content value and answers with exactly those keys", () => {
    const value = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    expect(Object.keys(value.content)).toEqual([...EXPECTED_CONTENT_KEYS]);
    expect(Object.isFrozen(value.content)).toBe(true);
    expect(value.content.author).toBe(BASE_AUTHOR);
    expect(value.content.completionNode).toBe("dev-c");
    expect(value.content.decompositionBudget).toBe(BASE_BUDGET);
    expect(value.content.parentRevision).toBe(BASE_PARENT);
    expect(value.content.policyRevision).toBe(BASE_POLICY_REVISION);
    expect(value.content.repositoryBaseTree).toBe(BASE_TREE);
    expect(value.content.snapshot.completionNodeKey).toBe("dev-c");
  });

  it("round-trips every field through the decoder unchanged", () => {
    const encoded = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const decoded = okValue(decodeGraphContent(encoded.bytes));
    expect(decoded.content).toEqual(encoded.content);
    expect(decoded.graphContentHash).toBe(encoded.graphContentHash);
  });

  it("carries an absent parentRevision as an explicit marker, deterministically", () => {
    const initial = okValue(encodeGraphContent(
      contentOf(baseSnapshot(), { parentRevision: null }),
    ));
    const again = okValue(encodeGraphContent(
      contentOf(baseSnapshot(), { parentRevision: null }),
    ));
    const withParent = okValue(encodeGraphContent(contentOf(baseSnapshot())));

    expect(initial.content.parentRevision).toBeNull();
    expect(textOf(initial.bytes)).toContain("\"parentRevision\":null");
    expect(textOf(again.bytes)).toBe(textOf(initial.bytes));
    expect(again.graphContentHash).toBe(initial.graphContentHash);
    // An initial revision is not the same content as a child of some parent.
    expect(initial.graphContentHash).not.toBe(withParent.graphContentHash);
    // ...and it survives the wire as absent, not as a coerced empty string.
    const decoded = okValue(decodeGraphContent(initial.bytes));
    expect(decoded.content.parentRevision).toBeNull();
  });

  it("never confuses an absent parentRevision with an empty string", () => {
    // The empty string is not a representable ref, so the two forms cannot be
    // reached from one another: absent is accepted, empty is refused outright.
    expect(pairsOf(encodeGraphContent(contentOf(baseSnapshot(), { parentRevision: "" }))))
      .toEqual([["GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_CODEC"]]);
  });

  const BOUND_VIOLATIONS: readonly (readonly [string, Record<string, unknown>])[] = [
    ["author empty", { author: "" }],
    ["author over-long", { author: "a".repeat(129) }],
    ["author non-ascii", { author: "human:arché" }],
    ["author not a string", { author: 7 }],
    ["author with a space", { author: "human architect" }],
    ["repositoryBaseTree not hex", { repositoryBaseTree: "z".repeat(40) }],
    ["repositoryBaseTree uppercase hex", { repositoryBaseTree: "A".repeat(40) }],
    ["repositoryBaseTree wrong length", { repositoryBaseTree: "4".repeat(39) }],
    ["repositoryBaseTree empty", { repositoryBaseTree: "" }],
    ["repositoryBaseTree not a string", { repositoryBaseTree: null }],
    ["parentRevision over-long", { parentRevision: `rev-${"9".repeat(129)}` }],
    ["parentRevision undefined rather than null", { parentRevision: undefined }],
    ["parentRevision not a string", { parentRevision: 0 }],
    ["policyRevision empty", { policyRevision: "" }],
    ["policyRevision over-long", { policyRevision: "p".repeat(129) }],
    ["policyRevision null", { policyRevision: null }],
    ["completionNode empty", { completionNode: "" }],
    ["completionNode over-long", { completionNode: "k".repeat(129) }],
    ["completionNode not a string", { completionNode: ["dev-c"] }],
    ["decompositionBudget negative", { decompositionBudget: -1 }],
    ["decompositionBudget fractional", { decompositionBudget: 1.5 }],
    ["decompositionBudget NaN", { decompositionBudget: Number.NaN }],
    ["decompositionBudget infinite", { decompositionBudget: Number.POSITIVE_INFINITY }],
    ["decompositionBudget past the kernel ceiling",
      { decompositionBudget: ABSOLUTE_MAX_GRAPH_NODES + 1 }],
    ["decompositionBudget a numeric string", { decompositionBudget: "24" }],
    ["decompositionBudget negative zero", { decompositionBudget: -0 }],
    // The v3 section: shape only, since admissibility belongs to the composer.
    ["nodeAuthority not an object", { nodeAuthority: 7 }],
    ["nodeAuthority empty", { nodeAuthority: { authorities: [], definitions: [] } }],
    ["nodeAuthority extra section key",
      { nodeAuthority: { ...(inertSection() as object), extra: 1 } }],
    ["nodeAuthority hash not hex64", { nodeAuthority: {
      authorities: [{ nodeAuthorityHash: "z".repeat(64), nodeKey: "dev-a" }],
      definitions: [{ nodeKey: "dev-a" }],
    } }],
    ["nodeAuthority entry extra key", { nodeAuthority: {
      authorities: [{ nodeAuthorityHash: hex("0"), nodeKey: "dev-a", extra: 1 }],
      definitions: [{ nodeKey: "dev-a" }],
    } }],
    ["nodeAuthority node key not a graph key", { nodeAuthority: {
      authorities: [{ nodeAuthorityHash: hex("0"), nodeKey: "dev a" }],
      definitions: [{ nodeKey: "dev a" }],
    } }],
    ["nodeAuthority definitions unaligned", { nodeAuthority: {
      authorities: [{ nodeAuthorityHash: hex("0"), nodeKey: "dev-a" }],
      definitions: [{ nodeKey: "dev-b" }],
    } }],
    ["nodeAuthority not strictly ascending", { nodeAuthority: {
      authorities: [
        { nodeAuthorityHash: hex("0"), nodeKey: "dev-b" },
        { nodeAuthorityHash: hex("1"), nodeKey: "dev-a" },
      ],
      definitions: [{ nodeKey: "dev-b" }, { nodeKey: "dev-a" }],
    } }],
    ["nodeAuthority lengths disagree", { nodeAuthority: {
      authorities: [{ nodeAuthorityHash: hex("0"), nodeKey: "dev-a" }],
      definitions: [{ nodeKey: "dev-a" }, { nodeKey: "dev-b" }],
    } }],
  ];

  it("refuses every out-of-bound field as GRAPH_CONTENT_FIELD_INVALID", () => {
    // A sweep that generated nothing would pass every assertion inside it.
    expect(BOUND_VIOLATIONS.length).toBeGreaterThan(0);
    const fieldsCovered = new Set<string>();
    for (const [label, patch] of BOUND_VIOLATIONS) {
      const key = Object.keys(patch)[0]!;
      fieldsCovered.add(key);
      expect(pairsOf(encodeGraphContent(contentOf(baseSnapshot(), patch))), label)
        .toEqual([["GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_CODEC"]]);
    }
    // Every field that HAS a caller-stated bound is covered. `snapshot` is
    // excluded on purpose: its judgement belongs to the graph validator, and a
    // codec-layer refusal for it would mean the codec had taken that over.
    expect([...fieldsCovered].sort()).toEqual(
      [...GRAPH_REVISION_CONTENT_KEYS].filter((key) => key !== "snapshot"),
    );
  });

  it("names the offending field in the refusal message", () => {
    const result = encodeGraphContent(contentOf(baseSnapshot(), { author: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("author");
  });

  it("accepts a hex64 repository base tree as well as hex40", () => {
    // git objects come in SHA-1 and SHA-256 flavours; neither is the codec's
    // business to prefer, and both must produce distinct content.
    const short = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const long = okValue(encodeGraphContent(
      contentOf(baseSnapshot(), { repositoryBaseTree: "4".repeat(64) }),
    ));
    expect(long.content.repositoryBaseTree).toHaveLength(64);
    expect(long.graphContentHash).not.toBe(short.graphContentHash);
  });

  const HOSTILE_CONTENT: readonly (readonly [string, () => unknown])[] = [
    ["not an object", () => 7],
    ["null", () => null],
    ["array", () => []],
    ["proxy over a valid content record", () => new Proxy(contentOf(baseSnapshot()), {})],
    ["extra key", () => ({ ...contentOf(baseSnapshot()), graphHash: HASH_A })],
    ["missing author", () => {
      const content = { ...contentOf(baseSnapshot()) } as Record<string, unknown>;
      delete content["author"];
      return content;
    }],
    ["symbol key", () => {
      const content = { ...contentOf(baseSnapshot()) } as Record<symbol, unknown>;
      content[Symbol("x")] = 1;
      return content;
    }],
    ["accessor author read twice", () => Object.defineProperty(
      { ...contentOf(baseSnapshot()) } as Record<string, unknown>,
      "author",
      { get: () => BASE_AUTHOR, enumerable: true, configurable: true },
    )],
    ["accessor decompositionBudget", () => Object.defineProperty(
      { ...contentOf(baseSnapshot()) } as Record<string, unknown>,
      "decompositionBudget",
      { get: () => BASE_BUDGET, enumerable: true, configurable: true },
    )],
    ["prototype-bearing record", () => Object.assign(
      Object.create({ author: BASE_AUTHOR }) as Record<string, unknown>,
      contentOf(baseSnapshot()),
    )],
  ];

  it("refuses every hostile content shape at the codec layer", () => {
    expect(HOSTILE_CONTENT.length).toBeGreaterThan(0);
    expect(HOSTILE_CONTENT.length).toBeGreaterThanOrEqual(10);
    for (const [label, build] of HOSTILE_CONTENT) {
      expect(pairsOf(encodeGraphContent(build())), label)
        .toEqual([["GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_CODEC"]]);
    }
  });

  it("refuses a completion node the graph does not agree with", () => {
    // Two statements of one fact, reconciled in exactly one place. `dev-a` is a
    // real declared node, so this is drift, not a missing-node error.
    expect(pairsOf(encodeGraphContent(contentOf(baseSnapshot(), { completionNode: "dev-a" }))))
      .toEqual([["GRAPH_CONTENT_COMPLETION_DRIFT", "GRAPH_CONTENT_IDENTITY"]]);
  });

  it("refuses drifted completion bytes on the way back in", () => {
    const encoded = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const text = textOf(encoded.bytes)
      .replace("\"completionNode\":\"dev-c\"", "\"completionNode\":\"dev-a\"");
    expect(text).not.toBe(textOf(encoded.bytes));
    expect(pairsOf(decodeGraphContent(ENCODER.encode(text))))
      .toEqual([["GRAPH_CONTENT_COMPLETION_DRIFT", "GRAPH_CONTENT_IDENTITY"]]);
  });

  it("refuses a content record whose snapshot is judged by the validator, not here", () => {
    // The layer answer is the assertion: a codec-layer refusal would mean the
    // field reader had started judging graph structure.
    const pairs = pairsOf(encodeGraphContent(contentOf(7)));
    expect(pairs).toEqual([["GRAPH_MALFORMED_SNAPSHOT", "GRAPH_VALIDATION"]]);
  });
});

// --- the content hash covers all seven fields --------------------------------

/**
 * One variation per declared field. Keyed BY FIELD NAME so the sweep can assert
 * its own coverage against the production key list: a field that silently drops
 * out of the hash is invisible to a count-free loop, and a field never generated
 * at all is invisible to a loop that only counts its own cases.
 */
const FIELD_VARIATIONS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["author", { author: "human:architect-00000000" }],
  // Legal, and reconciled with the graph: the two move together because the
  // kernel binds them (see the header). This case is a presence check; the
  // field's authority is pinned by the drift-refusal cases above.
  ["completionNode", {
    completionNode: "dev-b",
    snapshot: devSnapshot(
      [devNode("dev-a"), devNode("dev-b")],
      [devHardEdge("dev-e1", "dev-a", "dev-b")],
      "dev-b",
    ),
  }],
  ["decompositionBudget", { decompositionBudget: BASE_BUDGET + 1 }],
  // The SAME graph with one body's objective moved: the section is the only thing
  // that differs, so a digest blind to it cannot tell these two contents apart.
  ["nodeAuthority", {
    nodeAuthority: authorityFor(baseSnapshot(), undefined, {
      "dev-a": { patch: { objective: "Land dev-a by another route." } },
    }),
  }],
  ["parentRevision", { parentRevision: "rev-000000000001" }],
  ["policyRevision", { policyRevision: "pol-000000000002" }],
  ["repositoryBaseTree", { repositoryBaseTree: "5".repeat(40) }],
  // A structurally distinct graph that keeps the SAME completion node, so this
  // case varies the node/edge set and nothing else.
  ["snapshot", {
    snapshot: devSnapshot(
      [...baseNodes(), devNode("dev-d")],
      [...baseEdges(), devHardEdge("dev-e4", "dev-d", "dev-c")],
      "dev-c",
    ),
  }],
];

describe("graphContentHash — every design-197 field is inside the digest", () => {
  it("changes when any one field changes, once per declared field", () => {
    // Coverage asserted against the PRODUCTION key list, not a count: a sweep
    // that generated nothing, or that skipped a field, passes a bare loop.
    expect(FIELD_VARIATIONS).toHaveLength(GRAPH_REVISION_CONTENT_KEYS.length);
    expect(FIELD_VARIATIONS.map(([field]) => field))
      .toEqual([...GRAPH_REVISION_CONTENT_KEYS]);

    const base = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const seen = new Map<string, string>([[base.graphContentHash, "base"]]);
    for (const [field, patch] of FIELD_VARIATIONS) {
      const value = okValue(encodeGraphContent(contentOf(baseSnapshot(), patch)));
      expect(value.graphContentHash, field).not.toBe(base.graphContentHash);
      expect(textOf(value.bytes), field).not.toBe(textOf(base.bytes));
      const collision = seen.get(value.graphContentHash);
      expect(collision, `${field} collided with ${collision ?? ""}`).toBeUndefined();
      seen.set(value.graphContentHash, field);
    }
    expect(seen.size).toBe(GRAPH_REVISION_CONTENT_KEYS.length + 1);
  });

  it("is length-framed, so a value cannot bleed across a field boundary", () => {
    // Two contents whose concatenated field values are identical: without
    // framing, `"pol-1" + "2"` and `"pol-12" + ""`-style shifts collide. Both
    // spellings below are legal refs of the same total text.
    const leftFields = { parentRevision: "rev-ab", policyRevision: "polcd" };
    const rightFields = { parentRevision: "rev-abpol", policyRevision: "cd" };
    // The unframed preimages are byte-identical; only framing separates them.
    expect(leftFields.parentRevision + leftFields.policyRevision)
      .toBe(rightFields.parentRevision + rightFields.policyRevision);
    const left = okValue(encodeGraphContent(contentOf(baseSnapshot(), leftFields)));
    const right = okValue(encodeGraphContent(contentOf(baseSnapshot(), rightFields)));
    expect(left.graphContentHash).not.toBe(right.graphContentHash);
  });

  it("inherits the validator's canonical ordering instead of re-deriving it", () => {
    const orderings = permutations(baseNodes())
      .flatMap((nodes) => permutations(baseEdges()).map((edges) => ({ nodes, edges })));
    expect(orderings).toHaveLength(36);

    const expected = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    for (const { nodes, edges } of orderings) {
      const value = okValue(encodeGraphContent(
        contentOf(devSnapshot(nodes, edges, "dev-c")),
      ));
      expect(value.graphContentHash).toBe(expected.graphContentHash);
      expect(textOf(value.bytes)).toBe(textOf(expected.bytes));
    }
  });

  it("is deterministic and blind to key insertion order", () => {
    const first = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const second = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    expect(textOf(second.bytes)).toBe(textOf(first.bytes));
    expect(second.graphContentHash).toBe(first.graphContentHash);

    // Same eight fields, declared in reverse. A codec that serialized caller key
    // order, or hashed it, would give one logical content two identities.
    const reversed = {
      snapshot: baseSnapshot(),
      repositoryBaseTree: BASE_TREE,
      policyRevision: BASE_POLICY_REVISION,
      parentRevision: BASE_PARENT,
      nodeAuthority: authorityFor(baseSnapshot()),
      decompositionBudget: BASE_BUDGET,
      completionNode: "dev-c",
      author: BASE_AUTHOR,
    };
    expect(Object.keys(reversed))
      .toEqual([...GRAPH_REVISION_CONTENT_KEYS].reverse());
    const shuffled = okValue(encodeGraphContent(reversed));
    expect(shuffled.graphContentHash).toBe(first.graphContentHash);
    expect(textOf(shuffled.bytes)).toBe(textOf(first.bytes));
  });
});

// --- decision dec-64b2391c: the two hashes are never the same value ----------

describe("content authority is never the structural identity", () => {
  it("answers with both hashes and they differ", () => {
    const value = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    expect(value.snapshotIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(value.graphContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(value.graphContentHash).not.toBe(value.snapshotIdentity);
  });

  /**
   * The decisive pair. `snapshotIdentity` must be INVARIANT under a change to any
   * non-structural field, and `graphContentHash` must not be — that is what makes
   * one structural and the other content, and it cannot be satisfied by returning
   * the same value for both.
   */
  it("holds the structural identity constant while content authority moves", () => {
    const base = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const nonStructural = FIELD_VARIATIONS
      .filter(([field]) => field !== "snapshot" && field !== "completionNode");
    expect(nonStructural).toHaveLength(GRAPH_REVISION_CONTENT_KEYS.length - 2);

    for (const [field, patch] of nonStructural) {
      const value = okValue(encodeGraphContent(contentOf(baseSnapshot(), patch)));
      expect(value.snapshotIdentity, field).toBe(base.snapshotIdentity);
      expect(value.graphContentHash, field).not.toBe(base.graphContentHash);
    }
  });

  it("moves the structural identity when the structure moves", () => {
    const base = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const restructured = okValue(encodeGraphContent(contentOf(devSnapshot(
      [...baseNodes(), devNode("dev-d")],
      [...baseEdges(), devHardEdge("dev-e4", "dev-d", "dev-c")],
      "dev-c",
    ))));
    expect(restructured.snapshotIdentity).not.toBe(base.snapshotIdentity);
    expect(restructured.graphContentHash).not.toBe(base.graphContentHash);
    // Still never equal to each other, on either graph.
    expect(restructured.graphContentHash).not.toBe(restructured.snapshotIdentity);
  });

  it("separates the wire tag from both digest domains", () => {
    expect(GRAPH_CONTENT_HASH_DOMAIN).toBe("MOE-GRAPH-CONTENT-HASH/3");
    expect(SNAPSHOT_IDENTITY_DOMAIN).toBe("MOE-GRAPH-SNAPSHOT-IDENTITY/1");
    expect(SCHEMA_TAG_PRODUCTION).toBe(SCHEMA_TAG);
    const tags = [GRAPH_CONTENT_HASH_DOMAIN, SNAPSHOT_IDENTITY_DOMAIN, SCHEMA_TAG_PRODUCTION];
    expect(new Set(tags).size).toBe(3);
    // A digest domain and a wire tag sharing one string cannot be rotated
    // independently, which is the whole reason they are separate constants.
    expect(GRAPH_CONTENT_HASH_DOMAIN).not.toContain(SNAPSHOT_IDENTITY_DOMAIN);
    expect(GRAPH_CONTENT_HASH_DOMAIN.startsWith(SCHEMA_TAG_PRODUCTION)).toBe(false);
  });

  it("keeps the structural identity out of the bytes it does not authorize", () => {
    // Only ONE hash is on the wire AS AN IDENTITY, and it is the content hash.
    //
    // v3 changes what "absent" can mean here and the change is stated rather than
    // asserted away: every admitted DependencyContract carries the structural
    // identity as its `graphBindingDigest`, so the string genuinely appears in the
    // bytes. What must not exist is a FIELD offering it as a second, weaker value
    // to bind to — so every occurrence is pinned to a contract binding, and the
    // count is asserted nonzero so this cannot pass by the string being absent.
    const value = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const text = textOf(value.bytes);
    expect(text).toContain(value.graphContentHash);
    const occurrences = text.split(value.snapshotIdentity).length - 1;
    const asBinding =
      text.split(`"graphBindingDigest":"${value.snapshotIdentity}"`).length - 1;
    expect(occurrences).toBeGreaterThan(0);
    expect(asBinding).toBe(occurrences);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain("snapshotIdentity");
    expect(parsed["hash"]).toBe(value.graphContentHash);
    expect(Object.keys(parsed["content"] as Record<string, unknown>))
      .not.toContain("snapshotIdentity");
  });

  it("is a digest over the structural identity, never the identity string", () => {
    const validated = validateGraphSnapshot(baseSnapshot());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const value = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    expect(value.snapshotIdentity).not.toBe(validated.graph.graphIdentity);
    expect(value.graphContentHash).not.toBe(validated.graph.graphIdentity);
    expect(textOf(value.bytes)).not.toContain(validated.graph.graphIdentity);
  });
});

// --- the v3 node-authority section (design 255) ------------------------------

const BASE_BINDING = ((): string => {
  const validated = validateGraphSnapshot(baseSnapshot());
  if (!validated.ok) throw new Error("base graph fixture refused");
  return snapshotIdentityHash(validated.graph);
})();

type Section = {
  authorities: { nodeAuthorityHash: string; nodeKey: string }[];
  definitions: Json[];
};

const sectionOf = (content: GraphRevisionContent): Section =>
  content.nodeAuthority as unknown as Section;

function hashOfNode(content: GraphRevisionContent, nodeKey: string): string {
  const entry = sectionOf(content).authorities.find((item) => item.nodeKey === nodeKey);
  if (entry === undefined) throw new Error(`no authority entry for ${nodeKey}`);
  return entry.nodeAuthorityHash;
}

/** The control with one or more bodies moved — the section is rederived, never edited. */
const controlWith = (
  overrides: Readonly<Record<string, BodyOptions>>,
): GraphRevisionContent =>
  contentOf(baseSnapshot(), { nodeAuthority: authorityFor(baseSnapshot(), undefined, overrides) });

/**
 * Bodies paired with INERT hashes instead of derived ones, for the arms where the
 * composer is expected to refuse: deriving first would throw in the fixture and
 * the codec's own passthrough would never be exercised.
 */
function underivedSection(overrides: Readonly<Record<string, BodyOptions>>): Json {
  const validated = validateGraphSnapshot(baseSnapshot());
  if (!validated.ok) throw new Error("base graph fixture refused");
  const definitions = definitionsFor(validated.graph, BASE_BINDING, overrides);
  return {
    authorities: definitions.map((body) => ({
      nodeAuthorityHash: hex("0"), nodeKey: (body as Json)["nodeKey"] as string,
    })),
    definitions,
  };
}

/** The control with the section EDITED after derivation — how a forgery is shaped. */
function tampered(mutate: (section: Section) => void): GraphRevisionContent {
  const section = authorityFor(baseSnapshot()) as unknown as Section;
  mutate(section);
  return contentOf(baseSnapshot(), { nodeAuthority: section });
}

/** dev-c's two incoming HARD contracts, so a case can move exactly one field of one. */
const completionEdges = (contractHash?: string): Json[] => [
  {
    edgeKey: "dev-e1",
    requirement: requirementFor({
      binding: BASE_BINDING, consumer: "dev-c", producer: "dev-a",
      ...(contractHash === undefined ? {} : { contractHash }),
    }),
  },
  {
    edgeKey: "dev-e2",
    requirement: requirementFor({ binding: BASE_BINDING, consumer: "dev-c", producer: "dev-b" }),
  },
];

describe("graph content v3 — the mandatory node authority section", () => {
  it("binds every snapshot node to the composer's derived authority, in canonical order", () => {
    const value = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const section = sectionOf(value.content);
    expect(section.authorities.map((entry) => entry.nodeKey)).toEqual(["dev-a", "dev-b", "dev-c"]);
    expect(section.definitions.map((body) => body["nodeKey"]))
      .toEqual(["dev-a", "dev-b", "dev-c"]);
    for (const entry of section.authorities) {
      expect(entry.nodeAuthorityHash).toMatch(/^[0-9a-f]{64}$/u);
    }
    // The COMPOSER is the authority, not this codec: the embedded set is exactly
    // what the production derivation answers for the same snapshot and bodies.
    const derived = deriveNodeAuthoritySet(baseSnapshot(), section.definitions);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(section.authorities).toEqual([...derived.value]);
    expect(derived.hardEdgeCount).toBe(2);
  });

  it("serializes the section into the canonical bytes it hashes", () => {
    const value = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const text = textOf(value.bytes);
    expect(text).toContain("\"nodeAuthority\":{\"authorities\":[");
    for (const entry of sectionOf(value.content).authorities) {
      expect(text).toContain(entry.nodeAuthorityHash);
    }
    // Canonical position: alphabetical, between decompositionBudget and parentRevision.
    expect(text.indexOf("\"nodeAuthority\"")).toBeGreaterThan(text.indexOf("\"decompositionBudget\""));
    expect(text.indexOf("\"nodeAuthority\"")).toBeLessThan(text.indexOf("\"parentRevision\""));
  });

  it("round-trips the section byte-identically through decode and re-encode", () => {
    const encoded = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const decoded = okValue(decodeGraphContent(encoded.bytes));
    expect(decoded.graphContentHash).toBe(encoded.graphContentHash);
    expect(sectionOf(decoded.content)).toEqual(sectionOf(encoded.content));
    const again = okValue(encodeGraphContent(decoded.content));
    expect(Array.from(again.bytes)).toEqual(Array.from(encoded.bytes));
  });

  it("deep-freezes the section and detaches it from the caller's record", () => {
    const record = contentOf(baseSnapshot());
    const value = okValue(encodeGraphContent(record));
    const section = value.content.nodeAuthority as unknown as Section;
    expect(Object.isFrozen(value.content.nodeAuthority)).toBe(true);
    expect(Object.isFrozen(section.authorities)).toBe(true);
    expect(Object.isFrozen(section.authorities[0])).toBe(true);
    expect(Object.isFrozen(section.definitions)).toBe(true);
    expect(Object.isFrozen(section.definitions[0])).toBe(true);

    // Mutating the CALLER's record after the call cannot move the answer.
    sectionOf(record).authorities[0]!.nodeAuthorityHash = hex("9");
    sectionOf(record).definitions.pop();
    expect(hashOfNode(value.content, "dev-a")).not.toBe(hex("9"));
    expect(sectionOf(value.content).definitions).toHaveLength(3);

    // And a decoded result cannot be edited into a second, different answer.
    const decoded = okValue(decodeGraphContent(value.bytes));
    expect(() => {
      (decoded.content.nodeAuthority as unknown as Section).authorities.pop();
    }).toThrow(TypeError);
    expect(okValue(decodeGraphContent(value.bytes)).graphContentHash)
      .toBe(value.graphContentHash);
  });
});

// --- hash sensitivity, one case per mutation class ---------------------------

/**
 * Each entry moves EXACTLY ONE class of fact and asserts the graph content hash
 * moved with it. Two facts in one case would leave both untested: a digest that
 * dropped either would still differ because of the other.
 */
const SECTION_MUTATIONS: readonly (readonly [string, () => GraphRevisionContent])[] = [
  ["node body field", () => controlWith({ "dev-b": { patch: { capability: "capability-review" } } })],
  ["direct contract field", () => controlWith({ "dev-c": { edges: completionEdges(hex("7")) } })],
  ["predecessor body", () => controlWith({ "dev-a": { patch: { objective: "Land dev-a later." } } })],
  ["advisory relation", () => contentOf(devSnapshot(
    baseNodes(),
    [devHardEdge("dev-e1", "dev-a", "dev-c"), devHardEdge("dev-e2", "dev-b", "dev-c"),
      devAdvisoryEdge("dev-e3", "dev-b", "dev-a")],
    "dev-c",
  ))],
  ["existing v2 field", () => contentOf(baseSnapshot(), { author: "human:architect-00000000" })],
];

describe("graphContentHash — the section is inside the digest", () => {
  it("moves for every mutation class, once per class", () => {
    expect(SECTION_MUTATIONS.length).toBe(5);
    const base = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const seen = new Map<string, string>([[base.graphContentHash, "base"]]);
    for (const [label, build] of SECTION_MUTATIONS) {
      const value = okValue(encodeGraphContent(build()));
      expect(value.graphContentHash, label).not.toBe(base.graphContentHash);
      expect(seen.has(value.graphContentHash), label).toBe(false);
      seen.set(value.graphContentHash, label);
    }
    expect(seen.size).toBe(SECTION_MUTATIONS.length + 1);
  });

  it("is unchanged by a byte-identical re-encode", () => {
    const first = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const second = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    expect(second.graphContentHash).toBe(first.graphContentHash);
    expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
  });

  /**
   * Propagation, asserted on the NODE hash rather than the graph hash: moving a
   * predecessor's body must move its successor's authority even though the
   * successor's own body is byte-identical.
   */
  it("propagates a predecessor's body into its successor's authority", () => {
    const base = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const moved = okValue(encodeGraphContent(
      controlWith({ "dev-a": { patch: { objective: "Land dev-a later." } } }),
    ));
    expect(hashOfNode(moved.content, "dev-a")).not.toBe(hashOfNode(base.content, "dev-a"));
    expect(hashOfNode(moved.content, "dev-c")).not.toBe(hashOfNode(base.content, "dev-c"));
    // dev-b has no HARD path from dev-a (dev-e3 is ADVISORY), so it must NOT move —
    // otherwise "everything moved" would be indistinguishable from propagation.
    expect(hashOfNode(moved.content, "dev-b")).toBe(hashOfNode(base.content, "dev-b"));
  });

  /**
   * The structural binding reaches the node authorities: an ADVISORY edge is
   * invisible to the HARD walk, but it moves `snapshotIdentityHash`, which every
   * contract states as its `graphBindingDigest`.
   */
  it("carries a structural change into every bound node authority", () => {
    const base = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const moved = okValue(encodeGraphContent(contentOf(devSnapshot(
      baseNodes(),
      [devHardEdge("dev-e1", "dev-a", "dev-c"), devHardEdge("dev-e2", "dev-b", "dev-c"),
        devAdvisoryEdge("dev-e3", "dev-b", "dev-a")],
      "dev-c",
    ))));
    expect(hashOfNode(moved.content, "dev-c")).not.toBe(hashOfNode(base.content, "dev-c"));
  });
});

// --- version refusal and closure, each pinning code AND layer ----------------

describe("graph content v3 — refuses anything that is not v3", () => {
  it.each([
    ["version 1", "MOE-GRAPH-CONTENT/1"],
    ["version 2", "MOE-GRAPH-CONTENT/2"],
  ])("refuses %s bytes at the schema gate, never upgrading them", (_label, tag) => {
    const encoded = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const downgraded = textOf(encoded.bytes).replace(`"${SCHEMA_TAG}"`, `"${tag}"`);
    expect(downgraded).toContain(tag);
    expect(pairsOf(decodeGraphContent(ENCODER.encode(downgraded))))
      .toEqual([["GRAPH_CONTENT_UNSUPPORTED_SCHEMA", "GRAPH_CONTENT_CODEC"]]);
  });

  it("refuses a structural-only record, naming the absent section", () => {
    const record = contentOf(baseSnapshot()) as unknown as Record<string, unknown>;
    const { nodeAuthority: _dropped, ...structuralOnly } = record;
    const result = encodeGraphContent(structuralOnly);
    expect(pairsOf(result)).toEqual([["GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_CODEC"]]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("nodeAuthority");
  });

  it("refuses structural-only bytes on the way back in", () => {
    const encoded = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const text = textOf(encoded.bytes);
    const start = text.indexOf(",\"nodeAuthority\":");
    const end = text.indexOf(",\"parentRevision\":");
    expect([start > 0, end > start]).toEqual([true, true]);
    const stripped = text.slice(0, start) + text.slice(end);
    expect(pairsOf(decodeGraphContent(ENCODER.encode(stripped))))
      .toEqual([["GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_CODEC"]]);
  });
});

describe("graph content v3 — closure failures keep their source code and layer", () => {
  const nodeIds = ["dev-a", "dev-b", "dev-c"];

  it("refuses a section whose definitions are not one-per-node and sorted", () => {
    // Duplicate nodeKeys never reach the composer: the codec's own reader pins the
    // canonical order, so this arm belongs to the CODEC layer by design.
    expect(pairsOf(encodeGraphContent(tampered((section) => {
      section.definitions[1] = section.definitions[0]!;
      section.authorities[1] = section.authorities[0]!;
    })))).toEqual([["GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_CODEC"]]);
  });

  it("refuses a definition list that disagrees with the authority list", () => {
    expect(pairsOf(encodeGraphContent(tampered((section) => {
      section.definitions.pop();
    })))).toEqual([["GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_CODEC"]]);
  });

  it("preserves the composer's verdict for a body the snapshot does not carry", () => {
    const extra = bodyOrThrow("dev-z", "dev-c", [...nodeIds, "dev-z"]) as Json;
    expect(pairsOf(encodeGraphContent(tampered((section) => {
      section.definitions.push(extra);
      section.authorities.push({ nodeAuthorityHash: hex("8"), nodeKey: "dev-z" });
    })))).toEqual([[
      "NODE_AUTHORITY_RECURSION_NODE_EXTRA", "NODE_AUTHORITY_RECURSION",
    ]]);
  });

  it("preserves the composer's verdict for a node with no admitted body", () => {
    expect(pairsOf(encodeGraphContent(tampered((section) => {
      section.definitions.pop();
      section.authorities.pop();
    })))).toEqual([[
      "NODE_AUTHORITY_RECURSION_NODE_MISSING", "NODE_AUTHORITY_RECURSION",
    ]]);
  });

  it("preserves the composer's verdict for a contract filed on an advisory edge", () => {
    const advisory = contentOf(baseSnapshot(), {
      nodeAuthority: underivedSection({
        "dev-b": {
          edges: [{
            edgeKey: "dev-e3",
            requirement: requirementFor({
              binding: BASE_BINDING, consumer: "dev-b", producer: "dev-a",
            }),
          }],
        },
      }),
    });
    expect(pairsOf(encodeGraphContent(advisory))).toEqual([[
      "NODE_AUTHORITY_RECURSION_CONTRACT_FORBIDDEN", "NODE_AUTHORITY_RECURSION",
    ]]);
  });

  it("preserves the node codec's verdict for a caller-stated node authority hash", () => {
    expect(pairsOf(encodeGraphContent(tampered((section) => {
      section.definitions[0] = { ...section.definitions[0], nodeAuthorityHash: hex("9") };
    })))).toEqual([[
      "NODE_AUTHORITY_CALLER_DIGEST_FORBIDDEN", "NODE_AUTHORITY_ADMISSION",
    ]]);
  });

  it("refuses a tampered authority pair on encode", () => {
    expect(pairsOf(encodeGraphContent(tampered((section) => {
      const first = section.authorities[0]!.nodeAuthorityHash;
      section.authorities[0]!.nodeAuthorityHash = section.authorities[1]!.nodeAuthorityHash;
      section.authorities[1]!.nodeAuthorityHash = first;
    })))).toEqual([[
      "GRAPH_CONTENT_AUTHORITY_DISAGREEMENT", "GRAPH_CONTENT_IDENTITY",
    ]]);
  });

  /**
   * Decode RECOMPUTES: the swap below is length-preserving and canonical, so only
   * a decoder that re-runs the composer can tell it from the real thing. It is
   * answered before the digest for the same reason completion drift is — internal
   * incoherence is the more specific verdict.
   */
  it("refuses a tampered authority pair in already-canonical bytes", () => {
    const encoded = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const first = hashOfNode(encoded.content, "dev-a");
    const second = hashOfNode(encoded.content, "dev-b");
    const swapped = textOf(encoded.bytes)
      .replace(first, "@".repeat(64)).replace(second, first).replace("@".repeat(64), second);
    expect(swapped).not.toBe(textOf(encoded.bytes));
    expect(swapped.length).toBe(textOf(encoded.bytes).length);
    expect(pairsOf(decodeGraphContent(ENCODER.encode(swapped)))).toEqual([[
      "GRAPH_CONTENT_AUTHORITY_DISAGREEMENT", "GRAPH_CONTENT_IDENTITY",
    ]]);
  });

  it("still reports a moved v2 field as a digest mismatch, not an authority failure", () => {
    const encoded = okValue(encodeGraphContent(contentOf(baseSnapshot())));
    const moved = textOf(encoded.bytes).replace(BASE_AUTHOR, "human:architect-00000000");
    expect(moved).not.toBe(textOf(encoded.bytes));
    expect(pairsOf(decodeGraphContent(ENCODER.encode(moved))))
      .toEqual([["GRAPH_CONTENT_DIGEST_MISMATCH", "GRAPH_CONTENT_IDENTITY"]]);
  });
});

// --- the section's byte allowance, searched with the production builders -----

describe("graph content v3 — the section's byte allowance", () => {
  /**
   * The v3 envelope embeds whole bodies, so the decode ceiling has to be derived
   * from the node codec's OWN ceiling or the codec could mint bytes it then
   * refuses to read back. The pair below is found by SEARCHING with the
   * production builder — the largest body it admits and the smallest it does not
   * — so both cases move together if a limit moves.
   */
  it("covers the largest body the node codec admits, and refuses the next one", () => {
    const nodeIds = ["dev-a", "dev-b", "dev-c"];
    const wide = (entries: number): BodyOptions => ({ scopeEntries: entries, wideScopes: true });
    let fits = 0;
    let steps = 0;
    let refusal: readonly [string, string] | null = null;
    for (let entries = 1; entries <= 512 && refusal === null; entries += 1) {
      steps += 1;
      const built = createNodeDefinition({
        acceptanceContract: (() => {
          const acceptance = createAcceptanceContract(acceptanceDraft(nodeIds));
          if (!acceptance.ok) throw new Error(`acceptance fixture refused: ${acceptance.code}`);
          return acceptance.contract;
        })(),
        draft: nodeDraft("dev-a", "dev-c", wide(entries)),
        planRevision: (() => {
          const plan = createPlanRevision(planDraft(nodeIds));
          if (!plan.ok) throw new Error(`plan fixture refused: ${plan.code}`);
          return plan.revision;
        })(),
        predicateRegistry: [registryEntry()],
      });
      if (built.ok) {
        fits = entries;
      } else {
        refusal = [built.issues[0]!.code, built.issues[0]!.layer] as const;
      }
    }
    // A search that generated nothing, or found no boundary, must FAIL rather
    // than pass vacuously.
    expect(steps).toBeGreaterThan(1);
    expect(fits).toBeGreaterThan(0);
    expect(refusal).not.toBeNull();

    const largest = bodyOrThrow("dev-a", "dev-c", nodeIds, wide(fits));
    const widest = canonicalText(largest).length;
    // Non-vacuous: the worst case must genuinely be large, not a default fixture.
    expect(widest).toBeGreaterThan(100_000);
    expect(widest).toBeLessThanOrEqual(NODE_AUTHORITY_LIMITS.maxBytes);

    const encoded = okValue(encodeGraphContent(controlWith({ "dev-a": wide(fits) })));
    expect(encoded.bytes.length).toBeGreaterThan(widest);
    expect(encoded.bytes.length).toBeLessThanOrEqual(MAX_GRAPH_CONTENT_BYTES);
    expect(okValue(decodeGraphContent(encoded.bytes)).graphContentHash)
      .toBe(encoded.graphContentHash);
  });
});
