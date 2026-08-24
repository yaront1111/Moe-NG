/**
 * The durable budget derivation behind `effect.activate`, TWO DOORS, ONE FUNCTION.
 *
 * Ruling `comment-e62d1751` on task-e194c5f6: `runEffectActivateCommand` has two production
 * callers, and they differ only in whether a `nodeKey` argument exists to cross-check.
 *   DOOR 1 — foundation.dispatch (foundation-attempt-service.ts:218) passes the key it
 *            computed and graph-validated at :192, as a DAEMON-INTERNAL argument. Never a
 *            payload key: the payload fence excludes it on purpose, because a caller-supplied
 *            node would be authority by proxy.
 *   DOOR 2 — the registered `effect.activate` command (daemon-command-registry.ts:202) has no
 *            such caller and no upstream node validation at all, so the module self-derives.
 *
 * BOTH doors read the SAME durable authority — `readCurrentActiveGraph` — so the graph is the
 * only authority here and the argument is a cross-check, never an input that decides anything.
 * That is why this is one function with an optional argument rather than two code paths: two
 * paths could drift apart under later edits and each door's tests would still pass.
 *
 * EVERY FIXTURE FACT COMES FROM A PRODUCTION WRITER. The project and goal are driven through
 * `runBootstrapCommand`; the revision through `reduceGraphRevision`; the body through
 * `putGraphBody`; the node authority through `createNodeDefinition` + `deriveNodeAuthoritySet`,
 * which RE-DERIVES what it is handed, so a hand-built authority section cannot pass. A
 * hand-written event would let this suite go green against bytes production never emits.
 *
 * WINDOWS HANDLE DISCIPLINE: the store handle closes in a `finally` INSIDE the temp
 * directory's own `finally`. A handle held across `rmSync` throws EPERM and kills the vitest
 * worker with no output at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

import { GOAL_ID, PROJECT_ID, driveThrough } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import { authorizeBudgetRoot } from "../budget/budget-ledger.js";
import { reserveBudgetForAdmission } from "../budget/budget-ledger-holds.js";
import {
  graphRevisionAggregateId, readCurrentActiveGraph,
} from "../planning/active-graph-projection.js";
import { putGraphBody } from "../planning/graph-body-record.js";

import { ACTIVATION_INGRESS_LAYER } from "./activation-ingress-contracts.js";
import { deriveActivationBudget } from "./activation-budget-derivation.js";

const ENCODER = new TextEncoder();
const hex = (digit: string): string => digit.repeat(64);
const seededHash = (seed: string): string => seed.repeat(64).slice(0, 64);

const PLAN_HASH = seededHash("11");
const REVISION_ID = "graph-revision-1";
const SOLO_NODE = "dev-solo";

/** One execution-bearing node, zero edges — the shape door 2 must resolve unaided. */
const soloSnapshot = (): GraphSnapshot => ({
  completionNodeKey: SOLO_NODE,
  edges: [],
  nodes: [{ executionBearing: true, nodeKey: SOLO_NODE }] as readonly GraphNode[],
});

/**
 * TWO bearing nodes — the ambiguity both doors must refuse, unconditionally.
 *
 * The edge MUST be HARD. `validate-graph-structure.ts:232` says it verbatim: every
 * execution-bearing node must be the completion node or a transitive HARD predecessor of it,
 * and "advisory edges cannot satisfy closure". So a second bearing node cannot exist in a valid
 * graph without a HARD edge carrying it, which is why this fixture owes a full
 * `DependencyContract` on `dev-c` and the solo fixture does not.
 */
const pairSnapshot = (): GraphSnapshot => ({
  completionNodeKey: "dev-c",
  edges: [
    { consumerNodeKey: "dev-c", edgeKey: "dev-e1", kind: "HARD", producerNodeKey: "dev-a" },
  ],
  nodes: [
    { executionBearing: true, nodeKey: "dev-a" },
    { executionBearing: true, nodeKey: "dev-c" },
  ] as readonly GraphNode[],
});

