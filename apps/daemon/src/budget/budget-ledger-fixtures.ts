/**
 * Shared durable fixtures for the budget ledger and its current projection.
 *
 * EVERY FACT THIS MODULE PUTS ON DISK COMES FROM A PRODUCTION WRITER. The project and the
 * goal are driven through `runBootstrapCommand` (via `bootstrap-test-fixtures`), so
 * `GoalCreated.budgetAccountRef` is the reducer's own event rather than a literal; the graph
 * revision is driven through `reduceGraphRevision` and its body through `putGraphBody`, so
 * `readCurrentActiveGraph` answers from the same evidence production would answer from.
 *
 * A hand-written event would let the ledger pass against bytes production never emits, and the
 * two would drift together while staying green.
 *
 * RAW SEEDING is offered by `plantRawTransition` and is used ONLY for states production writers
 * refuse to produce by construction — a second root, a sequence gap, a conservation breach,
 * tampered bytes. Every call site says which impossible state it is planting.
 *
 * WINDOWS HANDLE DISCIPLINE: `withBudgetStore` closes the handle in a `finally` inside the temp
 * directory's own `finally`. A handle held across `rmSync` throws EPERM and kills the vitest
 * worker with no output at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
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
  GraphContent, GraphEdge, GraphNode, GraphRevisionContent, GraphSnapshot,
  NodeAuthoritySection, NodeDefinition,
} from "@moe/scheduler";
import { SqliteEventStore } from "@moe/store";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { GOAL_ID, PROJECT_ID, driveThrough } from "../bootstrap/bootstrap-test-fixtures.js";
import { putGraphBody } from "../planning/graph-body-record.js";
import { graphRevisionAggregateId } from "../planning/active-graph-projection.js";

export { GOAL_ID, PROJECT_ID };

/** The account ref `bootstrap-test-fixtures.goalPayload()` hands `goal.create`. Read back off
 *  the durable `GoalCreated` by the production binding reader; restated here only so a test can
 *  assert the reader found THE SAME ref rather than one it was handed. */
export const BUDGET_ACCOUNT_REF = "budget-account-1";
export const REVISION_ID = "graph-revision-1";
export const SUCCESSOR_REVISION_ID = "graph-revision-2";

const ENCODER = new TextEncoder();

function seededHash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

const PLAN_HASH = seededHash("11");
const CANONICALIZER = "canon-v1";
const CARRY_HASH = seededHash("44");
const BINDING_HASH = seededHash("66");

