/**
 * The server-side derivation of the two facts `foundation.dispatch` used to take from
 * its caller: the ACTIVE graph snapshot and the sealed workspace input manifest.
 *
 * NOTHING HERE IS SIMULATED. A real file-backed `SqliteEventStore`, the real bootstrap
 * command pipeline for project registration and repository binding, the real graph
 * revision reducer for the ACTIVE revision, and a real git repository on disk for the
 * manifest. A helper that reimplemented any of those would let the derivation pass
 * against facts production never produces.
 *
 * THE FIXTURE REPOSITORY IS SHA-256 ON PURPOSE, and it is the constraint that makes
 * these two authorities composable at all: the durable project observation validates
 * `baseRevisionHash` as 64 hex (`packages/core` project-validation `HASH_64`), while the
 * workspace manifest accepts 40 OR 64 (`baseIdentityRejection`). A default sha-1 `git
 * init` produces a 40-hex HEAD that the durable bind refuses, so the two layers can only
 * agree on a sha-256 repository.
 *
 * The reducer COMMAND INPUT below is restated rather than imported — `@moe/core`'s
 * revision fixtures are test-only and unreachable from its root — but every event, state
 * and lifecycle rule still comes from the production reducer.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAcceptanceContract, createPlanRevision, reduceGraphRevision,
} from "@moe/core";
import type { GraphRevisionCommand, GraphRevisionEvent, GraphRevisionState } from "@moe/core";
import {
  ADMISSION_PURPOSES,
  createNodeDefinition,
  deriveNodeAuthoritySet,
  encodeGraphContent,
  snapshotIdentityHash,
  validateGraphSnapshot,
} from "@moe/scheduler";
import type {
  GraphContent, GraphEdge, GraphRevisionContent, GraphSnapshot,
  NodeAuthoritySection, NodeDefinition,
} from "@moe/scheduler";
import { hermeticGitEnvironment } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  OBSERVATION, PROJECT_ID, closeStores, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  ACTIVE_GRAPH_PROJECTION_LAYER, graphRevisionAggregateId,
} from "../planning/active-graph-projection.js";
import { putGraphBody } from "../planning/graph-body-record.js";
import { deriveFoundationDispatchFacts } from "./foundation-dispatch-derivation.js";
import { FOUNDATION_ATTEMPT_INPUT_KEYS } from "./foundation-attempt-contracts.js";
import { FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION } from "./foundation-repository-scope-contracts.js";

const ENCODER = new TextEncoder();
const SCOPE_PATHS = ["scope/alpha.txt", "scope/beta.txt"] as const;
const roots: string[] = [];

// --- the real repository on disk ---------------------------------------------

interface RepositoryFixture {
  readonly head: string;
  readonly root: string;
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root, encoding: "utf8", env: hermeticGitEnvironment(process.env),
    shell: false, windowsHide: true,
  }).trim();
}

function repositoryFixture(): RepositoryFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-dispatch-derivation-")));
  roots.push(root);
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, SCOPE_PATHS[0]), Buffer.from("alpha\n", "utf8"));
  writeFileSync(join(root, SCOPE_PATHS[1]), Buffer.from("beta\n", "utf8"));
  // sha-256 objects: a 40-hex HEAD cannot be bound durably. See the header.
  runGit(root, ["init", "--object-format=sha256", "--initial-branch=main", "--quiet"]);
  runGit(root, ["add", "--", ...SCOPE_PATHS]);
  runGit(root, [
    "-c", "user.name=Moe Foundation", "-c", "user.email=foundation@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "dispatch derivation fixture",
  ]);
  return { head: runGit(root, ["rev-parse", "HEAD"]), root };
}

function expectedEntries(fixture: RepositoryFixture) {
  return SCOPE_PATHS.map((path) => {
    const bytes = readFileSync(join(fixture.root, path));
    return {
      byteLength: bytes.byteLength, path, producer: { kind: "BASE" as const },
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

// --- durable seeding, all through production seams ---------------------------

/** Registers the project and binds the repository at the fixture's REAL head. */
function seedProject(store: SqliteEventStore, fixture: RepositoryFixture): void {
  driveThrough(store, "project.bind_repository");
  const outcome = send(store, envelope("project.bind_repository", 1, {
    observation: { ...OBSERVATION, baseRevisionHash: fixture.head },
  }));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
}

