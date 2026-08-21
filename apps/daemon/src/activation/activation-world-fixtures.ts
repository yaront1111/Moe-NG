/**
 * The ACTIVATION WORLD every activation seeder owes once `effect.activate` derives its budget
 * from durable authority instead of the caller's payload section.
 *
 * WHY THIS FILE EXISTS. Until now no activation fixture needed a durable ACTIVE graph: the
 * caller's budget section WAS the authority, so a store with a project and a goal was enough.
 * The moment authority moves to `readCurrentActiveGraph`, every one of those worlds refuses
 * `BUDGET_PROJECTION_GRAPH_UNAVAILABLE`. This file seeds the missing layer once, so the flip
 * is a no-op rather than a wall (task-acc1a3b4; the measurement is comment-e074e82a on
 * task-e194c5f6 — 24 files / 413 tests, one root cause).
 *
 * EVERY FACT COMES FROM A PRODUCTION WRITER. The revision is driven through
 * `reduceGraphRevision`, the body through `putGraphBody`, the node authority through
 * `createNodeDefinition` + `deriveNodeAuthoritySet` (which RE-DERIVES what it is handed, so a
 * hand-built authority section cannot pass), and the root through `authorizeBudgetRoot`. A
 * hand-folded event would let every consuming suite go green against bytes production never
 * emits — the defect class this board retires.
 *
 * THE METER IS LOAD-BEARING, NOT INCIDENTAL. The root is authorized on `runner.authorized_ms`
 * because that is the meter the node definition's `admissionAmounts` are denominated in.
 * `NODE_ADMISSION_METERS` is closed at the node-authority boundary while the ledger's meter is
 * a bounded free string, so a root funded on ledger vocabulary (`tokens`, `seconds`) seeds
 * GREEN and refuses at reserve time, long after this fixture is out of sight. The sibling test
 * asserts that correspondence rather than restating it in prose.
 *
 * SOURCE. The chain is TRANSCRIBED from `seedWorld` in
 * `activation-budget-derivation.test.ts:339`, which is task-e194c5f6's UNCOMMITTED work.
 * Nothing here imports it: a green that depends on untracked bytes git cannot restore is not a
 * green. Credit, not coupling.
 */

import {
  createAcceptanceContract,
  createPlanRevision,
  reduceGraphRevision,
} from "@moe/core";
import type { GraphRevisionCommand, GraphRevisionEvent, GraphRevisionState } from "@moe/core";
import {
  ADMISSION_PURPOSES,
  createNodeDefinition,
  deriveNodeAuthoritySet,
  encodeGraphContent,
  validateGraphSnapshot,
} from "@moe/scheduler";
import type {
  GraphContent,
  GraphNode,
  GraphRevisionContent,
  GraphSnapshot,
  NodeAuthoritySection,
  NodeDefinition,
} from "@moe/scheduler";
import { SqliteEventStore } from "@moe/store";

import { GOAL_ID, PROJECT_ID, envelope, goalPayload, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import { authorizeBudgetRoot } from "../budget/budget-ledger.js";
import { graphRevisionAggregateId, readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import { putGraphBody } from "../planning/graph-body-record.js";

const ENCODER = new TextEncoder();
const hex = (digit: string): string => digit.repeat(64);
const seededHash = (seed: string): string => seed.repeat(64).slice(0, 64);

/** The revision the seeded world activates; consumers assert against this id, not a literal. */
export const ACTIVATION_WORLD_REVISION_ID = "graph-revision-1";
/** The single execution-bearing node door 2 must resolve with no caller argument. */
export const ACTIVATION_WORLD_NODE_KEY = "dev-solo";
/** Exact, not `> 0`: a fixture that plants an empty graph must not satisfy the readback. */
export const ACTIVATION_WORLD_BEARING_NODE_COUNT = 1;
/** The one meter the node's `admissionAmounts` and the authorized root must agree on. */
export const ACTIVATION_WORLD_METER = "runner.authorized_ms";
export const ACTIVATION_WORLD_AUTHORIZED_AMOUNT = 1_000_000;

const PLAN_HASH = seededHash("11");

/** One execution-bearing node, zero edges — so it owes no dependency contract and no proof. */
const soloSnapshot = (): GraphSnapshot => ({
  completionNodeKey: ACTIVATION_WORLD_NODE_KEY,
  edges: [],
  nodes: [{ executionBearing: true, nodeKey: ACTIVATION_WORLD_NODE_KEY }] as readonly GraphNode[],
});

const planDraftFor = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  affectedCriterionIds: ["criterion-a"],
  affectedNodeIds: [...nodeKeys],
  approvalState: "APPROVED",
  authorRef: "principal-a",
  graphBinding: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null,
  rejectionRef: null,
  revisionId: "plan-revision-a",
  steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-a" }],
  verificationRecipeRefs: ["recipe-a"],
});

