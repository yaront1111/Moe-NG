/**
 * Inputs only, for the expansion-admission suites (task-c4171c1cfe854cb78dd233794b342025).
 *
 * NOTHING HERE PRODUCES AN AUTHORITY VALUE. The durable world is seeded through production
 * writers (`seedActivationWorld` then `handleExpansionRequest`), and every machine fact the
 * caller's approval evidence has to AGREE with — the derived child keys, the derived quality
 * digest, the reserved budget account — is read back out of a REAL `admitExpansion` run rather
 * than authored. That mirrors the world: a human approves against a preparation the daemon
 * showed them, so their record repeats machine facts they did not invent. A fixture that made
 * those numbers up would let the suites go green against bytes production never emits.
 *
 * THE ONE HONEST EXCEPTION, STATED LOUDLY. `handleExpansionRequest`'s release reader is still
 * `unavailableExpansionReleaseAuthority` in production while
 * task-e62e3828df234c66969a99b8223487f4 is absent, so the hold is seeded through
 * `testOnlyReleaseAuthorityReader` — the same seam and the same disclosure
 * task-738a12a816e8421a96edd84648565a38 shipped. It seeds a WORLD for this slice to read; it is
 * not reachable from this slice's own production path, which never touches release authority.
 *
 * No `expect` and no assertion lives here. A fixture that judged an outcome would be a second
 * authority beside the one under test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { admitExpansion } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { SqliteEventStore as SqliteEventStoreClass } from "@moe/store";

import {
  ACTIVATION_WORLD_NODE_KEY, seedActivationWorld,
} from "../activation/activation-world-fixtures.js";
import { GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readExpansionAdmissionBindings } from "./expansion-admission-bindings.js";
import { decodeExpansionAdmissionPayload } from "./expansion-admission-contracts.js";
import type { ExpansionAdmissionRefusal } from "./expansion-admission-contracts.js";
import {
  EXPANSION_APPROVAL_EVENT_TYPE, decodeExpansionApprovalRecord,
  expansionApprovalAggregatePrefix,
} from "./expansion-admission-records.js";
import { handleExpansionAdmission } from "./expansion-admission-service.js";
import type { ExpansionAdmissionOutcome } from "./expansion-admission-service.js";
import { handleExpansionRequest } from "./expansion-request-service.js";
import type { ExpansionRequestContext } from "./expansion-request-service.js";
import { testOnlyReleaseAuthorityReader } from "./expansion-request-test-fixtures.js";

export const REQUEST_COMMAND_ID = "cmd-expansion-request-1";
export const ADMISSION_COMMAND_ID = "cmd-expansion-admission-1";
export const DECIDED_AT = "2026-08-26T00:00:00.000Z";
export { GOAL_ID, PROJECT_ID, RUN_ID, ACTIVATION_WORLD_NODE_KEY };

export const hex = (character: string): string => character.repeat(64);

type Record_ = Record<string, unknown>;

/** Seeds the goal, the parent run, the ACTIVE graph, and then one ACTIVE expansion hold. */
export function seedExpansionAdmissionWorld(store: SqliteEventStore): void {
  seedActivationWorld(store);
  const outcome = handleExpansionRequest({
    envelope: {
      commandId: REQUEST_COMMAND_ID,
      correlationId: `corr-${REQUEST_COMMAND_ID}`,
      decidedAt: DECIDED_AT,
      payload: {
        goalRef: GOAL_ID,
        parentNodeRef: ACTIVATION_WORLD_NODE_KEY,
        parentRunRef: RUN_ID,
        rationale: "the parent node needs a decomposition",
      },
      principalId: "principal-1",
      projectId: PROJECT_ID,
    },
    releaseAuthority: testOnlyReleaseAuthorityReader() as ExpansionRequestContext["releaseAuthority"],
    store,
  });
  if (!outcome.ok) throw new Error(`fixture hold refused: ${outcome.code}/${outcome.layer}`);
}

/** A receipt every derivation accepts. Each arm perturbs exactly one thing. */
export function receipt(overrides: Record_ = {}): Record_ {
  return {
    proposalId: "prop-1",
    revision: 3,
    goalVersion: 7,
    graphEpoch: 11,
    observedAtSequence: 100,
    horizonSequence: 90,
    parentScope: ["a", "b", "c", "d"],
    childScopes: [
      {
        childKey: "child-1", scope: ["a", "b"], oracleKind: "OBSERVED", completion: "CLOSED",
        inputs: [{ inputKey: "in-1", materialization: "MATERIALIZED", digest: hex("a") }],
      },
      {
        childKey: "child-2", scope: ["c"], oracleKind: "DERIVED", completion: "CLOSED",
        inputs: [{ inputKey: "in-2", materialization: "MATERIALIZED", digest: hex("b") }],
      },
    ],
    sourceDigests: [hex("a"), hex("b")],
    ...overrides,
  };
}