function catalogSourceFor(fixture: RepositoryFixture): () => unknown {
  return () => ({
    catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
    entries: [{
      declaredPaths: [...SCOPE_PATHS], projectId: PROJECT_ID,
      repositoryRef: OBSERVATION.repositoryRef, scopeRef: OBSERVATION.scopeRef,
      sourceRepositoryRoot: fixture.root, worktreeParent: fixture.root,
    }],
  });
}

// --- graph revision fixtures (command input only; the reducer owns the rules) --

function baseSnapshot(): GraphSnapshot {
  return {
    completionNodeKey: "dev-c",
    edges: [{ consumerNodeKey: "dev-c", edgeKey: "dev-e1", kind: "HARD", producerNodeKey: "dev-a" }],
    nodes: [{ executionBearing: true, nodeKey: "dev-a" }, { executionBearing: false, nodeKey: "dev-c" }],
  };
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

function encoded(author: string): GraphContent {
  const snapshot = baseSnapshot();
  const content: GraphRevisionContent = {
    author, completionNode: "dev-c", decompositionBudget: 24,
    nodeAuthority: authoritySectionFor(snapshot),
    parentRevision: "rev-000000000000", policyRevision: "pol-000000000001",
    repositoryBaseTree: "4".repeat(40), snapshot,
  };
  const result = encodeGraphContent(content);
  if (!result.ok) throw new Error(`fixture failed to encode: ${JSON.stringify(result.issues)}`);
  return result.value;
}

const seededHash = (seed: string): string => seed.repeat(64).slice(0, 64);

function bindingOf(graphHash: string) {
  return {
    budgetHash: seededHash("55"), expectedGoalVersion: 3, graphHash,
    policyHash: seededHash("66"), qualityHash: seededHash("33"),
  } as const;
}

type Step = (current: GraphRevisionState | undefined) => GraphRevisionCommand;
const versionOf = (current: GraphRevisionState | undefined): number =>
  current === undefined ? 0 : current.version;

function activePath(revisionId: string, graphHash: string, activationRef: string): readonly Step[] {
  return [
    () => ({
      commandId: `cmd-create-${revisionId}`, expectedVersion: 0, goalRef: "goal-1",
      graphContentHash: graphHash, kind: "graph_revision.create",
      planHash: seededHash("11"), revisionId,
    }) as GraphRevisionCommand,
    (current) => ({
      commandId: `cmd-submit-${revisionId}`, expectedVersion: versionOf(current),
      kind: "graph_revision.submit",
      witness: { submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED" },
    }) as GraphRevisionCommand,
    (current) => ({
      activation: {
        ...bindingOf(graphHash), activationRef, graphEpoch: 1, truthClass: "HUMAN_APPROVED",
      },
      approval: { ...bindingOf(graphHash), approvalRef: `approval-${revisionId}`, truthClass: "HUMAN_APPROVED" },
      commandId: `cmd-approve-${revisionId}`, expectedVersion: versionOf(current),
      kind: "graph.approve",
    }) as unknown as GraphRevisionCommand,
  ];
}

function seedActiveRevision(
  store: SqliteEventStore, revisionId: string, content: GraphContent, activationRef: string,
): void {
  let current: GraphRevisionState | undefined;
  const events: GraphRevisionEvent[] = [];
  for (const step of activePath(revisionId, content.graphContentHash, activationRef)) {
    const result = reduceGraphRevision(current, step(current));
    if (!result.ok) throw new Error(`fixture command rejected: ${result.error.code}`);
    current = result.state;
    events.push(...result.events);
  }
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, revisionId);
  store.commit({
    aggregateId, commandBytes: ENCODER.encode(`seed-${revisionId}`),
    commandId: `seed-${revisionId}`, committedAt: "2026-08-19T00:00:00.000Z",
    events: events.map((event, index) => ({
      eventId: `seed-${revisionId}-${index}`, eventType: event.kind,
      payload: ENCODER.encode(JSON.stringify(event)),
    })),
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
  const stored = putGraphBody(store, PROJECT_ID, content);
  if (!stored.ok) throw new Error(`fixture body refused: ${stored.code}`);
}

// --- the call under test ------------------------------------------------------

function derive(store: SqliteEventStore, fixture: RepositoryFixture, projectId = PROJECT_ID) {
  return deriveFoundationDispatchFacts({
    catalogSource: catalogSourceFor(fixture), projectId, store,
  });
}

afterEach(() => {
  closeStores();
  for (const root of [...roots]) {
    rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    roots.splice(roots.indexOf(root), 1);
  }
});

describe("foundation dispatch derivation", () => {
  it("derives the ACTIVE graph snapshot from the durable revision, with its provenance", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    const content = encoded("human:architect-primary");
    seedActiveRevision(store, "graph-revision-1", content, "activation-1");

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(true);
    if (!derived.ok) throw new Error(derived.code);
    // `content.content` is the ENCODER's projection of the graph; `derived.graphSnapshot`
    // is the projection's read-back of the durable body. Independent operands.
    expect(derived.graphSnapshot).toEqual(content.content.snapshot);
    expect(derived.provenance).toMatchObject({
      graphContentHash: content.graphContentHash, graphEpoch: 1, revisionId: "graph-revision-1",
    });
  });

  it("passes an ABSENT graph refusal through with the projection's OWN layer", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(false);
    if (derived.ok) throw new Error("derivation accepted a project with no ACTIVE graph");
    expect([derived.code, derived.refusedBy])
      .toEqual(["ACTIVE_GRAPH_ABSENT", ACTIVE_GRAPH_PROJECTION_LAYER]);
  });

  it("passes SPLIT_BRAIN through rather than choosing between two ACTIVE revisions", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    seedActiveRevision(store, "graph-revision-1", encoded("human:architect-primary"), "activation-1");
    seedActiveRevision(store, "graph-revision-2", encoded("human:architect-successor"), "activation-2");

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(false);
    if (derived.ok) throw new Error("derivation chose between two ACTIVE revisions");
    expect([derived.code, derived.refusedBy])
      .toEqual(["ACTIVE_GRAPH_SPLIT_BRAIN", ACTIVE_GRAPH_PROJECTION_LAYER]);
  });

  it("seals the input manifest from the SERVER-observed head, in the codec's exact shape", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    seedActiveRevision(store, "graph-revision-1", encoded("human:architect-primary"), "activation-1");

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(true);
    if (!derived.ok) throw new Error(derived.code);
    // The head the SERVER read from the repository, not any value a caller could send.
    expect(derived.inputManifest.baseIdentity).toBe(fixture.head);
    expect(runGit(fixture.root, ["rev-parse", "HEAD"])).toBe(derived.inputManifest.baseIdentity);
    expect(derived.inputManifest.entries).toEqual(expectedEntries(fixture));
    // The sealed manifest carries manifestVersion and sha256 too; the attempt codec's
    // allow-list is exactly two keys, so the derivation must project rather than forward.
    expect(Object.keys(derived.inputManifest).sort())
      .toEqual([...FOUNDATION_ATTEMPT_INPUT_KEYS].sort());
  });

  it("passes a hydrator refusal through with the hydrator's own code and layer", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    seedActiveRevision(store, "graph-revision-1", encoded("human:architect-primary"), "activation-1");
    rmSync(fixture.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    roots.splice(roots.indexOf(fixture.root), 1);

    const derived = derive(store, fixture);

    expect(derived.ok).toBe(false);
    if (derived.ok) throw new Error("derivation sealed a manifest over a missing worktree");
    expect(derived.code).toBe("FOUNDATION_INPUT_WORKTREE_MISSING");
    expect(derived.refusedBy).not.toBe(ACTIVE_GRAPH_PROJECTION_LAYER);
  });

  it("does not return one project's ACTIVE graph when deriving for another", () => {
    const fixture = repositoryFixture();
    const store = openStore();
    seedProject(store, fixture);
    seedActiveRevision(store, "graph-revision-1", encoded("human:architect-primary"), "activation-1");

    const derived = derive(store, fixture, "project-2");

    expect(derived.ok).toBe(false);
    if (derived.ok) throw new Error("derivation crossed a project boundary");
    expect(derived.code).toBe("ACTIVE_GRAPH_ABSENT");
  });
});