const acceptanceDraftFor = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  applicability: {
    graphContentHash: hex("a"),
    graphRevisionRef: "graph-revision-a",
    nodeIds: [...nodeKeys],
    nodeKind: "LEAF",
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
  parameterSchema: { digest: hex("b"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-a",
  proofRationale: "An artifact seal cannot become unsealed.",
  schemaId: "schema-a",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
};

/** Admitted by PRODUCTION or not built at all: a body the codec refuses could never reach the
 *  encode this fixture exists to feed. */
function nodeDefinitionFor(nodeKey: string, snapshot: GraphSnapshot): NodeDefinition {
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
        meter: ACTIVATION_WORLD_METER, purpose, quantity: index + 1,
      })),
      admissionGatePolicy: "POLICY_ALLOWANCE",
      capability: "capability-implement",
      completionLinkage: completes ? nodeKey : null,
      constraints: ["constraint-a"],
      // Edge-free BY DESIGN, so no node owes a dependency contract. This is not a shortcut a
      // widened snapshot could silently inherit: `deriveNodeAuthoritySet` re-derives against the
      // real structure, so a HARD in-edge with no contract fails derivation rather than
      // producing an under-specified node.
      directHardDependencies: [],
      joinRole: completes ? "COMPLETION" : "NONE",
      nodeKey,
      objective: `Land ${nodeKey}.`,
      policySliceHash: hex("3"),
      readScopes: ["services/api/src"],
      repositoryBaseTree: hex("4"),
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