const NODES = ["dev-node-a", "dev-node-b", "dev-node-c"];
const EDGES = [
  { edgeKey: "dev-edge-ab", producerNodeKey: "dev-node-a", consumerNodeKey: "dev-node-b" },
  { edgeKey: "dev-edge-bc", producerNodeKey: "dev-node-b", consumerNodeKey: "dev-node-c" },
];

function contractFor(producerNodeKey: string, consumerNodeKey: string): Record_ {
  return {
    producerNodeKey, consumerNodeKey, edgeKind: "ARTIFACT_CONSUMPTION",
    graphBindingDigest: hex("c"),
    producer: {
      kind: "ARTIFACT_CONSUMPTION", artifactOrInterfaceRef: "artifact:shared", digest: hex("b"),
    },
    consumer: {
      kind: "PRECONDITION", criterionRef: `criterion:${consumerNodeKey}`, contractHash: hex("a"),
    },
    minimumQualifyingMilestone: "RESULT_SEALED",
    satisfactionPredicate: {
      predicateRef: "predicate:sealed", schemaId: "moe.predicate.sealed", schemaVersion: 1,
      parametersDigest: hex("b"),
    },
    stability: "REVOCABLE",
    satisfactionWitnesses: [{
      witnessRef: `witness:${producerNodeKey}`, witnessVersion: 1, witnessDigest: hex("a"),
      sourceOperationClass: "ARTIFACT_SEAL",
    }],
    consumptionHorizon: "RESULT_SEAL",
    necessity: {
      failedConsumerCriterionRef: `criterion:${consumerNodeKey}`, failureKind: "MISSING_ARTIFACT",
      truthClass: "DAEMON_VERIFIED",
    },
    alternativeRuling: { kind: "NOT_APPLICABLE", reason: "no compatible substitute" },
    alternateProducers: [],
    truthClass: "DAEMON_VERIFIED",
    invalidationFacts: [{
      sourceFactRef: `fact:${producerNodeKey}`, sourceFactVersion: 1, sourceFactDigest: hex("a"),
    }],
    recheckPredicateRef: "predicate:sealed",
  };
}

/** The proposed subgraph: a three-node hard chain, its own contracts, its own baseline. */
export function graphInput(): Record_ {
  const snapshot = {
    nodes: NODES.map((nodeKey) => ({ nodeKey, executionBearing: true })),
    edges: EDGES.map((edge) => ({ ...edge, kind: "HARD" })),
    completionNodeKey: "dev-node-c",
  };
  return {
    proposedSnapshot: snapshot,
    sequentialBaselineSnapshot: snapshot,
    contracts: EDGES.map((edge) => ({
      edgeKey: edge.edgeKey, edgeKind: "ARTIFACT_CONSUMPTION",
      contract: contractFor(edge.producerNodeKey, edge.consumerNodeKey),
      necessityWitness: { edgeKey: edge.edgeKey, truthClass: "DAEMON_VERIFIED" },
    })),
  };
}

export function rotation(overrides: Record_ = {}): Record_ {
  return {
    ring: {
      ringId: "ring.main", dimensionId: "dim.alpha",
      resources: [{ resourceId: "res.a", weight: 1 }, { resourceId: "res.b", weight: 1 }],
      entries: [
        { workItemId: "item.a", resourceId: "res.a", deficitCounter: 1 },
        { workItemId: "item.b", resourceId: "res.b", deficitCounter: 1 },
      ],
    },
    workItems: ["item.a", "item.b"].map((workItemId) => ({
      workItemId, dimensionId: "dim.alpha", priority: "P2",
      resourceId: workItemId === "item.a" ? "res.a" : "res.b",
      dispatchability: { state: "DISPATCHABLE", observationRef: `obs.${workItemId}` },
    })),
    capacities: [
      { resourceId: "res.a", capacityUnits: 4, inFlightUnits: 0 },
      { resourceId: "res.b", capacityUnits: 4, inFlightUnits: 0 },
    ],
    forcedHead: null, capRevision: null,
    ...overrides,
  };
}

