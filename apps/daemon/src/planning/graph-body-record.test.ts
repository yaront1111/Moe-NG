/**
 * The durable graph-content body record, driven through a REAL file-backed
 * SqliteEventStore.
 *
 * WHAT THIS MODULE IS FOR, stated once so the tests below are legible: a graph
 * revision event carries a `graphContentHash`, never the graph itself. Something
 * must hold the bytes that hash names, and the ONLY lawful producer of both is
 * `encodeGraphContent` — the scheduler root says so explicitly and withholds the
 * canonicalisation and digest mechanics precisely so no consumer can mint a
 * second serialisation. This record therefore stores the codec's OWN canonical
 * bytes verbatim and re-validates them through `decodeGraphContent` on the way
 * out. It never hashes, never canonicalises, and never re-serialises.
 *
 * WHY THE DECODER RUNS INSIDE THE ASSERTIONS rather than a local byte compare:
 * the decoder's digest check IS the integrity authority. A test that compared
 * stored bytes to remembered bytes would pass just as happily against a module
 * that skipped the decode entirely, which is exactly the mutant step 6 drills.
 *
 * WINDOWS HANDLE DISCIPLINE: every store handle is closed in a `finally` before
 * the temp directory is removed. A handle held across cleanup throws EPERM and
 * kills the vitest worker with zero test output — it reads as a native crash
 * rather than as a leak.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADMISSION_PURPOSES,
  createNodeDefinition,
  decodeGraphContent,
  deriveNodeAuthoritySet,
  encodeGraphContent,
  snapshotIdentityHash,
  validateGraphSnapshot,
} from "@moe/scheduler";
import type {
  GraphContent,
  GraphEdge,
  GraphNode,
  GraphRevisionContent,
  GraphSnapshot,
  NodeAuthoritySection,
  NodeDefinition,
} from "@moe/scheduler";
import { createAcceptanceContract, createPlanRevision } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  GRAPH_BODY_EVENT_TYPE,
  GRAPH_BODY_RECORD_CODES,
  GRAPH_BODY_RECORD_LAYER,
  graphBodyAggregateId,
  putGraphBody,
  readGraphBody,
} from "./graph-body-record.js";

const PROJECT_ID = "proj-graph-body-0001";

// --- fixtures ----------------------------------------------------------------

/**
 * Three nodes, two HARD edges into the completion node plus one ADVISORY edge.
 * `@moe/scheduler`'s own `test-fixtures.ts` is NOT reachable from its root — the
 * exports map is `{".": "./src/index.ts"}` and publishes no subpaths — so the
 * shapes are restated here from the exported TYPES rather than deep-imported.
 */
function baseSnapshot(): GraphSnapshot {
  const nodes: readonly GraphNode[] = [
    { nodeKey: "dev-a", executionBearing: true },
    { nodeKey: "dev-b", executionBearing: true },
    { nodeKey: "dev-c", executionBearing: true },
  ];
  const edges: readonly GraphEdge[] = [
    { edgeKey: "dev-e1", producerNodeKey: "dev-a", consumerNodeKey: "dev-c", kind: "HARD" },
    { edgeKey: "dev-e2", producerNodeKey: "dev-b", consumerNodeKey: "dev-c", kind: "HARD" },
    { edgeKey: "dev-e3", producerNodeKey: "dev-a", consumerNodeKey: "dev-b", kind: "ADVISORY" },
  ];
  return { nodes, edges, completionNodeKey: "dev-c" };
}

// --- v3 node-authority fixtures (task-8c7e6ce4) ------------------------------

/**
 * `GraphRevisionContent` v3 (task-6ba1ff89) makes `nodeAuthority` MANDATORY, and
 * `encodeGraphContent` RE-DERIVES the set it is handed rather than adopting it
 * (`graph-content.ts:120-141`), so a hand-built section can never pass. Everything below
 * COMPOSES the published producers — `createPlanRevision` / `createAcceptanceContract`
 * (@moe/core), then `createNodeDefinition` and `deriveNodeAuthoritySet` (@moe/scheduler) —
 * and judges nothing: each helper hands back what production returned, or throws carrying
 * production's own code, so a fixture that stopped building is never mistaken for a
 * boundary that stopped refusing.
 */
const AUTHORITY_HEX = (digit: string): string => digit.repeat(64);

const planDraftFor = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  affectedCriterionIds: ["criterion-a"],
  affectedNodeIds: [...nodeKeys],
  approvalState: "APPROVED",
  authorRef: "principal-a",
  graphBinding: { graphContentHash: AUTHORITY_HEX("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null,
  rejectionRef: null,
  revisionId: "plan-revision-a",
  steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-a" }],
  verificationRecipeRefs: ["recipe-a"],
});