/** `authorities` is the PRODUCER'S value: `bindAuthority` re-derives and refuses any other. */
function authoritySectionFor(snapshot: GraphSnapshot): NodeAuthoritySection {
  const validated = validateGraphSnapshot(snapshot);
  if (!validated.ok) {
    throw new Error(`graph fixture refused: ${validated.issues[0]?.code ?? "?"}`);
  }
  const definitions = snapshot.nodes
    .map((node) => node.nodeKey)
    .slice()
    .sort()
    .map((nodeKey) => nodeDefinitionFor(nodeKey, snapshot));
  const derived = deriveNodeAuthoritySet(snapshot, definitions);
  if (!derived.ok) {
    throw new Error(derived.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return { authorities: derived.value, definitions };
}

function encodedContent(snapshot: GraphSnapshot): GraphContent {
  const content: GraphRevisionContent = {
    author: "human:architect-primary",
    completionNode: snapshot.completionNodeKey,
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

const bindingOf = (graphHash: string) => ({
  budgetHash: seededHash("55"),
  expectedGoalVersion: 3,
  graphHash,
  policyHash: seededHash("66"),
  qualityHash: seededHash("33"),
} as const);

/** Drives the REAL revision reducer and returns the events it actually emitted. */
function driveRevision(graphContentHash: string): readonly GraphRevisionEvent[] {
  const binding = bindingOf(graphContentHash);
  const steps: readonly ((c: GraphRevisionState | undefined) => GraphRevisionCommand)[] = [
    () => ({
      commandId: `cmd-create-${ACTIVATION_WORLD_REVISION_ID}`,
      expectedVersion: 0,
      goalRef: GOAL_ID,
      graphContentHash,
      kind: "graph_revision.create",
      planHash: PLAN_HASH,
      revisionId: ACTIVATION_WORLD_REVISION_ID,
    }) as GraphRevisionCommand,
    (current) => ({
      commandId: "cmd-submit",
      expectedVersion: current === undefined ? 0 : current.version,
      kind: "graph_revision.submit",
      witness: { submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED" },
    }) as GraphRevisionCommand,
    (current) => ({
      activation: {
        ...binding, activationRef: "activation-1", graphEpoch: 1, truthClass: "HUMAN_APPROVED",
      },
      approval: { ...binding, approvalRef: "approval-1", truthClass: "HUMAN_APPROVED" },
      commandId: "cmd-approve",
      expectedVersion: current === undefined ? 0 : current.version,
      kind: "graph.approve",
    }) as unknown as GraphRevisionCommand,
  ];
  let current: GraphRevisionState | undefined;
  const events: GraphRevisionEvent[] = [];
  for (const step of steps) {
    const result = reduceGraphRevision(current, step(current));
    if (!result.ok) throw new Error(`fixture command rejected: ${result.error.code}`);
    current = result.state;
    events.push(...result.events);
  }
  if (current === undefined) throw new Error("revision path produced no state");
  return events;
}

function commitRevision(store: SqliteEventStore, events: readonly GraphRevisionEvent[]): void {
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, ACTIVATION_WORLD_REVISION_ID);
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(`seed-${ACTIVATION_WORLD_REVISION_ID}`),
    commandId: `seed-${ACTIVATION_WORLD_REVISION_ID}`,
    committedAt: "2026-08-19T00:00:00.000Z",
    events: events.map((event, index) => ({
      eventId: `seed-${ACTIVATION_WORLD_REVISION_ID}-${index}`,
      eventType: event.kind,
      payload: ENCODER.encode(JSON.stringify(event)),
    })),
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

/**
 * Drives `goal.create` only when the world does not already carry one.
 *
 * Seeders differ on this: `driveThrough` creates a goal, `seedReadyProject` does not, and the
 * measured red set showed GOAL_ABSENT only 6 times against GRAPH_UNAVAILABLE 265 — most worlds
 * already have a goal and only the graph is missing everywhere. Re-sending `goal.create` into a
 * world that has one would refuse on the aggregate version, so the check is a precondition, not
 * a swallowed error: any OTHER refusal still throws.
 */
export function ensureSeededGoal(store: SqliteEventStore): void {
  if (store.readEvents(GOAL_ID).length > 0) return;
  const outcome = send(store, envelope("goal.create", 0, goalPayload()));
  if (!outcome.ok) throw new Error(`activation world goal.create refused: ${outcome.code}`);
}

/** The durable ACTIVE graph on its own — no budget root. */
export function seedActivationGraph(store: SqliteEventStore): GraphContent {
  const content = encodedContent(soloSnapshot());
  commitRevision(store, driveRevision(content.graphContentHash));
  const recorded = putGraphBody(store, PROJECT_ID, content);
  if (!recorded.ok) throw new Error(`activation world graph body refused: ${recorded.code}`);
  return content;
}

/**
 * THE HAPPY WORLD: an ACTIVE graph with one execution-bearing node and a budget root authorized
 * on the meter that node actually spends. This is what the ~14 activation seeders gain.
 *
 * IDEMPOTENT BY CONSTRUCTION, and that is a correctness property rather than a convenience.
 * Worlds arrive here in three different states: no graph at all (`seedReadyProject`), a graph
 * the production planning chain already activated (`driveThrough` past `plan.propose`, whose
 * own revision is ALSO `graph-revision-1`), and a root already authorized. Seeding
 * unconditionally would publish a second ACTIVE revision and turn a healthy world into
 * `ACTIVE_GRAPH_SPLIT_BRAIN` — measured, not hypothesised. So each layer is added ONLY when it
 * is the missing one, which is exactly this row's mandate: enrich the world, never rebuild it.
 */
export function seedActivationWorld(store: SqliteEventStore): void {
  ensureSeededGoal(store);
  ensureActiveGraph(store);
  ensureAuthorizedBudgetRoot(store);
}

/**
 * Seeds a graph only when the projection says one is ABSENT — never on any other refusal.
 *
 * The looser test (`if (!result.ok)`) is wrong in a way that hides defects: a world whose graph
 * exists but is unreadable refuses `ACTIVE_GRAPH_BODY_UNAVAILABLE`, and seeding a second
 * revision on top of it would bury that real refusal under `ACTIVE_GRAPH_SPLIT_BRAIN` from a
 * fixture. Absent means seed; broken means leave it broken and visible.
 */
function ensureActiveGraph(store: SqliteEventStore): void {
  const current = readCurrentActiveGraph(store, PROJECT_ID);
  if (current.ok || current.code !== "ACTIVE_GRAPH_ABSENT") return;
  seedActivationGraph(store);
}

/**
 * Authorizes the root only when the ledger says there is none.
 *
 * Same discipline as the graph: `BUDGET_PROJECTION_ABSENT` is the one refusal that means "no
 * root yet". Authorizing on any other refusal would either mask it or hit
 * BUDGET_LEDGER_ALREADY_AUTHORIZED and turn enrichment into a thrown fixture.
 */
function ensureAuthorizedBudgetRoot(store: SqliteEventStore): void {
  const existing = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (existing.ok || existing.code !== "BUDGET_PROJECTION_ABSENT") return;
  const authorized = authorizeBudgetRoot(store, {
    amounts: [{ meter: ACTIVATION_WORLD_METER, amount: ACTIVATION_WORLD_AUTHORIZED_AMOUNT }],
    context: {
      commandId: "cmd-authorize-activation-world",
      correlationId: "corr-activation-world",
      decidedAt: "2026-08-19T00:00:00.000Z",
      principalId: "principal-1",
    },
    goalRef: GOAL_ID,
    projectId: PROJECT_ID,
  });
  if (!authorized.ok) throw new Error(`activation world budget root refused: ${authorized.code}`);
}

/**
 * DELIBERATE NEGATIVE WORLD — a goal and NO graph.
 *
 * Enriching every world with the happy precondition would delete the coverage that precondition
 * guards: `BUDGET_PROJECTION_GRAPH_UNAVAILABLE` had 265 hits when the flip ran, and a refusal
 * with no reachable world is a guard that is green forever and killable by deleting the check.
 * This is that refusal's durable home, and the sibling test reads it back by exact code.
 */
export function seedActivationWorldWithoutGraph(store: SqliteEventStore): void {
  ensureSeededGoal(store);
}

/**
 * DELIBERATE NEGATIVE WORLD — a graph and NO goal, the durable home for
 * `BUDGET_PROJECTION_GOAL_ABSENT`. Distinct from the no-graph world: the two refusals come from
 * different branches of `readBudgetBinding` and one cannot stand in for the other.
 */
export function seedActivationWorldWithoutGoal(store: SqliteEventStore): GraphContent {
  return seedActivationGraph(store);
}