/** One meter, five purposes: the shape `fundingFactsOf` can describe with one funding fact. */
export const OPEN_METERS = Object.freeze(
  [{ meter: "tokens", available: 1000, reserved: 0, quarantined: 0, committed: 0 }],
);

export function budget(overrides: Record_ = {}): Record_ {
  return {
    view: { accountId: "acct.1", state: "OPEN", version: 4, meters: [...OPEN_METERS] },
    admission: {
      admissionRef: "adm.1", expectedVersion: 4,
      amounts: [
        { purpose: "EXECUTION", meter: "tokens", quantity: 10 },
        { purpose: "VERIFICATION", meter: "tokens", quantity: 5 },
        { purpose: "INDEPENDENT_REVIEW", meter: "tokens", quantity: 5 },
        { purpose: "FINAL_ACCEPTANCE", meter: "tokens", quantity: 5 },
        { purpose: "CONTINGENCY", meter: "tokens", quantity: 5 },
      ],
    },
    gate: { allowance: { decisionRef: "dec.1", outcome: "ALLOW" }, approval: null },
    ...overrides,
  };
}

export function resources(overrides: Record_ = {}): Record_ {
  return {
    requestId: "req.1",
    declaredResources: [
      { resourceId: "res.a", capacityUnits: 1, external: false, fenceable: true },
    ],
    capacitySnapshot: { "res.a": 4 },
    epoch: 1,
    eligibilityEventSequenceRef: "seq.1",
    continuouslyEligibleSinceRef: "since.1",
    callerObservation: "obs.1",
    ...overrides,
  };
}

export function proposal(overrides: Record_ = {}): Record_ {
  return {
    receipt: receipt(),
    lineage: { expansionDepth: 2, nodesAddedInExpansion: 2 },
    graph: graphInput(),
    rotation: rotation(),
    bypassClaim: null,
    budget: budget(),
    resources: resources(),
    ...overrides,
  };
}

export function opportunity(overrides: Record_ = {}): Record_ {
  return {
    observationRef: "obs.item.a", opportunityRef: "opportunity.1",
    winnerWorkItemId: "item.a", ...overrides,
  };
}

/** Tier `R2` is human-only, so this input evaluates to REQUIRE_HUMAN_APPROVAL. */
export function policy(overrides: Record_ = {}): Record_ {
  return {
    action: "graph.expand", actor: "human:reviewer-1", callerRiskHint: null,
    decisionDigest: hex("c"), evaluatedAtEpochMs: 1_700_000_000_000,
    evaluatorVersion: "policy-evaluator-v1",
    facts: [{ factId: "fact-risk", tier: "R2", truthClass: "DAEMON_VERIFIED" }],
    graphNodeRevisionRefs: ["revision-1"], policyRevisionRef: hex("d"),
    requiredFactIds: ["fact-risk"], scope: ["child-1", "child-2"],
    sliceChain: [{
      autoApprovalOptIns: [], sliceRef: "slice-root",
      rules: [{
        effect: "ALLOW", obligations: [], requiredFactIds: ["fact-risk"], ruleId: "rule-1",
      }],
    }],
    waivers: [],
    ...overrides,
  };
}

export interface Predecessor {
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly revisionId: string;
}

/**
 * What the daemon CURRENTLY holds. The proposal receipt has to be observed under exactly this
 * goal version and graph epoch or the scheduler bridge refuses
 * `EXPANSION_BINDING_GOAL_VERSION_MISMATCH` / `_GRAPH_EPOCH_MISMATCH` — a real fence, not a
 * fixture convenience, so these values are READ rather than chosen.
 */
export interface CurrentFacts {
  readonly goalVersion: number;
  readonly predecessor: Predecessor;
}

export const SUCCESSOR_HASH = hex("b");

/** The successor the kernel demands: next epoch, new revision, predecessor named both ways. */
export function supersession(predecessor: Predecessor, overrides: Record_ = {}): Record_ {
  return {
    dispositions: [{
      kind: "ADD", nodeKey: "node-add", predecessorAuthorityHash: null,
      safeCarry: null, successorAuthorityHash: hex("1"),
    }],
    expectedPredecessor: { ...predecessor },
    successor: {
      graphContentHash: SUCCESSOR_HASH,
      graphEpoch: predecessor.graphEpoch + 1,
      predecessorGraphContentHash: predecessor.graphContentHash,
      predecessorRevisionId: predecessor.revisionId,
      revisionId: `${predecessor.revisionId}-successor`,
    },
    supportedCanonicalizerVersions: ["canon-v1"],
    ...overrides,
  };
}