/** No bearing node at all — the absent case, distinct from the ambiguous one. */
const barrenSnapshot = (): GraphSnapshot => ({
  completionNodeKey: "dev-idle",
  edges: [],
  nodes: [{ executionBearing: false, nodeKey: "dev-idle" }] as readonly GraphNode[],
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
    graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a",
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
  parameterSchema: { digest: hex("b"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-a",
  proofRationale: "An artifact seal cannot become unsealed.",
  schemaId: "schema-a",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
};

/** ONE contract per HARD edge ENTERING a node. `graphBindingDigest` is PRODUCTION's
 *  `snapshotIdentityHash` over the ACCEPTED graph, never a literal: a digest that did not come
 *  from this structure refuses NODE_AUTHORITY_RECURSION_BINDING_MISMATCH at derive time. */
const hardEdgeRequirement = (edge: GraphEdge, binding: string): Record<string, unknown> => ({
  edgeKey: edge.edgeKey,
  requirement: {
    contract: {
      alternateProducers: [] as string[],
      alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
      consumer: { contractHash: hex("c"), criterionRef: "criterion-a", kind: "PRECONDITION" },
      consumerNodeKey: edge.consumerNodeKey,
      consumptionHorizon: "RESULT_SEAL",
      edgeKind: "ARTIFACT_CONSUMPTION",
      graphBindingDigest: binding,
      invalidationFacts: [
        { sourceFactDigest: hex("e"), sourceFactRef: "fact-a", sourceFactVersion: 1 },
      ],
      minimumQualifyingMilestone: "RESULT_SEALED",
      necessity: {
        failedConsumerCriterionRef: "criterion-a", failureKind: "MISSING_ARTIFACT",
        truthClass: "OBSERVED",
      },
      producer: {
        artifactOrInterfaceRef: "artifact-a", digest: hex("f"), kind: "ARTIFACT_CONSUMPTION",
      },
      producerNodeKey: edge.producerNodeKey,
      recheckPredicateRef: "predicate-a",
      satisfactionPredicate: {
        parametersDigest: hex("1"), predicateRef: "predicate-a",
        schemaId: "schema-a", schemaVersion: 1,
      },
      satisfactionWitnesses: [{
        sourceOperationClass: "ARTIFACT_SEAL", witnessDigest: hex("2"),
        witnessRef: "witness-a", witnessVersion: 1,
      }],
      stability: "MONOTONIC",
      truthClass: "OBSERVED",
    },
    edgeKind: "ARTIFACT_CONSUMPTION",
  },
});

/**
 * Admitted by PRODUCTION or not built at all: a body the codec refuses could never reach the
 * encode this fixture exists to feed. The solo graph is edge-free, so it owes no contract and
 * no proof; the pair graph's completion node owes one contract for its HARD in-edge.
 */
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
function driveRevision(graphContentHash: string): {
  events: GraphRevisionEvent[]; state: GraphRevisionState;
} {
  const binding = bindingOf(graphContentHash);
  const steps: readonly ((c: GraphRevisionState | undefined) => GraphRevisionCommand)[] = [
    () => ({
      commandId: `cmd-create-${REVISION_ID}`, expectedVersion: 0, goalRef: GOAL_ID,
      graphContentHash, kind: "graph_revision.create", planHash: PLAN_HASH,
      revisionId: REVISION_ID,
    }) as GraphRevisionCommand,
    (current) => ({
      commandId: "cmd-submit", expectedVersion: current === undefined ? 0 : current.version,
      kind: "graph_revision.submit",
      witness: { submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED" },
    }) as GraphRevisionCommand,
    (current) => ({
      activation: {
        ...binding, activationRef: "activation-1", graphEpoch: 1, truthClass: "HUMAN_APPROVED",
      },
      approval: { ...binding, approvalRef: "approval-1", truthClass: "HUMAN_APPROVED" },
      commandId: "cmd-approve", expectedVersion: current === undefined ? 0 : current.version,
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
  if (current === undefined) throw new Error("path produced no state");
  return { events, state: current };
}

function commitRevision(store: SqliteEventStore, events: readonly GraphRevisionEvent[]): void {
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, REVISION_ID);
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(`seed-${REVISION_ID}`),
    commandId: `seed-${REVISION_ID}`,
    committedAt: "2026-08-19T00:00:00.000Z",
    events: events.map((event, index) => ({
      eventId: `seed-${REVISION_ID}-${index}`,
      eventType: event.kind,
      payload: ENCODER.encode(JSON.stringify(event)),
    })),
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

/**
 * An ACTIVE project, a durable `GoalCreated` with its account ref, one ACTIVE revision, and an
 * authorized budget root.
 *
 * The root is authorized on `runner.authorized_ms` DELIBERATELY: that is the meter the node
 * definition's `admissionAmounts` are denominated in (`NODE_ADMISSION_METERS` is closed at the
 * authority boundary, while the ledger's meter is a bounded string). A root funded on some
 * other meter would leave the derivation with no durable coverage for the meter it must
 * actually reserve — which is a refusal, not an accepted control, and is exercised separately.
 */
function seedWorld(store: SqliteEventStore, snapshot: GraphSnapshot): GraphContent {
  driveThrough(store, "plan.propose");
  const content = encodedContent(snapshot);
  const driven = driveRevision(content.graphContentHash);
  commitRevision(store, driven.events);
  putGraphBody(store, PROJECT_ID, content);
  const authorized = authorizeBudgetRoot(store, {
    amounts: [{ meter: "runner.authorized_ms", amount: 1_000_000 }],
    context: {
      commandId: "cmd-authorize", correlationId: "corr-actbudget",
      decidedAt: "2026-08-19T00:00:00.000Z", principalId: "principal-1",
    },
    goalRef: GOAL_ID,
    projectId: PROJECT_ID,
  });
  if (!authorized.ok) throw new Error(`budget root fixture refused: ${authorized.code}`);
  return content;
}

function withStore<T>(name: string, run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-actbudget-${name}-`));
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

const derive = (store: SqliteEventStore, nodeKey?: string) =>
  deriveActivationBudget(
    nodeKey === undefined
      ? { goalRef: GOAL_ID, projectId: PROJECT_ID, store }
      : { goalRef: GOAL_ID, nodeKey, projectId: PROJECT_ID, store },
  );

/** The PRODUCTION shape: neither door names a goal, so the graph is what resolves one. */
const deriveUnnamed = (store: SqliteEventStore, nodeKey?: string) =>
  deriveActivationBudget(
    nodeKey === undefined
      ? { projectId: PROJECT_ID, store }
      : { nodeKey, projectId: PROJECT_ID, store },
  );

/** Reason code AND refusing layer, never merely "it failed" (global rail 1). */
const refusalOf = (result: { ok: boolean }): readonly [string, string] => {
  const refused = result as { code?: string; layer?: string };
  return [refused.code ?? "UNEXPECTEDLY_ADMITTED", refused.layer ?? "NO_LAYER"];
};

describe("activation budget derivation — door 2 (registry): self-derives from durable graph", () => {
  it("resolves the single execution-bearing node with no caller argument", () => {
    withStore("d2-accept", (store) => {
      const content = seedWorld(store, soloSnapshot());
      const derived = derive(store);
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      expect(derived.value.nodeKey).toBe(SOLO_NODE);
      // Anti-tautology: the amounts operand is the PRODUCER'S own definition, read back out
      // of the durable content — never a literal this suite wrote.
      const [definition] = content.content.nodeAuthority.definitions;
      expect(definition).toBeDefined();
      expect(derived.value.amounts).toStrictEqual(definition?.admissionAmounts);
      expect(derived.value.policySliceHash).toBe(definition?.policySliceHash);
      expect(derived.value.amounts.length).toBeGreaterThan(0);
    });
  });

  it("derives the account from the goal's own GoalCreated, not from any caller", () => {
    withStore("d2-account", (store) => {
      seedWorld(store, soloSnapshot());
      const derived = derive(store);
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      expect(derived.value.accountId.length).toBeGreaterThan(0);
      expect(derived.value.graphRevisionRef).toBe(REVISION_ID);
    });
  });

  it("refuses an AMBIGUOUS graph with its own code and layer — unconditional", () => {
    withStore("d2-ambiguous", (store) => {
      seedWorld(store, pairSnapshot());
      expect(refusalOf(derive(store)))
        .toStrictEqual(["ACTIVATION_BUDGET_NODE_AMBIGUOUS", ACTIVATION_INGRESS_LAYER]);
    });
  });

  it("refuses a graph with NO execution-bearing node, distinctly from ambiguous", () => {
    withStore("d2-barren", (store) => {
      seedWorld(store, barrenSnapshot());
      expect(refusalOf(derive(store)))
        .toStrictEqual(["ACTIVATION_BUDGET_NODE_ABSENT", ACTIVATION_INGRESS_LAYER]);
    });
  });
});

describe("activation budget derivation — door 1 (dispatch): argument is a CROSS-CHECK", () => {
  it("accepts the internal argument when it equals the durably-derived node", () => {
    withStore("d1-accept", (store) => {
      seedWorld(store, soloSnapshot());
      const derived = derive(store, SOLO_NODE);
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      expect(derived.value.nodeKey).toBe(SOLO_NODE);
    });
  });

  it("produces the IDENTICAL derivation on both doors — one authority, not two paths", () => {
    withStore("d1-parity", (store) => {
      seedWorld(store, soloSnapshot());
      const withArgument = derive(store, SOLO_NODE);
      const withoutArgument = derive(store);
      expect(withArgument.ok && withoutArgument.ok).toBe(true);
      if (!withArgument.ok || !withoutArgument.ok) return;
      expect(withArgument.value).toStrictEqual(withoutArgument.value);
    });
  });

  it("refuses an argument the durable graph does not name — the graph is the authority", () => {
    withStore("d1-mismatch", (store) => {
      seedWorld(store, soloSnapshot());
      expect(refusalOf(derive(store, "dev-imposter")))
        .toStrictEqual(["ACTIVATION_BUDGET_NODE_MISMATCH", ACTIVATION_INGRESS_LAYER]);
    });
  });

  it("refuses AMBIGUITY even when the argument names a real bearing node", () => {
    // The unconditional dispatch-form rule, NOT core's EXPANSION-exempt form
    // (planning-run-submission.ts:158 exempts EXPANSION; foundation-attempt-contracts.ts:161
    // does not, and this route follows the door it is reached through).
    withStore("d1-ambiguous", (store) => {
      seedWorld(store, pairSnapshot());
      expect(refusalOf(derive(store, "dev-a")))
        .toStrictEqual(["ACTIVATION_BUDGET_NODE_AMBIGUOUS", ACTIVATION_INGRESS_LAYER]);
    });
  });
});

describe("activation budget derivation — upstream refusals travel unrestamped", () => {
  it("forwards the binding refusal when the goal was never created", () => {
    withStore("up-nogoal", (store) => {
      const [code, layer] = refusalOf(derive(store));
      expect(code).not.toBe("UNEXPECTEDLY_ADMITTED");
      // The goal fact is absent, so the BINDING layer answers — not this module's own code.
      expect(code).toBe("BUDGET_PROJECTION_GOAL_ABSENT");
      expect(layer).not.toBe(ACTIVATION_INGRESS_LAYER);
    });
  });

  it("refuses when the project has no ACTIVE graph rather than defaulting", () => {
    withStore("up-nograph", (store) => {
      driveThrough(store, "plan.propose");
      // EXACT code AND layer: the durable READER is what answered, not this module, and a
      // world with a goal but no graph may never be reported as a world with no goal.
      expect(refusalOf(derive(store)))
        .toStrictEqual(["BUDGET_PROJECTION_GRAPH_UNAVAILABLE", "BUDGET_CURRENT_PROJECTION"]);
    });
  });

  it("answers GRAPH_UNAVAILABLE — never GOAL_ABSENT — when no goal was named", () => {
    // The PRODUCTION shape. Neither door names a goal, so the graph is the only thing that
    // could name one; reporting its absence as a missing GOAL would send an operator to fix
    // the wrong record, and it is the arm a `goalRef ?? ""` fallback silently gets wrong.
    withStore("up-nograph-unnamed", (store) => {
      driveThrough(store, "plan.propose");
      expect(refusalOf(deriveUnnamed(store)))
        .toStrictEqual(["BUDGET_PROJECTION_GRAPH_UNAVAILABLE", "BUDGET_CURRENT_PROJECTION"]);
    });
  });
});

describe("activation budget derivation — the goal is a durable fact, not an input", () => {
  it("self-derives the goal from the ACTIVE graph's own provenance", () => {
    withStore("goal-self", (store) => {
      seedWorld(store, soloSnapshot());
      const derived = deriveUnnamed(store);
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      // Anti-tautology: the expected operand is the GRAPH's provenance read back through the
      // production projection, never a constant this suite chose.
      const graph = readCurrentActiveGraph(store, PROJECT_ID);
      expect(graph.ok).toBe(true);
      if (!graph.ok) return;
      expect(derived.value.goalRef).toBe(graph.provenance.goalRef);
    });
  });

  it("derives the SAME authority named or unnamed — naming a goal grants nothing", () => {
    withStore("goal-same", (store) => {
      seedWorld(store, soloSnapshot());
      const named = derive(store);
      const unnamed = deriveUnnamed(store);
      expect(named.ok && unnamed.ok).toBe(true);
      if (!named.ok || !unnamed.ok) return;
      expect(unnamed.value).toStrictEqual(named.value);
    });
  });

  it("refuses a goal the ACTIVE graph does not own, with the binding's own code", () => {
    withStore("goal-foreign", (store) => {
      seedWorld(store, soloSnapshot());
      const foreign = deriveActivationBudget(
        { goalRef: "goal-not-this-one", projectId: PROJECT_ID, store },
      );
      // GOAL_ABSENT, not SCOPE_FOREIGN: `readBudgetBinding` looks for the GoalCreated fact
      // first and this ref has none. The point of the assertion is the exact upstream pair.
      expect(refusalOf(foreign))
        .toStrictEqual(["BUDGET_PROJECTION_GOAL_ABSENT", "BUDGET_CURRENT_PROJECTION"]);
    });
  });
});

describe("activation budget derivation — funding, not measurement, gates admission", () => {
  it("refuses a meter the durable projection carries no position for", () => {
    // The fail-closed half. The root is funded on a meter the node does not spend, so every
    // amount names a meter with NO durable position — which may never be synthesised as zero.
    withStore("meter-unfunded", (store) => {
      driveThrough(store, "plan.propose");
      const content = encodedContent(soloSnapshot());
      commitRevision(store, driveRevision(content.graphContentHash).events);
      putGraphBody(store, PROJECT_ID, content);
      const authorized = authorizeBudgetRoot(store, {
        amounts: [{ meter: "provider.input_tokens", amount: 1_000_000 }],
        context: {
          commandId: "cmd-authorize", correlationId: "corr-actbudget",
          decidedAt: "2026-08-19T00:00:00.000Z", principalId: "principal-1",
        },
        goalRef: GOAL_ID,
        projectId: PROJECT_ID,
      });
      expect(authorized.ok).toBe(true);
      expect(refusalOf(deriveUnnamed(store)))
        .toStrictEqual(["ACTIVATION_BUDGET_METER_UNFUNDED", ACTIVATION_INGRESS_LAYER]);
    });
  });

  it("still derives once a hold is already open on the meter — holds do not serialize", () => {
    // THE ANTI-BLOCKING PROPERTY, and the reason `coverageOf`'s verdict is not the gate here:
    // it reports UNKNOWN from the moment `openHoldCount > 0`, so gating on it would admit
    // exactly ONE attempt per meter per project and refuse every concurrent one.
    withStore("hold-open", (store) => {
      seedWorld(store, soloSnapshot());
      const first = deriveUnnamed(store);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const held = reserveBudgetForAdmission(store, {
        accountId: first.value.accountId,
        admissionRef: "activation:cmd-first",
        amounts: [...first.value.amounts],
        context: {
          commandId: "cmd-first", correlationId: "corr-actbudget",
          decidedAt: "2026-08-19T00:00:01.000Z", principalId: "principal-1",
        },
        gate: { allowance: { decisionRef: "decision-1", outcome: "ALLOW" }, approval: null },
        goalRef: first.value.goalRef,
        projectId: PROJECT_ID,
      });
      expect(held.ok).toBe(true);
      // The hold is real: the production projection now reports the meter as UNKNOWN.
      const after = readCurrentBudgetLedger(store, PROJECT_ID, first.value.goalRef);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.meters.map((entry) => entry.coverage)).toContain("UNKNOWN");
      // And the derivation still admits, with the fence advanced to the NEW head.
      const second = deriveUnnamed(store);
      expect(refusalOf(second)[0]).toBe("UNEXPECTEDLY_ADMITTED");
      if (!second.ok) return;
      expect(second.value.expectedVersion).toBe(after.headVersion);
      expect(second.value.expectedVersion).toBeGreaterThan(first.value.expectedVersion);
    });
  });
});

describe("activation budget derivation — the caller's numbers are never authority", () => {
  it("takes no caller budget input at all: its whole input is identity", () => {
    // Task rail 1 in shape rather than in prose. A caller supplies a project, a goal, an
    // attempt and (door 1 only) a node to be checked — never a view, a balance, a coverage
    // claim or a reservation. A key the signature cannot carry is a key no call site forwards.
    withStore("rail-shape", (store) => {
      seedWorld(store, soloSnapshot());
      const derived = derive(store, SOLO_NODE);
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      const keys = Object.keys(derived.value).sort();
      expect(keys).not.toContain("budgetView");
      expect(keys).not.toContain("coverage");
    });
  });

  it("never consults a provider launch limit (task rail 2)", () => {
    withStore("rail-launch", (store) => {
      seedWorld(store, soloSnapshot());
      const derived = derive(store, SOLO_NODE);
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      const serialized = JSON.stringify(derived.value);
      for (const limit of ["stdout", "stderr", "tail", "timeout"]) {
        expect(serialized).not.toContain(limit);
      }
    });
  });
});