function baseSnapshot(): GraphSnapshot {
  const nodes: readonly GraphNode[] = [
    { nodeKey: "dev-a", executionBearing: true },
    { nodeKey: "dev-c", executionBearing: true },
  ];
  const edges: readonly GraphEdge[] = [
    { edgeKey: "dev-e1", producerNodeKey: "dev-a", consumerNodeKey: "dev-c", kind: "HARD" },
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

function encodedContent(author: string): GraphContent {
  const snapshot = baseSnapshot();
  const content: GraphRevisionContent = {
    author,
    completionNode: "dev-c",
    decompositionBudget: 24,
    nodeAuthority: authoritySectionFor(snapshot),
    parentRevision: "rev-000000000000",
    policyRevision: "pol-000000000001",
    repositoryBaseTree: "4".repeat(40),
    snapshot,
  };
  const result = encodeGraphContent(content);
  if (!result.ok) throw new Error(`fixture failed to encode: ${JSON.stringify(result.issues)}`);
  return result.value;
}

export const PRIMARY_CONTENT = encodedContent("human:architect-primary");
export const SUCCESSOR_CONTENT = encodedContent("human:architect-successor");

type Step = (current: GraphRevisionState | undefined) => GraphRevisionCommand;

const versionOf = (current: GraphRevisionState | undefined): number =>
  current === undefined ? 0 : current.version;

function bindingOf(graphHash: string) {
  return {
    budgetHash: seededHash("55"),
    expectedGoalVersion: 3,
    graphHash,
    policyHash: seededHash("66"),
    qualityHash: seededHash("33"),
  } as const;
}

function createOf(revisionId: string, graphContentHash: string): Step {
  return () => ({
    commandId: `cmd-create-${revisionId}`, expectedVersion: 0, goalRef: GOAL_ID,
    graphContentHash, kind: "graph_revision.create", planHash: PLAN_HASH, revisionId,
  }) as GraphRevisionCommand;
}

const submit: Step = (current) => ({
  commandId: "cmd-submit", expectedVersion: versionOf(current), kind: "graph_revision.submit",
  witness: { submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED" },
}) as GraphRevisionCommand;

function approveAndActivateOf(graphHash: string): Step {
  const binding = bindingOf(graphHash);
  return (current) => ({
    activation: { ...binding, activationRef: "activation-1", graphEpoch: 1, truthClass: "HUMAN_APPROVED" },
    approval: { ...binding, approvalRef: "approval-1", truthClass: "HUMAN_APPROVED" },
    commandId: "cmd-approve", expectedVersion: versionOf(current), kind: "graph.approve",
  }) as unknown as GraphRevisionCommand;
}

function carryFact(digest: string) {
  return {
    canonicalizerVersion: CANONICALIZER, dependenciesPresent: true,
    environmentClosureUnchanged: true, policySliceUnchanged: true,
    predecessorResultUnchanged: true, sourceHash: digest, targetHash: digest,
  };
}

function successorBindingOf(current: GraphRevisionState) {
  return {
    graphContentHash: SUCCESSOR_CONTENT.graphContentHash,
    graphEpoch: current.graphEpoch + 1,
    predecessorGraphContentHash: current.graphContentHash,
    predecessorRevisionId: current.revisionId,
    revisionId: SUCCESSOR_REVISION_ID,
  };
}

const supersede: Step = (current) => {
  if (current === undefined) throw new Error("supersede needs a live state");
  return {
    commandId: "cmd-supersede", expectedVersion: current.version, kind: "graph.supersede",
    supersession: {
      dispositions: [{
        kind: "CARRY", nodeKey: "node-carry", predecessorAuthorityHash: CARRY_HASH,
        safeCarry: { authority: carryFact(CARRY_HASH), inputBinding: carryFact(BINDING_HASH) },
        successorAuthorityHash: CARRY_HASH,
      }],
      expectedPredecessor: {
        graphContentHash: current.graphContentHash, graphEpoch: current.graphEpoch,
        revisionId: current.revisionId,
      },
      successor: successorBindingOf(current),
      supportedCanonicalizerVersions: [CANONICALIZER],
    },
  } as unknown as GraphRevisionCommand;
};

function activateSuccessorOf(predecessor: GraphRevisionState): Step {
  const successor = successorBindingOf(predecessor);
  const binding = bindingOf(successor.graphContentHash);
  return (current) => ({
    activation: {
      ...binding, activationRef: "activation-2", graphEpoch: successor.graphEpoch,
      succession: {
        predecessorGraphContentHash: successor.predecessorGraphContentHash,
        predecessorGraphEpoch: predecessor.graphEpoch,
        predecessorRevisionId: successor.predecessorRevisionId,
      },
      truthClass: "HUMAN_APPROVED",
    },
    approval: { ...binding, approvalRef: "approval-2", truthClass: "HUMAN_APPROVED" },
    commandId: "cmd-approve-2", expectedVersion: versionOf(current), kind: "graph.approve",
  }) as unknown as GraphRevisionCommand;
}

/** Drives the REAL revision reducer and returns the events it actually emitted. */
function drive(steps: readonly Step[]): { events: GraphRevisionEvent[]; state: GraphRevisionState } {
  let current: GraphRevisionState | undefined;
  const events: GraphRevisionEvent[] = [];
  for (const step of steps) {
    const result = reduceGraphRevision(current, step(current));
    if (!result.ok) throw new Error(`fixture command rejected: ${result.error.code}`);
    current = result.state;
    events.push(...result.events);
  }
  if (current === undefined) throw new Error("path produced no state");
  return { events, state: current };
}

function commitRevision(
  store: SqliteEventStore, revisionId: string, events: readonly GraphRevisionEvent[], tag: string,
): void {
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, revisionId);
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(`${tag}-${revisionId}`),
    commandId: `${tag}-${revisionId}`,
    committedAt: "2026-08-19T00:00:00.000Z",
    events: events.map((event, index) => ({
      eventId: `${tag}-${revisionId}-${index}`,
      eventType: event.kind,
      payload: ENCODER.encode(JSON.stringify(event)),
    })),
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

/**
 * The whole server-side precondition this task's writers bind to: an ACTIVE project, a durable
 * `GoalCreated` carrying `budgetAccountRef`, and one ACTIVE graph revision with its body.
 * Returns the revision state so a caller can assert against the epoch the reducer produced.
 */
export function seedProjectAndGoal(store: SqliteEventStore): void {
  driveThrough(store, "plan.propose");
}

export function seedDurableBindings(store: SqliteEventStore): GraphRevisionState {
  seedProjectAndGoal(store);
  const driven = drive([
    createOf(REVISION_ID, PRIMARY_CONTENT.graphContentHash), submit,
    approveAndActivateOf(PRIMARY_CONTENT.graphContentHash),
  ]);
  commitRevision(store, REVISION_ID, driven.events, "seed");
  putGraphBody(store, PROJECT_ID, PRIMARY_CONTENT);
  return driven.state;
}

/**
 * Supersedes the seeded revision and activates the successor, so `readCurrentActiveGraph` moves
 * to graph epoch 2. This is the honest way to make an already-committed ledger binding STALE:
 * nothing about the ledger changes, the world underneath it does.
 */
export function advanceActiveGraph(store: SqliteEventStore, predecessor: GraphRevisionState): GraphRevisionState {
  const superseded = drive([
    createOf(REVISION_ID, PRIMARY_CONTENT.graphContentHash), submit,
    approveAndActivateOf(PRIMARY_CONTENT.graphContentHash), supersede,
  ]);
  commitRevision(store, REVISION_ID, superseded.events.slice(-1), "supersede");
  const successor = drive([
    createOf(SUCCESSOR_REVISION_ID, SUCCESSOR_CONTENT.graphContentHash), submit,
    activateSuccessorOf(predecessor),
  ]);
  commitRevision(store, SUCCESSOR_REVISION_ID, successor.events, "successor");
  putGraphBody(store, PROJECT_ID, SUCCESSOR_CONTENT);
  return successor.state;
}

export function withBudgetStore<T>(name: string, run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-budget-${name}-`));
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

export interface RawCounts {
  readonly events: number;
  readonly decisions: number;
}

/** Raw durable counts, read straight off the store — the invariance every read-only claim owes. */
export function rawCounts(store: SqliteEventStore, aggregateId: string): RawCounts {
  return {
    decisions: readDurableLedger(store, PROJECT_ID).decisionCount,
    events: store.readEvents(aggregateId).length,
  };
}

/**
 * Appends bytes to the ledger aggregate WITHOUT going through a writer.
 *
 * Planted-row precedent: the states this reaches — a second root, a sequence gap, a successor
 * that disagrees with its own entry fold, tampered bytes — are refused by the production writers
 * by construction, so no honest fixture can produce them and the projection's refusal arms would
 * otherwise be unreachable and untested.
 */
export function plantRawTransition(
  store: SqliteEventStore, aggregateId: string, eventId: string, eventType: string, payload: Uint8Array,
): void {
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(`plant-${eventId}`),
    commandId: `plant-${eventId}`,
    committedAt: "2026-08-19T00:00:01.000Z",
    events: [{ eventId, eventType, payload }],
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

/**
 * An ACTIVE graph revision whose BODY was never recorded.
 *
 * `readCurrentActiveGraph` answers `ACTIVE_GRAPH_BODY_UNAVAILABLE` here rather than
 * `ACTIVE_GRAPH_ABSENT`: a durable history that exists and cannot be read whole is a DIFFERENT
 * world from a clean empty project, which is the distinction active-graph-projection.ts:120-126
 * exists to preserve. A genesis bootstrap must refuse this world, so a suite needs a way to
 * reach it through the same writers the ACTIVE world is seeded with.
 */
export function seedActiveGraphWithoutBody(store: SqliteEventStore): GraphRevisionState {
  seedProjectAndGoal(store);
  const driven = drive([
    createOf(REVISION_ID, PRIMARY_CONTENT.graphContentHash), submit,
    approveAndActivateOf(PRIMARY_CONTENT.graphContentHash),
  ]);
  commitRevision(store, REVISION_ID, driven.events, "seed-bodyless");
  return driven.state;
}