export function criteria(overrides: Record_ = {}): Record_ {
  return {
    approvalRef: "approval-1", budgetRef: hex("4"), criteriaRef: hex("5"),
    dependencyChanges: { additions: ["dependency-a"], challenges: [], removals: [] },
    riskTier: "R2",
    ...overrides,
  };
}

export function decideCommand(overrides: Record_ = {}): Record_ {
  return {
    decision: "APPROVE", decisionReason: "approved after review",
    kind: "approval.decide", stepUpAuthRef: "step-up-1",
    ...overrides,
  };
}

/** The machine facts a human approval must repeat, read back from a REAL admission run. */
export interface AdmittedEcho {
  readonly childKeys: readonly string[];
  readonly qualityDigest: string;
}

export function admittedEcho(proposalValue: unknown): AdmittedEcho {
  const result = admitExpansion(proposalValue);
  if (!result.ok) {
    throw new Error(`fixture proposal refused: ${result.issues.map((one) => one.code).join(",")}`);
  }
  const bound = result.preparation.bound;
  return { childKeys: [...bound.childKeys], qualityDigest: bound.qualityDigest };
}

export function approvalRecord(
  echo: AdmittedEcho, criteriaValue: Record_, revisionHash: string, overrides: Record_ = {},
): Record_ {
  return {
    actor: "human:reviewer-1", actorKind: "HUMAN", applicablePolicyRef: hex("d"),
    approvalRef: criteriaValue["approvalRef"], approvedNodeScope: [...echo.childKeys],
    budgetRef: criteriaValue["budgetRef"], criteriaRef: criteriaValue["criteriaRef"],
    decision: null, decisionReason: null,
    dependencyChanges: criteriaValue["dependencyChanges"],
    exactRevisionHash: revisionHash, lifecycle: "PENDING",
    planQualityAssessmentRef: echo.qualityDigest, policyDecisionRef: hex("c"),
    riskTier: criteriaValue["riskTier"], stepUpAuthRef: "step-up-1",
    truthClass: "HUMAN_APPROVED", validity: "CURRENT",
    ...overrides,
  };
}

/** The current facts the daemon holds, read through the production binding reader. */
export function currentFacts(store: SqliteEventStore): CurrentFacts {
  const decoded = decodeExpansionAdmissionPayload(payloadShell());
  if (!decoded.ok) throw new Error("fixture payload shell is malformed");
  const bindings = readExpansionAdmissionBindings(store, PROJECT_ID, decoded.payload);
  if (!bindings.ok) {
    throw new Error(`fixture bindings refused: ${bindings.code}/${bindings.layer}`);
  }
  const authority = bindings.bindings.authority;
  return {
    goalVersion: authority.goalVersion,
    predecessor: {
      graphContentHash: authority.graphContentHash,
      graphEpoch: authority.graphEpoch,
      revisionId: authority.parentRevisionRef,
    },
  };
}

/** The three subject refs plus placeholder evidence: enough to resolve the bindings, no more. */
function payloadShell(): Record_ {
  return {
    approval: null, approvalCommand: null, criteria: null, goalRef: GOAL_ID,
    opportunity: null, parentNodeRef: ACTIVATION_WORLD_NODE_KEY, parentRunRef: RUN_ID,
    policy: null, proposal: null, supersession: null,
  };
}

/** The complete accepted payload, every echoed fact taken from a real production run. */
/**
 * The nominal facts used when a deliberate perturbation puts the echo or the durable world out
 * of reach — a proposal the scheduler cannot parse has no derived quality digest, and a world
 * with no hold has no current authority. Those arms exist to prove the SERVICE refuses, so the
 * payload carries nominal evidence and the assertion is on the service's answer, never on the
 * fixture's. The ACCEPTED arms never reach these: their echo and their world both resolve.
 */
const NOMINAL_FACTS: CurrentFacts = {
  goalVersion: 1,
  predecessor: {
    graphContentHash: hex("a"), graphEpoch: 0, revisionId: "graph-revision-out-of-reach",
  },
};
const NOMINAL_ECHO: AdmittedEcho = {
  childKeys: ["child-1", "child-2"], qualityDigest: hex("2"),
};