const acceptanceDraftFor = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  applicability: {
    graphContentHash: AUTHORITY_HEX("a"), graphRevisionRef: "graph-revision-a",
    nodeIds: [...nodeKeys], nodeKind: "LEAF",
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

/** A MONOTONIC contract owes a matching registry proof, else the codec refuses
 *  NODE_AUTHORITY_MONOTONIC_PROOF_MISSING @ NODE_AUTHORITY_PROOFS. */
const AUTHORITY_REGISTRY_ENTRY: Record<string, unknown> = {
  parameterSchema: { digest: AUTHORITY_HEX("b"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-a",
  proofRationale: "An artifact seal cannot become unsealed.",
  schemaId: "schema-a",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
};

/** ONE contract per HARD edge ENTERING a node. `graphBindingDigest` is PRODUCTION's
 *  `snapshotIdentityHash` over the ACCEPTED graph, never a literal: a digest that did not
 *  come from this structure refuses NODE_AUTHORITY_RECURSION_BINDING_MISMATCH at derive
 *  time (`node-authority-recursion.ts:164-167`). */
const hardEdgeRequirement = (edge: GraphEdge, binding: string): Record<string, unknown> => ({
  edgeKey: edge.edgeKey,
  requirement: {
    contract: {
      alternateProducers: [] as string[],
      alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
      consumer: {
        contractHash: AUTHORITY_HEX("c"), criterionRef: "criterion-a", kind: "PRECONDITION",
      },
      consumerNodeKey: edge.consumerNodeKey,
      consumptionHorizon: "RESULT_SEAL",
      edgeKind: "ARTIFACT_CONSUMPTION",
      graphBindingDigest: binding,
      invalidationFacts: [
        { sourceFactDigest: AUTHORITY_HEX("e"), sourceFactRef: "fact-a", sourceFactVersion: 1 },
      ],
      minimumQualifyingMilestone: "RESULT_SEALED",
      necessity: {
        failedConsumerCriterionRef: "criterion-a", failureKind: "MISSING_ARTIFACT",
        truthClass: "OBSERVED",
      },
      producer: {
        artifactOrInterfaceRef: "artifact-a", digest: AUTHORITY_HEX("f"),
        kind: "ARTIFACT_CONSUMPTION",
      },
      producerNodeKey: edge.producerNodeKey,
      recheckPredicateRef: "predicate-a",
      satisfactionPredicate: {
        parametersDigest: AUTHORITY_HEX("1"), predicateRef: "predicate-a",
        schemaId: "schema-a", schemaVersion: 1,
      },
      satisfactionWitnesses: [{
        sourceOperationClass: "ARTIFACT_SEAL", witnessDigest: AUTHORITY_HEX("2"),
        witnessRef: "witness-a", witnessVersion: 1,
      }],
      stability: "MONOTONIC",
      truthClass: "OBSERVED",
    },
    edgeKind: "ARTIFACT_CONSUMPTION",
  },
});

/** Admitted by PRODUCTION or not built at all: a body the codec refuses could never reach
 *  the encode this fixture exists to feed. */
function nodeDefinitionFor(
  nodeKey: string, snapshot: GraphSnapshot, binding: string,
): NodeDefinition {
  const nodeKeys = snapshot.nodes.map((node) => node.nodeKey);
  const plan = createPlanRevision(planDraftFor(nodeKeys));
  if (!plan.ok) throw new Error(`plan revision fixture refused: ${plan.code}`);
  const acceptance = createAcceptanceContract(acceptanceDraftFor(nodeKeys));
  if (!acceptance.ok) throw new Error(`acceptance fixture refused: ${acceptance.code}`);
  const completes = nodeKey === snapshot.completionNodeKey;
  const built = createNodeDefinition({
    acceptanceContract: acceptance.contract,
    draft: {
      admissionAmounts: [...ADMISSION_PURPOSES].sort().map((purpose, index) => ({
        meter: "runner.authorized_ms", purpose, quantity: index + 1,
      })),
      admissionGatePolicy: "POLICY_ALLOWANCE",
      capability: "capability-implement",
      completionLinkage: completes ? nodeKey : null,
      constraints: ["constraint-a"],
      directHardDependencies: snapshot.edges
        .filter((edge) => edge.kind === "HARD" && edge.consumerNodeKey === nodeKey)
        .map((edge) => hardEdgeRequirement(edge, binding)),
      joinRole: completes ? "COMPLETION" : "NONE",
      nodeKey,
      objective: `Land ${nodeKey}.`,
      policySliceHash: AUTHORITY_HEX("3"),
      readScopes: ["services/api/src"],
      repositoryBaseTree: AUTHORITY_HEX("4"),
      resources: ["resource-a"],
      verificationRecipeRevisions: ["recipe-a"],
      writeScopes: ["services/api/src/node"],
    },
    planRevision: plan.revision,
    predicateRegistry: [AUTHORITY_REGISTRY_ENTRY],
  });
  if (!built.ok) {
    throw new Error(built.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return built.value.definition;
}

/**
 * The authenticated half of a v3 record. `definitions` is sorted by `nodeKey` because
 * `readAuthoritySection` requires the two arrays index-aligned and STRICTLY ASCENDING
 * (`graph-content-fields.ts:121-147`), and `deriveNodeAuthoritySet` already returns its
 * entries in that order. `authorities` is the PRODUCER'S own value, never a rebuilt one:
 * `bindAuthority` re-derives and refuses GRAPH_CONTENT_AUTHORITY_DISAGREEMENT on any
 * stated set that is not the derived one.
 */
function authoritySectionFor(snapshot: GraphSnapshot): NodeAuthoritySection {
  const validated = validateGraphSnapshot(snapshot);
  if (!validated.ok) {
    throw new Error(`graph fixture refused: ${validated.issues[0]?.code ?? "?"}`);
  }
  const binding = snapshotIdentityHash(validated.graph);
  const definitions = snapshot.nodes
    .map((node) => node.nodeKey)
    .slice()
    .sort()
    .map((nodeKey) => nodeDefinitionFor(nodeKey, snapshot, binding));
  const derived = deriveNodeAuthoritySet(snapshot, definitions);
  if (!derived.ok) {
    throw new Error(derived.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return { authorities: derived.value, definitions };
}

function contentOf(patch: Partial<Record<string, unknown>> = {}): GraphRevisionContent {
  const snapshot = baseSnapshot();
  return {
    author: "human:architect-2cc07e26",
    completionNode: "dev-c",
    decompositionBudget: 24,
    nodeAuthority: authoritySectionFor(snapshot),
    parentRevision: "rev-000000000000",
    policyRevision: "pol-000000000001",
    repositoryBaseTree: "4".repeat(40),
    snapshot,
    ...patch,
  };
}

/** An `encodeGraphContent` SUCCESS value — the only lawful input to a put. */
function encodedContent(patch: Partial<Record<string, unknown>> = {}): GraphContent {
  const result = encodeGraphContent(contentOf(patch));
  if (!result.ok) {
    throw new Error(`fixture failed to encode: ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

// --- harness -----------------------------------------------------------------

function withStore<T>(name: string, run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-graph-body-${name}-`));
  try {
    const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
    try {
      return run(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, maxRetries: 5, recursive: true });
  }
}

function bodyEventCount(store: SqliteEventStore, hash: string): number {
  return store.readEvents(graphBodyAggregateId(PROJECT_ID, hash)).length;
}

/**
 * Plant a body row carrying bytes the record itself would never have written.
 * Corruption of an already-durable row is not reachable through `putGraphBody`
 * by construction — it only ever writes codec output — so the only honest way to
 * exercise the read-side decode gate is to write the damaged row directly, the
 * same way a disk fault or a hostile writer would.
 */
function plantBody(store: SqliteEventStore, hash: string, payload: Uint8Array): void {
  const aggregateId = graphBodyAggregateId(PROJECT_ID, hash);
  store.commit({
    aggregateId,
    commandBytes: new TextEncoder().encode(`plant-${hash}`),
    commandId: `plant-${hash}`,
    committedAt: "2026-08-18T00:00:00.000Z",
    events: [{ eventId: `planted-${hash}`, eventType: GRAPH_BODY_EVENT_TYPE, payload }],
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

// --- tests -------------------------------------------------------------------

describe("graph body record", () => {
  it("appends exactly one record keyed by the codec's own graphContentHash", () => {
    withStore("put", (store) => {
      const encoded = encodedContent();
      const put = putGraphBody(store, PROJECT_ID, encoded);

      expect(put.ok).toBe(true);
      if (!put.ok) throw new Error(`unexpected refusal ${put.code}`);
      expect(put.graphContentHash).toBe(encoded.graphContentHash);
      expect(bodyEventCount(store, encoded.graphContentHash)).toBe(1);
    });
  });

  it("returns bytes the REAL decoder accepts, re-deriving the requested key", () => {
    withStore("read", (store) => {
      const encoded = encodedContent();
      putGraphBody(store, PROJECT_ID, encoded);

      const read = readGraphBody(store, PROJECT_ID, encoded.graphContentHash);
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(`unexpected refusal ${read.code}`);

      // The decoder, not a byte compare, is the integrity authority here.
      const decoded = decodeGraphContent(read.bytes);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error("stored bytes did not survive the decoder");
      expect(decoded.value.graphContentHash).toBe(encoded.graphContentHash);
      expect(read.graphContentHash).toBe(encoded.graphContentHash);

      // dec-64b2391c: the structural identity is answered beside the content
      // hash and is never equal to it.
      expect(decoded.value.snapshotIdentity).not.toBe(decoded.value.graphContentHash);
    });
  });

  it("surfaces the DECODER's own code under this module's layer for a corrupt row", () => {
    withStore("corrupt", (store) => {
      const encoded = encodedContent();
      // A swapped hash inside otherwise-canonical bytes: the decoder recomputes
      // the digest BEFORE the byte comparison, so this is DIGEST_MISMATCH and
      // specifically not the misleading NONCANONICAL.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded.bytes);
      const tampered = new TextEncoder().encode(
        text.replace(encoded.graphContentHash, "b".repeat(64)),
      );
      plantBody(store, encoded.graphContentHash, tampered);

      const read = readGraphBody(store, PROJECT_ID, encoded.graphContentHash);
      expect(read.ok).toBe(false);
      if (read.ok) throw new Error("a corrupt row was accepted");
      expect(read.code).toBe("GRAPH_CONTENT_DIGEST_MISMATCH");
      expect(read.layer).toBe(GRAPH_BODY_RECORD_LAYER);
      // Which layer ACTUALLY refused, kept distinct from which layer reported.
      expect(read.sourceLayer).toBe("GRAPH_CONTENT_IDENTITY");
    });
  });

  it("refuses an absent hash with a code distinct from corruption", () => {
    withStore("absent", (store) => {
      const encoded = encodedContent();
      const read = readGraphBody(store, PROJECT_ID, encoded.graphContentHash);

      expect(read.ok).toBe(false);
      if (read.ok) throw new Error("an absent body was accepted");
      expect(read.code).toBe("GRAPH_BODY_ABSENT");
      expect(read.layer).toBe(GRAPH_BODY_RECORD_LAYER);
      expect(read.sourceLayer).toBeNull();
      // Absence is not corruption: the two must never collapse into one code.
      expect(read.code).not.toBe("GRAPH_CONTENT_DIGEST_MISMATCH");
    });
  });

  it("refuses a row whose bytes decode to a hash other than its key", () => {
    withStore("identity", (store) => {
      const wrong = encodedContent({ author: "human:someone-else" });
      const key = encodedContent().graphContentHash;
      expect(wrong.graphContentHash).not.toBe(key);
      // Perfectly canonical bytes, filed under the wrong key.
      plantBody(store, key, wrong.bytes);

      const read = readGraphBody(store, PROJECT_ID, key);
      expect(read.ok).toBe(false);
      if (read.ok) throw new Error("a misfiled body was accepted");
      expect(read.code).toBe("GRAPH_BODY_IDENTITY_MISMATCH");
      expect(read.layer).toBe(GRAPH_BODY_RECORD_LAYER);
      expect(read.sourceLayer).toBeNull();
    });
  });

  it("refuses a write that did not come from encodeGraphContent", () => {
    withStore("unencoded", (store) => {
      const encoded = encodedContent();
      // Hash and content are real; `bytes` is a plausible hand-serialisation.
      // Accepting this is the mint-your-own-identity seam the codec withholds.
      const forged = {
        ...encoded,
        bytes: new TextEncoder().encode(JSON.stringify(encoded.content)),
      } as unknown as GraphContent;

      const put = putGraphBody(store, PROJECT_ID, forged);
      expect(put.ok).toBe(false);
      if (put.ok) throw new Error("a hand-serialised body was accepted");
      expect(put.code).toBe("GRAPH_BODY_NOT_ENCODED");
      expect(put.layer).toBe(GRAPH_BODY_RECORD_LAYER);
      expect(bodyEventCount(store, encoded.graphContentHash)).toBe(0);
    });
  });

  it("is idempotent: a second put adds no event and returns the same hash", () => {
    withStore("idempotent", (store) => {
      const encoded = encodedContent();
      const first = putGraphBody(store, PROJECT_ID, encoded);
      const afterFirst = bodyEventCount(store, encoded.graphContentHash);
      const second = putGraphBody(store, PROJECT_ID, encoded);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error("idempotent put refused");
      expect(second.graphContentHash).toBe(first.graphContentHash);
      expect(afterFirst).toBe(1);
      expect(bodyEventCount(store, encoded.graphContentHash)).toBe(1);
    });
  });

  it("never appends on a read, on either the accepted or the refused path", () => {
    withStore("read-only", (store) => {
      const encoded = encodedContent();
      putGraphBody(store, PROJECT_ID, encoded);
      const before = bodyEventCount(store, encoded.graphContentHash);

      readGraphBody(store, PROJECT_ID, encoded.graphContentHash);
      readGraphBody(store, PROJECT_ID, "c".repeat(64));

      expect(before).toBe(1);
      expect(bodyEventCount(store, encoded.graphContentHash)).toBe(1);
      expect(bodyEventCount(store, "c".repeat(64))).toBe(0);
    });
  });

  it("declares every refusal code it can produce, and no more", () => {
    // A frozen vocabulary the drills in step 6 can be checked against; a code
    // that exists but is unreachable is as much a defect as a missing one.
    expect([...GRAPH_BODY_RECORD_CODES].sort()).toEqual([
      "GRAPH_BODY_ABSENT",
      "GRAPH_BODY_IDENTITY_MISMATCH",
      "GRAPH_BODY_NOT_ENCODED",
    ]);
  });
});

/**
 * DoD 2 of task-8c7e6ce4. The migration ADDS authority; it never weakens what this file
 * already proved, so every original persistence assertion above stands unchanged and these
 * cases sit beside them.
 *
 * NOT A TAUTOLOGY, and the distinction is the whole point. Comparing `authoritySectionFor`'s
 * stated set against a second `deriveNodeAuthoritySet` call over the same definitions would
 * compare production to itself. Each case below therefore holds ONE operand the producer did
 * not supply: the counts come from the fixture's own snapshot literal, the ordering rule from
 * `readAuthoritySection`'s contract, and the round trip from a SEPARATE production path —
 * `encodeGraphContent`'s `bindAuthority` re-derives the set and would refuse
 * GRAPH_CONTENT_AUTHORITY_DISAGREEMENT rather than return these bytes.
 */
describe("v3 node authority", () => {
  it("states one authority per snapshot node, index-aligned with its definition", () => {
    const snapshot = baseSnapshot();
    const section = authoritySectionFor(snapshot);

    // Nonempty is asserted explicitly: an empty section is the exact shape a sweep that
    // generated nothing would produce, and every set assertion below would pass over it.
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(section.authorities).toHaveLength(snapshot.nodes.length);
    expect(section.definitions).toHaveLength(snapshot.nodes.length);
    expect(section.definitions.map((definition) => definition.nodeKey))
      .toEqual(section.authorities.map((entry) => entry.nodeKey));
  });

  it("orders the section strictly ascending by nodeKey, as the field reader demands", () => {
    const keys = authoritySectionFor(baseSnapshot()).authorities.map((entry) => entry.nodeKey);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("carries one distinct 64-hex hash per node, none of them stated by this fixture", () => {
    const hashes = authoritySectionFor(baseSnapshot())
      .authorities.map((entry) => entry.nodeAuthorityHash);
    expect(hashes.filter((hash) => /^[0-9a-f]{64}$/u.test(hash))).toHaveLength(hashes.length);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("derives over exactly the HARD edges of the fixture graph, ADVISORY excluded", () => {
    const snapshot = baseSnapshot();
    const derived = deriveNodeAuthoritySet(
      snapshot, authoritySectionFor(snapshot).definitions,
    );
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    // The right operand is counted off the fixture's own literal, so this compares the
    // producer's view of the structure against the structure the test declared.
    expect(derived.hardEdgeCount)
      .toBe(snapshot.edges.filter((edge) => edge.kind === "HARD").length);
  });

  it("survives the codec's own re-derivation: the decoded set is the stated one", () => {
    const stated = contentOf().nodeAuthority;
    const encoded = encodedContent();
    const decoded = decodeGraphContent(encoded.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // `bindAuthority` RE-DERIVES rather than adopting, so agreement here is production
    // confirming the fixture, not the fixture confirming itself.
    expect(decoded.value.content.nodeAuthority.authorities).toEqual(stated.authorities);
  });
});