function factsOrNominal(store: SqliteEventStore): CurrentFacts {
  try {
    return currentFacts(store);
  } catch {
    return NOMINAL_FACTS;
  }
}

function echoOrNominal(proposalValue: unknown): AdmittedEcho {
  try {
    return admittedEcho(proposalValue);
  } catch {
    return NOMINAL_ECHO;
  }
}

export function admissionPayload(store: SqliteEventStore, overrides: Record_ = {}): Record_ {
  const current = factsOrNominal(store);
  const proposalValue = (overrides["proposal"] ?? proposal({
    receipt: receipt({
      goalVersion: current.goalVersion, graphEpoch: current.predecessor.graphEpoch,
    }),
  })) as Record_;
  const criteriaValue = (overrides["criteria"] ?? criteria()) as Record_;
  const echo = echoOrNominal(proposalValue);
  return {
    approval: approvalRecord(echo, criteriaValue, SUCCESSOR_HASH),
    approvalCommand: decideCommand(),
    criteria: criteriaValue,
    goalRef: GOAL_ID,
    opportunity: opportunity(),
    parentNodeRef: ACTIVATION_WORLD_NODE_KEY,
    parentRunRef: RUN_ID,
    policy: policy(),
    proposal: proposalValue,
    supersession: supersession(current.predecessor),
    ...overrides,
  };
}

export function admissionEnvelope(payload: unknown, overrides: Record_ = {}): Record_ {
  return {
    commandId: ADMISSION_COMMAND_ID,
    correlationId: `corr-${ADMISSION_COMMAND_ID}`,
    decidedAt: DECIDED_AT,
    payload,
    principalId: "principal-1",
    projectId: PROJECT_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SUITE HARNESS. Shared by every expansion-admission suite so no suite imports another suite —
// importing a `.test.ts` would register its describes twice under the importer.
//
// WINDOWS HANDLE DISCIPLINE: the store is closed in a `finally` INSIDE the temp directory's own
// `finally`. A handle held across `rmSync` throws EPERM and kills the vitest worker with no
// output at all.
//
// `refusalOf` and `acceptedOf` THROW rather than assert. A fixture that judged an outcome would
// be a second authority beside the one under test.
// ---------------------------------------------------------------------------

export function withWorld<T>(
  run: (store: SqliteEventStore) => T,
  seed: (store: SqliteEventStore) => void = seedExpansionAdmissionWorld,
): T {
  const directory = mkdtempSync(join(tmpdir(), "moe-expansion-admission-"));
  try {
    const store = SqliteEventStoreClass.openForProject(
      join(directory, "store.sqlite"), PROJECT_ID,
    );
    try {
      seed(store);
      return run(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function admit(
  store: SqliteEventStore, overrides: Record_ = {}, envelope: Record_ = {},
): ExpansionAdmissionOutcome {
  return handleExpansionAdmission({
    envelope: admissionEnvelope(admissionPayload(store, overrides), envelope),
    store,
  });
}

export function refusalOf(outcome: ExpansionAdmissionOutcome): ExpansionAdmissionRefusal {
  if (outcome.ok) throw new Error("expected a refusal, got an approved expansion binding");
  return outcome;
}

export interface AcceptedIdentities {
  readonly approvalIdentity: string;
  readonly preparationIdentity: string;
  readonly proposalIdentity: string;
  readonly recordAggregateId: string;
}

export function acceptedOf(outcome: ExpansionAdmissionOutcome): AcceptedIdentities {
  if (!outcome.ok) {
    throw new Error(`unexpected refusal: ${outcome.code}/${outcome.layer}`
      + ` upstream=${outcome.upstream?.code ?? "none"}`);
  }
  return outcome;
}

/** Every approval record the store holds, decoded through the production codec. */
export function recordedBindings(store: SqliteEventStore): readonly Record_[] {
  const found: Record_[] = [];
  for (const aggregateId of store.enumerateAggregateIdsByPrefix(
    expansionApprovalAggregatePrefix(PROJECT_ID),
  )) {
    for (const event of store.readEvents(aggregateId)) {
      if (event.eventType !== EXPANSION_APPROVAL_EVENT_TYPE) continue;
      const decoded = decodeExpansionApprovalRecord(event.payload);
      if (decoded === null) throw new Error("a recorded binding did not decode");
      found.push(decoded as unknown as Record_);
    }
  }
  return found;
}
