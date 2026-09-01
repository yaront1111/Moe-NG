/**
 * Package-ROOT reachability contract for the claim-composition surface.
 *
 * Every specifier here is the bare package root `@moe/scheduler`: the package
 * `exports` map is exclusive, so a deep subpath would not resolve for a real
 * consumer and testing one would prove nothing. The expected namespace below is
 * hand-transcribed, never derived from the namespace under test, so a removed
 * export AND an unreviewed addition both go red.
 */
import { expect, it } from "vitest";

import {
  createAcceptanceContract, createAcceptanceCriterionContent, createPlanExecutionContent,
  createPlanRevision,
  reduceExpansionPlanningHold, validExpansionHoldBinding,
} from "@moe/core";
/**
 * Reached through the BARE root, not relatively: task-210efa47 published them, so
 * the fixture that builds a v3 `GraphRevisionContent` now travels the same path a
 * real consumer does. A relative import here would have proven nothing about the
 * package root, which is the subject of every assertion below.
 */
import {
  createNodeDefinition, deriveNodeAuthoritySet, snapshotIdentityHash,
} from "@moe/scheduler";
import type { ExpansionPlanningHoldState, PlanningExpansionHoldBinding } from "@moe/core";

import * as scheduler from "@moe/scheduler";
import type {
  AuthorityErrorCode, AuthorityIssue, AuthorityOutcome, AuthorityProof, AuthorityRejection,
  ClockObservation, Fenced, LeaseKind, LeaseRecord, LeaseState, RejectionSecurityRecord,
} from "@moe/scheduler";
import type {
  AcquisitionFailure, AcquisitionSet, AcquisitionState, DeclaredResource,
  ProviderSlotActivateCommand, ProviderSlotReleaseCommand, ProviderSlotReservation,
  ReserveAllRequest, ReserveAllResult,
  ResourceRow, ResourceWaitRequest, SlotState,
} from "@moe/scheduler";
import type {
  AdmissionAmount, AdmissionGate, AdmissionHumanApproval, AdmissionPolicyAllowance,
  AdmissionPurpose, AdmissionRequest, BudgetAvailableView, BudgetReservationIssue,
  BudgetReservationIssueCode, BudgetReservationResult, ReservationActivateCommand,
  ReservationCancelCommand, ReservationLine, ReservationRecord, ReservationState,
} from "@moe/scheduler";
import type {
  BudgetAccountRecord, BudgetAccountState, BudgetMeterBuckets, BudgetPolicyOutcome,
  BudgetReservePurpose,
} from "@moe/scheduler";
import type {
  BudgetAccountIssue, BudgetAccountIssueCode, BudgetAuthorization, BudgetCloseCommand,
  BudgetLedgerEntry, BudgetLedgerEntryKind, BudgetLedgerResult, BudgetLedgerState,
  BudgetMeterAmount, BudgetMovementCommand,
} from "@moe/scheduler";
import type {
  BudgetOverrun, BudgetSettlementIssue, BudgetSettlementIssueCode, BudgetSettlementResult,
  CloseCommand, ConservativeCommand, LineDisposition, ReconcileEvidence, SettleCommand,
  SettleEvidence, SettlementCommand, SettlementLine, SettlementRecord, SettlementState,
} from "@moe/scheduler";
import type {
  BudgetIssueCode, BudgetMeasurementCoverage, BudgetMeasurementSource, LayeredIssue,
  MeasurementIssueCode, MeasurementIssueLayer, MeasurementResult, NormalizedMeasurement,
  ObservedIntervalRefs, PricebookBinding, UsageMeasurementRecord,
} from "@moe/scheduler";
import type {
  FairnessBypassClaim, FairnessCapMigration, FairnessCapRevision, FairnessContractIssue,
  FairnessContractIssueCode, FairnessContractLayer, FairnessContractRefusal,
  FairnessContractResult, FairnessDispatchabilityFact, FairnessDispatchabilityState,
  FairnessOpportunityAttestation, FairnessPriorityClass, FairnessProvenBypasses, FairnessRing,
  FairnessRingQueueEntry, FairnessRingResource, FairnessWorkItem,
} from "@moe/scheduler";
import type {
  FairnessAgedStanding, FairnessResourceCapacity, FairnessRotationDisposition,
  FairnessRotationInputs, FairnessRotationOutcome, FairnessRotationSelection,
} from "@moe/scheduler";
import type {
  SupersessionBoundDispositionField, SupersessionBudgetFacts, SupersessionCarryRefusal,
  SupersessionDispositionFamily, SupersessionDispositionLayer, SupersessionDispositionResult,
  SupersessionDispositionSet, SupersessionFamilyDisposition,
  SupersessionNodeFacts, SupersessionRefusalCode, SupersessionResourceFacts,
} from "@moe/scheduler";
import type {
  DerivedExpansionEvidence, ExpansionAdmissionIssue, ExpansionAdmissionIssueCode,
  ExpansionAdmissionOrigin, ExpansionAdmissionRefusal, ExpansionAdmissionRequest,
  ExpansionAdmissionResult, ExpansionAdmissionUnwind, ExpansionBoundFacts, ExpansionBudgetFacts,
  ExpansionCapacityFact, ExpansionChildFacts, ExpansionEvidenceIssue, ExpansionEvidenceIssueCode,
  ExpansionEvidenceLayer, ExpansionEvidenceRefusal, ExpansionEvidenceResult, ExpansionFairnessFacts,
  ExpansionInputFact, ExpansionLineageFacts, ExpansionPreparation, ExpansionResourceFacts,
  ExpansionRestoredMeter,
} from "@moe/scheduler";
import type {
  DrainDisposition, ReleaseHandoff, ReleaseRequest, ReleaseResult,
} from "@moe/scheduler";
import type {
  ExpansionAdmissionBinding, ExpansionBindingIssue, ExpansionBindingIssueCode,
  ExpansionBindingLayer, ExpansionBindingOrigin, ExpansionBindingRefusal,
  ExpansionBindingRequest, ExpansionBindingResult, ExpansionCurrentAuthority,
  ExpansionCurrentHoldRequest, ExpansionCurrentHoldResult,
} from "@moe/scheduler";
/**
 * The 24 node-authority types the root publishes. They are invisible to
 * EXPECTED_EXPORTS -- a type publishes no runtime key -- so the only way to prove
 * the root exports them is to make production values flow through them, which the
 * annotations further down do. Imported from the BARE specifier on purpose: a
 * relative import here would prove nothing about the package root.
 */
import type {
  NodeAdmissionAmount, NodeAdmissionGatePolicy, NodeAdmissionMeter, NodeAuthorityBody,
  NodeAuthorityBytesResult, NodeAuthorityDraft, NodeAuthorityDraftResult,
  NodeAuthorityEdgeInput, NodeAuthorityEntry, NodeAuthorityIssue, NodeAuthorityIssueCode,
  NodeAuthorityLayer,
  NodeAuthorityRecursionCode, NodeAuthorityRecursionIssue, NodeAuthorityRecursionLayer,
  NodeAuthorityRecursionResult, NodeAuthorityRefusal, NodeAuthorityResult, NodeAuthoritySection,
  NodeCriterionBinding, NodeDefinition, NodeDefinitionKey, NodeDependencyEntry, NodeJoinRole,
} from "@moe/scheduler";
import type {
  NodePropertyFactIdsAccepted, NodePropertyFactIdsResult, NodePropertyFactKind,
} from "@moe/scheduler";
import type {
  NodePlanningSourceBytesResult, NodePlanningSourceContent, NodePlanningSourceDependency,
  NodePlanningSourceIssue, NodePlanningSourceIssueCode, NodePlanningSourceLayer,
  NodePlanningSourceResult,
} from "@moe/scheduler";

type ExportKind = "array" | "function" | "number" | "record" | "string";
/**
 * Hand-transcribed: 17 pre-existing graph values + 20 approved claim-composition
 * values + 11 fairness contract values + 6 supersession disposition values +
 * 12 fairness rotation and aging values + 7 expansion admission values + the three
 * admission-to-preparation binding values (bindExpansionAdmission, its sole hold
 * producer bindCurrentExpansionHold, and validateOpportunityAttestation) + the 7
 * usage-measurement values (the
 * normalizeUsageMeasurement authority plus the six closed vocabularies a provider
 * telemetry composer needs so it never has to copy the source/coverage matrix) + the
 * 6 graph content identity values (the encode/decode codec boundary, its schema
 * version, byte ceiling, and the two closed refusal vocabularies a durable graph
 * revision needs to tell a framing refusal from an identity refusal) + the design-765
 * release authority `releaseWork`, the sole composer of a lease's RELEASED/DRAINING/NO_OP
 * transition. Its four types travel with it but are invisible here — a type publishes no
 * runtime key — so they are proven by annotation in the release block further down. Plus
 * the 16 conserved-budget ledger values: the 8 account-ledger transition/vocabulary values
 * and the 8 settlement/reconciliation ones, so a durable budget consumer never has to copy
 * the subtree aggregation, the settlement identity, or the version ceiling. Their 25 types
 * are likewise invisible here and are proven by annotation in the two transition blocks.
 */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["ABSOLUTE_MAX_GRAPH_HARD_EDGES", "number"], ["ABSOLUTE_MAX_GRAPH_NODES", "number"],
  ["ABSOLUTE_MAX_GRAPH_TOTAL_EDGES", "number"], ["ADMISSION_PURPOSES", "array"],
  ["ADMISSION_PURPOSE_RESERVE_CONTRACT", "record"], ["BUDGET_ACCOUNT_ISSUE_CODES", "array"],
  ["BUDGET_ISSUE_CODES", "array"],
  ["BUDGET_MEASUREMENT_COVERAGES", "array"], ["BUDGET_MEASUREMENT_SOURCES", "array"],
  ["BUDGET_RESERVATION_ISSUE_CODES", "array"], ["BUDGET_SETTLEMENT_ISSUE_CODES", "array"],
  ["DEFAULT_GRAPH_POLICY", "record"], ["DEFAULT_MAX_HARD_EDGES", "number"],
  ["DEFAULT_MAX_NODES", "number"], ["DEFAULT_MAX_TOTAL_EDGES", "number"],
  ["EXPANSION_ADMISSION_ISSUE_CODES", "array"], ["EXPANSION_ADMISSION_ORIGINS", "array"],
  ["EXPANSION_BINDING_ISSUE_CODES", "array"], ["EXPANSION_BINDING_LAYERS", "array"],
  ["EXPANSION_BINDING_ORIGINS", "array"],
  ["EXPANSION_EVIDENCE_ISSUE_CODES", "array"], ["EXPANSION_EVIDENCE_LAYERS", "array"],
  ["FAIRNESS_BYPASSES_PER_LEVEL", "number"],
  ["FAIRNESS_CONTRACT_ISSUE_CODES", "array"], ["FAIRNESS_CONTRACT_LAYERS", "array"],
  ["FAIRNESS_DIMENSION_CEILING", "number"],
  ["FAIRNESS_DISPATCHABILITY_STATES", "array"],
  ["FAIRNESS_FORCED_BYPASS_BOUND", "number"], ["FAIRNESS_PRIORITY_CLASSES", "array"],
  ["FAIRNESS_PRIORITY_LADDER", "array"], ["FAIRNESS_ROTATION_DISPOSITIONS", "array"],
  ["FAIRNESS_SERVICE_COST", "number"], ["FORBIDDEN_VERDICT_KEYS", "array"],
  ["GRAPH_CONTENT_ISSUE_CODES", "array"], ["GRAPH_CONTENT_LAYERS", "array"],
  ["GRAPH_CONTENT_SCHEMA_VERSION", "number"],
  ["GRAPH_REVISION_CONTENT_KEYS", "array"],
  ["GraphAnalysisError", "function"], ["LINE_DISPOSITIONS", "array"],
  ["MAX_BUDGET_VERSION", "number"], ["MAX_GRAPH_CONTENT_BYTES", "number"],
  ["MAX_GRAPH_KEY_CODE_UNITS", "number"],
  ["MEASUREMENT_ISSUE_CODES", "array"], ["MEASUREMENT_ISSUE_LAYERS", "array"],
  ["MIN_GATED_DESCENDANTS_FOR_REVIEW", "number"],
  ["NODE_ADMISSION_GATE_POLICIES", "array"], ["NODE_ADMISSION_GATE_POLICY_WITNESS", "record"],
  ["NODE_ADMISSION_METERS", "array"], ["NODE_AUTHORITY_CODES", "array"],
  ["NODE_AUTHORITY_DIGEST_DOMAIN", "string"], ["NODE_AUTHORITY_DRAFT_KEYS", "array"],
  ["NODE_AUTHORITY_EXCLUDED_STATE_KEYS", "array"],
  ["NODE_AUTHORITY_FORBIDDEN_IDENTITY_KEYS", "array"], ["NODE_AUTHORITY_LAYERS", "array"],
  ["NODE_AUTHORITY_LIMITS", "record"],
  ["NODE_AUTHORITY_RECURSION_CODES", "array"], ["NODE_AUTHORITY_RECURSION_LAYERS", "array"],
  ["NODE_AUTHORITY_SCHEMA_TAG", "string"],
  ["NODE_AUTHORITY_SCHEMA_VERSION", "number"], ["NODE_DEFINITION_KEYS", "array"],
  ["NODE_JOIN_ROLES", "array"], ["NODE_PLANNING_SOURCE_CODES", "array"],
  ["NODE_PLANNING_SOURCE_DIGEST_DOMAIN", "string"],
  ["NODE_PLANNING_SOURCE_SCHEMA_VERSION", "number"], ["NODE_PROPERTY_FACT_KINDS", "array"],
  ["PROTECTED_ADMISSION_PURPOSES", "array"],
  ["RESERVATION_STATES", "array"], ["SETTLEMENT_STATES", "array"], ["SLOT_STATES", "array"],
  ["SUPERSESSION_BOUND_DISPOSITION_FIELDS", "array"],
  ["SUPERSESSION_DISPOSITION_FAMILIES", "array"],
  ["SUPERSESSION_DISPOSITION_LAYERS", "array"], ["SUPERSESSION_REFUSAL_CODES", "array"],
  ["SUPPORTED_SOURCE_PARSER_VERSIONS", "array"],
  ["activateProviderSlot", "function"],
  ["activateReservation", "function"], ["adapterConfirm", "function"],
  ["adapterFail", "function"], ["admitExpansion", "function"],
  ["admitNodeDefinition", "function"], ["ageWorkItem", "function"],
  ["allocateToChild", "function"], ["analyzeGraphStructure", "function"],
  ["analyzeHardEdgeCounterfactuals", "function"],
  ["bindCurrentExpansionHold", "function"], ["bindExpansionAdmission", "function"],
  ["buildSupersessionDispositions", "function"], ["bypassesToForced", "function"],
  ["cancelReservation", "function"],
  ["carryWaitProjection", "function"], ["closeBudgetAccount", "function"],
  ["closeSettledView", "function"], ["conservativeSettle", "function"],
  ["createNodeDefinition", "function"],
  ["createNodeDefinitionFromPlanningContent", "function"],
  ["createNodePlanningSourceContent", "function"], ["createTraversalCounter", "function"],
  ["decodeGraphContent", "function"], ["decodeNodeDefinitionBytes", "function"],
  ["decodeNodePlanningSourceContentBytes", "function"],
  ["decodeProviderRunRefAttempt", "function"],
  ["deriveExpansionEvidence", "function"], ["deriveNodeAuthoritySet", "function"],
  ["deriveNodePropertyFactIds", "function"],
  ["deriveReservationId", "function"], ["deriveSettlementId", "function"],
  ["deriveSubtreeTotals", "function"], ["encodeGraphContent", "function"],
  ["encodeNodeDefinition", "function"], ["encodeNodePlanningSourceContent", "function"],
  ["encodeProviderRunRef", "function"], ["fenceAuthority", "function"],
  ["grantSuccessorCapacity", "function"],
  ["isFairnessIdentity", "function"], ["normalizeUsageMeasurement", "function"],
  ["openBudgetRoot", "function"],
  ["parseClock", "function"], ["parseLeaseRecord", "function"], ["parseProof", "function"],
  ["partitionFrontier", "function"], ["previewGraphSnapshot", "function"],
  ["reconcileSettlement", "function"], ["releaseProviderSlot", "function"],
  ["releaseWork", "function"], ["replayBudgetLedger", "function"],
  ["reserveAll", "function"], ["reserveForAdmission", "function"],
  ["reserveProviderSlot", "function"], ["resolveGraphPolicy", "function"],
  ["resourceRotationOrder", "function"], ["returnToParent", "function"],
  ["rotateOnce", "function"], ["settleReservation", "function"],
  ["snapshotIdentityHash", "function"],
  ["validateBypassClaim", "function"], ["validateCapRevision", "function"],
  ["validateGraphSnapshot", "function"], ["validateOpportunityAttestation", "function"],
  ["validateResourceCapacity", "function"],
  ["validateRing", "function"],
  ["validateRingResource", "function"], ["validateRotationRequest", "function"],
  ["validateWorkItem", "function"],
  ["validateWorkItemSet", "function"],
];
const surface: Readonly<Record<string, unknown>> = scheduler;

it("generates one expectation per published root export", () => {
  expect(EXPECTED_EXPORTS.length).toBe(144);
});

/**
 * Hand-written, never derived from the namespace under test. Each name is a measurement or budget
 * symbol its own module exports but the root deliberately withholds: the bare validator and the
 * budget-policy projection would let a consumer accept a record normalizeUsageMeasurement refuses,
 * and the account/reserve validators belong to a different seam entirely.
 */
const WITHHELD_BUDGET_NAMES: readonly string[] = [
  "projectBudgetFact", "validateUsageMeasurement", "MEASUREMENT_FACT_TIER",
  "validateBudgetAccount", "validateReserveDeclaration", "MAX_BUDGET_METERS",
];

it("withholds the budget symbols a consumer could use to bypass the measurement authority", () => {
  expect(WITHHELD_BUDGET_NAMES.length).toBe(6);
  const published = new Set(Object.keys(scheduler));
  const leaked = WITHHELD_BUDGET_NAMES.filter((name) => published.has(name));
  expect(leaked).toStrictEqual([]);
});

/**
 * The refusal CONSTRUCTORS the current-hold module exports for `expansion-binding.ts` to reuse.
 * They mint an `ExpansionBindingIssue` from arbitrary strings, so publishing one would let a
 * consumer manufacture a refusal — or, worse, a provenance — the bridge never spoke. This is the
 * negative control for the export block that publishes `bindCurrentExpansionHold` beside them.
 */
const WITHHELD_BINDING_NAMES: readonly string[] = [
  "refusalOf", "localRefusal", "isBindingRefusal",
];

it("withholds the refusal constructors that would let a consumer mint provenance", () => {
  expect(WITHHELD_BINDING_NAMES.length).toBe(3);
  const published = new Set(Object.keys(scheduler));
  expect(WITHHELD_BINDING_NAMES.filter((name) => published.has(name))).toStrictEqual([]);
  // Positive control on the same block: the value that IS published resolves from it.
  expect(published.has("bindCurrentExpansionHold")).toBe(true);
});

/**
 * The wire mechanics behind the codec. `canonicalGraphJson` and
 * `graphContentHash` take an ALREADY-validated graph, so a consumer holding
 * either could mint canonical bytes and a matching digest for a snapshot the
 * kernel never accepted — the exact bypass `encodeGraphContent` exists to make
 * impossible. Negative control for the block that publishes the codec.
 */
const WITHHELD_GRAPH_CONTENT_NAMES: readonly string[] = [
  "canonicalGraphJson", "graphContentHash", "projectGraphSnapshot",
  "readContentBytes", "readContentEnvelope", "sameBytes", "SCHEMA_TAG",
  "DECODE_POLICY",
  // The v3 content mechanics the node-authority publication must NOT drag onto the
  // root with it. Each one takes an already-validated structure and would let a
  // consumer mint canonical bytes, a field read, or a digest that no encode
  // produced -- the same bypass the four names above exist to close.
  "canonicalContentJson", "projectContent", "graphContentDigest", "readContentFields",
];

it("withholds the wire mechanics that would let a consumer mint content identity", () => {
  expect(WITHHELD_GRAPH_CONTENT_NAMES.length).toBe(12);
  const published = new Set(Object.keys(scheduler));
  expect(WITHHELD_GRAPH_CONTENT_NAMES.filter((name) => published.has(name)))
    .toStrictEqual([]);
  // Positive control on the same block: the values that ARE published resolve.
  expect([published.has("encodeGraphContent"), published.has("decodeGraphContent")])
    .toEqual([true, true]);
});

/**
 * The 22 node-authority bindings the six modules export and the root deliberately
 * withholds. Publishing 19 of the 41 leaves exactly these: the preimage and
 * canonical-text mechanics (canonicalText, nodeBodyDigest, canonicalEnvelopeJson)
 * would let a consumer mint a body digest for a definition the codec never
 * admitted; draftNodeAuthority yields an IDENTITY-LESS draft that looks like a
 * definition and is not one; and the compose/field/budget readers are internal
 * halves of admission whose partial verdicts mean nothing outside it.
 *
 * BIDIRECTIONAL BY CONSTRUCTION: 19 published + 22 withheld = the 41 runtime
 * bindings those modules export, so a name added to the public module without
 * review lands in neither list and the set-equality above names it.
 */
const WITHHELD_NODE_AUTHORITY_NAMES: readonly string[] = [
  "draftNodeAuthority", "readDraftFields", "readText", "normalizeScope",
  "forbiddenKeyRefusal", "forbiddenBudgetKeyRefusal", "readNodeAuthorityBudget",
  "ok", "refuse", "passthrough", "compareStrings", "deepFreeze",
  "canonicalText", "nodeBodyDigest", "canonicalEnvelopeJson",
  "pick", "admitPlanning", "applicable", "composeEdges", "requirementsOf",
  "readDerived", "project",
];

it("withholds the node-authority internals that would bypass the admission authority", () => {
  expect(WITHHELD_NODE_AUTHORITY_NAMES.length).toBe(22);
  const published = new Set(Object.keys(scheduler));
  expect(WITHHELD_NODE_AUTHORITY_NAMES.filter((name) => published.has(name)))
    .toStrictEqual([]);
  // Positive controls on the same block: the two values that ARE published resolve,
  // so an empty namespace cannot pass this leak check vacuously.
  expect([published.has("createNodeDefinition"), published.has("deriveNodeAuthoritySet")])
    .toEqual([true, true]);
});

const hex = (digit: string): string => digit.repeat(64);
const CODEC_NODES = ["dev-a", "dev-b"] as const;

/**
 * The v3 node-authority section for the two-node graph below, built by PRODUCTION
 * code end to end — no hand-written body and no hand-written authority hash — so
 * this file exercises the real codec rather than a shape that merely looks like
 * one. `graphBindingDigest` is the graph's own structural identity because the
 * composer requires exactly that; a made-up digest would be refused.
 */
function codecNodeAuthority(snapshot: unknown): NodeAuthoritySection {
  const validated = scheduler.validateGraphSnapshot(snapshot);
  if (!validated.ok) throw new Error("codec fixture graph refused");
  const binding = snapshotIdentityHash(validated.graph);
  const plan = createPlanRevision({
    affectedCriterionIds: ["criterion-a"],
    affectedNodeIds: [...CODEC_NODES],
    approvalState: "APPROVED",
    authorRef: "principal-a",
    graphBinding: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a" },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: "plan-revision-a",
    steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-a" }],
    verificationRecipeRefs: ["recipe-a"],
  });
  const acceptance = createAcceptanceContract({
    applicability: {
      graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a",
      nodeIds: [...CODEC_NODES], nodeKind: "LEAF",
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
  if (!plan.ok || !acceptance.ok) throw new Error("codec fixture plan/acceptance refused");
  const contract = {
    alternateProducers: [] as string[],
    alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
    consumer: { contractHash: hex("c"), criterionRef: "criterion-a", kind: "PRECONDITION" },
    consumerNodeKey: "dev-b",
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
    producerNodeKey: "dev-a",
    recheckPredicateRef: "predicate-a",
    satisfactionPredicate: {
      parametersDigest: hex("1"), predicateRef: "predicate-a", schemaId: "schema-a",
      schemaVersion: 1,
    },
    satisfactionWitnesses: [{
      sourceOperationClass: "ARTIFACT_SEAL", witnessDigest: hex("2"),
      witnessRef: "witness-a", witnessVersion: 1,
    }],
    stability: "MONOTONIC",
    truthClass: "OBSERVED",
  };
  const body = (nodeKey: string, edges: readonly NodeAuthorityEdgeInput[]): NodeDefinition => {
    const built: NodeAuthorityResult = createNodeDefinition({
      acceptanceContract: acceptance.contract,
      draft: {
        admissionAmounts: [...scheduler.ADMISSION_PURPOSES].sort().map((purpose, index) => ({
          meter: "runner.authorized_ms", purpose, quantity: index + 1,
        })),
        admissionGatePolicy: "POLICY_ALLOWANCE",
        capability: "capability-implement",
        completionLinkage: nodeKey === "dev-b" ? "dev-b" : null,
        constraints: ["constraint-a"],
        directHardDependencies: edges,
        joinRole: nodeKey === "dev-b" ? "COMPLETION" : "NONE",
        nodeKey,
        objective: `Land ${nodeKey}.`,
        policySliceHash: hex("3"),
        readScopes: ["services/api/src/0"],
        repositoryBaseTree: hex("4"),
        resources: ["resource-a"],
        verificationRecipeRevisions: ["recipe-a"],
        writeScopes: ["services/api/src/node"],
      },
      planRevision: plan.revision,
      predicateRegistry: [{
        parameterSchema: { digest: hex("b"), kind: "JSON_SCHEMA" },
        predicateRef: "predicate-a",
        proofRationale: "An artifact seal cannot become unsealed.",
        schemaId: "schema-a",
        schemaVersion: 1,
        sourceOperationClass: "ARTIFACT_SEAL",
      }],
    });
    if (!built.ok) {
      throw new Error(built.issues
        .map((issue: NodeAuthorityIssue) => `${issue.code}@${issue.layer}`).join(","));
    }
    const authored: NodeAuthorityBody = built.value;
    return authored.definition;
  };
  const definitions = [
    body("dev-a", []),
    body("dev-b", [{ edgeKey: "dev-e1", requirement: { contract, edgeKind: "ARTIFACT_CONSUMPTION" } }]),
  ];
  const derived: NodeAuthorityRecursionResult = deriveNodeAuthoritySet(snapshot, definitions);
  if (!derived.ok) {
    throw new Error(derived.issues
      .map((issue: NodeAuthorityRecursionIssue) => `${issue.code}@${issue.layer}`).join(","));
  }
  const authorities: readonly NodeAuthorityEntry[] = [...derived.value];
  return { authorities, definitions };
}

/** The two-node hard-edge graph both codec cases below build their authority from. */
const CODEC_SNAPSHOT = {
  nodes: [
    { nodeKey: "dev-b", executionBearing: true },
    { nodeKey: "dev-a", executionBearing: true },
  ],
  edges: [{
    edgeKey: "dev-e1", producerNodeKey: "dev-a",
    consumerNodeKey: "dev-b", kind: "HARD",
  }],
  completionNodeKey: "dev-b",
};

/**
 * The published type surface, closed over PRODUCTION values. `EXPECTED_EXPORTS` is
 * blind to all 24 node-authority types, so without this case the root could publish
 * every runtime name and no type at all and every other assertion in this file would
 * still pass. Each annotation below is a real value the production codec built.
 *
 * The two refusal arms pin the exact code AND the layer that refused (epic rail 6):
 * asserting only "it refused" would survive a second layer answering first.
 */
it("closes the published node-authority type surface over production values", () => {
  const section: NodeAuthoritySection = codecNodeAuthority(CODEC_SNAPSHOT);
  const definition: NodeDefinition = section.definitions[0]!;
  const joinRole: NodeJoinRole = definition.joinRole;
  const gatePolicy: NodeAdmissionGatePolicy = definition.admissionGatePolicy;
  const amount: NodeAdmissionAmount = definition.admissionAmounts[0]!;
  const meter: NodeAdmissionMeter = amount.meter;
  const bindings: readonly NodeCriterionBinding[] = definition.criterionBindings;
  const dependencies: readonly NodeDependencyEntry[] = definition.directHardDependencies;
  const draft: NodeAuthorityDraft = { ...definition, directHardDependencies: [] };
  const drafted: NodeAuthorityDraftResult = { draft, ok: true };
  const keys: readonly NodeDefinitionKey[] = scheduler.NODE_DEFINITION_KEYS;
  const encoded: NodeAuthorityBytesResult = scheduler.encodeNodeDefinition(definition);

  expect(joinRole).toBe("NONE");
  expect(gatePolicy).toBe("POLICY_ALLOWANCE");
  expect(meter).toBe("runner.authorized_ms");
  expect(bindings.map((binding) => binding.criterionId)).toStrictEqual(["criterion-a"]);
  expect(dependencies).toStrictEqual([]);
  expect(drafted.ok).toBe(true);
  expect(keys).toContain("nodeKey");
  expect(encoded.ok).toBe(true);

  const refused: NodeAuthorityResult = scheduler.admitNodeDefinition({});
  if (refused.ok) throw new Error("admitNodeDefinition admitted a non-definition");
  const refusal: NodeAuthorityRefusal = refused;
  const issue: NodeAuthorityIssue = refusal.issues[0]!;
  const code: NodeAuthorityIssueCode = issue.code;
  const layer: NodeAuthorityLayer = issue.layer;
  expect([code, layer])
    .toEqual(["NODE_AUTHORITY_UNSUPPORTED_SCHEMA", "NODE_AUTHORITY_SCHEMA"]);

  const recursed: NodeAuthorityRecursionResult =
    scheduler.deriveNodeAuthoritySet(CODEC_SNAPSHOT, []);
  if (recursed.ok) throw new Error("deriveNodeAuthoritySet derived from no definitions");
  const recursionIssue: NodeAuthorityRecursionIssue = recursed.issues[0]!;
  const recursionCode: NodeAuthorityRecursionCode | string = recursionIssue.code;
  const recursionLayer: NodeAuthorityRecursionLayer = recursionIssue.layer;
  expect([recursionCode, recursionLayer])
    .toEqual(["NODE_AUTHORITY_RECURSION_NODE_MISSING", "NODE_AUTHORITY_RECURSION"]);
});

it("closes the graph-free planning-source type surface over codec results", () => {
  const plan = createPlanExecutionContent({
    affectedCriterionIds: ["criterion-source"], affectedNodeIds: ["node-source"],
    steps: [{ description: "Implement the source node.", kind: "IMPLEMENTATION",
      stepId: "step-source" }], verificationRecipeRefs: ["recipe-source"],
  });
  const criteria = createAcceptanceCriterionContent({ nodeKind: "LEAF", obligations: [{
    criterionId: "criterion-source", evidenceRequirements: [{ evidenceRef: "evidence-source",
      kind: "ARTIFACT", requirementId: "requirement-source" }],
    statement: "The source node is verifiably implemented.",
    verificationRecipeRefs: ["recipe-source"],
  }] });
  if (!plan.ok || !criteria.ok) throw new Error("planning-source fixture refused");
  const created: NodePlanningSourceResult = scheduler.createNodePlanningSourceContent({
    acceptanceCriterionContent: criteria.content,
    directHardDependencies: [], planExecutionContent: plan.content, predicateRegistry: [],
  });
  if (!created.ok) throw new Error("planning-source codec refused its fixture");
  const content: NodePlanningSourceContent = created.content;
  const dependencies: readonly NodePlanningSourceDependency[] = content.directHardDependencies;
  const encoded: NodePlanningSourceBytesResult =
    scheduler.encodeNodePlanningSourceContent(content);
  expect(dependencies).toEqual([]);
  expect(encoded.ok).toBe(true);

  const refused: NodePlanningSourceResult = scheduler.createNodePlanningSourceContent({
    ...content, sourceDigest: "caller-owned",
  });
  if (refused.ok) throw new Error("planning-source codec accepted a caller digest");
  const issue: NodePlanningSourceIssue = refused.issues[0]!;
  const code: NodePlanningSourceIssueCode = issue.code;
  const layer: NodePlanningSourceLayer = issue.layer;
  expect(code).toBe("NODE_PLANNING_SOURCE_MALFORMED");
  expect(layer).toBe("NODE_PLANNING_SOURCE_ADMISSION");
});

/**
 * The sealed-node property vocabulary (task-cb0d65ff). Every id below is derived from a
 * definition the PRODUCTION codec admitted, never from a projection the test built, so the
 * helper cannot report a property admission never accepted.
 *
 * The roster check is BIDIRECTIONAL and both directions are asserted separately. The SERVED
 * set is enumerated from the emitted ids -- the implementation seam -- not from the advertised
 * tuple: iterating the tuple alone would shrink with it, so deleting an advertised kind while
 * production stopped emitting it would stay green in both halves at once.
 *
 * The provenance sweep is the ruling's hard boundary: a planner cannot state a tier, because a
 * node record carrying one is refused by the codec BEFORE any policy code runs. It pins the
 * exact code AND the refusing layer, and the keyless positive control proves the same record
 * is otherwise admissible -- so the arm cannot pass by refusing everything.
 */
const TIER_INJECTION_KEYS: readonly string[] = ["risk", "riskTier", "tier"];

it("derives the closed node-property fact-id vocabulary from an admitted definition", () => {
  const definition: NodeDefinition = codecNodeAuthority(CODEC_SNAPSHOT).definitions[0]!;
  const kinds: readonly NodePropertyFactKind[] = scheduler.NODE_PROPERTY_FACT_KINDS;
  const derived: NodePropertyFactIdsResult = scheduler.deriveNodePropertyFactIds(definition);
  if (!derived.ok) {
    throw new Error(derived.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  const accepted: NodePropertyFactIdsAccepted = derived;

  // Exactly the four sealed families, code-unit sorted, one id per stated value.
  expect(accepted.factIds).toStrictEqual([
    "node.capability:capability-implement",
    "node.read_scope:services/api/src/0",
    "node.resource:resource-a",
    "node.write_scope:services/api/src/node",
  ]);
  expect(new Set(accepted.factIds).size).toBe(accepted.factIds.length);
  expect(Object.isFrozen(accepted.factIds)).toBe(true);
  expect(kinds).toStrictEqual(
    ["node.capability", "node.read_scope", "node.resource", "node.write_scope"],
  );

  const advertised = new Set<string>(kinds);
  const served = new Set(accepted.factIds.map((id) => id.slice(0, id.indexOf(":"))));
  expect(served.size).toBeGreaterThan(0);
  // Direction 1: nothing production emits is missing from the advertised roster.
  expect([...served].filter((kind) => !advertised.has(kind))).toStrictEqual([]);
  // Direction 2: nothing advertised is unserved by production.
  expect([...advertised].filter((kind) => !served.has(kind))).toStrictEqual([]);

  // Positive control: the same record, with no tier key, is admissible.
  expect(scheduler.deriveNodePropertyFactIds({ ...definition }).ok).toBe(true);
  expect(TIER_INJECTION_KEYS.length).toBe(3);
  for (const key of TIER_INJECTION_KEYS) {
    const injected = scheduler.deriveNodePropertyFactIds({ ...definition, [key]: "R0" });
    expect([key, injected.ok]).toStrictEqual([key, false]);
    if (injected.ok) continue;
    expect([key, injected.issues.map((issue) => [issue.code, issue.layer])]).toStrictEqual([
      key, [["NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION"]],
    ]);
  }

  // A non-definition never reaches the vocabulary at all: the codec answers first.
  const bare: NodePropertyFactIdsResult = scheduler.deriveNodePropertyFactIds({});
  expect(bare.ok).toBe(false);
  if (bare.ok) return;
  expect(bare.issues.map((issue) => [issue.code, issue.layer]))
    .toStrictEqual([["NODE_AUTHORITY_UNSUPPORTED_SCHEMA", "NODE_AUTHORITY_SCHEMA"]]);
});
it("reaches the real graph content codec through the bare package root", () => {
  const snapshot = CODEC_SNAPSHOT;
  const nodeAuthority = codecNodeAuthority(snapshot);
  const encoded = scheduler.encodeGraphContent({
    author: "human:architect-2cc07e26",
    completionNode: "dev-b",
    decompositionBudget: 24,
    nodeAuthority,
    parentRevision: null,
    policyRevision: "pol-000000000001",
    repositoryBaseTree: "4".repeat(40),
    snapshot,
  });
  if (!encoded.ok) {
    throw new Error(encoded.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }

  // A real production result, not a shape: the hash is the digest @moe/core's
  // revision gate accepts, and the canonical order is the validator's, not the
  // caller's (the snapshot above deliberately supplies dev-b first).
  expect(encoded.value.graphContentHash).toMatch(/^[0-9a-f]{64}$/u);
  expect(encoded.value.content.snapshot.nodes.map((node) => node.nodeKey))
    .toEqual(["dev-a", "dev-b"]);
  expect(encoded.value.schemaVersion).toBe(scheduler.GRAPH_CONTENT_SCHEMA_VERSION);
  // The v3 section survived the round through the ROOT codec, carrying the
  // composer's own derived authority for every snapshot node in canonical order.
  expect(encoded.value.content.nodeAuthority.authorities.map((entry) => entry.nodeKey))
    .toEqual(["dev-a", "dev-b"]);
  expect(encoded.value.content.nodeAuthority.definitions).toHaveLength(2);
  for (const entry of encoded.value.content.nodeAuthority.authorities) {
    expect(entry.nodeAuthorityHash).toMatch(/^[0-9a-f]{64}$/u);
  }
  // Content authority is not the structural identity — dec-64b2391c, reached
  // through the bare package root rather than the internal module.
  expect(encoded.value.snapshotIdentity).toMatch(/^[0-9a-f]{64}$/u);
  expect(encoded.value.graphContentHash).not.toBe(encoded.value.snapshotIdentity);
  expect(Object.keys(encoded.value.content))
    .toEqual([...scheduler.GRAPH_REVISION_CONTENT_KEYS]);

  const decoded = scheduler.decodeGraphContent(encoded.value.bytes);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  expect(decoded.value.graphContentHash).toBe(encoded.value.graphContentHash);

  // And the refusal path reaches the same implementation, with the exported
  // vocabulary describing it rather than a string the test made up.
  // A stated authority set the composer does not derive: shape-valid, so only the
  // codec's consumer edge can refuse it, and it must do so under its own code.
  const forged = scheduler.encodeGraphContent({
    author: "human:architect-2cc07e26",
    completionNode: "dev-b",
    decompositionBudget: 24,
    nodeAuthority: {
      authorities: [
        { nodeAuthorityHash: hex("8"), nodeKey: "dev-a" },
        { nodeAuthorityHash: hex("9"), nodeKey: "dev-b" },
      ],
      definitions: (nodeAuthority["definitions"] as unknown[]),
    },
    parentRevision: null,
    policyRevision: "pol-000000000001",
    repositoryBaseTree: "4".repeat(40),
    snapshot,
  });
  expect(forged.ok).toBe(false);
  if (forged.ok) return;
  expect(forged.issues.map((issue) => [issue.code, issue.layer]))
    .toEqual([["GRAPH_CONTENT_AUTHORITY_DISAGREEMENT", "GRAPH_CONTENT_IDENTITY"]]);

  const refused = scheduler.decodeGraphContent("not bytes");
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.issues.map((issue) => [issue.code, issue.layer]))
    .toEqual([["GRAPH_CONTENT_NOT_BYTES", "GRAPH_CONTENT_CODEC"]]);
  expect(scheduler.GRAPH_CONTENT_ISSUE_CODES)
    .toContain(refused.issues[0]?.code);
  expect(scheduler.GRAPH_CONTENT_LAYERS).toContain(refused.issues[0]?.layer);
  expect(scheduler.MAX_GRAPH_CONTENT_BYTES).toBeGreaterThan(0);
});

it("publishes exactly the reviewed root namespace, with no loss and no addition", () => {
  expect(Object.keys(scheduler).sort()).toEqual(EXPECTED_EXPORTS.map(([name]) => name));
});

it.each(EXPECTED_EXPORTS)("publishes %s on the package root as a %s", (name, kind) => {
  const value = surface[name];
  if (kind === "array") expect(Array.isArray(value)).toBe(true);
  else if (kind === "record") expect(typeof value === "object" && !Array.isArray(value)).toBe(true);
  else expect(typeof value).toBe(kind);
});

const DIGEST = "a".repeat(64);
const LOCAL: DeclaredResource =
  { resourceId: "res:local", capacityUnits: 1, external: false, fenceable: true };
const EXTERNAL: DeclaredResource =
  { resourceId: "res:remote", capacityUnits: 1, external: true, fenceable: true };
const RESERVE_REQUEST: ReserveAllRequest = {
  requestId: "req:1", declaredResources: [LOCAL, EXTERNAL],
  capacitySnapshot: { "res:local": 4, "res:remote": 4 }, epoch: 1,
  eligibilityEventSequenceRef: "seq:1", continuouslyEligibleSinceRef: "since:1",
  callerObservation: "obs:1",
};
const LEASE: LeaseRecord = {
  leaseId: "lease:1", kind: "ASSIGNMENT" satisfies LeaseKind, ownerSessionRef: "session:1",
  leaseToken: "token:1", epoch: 3, state: "ACTIVE" satisfies LeaseState, serverWallDeadline: 90,
  bootId: "boot:1", monotonicObservation: 12, authorityHashRef: DIGEST, version: 7,
};
const PROOF: AuthorityProof = {
  leaseToken: "token:1", epoch: 3, authorityHashRef: DIGEST, ownerSessionRef: "session:1",
  expectedVersion: 7,
};
const LEGAL_STATES: readonly LeaseState[] = ["ACTIVE"];

/** Names every arm of AuthorityOutcome without any deep import. */
function authorityCodes(outcome: AuthorityOutcome<unknown>): readonly AuthorityErrorCode[] {
  if (outcome.ok) return [];
  const rejection: AuthorityRejection = outcome;
  const record: RejectionSecurityRecord | null = rejection.securityRecord;
  expect(record === null || record.aggregateKind === "LEASE").toBe(true);
  return rejection.issues.map((issue: AuthorityIssue): AuthorityErrorCode => issue.code);
}
function reservedRows(outcome: AuthorityOutcome<ReserveAllResult>): readonly ResourceRow[] {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return [];
  const result: ReserveAllResult = outcome.value;
  if (result.outcome === "WAITING") {
    const waiting: ResourceWaitRequest = result.waitRequest;
    throw new Error(`unexpected wait for ${waiting.requestId}`);
  }
  return result.rows;
}
function acquisitionSet(outcome: AuthorityOutcome<AcquisitionSet>): AcquisitionSet {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(authorityCodes(outcome).join(","));
  return outcome.value;
}

it("reserves and confirms an acquisition set through the root exports", () => {
  const rows = reservedRows(scheduler.reserveAll(RESERVE_REQUEST));
  const states: readonly AcquisitionState[] = rows.map((row) => row.state);
  expect(rows.map((row) => row.resourceId)).toEqual(["res:local", "res:remote"]);
  expect(states).toEqual(["ACTIVE", "PENDING_ACQUIRE"]);
  const confirmed = acquisitionSet(scheduler.adapterConfirm(rows, "res:remote", 1));
  expect(confirmed.allActive).toBe(true);
  const slot: AuthorityOutcome<ProviderSlotReservation> =
    scheduler.reserveProviderSlot(confirmed.rows, "default", "slot:1", "req:1");
  expect(slot.ok).toBe(true);
  const state: SlotState = slot.ok ? slot.value.state : "RELEASED";
  expect(state).toBe("RESERVED");
  expect(scheduler.SLOT_STATES).toContain(state);
});

it("activates a reserved provider slot through the root exports", () => {
  const rows = reservedRows(scheduler.reserveAll(RESERVE_REQUEST));
  const confirmed = acquisitionSet(scheduler.adapterConfirm(rows, "res:remote", 1));
  const slot = scheduler.reserveProviderSlot(confirmed.rows, "default", "slot:1", "req:1");
  expect(slot.ok).toBe(true);
  if (!slot.ok) throw new Error(authorityCodes(slot).join(","));
  expect(slot.value.dimension).toBe("default");
  expect(slot.value.attemptRef).toBeNull();
  const activation: ProviderSlotActivateCommand = {
    dimension: "default", slotRef: "slot:1", requestId: "req:1", attemptRef: "attempt:1",
  };
  const activated: AuthorityOutcome<ProviderSlotReservation> =
    scheduler.activateProviderSlot(slot.value, activation);
  expect(activated.ok).toBe(true);
  if (!activated.ok) throw new Error(authorityCodes(activated).join(","));
  const next: SlotState = activated.value.state;
  expect(next).toBe("ACTIVE");
  expect(activated.value.attemptRef).toBe("attempt:1");
  expect(activated.value.dimension).toBe("default");
  expect(slot.value.state).toBe("RESERVED");
});

it("refuses drifted or replayed activation with the exact root refusal codes", () => {
  const rows = reservedRows(scheduler.reserveAll(RESERVE_REQUEST));
  const confirmed = acquisitionSet(scheduler.adapterConfirm(rows, "res:remote", 1));
  const slot = scheduler.reserveProviderSlot(confirmed.rows, "default", "slot:1", "req:1");
  if (!slot.ok) throw new Error(authorityCodes(slot).join(","));
  const good = { dimension: "default", slotRef: "slot:1", requestId: "req:1", attemptRef: "a:1" };
  const drifted = scheduler.activateProviderSlot(slot.value, { ...good, slotRef: "slot:2" });
  expect(authorityCodes(drifted)).toEqual(["AUTHORITY_STALE_LEASE"]);
  const malformed = scheduler.activateProviderSlot(slot.value, { ...good, attemptRef: "" });
  expect(authorityCodes(malformed)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  const first = scheduler.activateProviderSlot(slot.value, good);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const replay = scheduler.activateProviderSlot(first.value, good);
  expect(authorityCodes(replay)).toEqual(["AUTHORITY_STALE_LEASE"]);
  expect(replay).not.toHaveProperty("value");
});

/**
 * The design-427 provider-slot release, reached through the bare package root. Same rule as
 * the release-authority block further down: the function is the only runtime key, so
 * `ProviderSlotReleaseCommand` is proven by ANNOTATION on a value that came through
 * `@moe/scheduler` -- a type published nowhere becomes a tsc error rather than a silently
 * green test. `SLOT_STATES` has always declared RELEASED, but this is the ONLY transition
 * that reaches it, so before this export no root consumer could produce a terminal slot.
 */
const SLOT_RELEASE: ProviderSlotReleaseCommand = {
  dimension: "default", slotRef: "slot:1", requestId: "req:1", attemptRef: "attempt:1",
};

/** An ACTIVE slot composed entirely from published root exports -- no deep import. */
function activeSlot(): ProviderSlotReservation {
  const rows = reservedRows(scheduler.reserveAll(RESERVE_REQUEST));
  const confirmed = acquisitionSet(scheduler.adapterConfirm(rows, "res:remote", 1));
  const reserved = scheduler.reserveProviderSlot(confirmed.rows, "default", "slot:1", "req:1");
  if (!reserved.ok) throw new Error(authorityCodes(reserved).join(","));
  const activated = scheduler.activateProviderSlot(reserved.value, {
    dimension: "default", slotRef: "slot:1", requestId: "req:1", attemptRef: "attempt:1",
  });
  if (!activated.ok) throw new Error(authorityCodes(activated).join(","));
  return activated.value;
}

/**
 * Three refusal arms below share `AUTHORITY_STALE_LEASE`, so the code alone cannot say WHICH
 * guard answered. The message does, and the guard order (shape -> identity -> attempt -> state)
 * is what stops a malformed record being reported as a state problem.
 */
function refusalMessages(outcome: AuthorityOutcome<ProviderSlotReservation>): readonly string[] {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return [];
  const rejection: AuthorityRejection = outcome;
  return rejection.issues.map((issue: AuthorityIssue): string => issue.message);
}

it("publishes releaseProviderSlot as a defined function binding on the package root", () => {
  // The roster's ExportKind check passes for ANY function, including an anonymous wrapper;
  // the name and arity pin that the root resolves to the owning module's own declaration.
  const released: unknown = surface["releaseProviderSlot"];
  expect(typeof released).toBe("function");
  expect((released as { readonly name: string }).name).toBe("releaseProviderSlot");
  expect((released as { readonly length: number }).length).toBe(2);
});

it("composes the only ACTIVE -> RELEASED provider-slot transition through the root", () => {
  const slot = activeSlot();
  const outcome: AuthorityOutcome<ProviderSlotReservation> =
    scheduler.releaseProviderSlot(slot, SLOT_RELEASE);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(authorityCodes(outcome).join(","));
  const next: SlotState = outcome.value.state;
  expect(next).toBe("RELEASED");
  expect(scheduler.SLOT_STATES).toContain(next);
  // The binding is retained, so a settled slot still names the attempt it was released against.
  expect(outcome.value.attemptRef).toBe("attempt:1");
  // Pure: a fresh frozen successor, and the caller's own record is neither mutated nor returned.
  expect(Object.isFrozen(outcome.value)).toBe(true);
  expect(outcome.value).not.toBe(slot);
  expect(slot.state).toBe("ACTIVE");
});

it("replays a settled provider-slot release as a NO_OP acceptance, not a refusal", () => {
  const first = scheduler.releaseProviderSlot(activeSlot(), SLOT_RELEASE);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(authorityCodes(first).join(","));
  const replay = scheduler.releaseProviderSlot(first.value, SLOT_RELEASE);
  expect(replay.ok).toBe(true);
  if (!replay.ok) return;
  // Idempotent, not a second transition: the state is unchanged and still terminal.
  expect(replay.value.state).toBe("RELEASED");
});

it("refuses a drifted, cross-attempt or malformed slot release with exact root codes", () => {
  const slot = activeSlot();
  const drifted = scheduler.releaseProviderSlot(slot, { ...SLOT_RELEASE, slotRef: "slot:2" });
  expect(authorityCodes(drifted)).toEqual(["AUTHORITY_STALE_LEASE"]);
  expect(refusalMessages(drifted)[0]).toContain("does not match the reserved provider slot");
  // Releasing against an attempt the slot never carried would leak authority across attempts.
  const foreign = scheduler.releaseProviderSlot(slot, { ...SLOT_RELEASE, attemptRef: "attempt:2" });
  expect(authorityCodes(foreign)).toEqual(["AUTHORITY_STALE_LEASE"]);
  expect(refusalMessages(foreign)[0]).toContain("a different attempt");
  // Shape is checked FIRST, so an empty ref is malformed rather than an attempt mismatch.
  const malformed = scheduler.releaseProviderSlot(slot, { ...SLOT_RELEASE, attemptRef: "" });
  expect(authorityCodes(malformed)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  expect(malformed).not.toHaveProperty("value");
});

it("refuses to release a slot whose state carries no release disposition", () => {
  // No production path yields a RESERVED slot that already names an attempt -- reserve leaves
  // attemptRef null and only activate sets it -- so the state guard is unreachable from an
  // honest fixture and would be UNGUARDED if only honest fixtures were used. This record is
  // planted deliberately to reach it, drifting exactly one field past the attempt check.
  const planted = { ...activeSlot(), state: "RESERVED" as const };
  const refused = scheduler.releaseProviderSlot(planted, SLOT_RELEASE);
  expect(authorityCodes(refused)).toEqual(["AUTHORITY_STALE_LEASE"]);
  expect(refusalMessages(refused)[0]).toContain("in state RESERVED cannot be released");
});

it("quarantines an unknown adapter failure and clears it with a proof", () => {
  const rows = reservedRows(scheduler.reserveAll(RESERVE_REQUEST));
  const disposition: AcquisitionFailure = "UNKNOWN";
  const held = acquisitionSet(scheduler.adapterFail(rows, "res:remote", 1, disposition));
  expect(held.held).toBe(true);
  expect(held.rows.some((row) => row.state === "QUARANTINED")).toBe(true);
  const cleared = acquisitionSet(scheduler.grantSuccessorCapacity(held.rows, "proof:1"));
  expect(cleared.rows.every((row) => row.state === "RELEASED")).toBe(true);
});

it("reports AUTHORITY_MALFORMED_INPUT from the root reserveAll on hostile input", () => {
  expect(authorityCodes(scheduler.reserveAll(null))).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
});

it("fences a current proof and names both Fenced arms from the root", () => {
  const fenced: Fenced = scheduler.fenceAuthority(LEASE, PROOF, "surface", LEGAL_STATES);
  expect(fenced.ok).toBe(true);
  if (!fenced.ok) throw new Error("expected a fenced authority");
  const lease: LeaseRecord = fenced.lease;
  const proof: AuthorityProof = fenced.proof;
  expect([lease.leaseId, proof.leaseToken]).toEqual(["lease:1", "token:1"]);
});

it("rejects a stale epoch with AUTHORITY_STALE_EPOCH and a redacted security record", () => {
  const stale: Fenced =
    scheduler.fenceAuthority(LEASE, { ...PROOF, epoch: 2 }, "surface", LEGAL_STATES);
  expect(stale.ok).toBe(false);
  if (stale.ok) throw new Error("expected a rejection");
  const rejection: AuthorityRejection = stale.rejection;
  expect(rejection.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_STALE_EPOCH"]);
  const record: RejectionSecurityRecord | null = rejection.securityRecord;
  expect(record?.code).toBe("AUTHORITY_STALE_EPOCH");
  expect(record).not.toHaveProperty("leaseToken");
});

it("parses lease, proof, and clock shapes from the root and refuses hostile input", () => {
  const parsedLease: LeaseRecord | null = scheduler.parseLeaseRecord(LEASE);
  const parsedProof: AuthorityProof | null = scheduler.parseProof(PROOF);
  const clock: ClockObservation | null =
    scheduler.parseClock({ serverWallSeconds: 10, bootId: "boot:1", monotonicObservation: 12 });
  expect([parsedLease?.state, parsedProof?.epoch, clock?.bootId]).toEqual(["ACTIVE", 3, "boot:1"]);
  expect([scheduler.parseLeaseRecord(null), scheduler.parseProof(null), scheduler.parseClock(null)])
    .toEqual([null, null, null]);
});

const METER: BudgetMeterBuckets =
  { meter: "usd", available: 100, reserved: 0, quarantined: 0, committed: 0 };
const VIEW: BudgetAvailableView = {
  accountId: "account:1", state: "OPEN" satisfies BudgetAccountState, version: 4, meters: [METER],
};
/** Hand-transcribed rather than mapped over ADMISSION_PURPOSES: a fixture derived from an
 * export under test collapses the whole file when that export goes missing, hiding the
 * per-name assertions that are supposed to report the loss. */
const PURPOSES: readonly AdmissionPurpose[] =
  ["EXECUTION", "VERIFICATION", "INDEPENDENT_REVIEW", "FINAL_ACCEPTANCE", "CONTINGENCY"];
const LINES: readonly AdmissionAmount[] =
  PURPOSES.map((purpose): ReservationLine => ({ purpose, meter: "usd", quantity: 2 }));
const ADMISSION: AdmissionRequest =
  { admissionRef: "admission:1", expectedVersion: 4, amounts: LINES };
const ALLOWANCE: AdmissionPolicyAllowance =
  { decisionRef: "decision:1", outcome: "ALLOW" satisfies BudgetPolicyOutcome };
const APPROVAL: AdmissionHumanApproval =
  { approvalRef: "approval:1", decision: "APPROVE", validity: "CURRENT" };
const GATE: AdmissionGate = { allowance: ALLOWANCE, approval: APPROVAL };

/** Names every arm of BudgetReservationResult without any deep import. */
function reservationOf(result: BudgetReservationResult): ReservationRecord {
  if (!result.ok) {
    const codes = result.issues.map((issue: BudgetReservationIssue) => issue.code);
    throw new Error(codes.join(","));
  }
  const view: BudgetAvailableView = result.view;
  expect(view.accountId).toBe("account:1");
  return result.reservation;
}
function issueCodes(result: BudgetReservationResult): readonly BudgetReservationIssueCode[] {
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  const held: ReservationRecord | null = result.reservation;
  expect(held === null || held.accountId === "account:1").toBe(true);
  return result.issues.map((issue: BudgetReservationIssue) => issue.code);
}

/** The refund is checked against the view the admission returned, not the one it consumed. */
function heldView(result: BudgetReservationResult): BudgetAvailableView {
  expect(result.ok).toBe(true);
  return result.view;
}

it("reserves, activates, and cancels an admission through the root exports", () => {
  const admitted = scheduler.reserveForAdmission(VIEW, ADMISSION, GATE);
  const reserved = reservationOf(admitted);
  const held = heldView(admitted);
  const state: ReservationState = reserved.state;
  expect(state).toBe("RESERVED");
  expect(reserved.reservationId).toBe(scheduler.deriveReservationId("account:1", "admission:1"));
  expect(scheduler.RESERVATION_STATES).toContain(state);
  const activate: ReservationActivateCommand = { expectedVersion: 0, attemptRef: "attempt:1" };
  expect(reservationOf(scheduler.activateReservation(held, reserved, activate)).state)
    .toBe("ACTIVATED");
  const cancel: ReservationCancelCommand =
    { expectedVersion: 0, neverStartedProofRef: "never:1" };
  expect(reservationOf(scheduler.cancelReservation(held, reserved, cancel)).state)
    .toBe("CANCELLED");
});

it("refuses a cancellation with no never-started proof by its own reason code", () => {
  const admitted = scheduler.reserveForAdmission(VIEW, ADMISSION, GATE);
  const cancel: ReservationCancelCommand = { expectedVersion: 0, neverStartedProofRef: null };
  expect(issueCodes(scheduler.cancelReservation(heldView(admitted), reservationOf(admitted), cancel)))
    .toEqual(["BUDGET_RESERVATION_NEVER_STARTED_PROOF_MISSING"]);
});

it("refuses a malformed admission view with BUDGET_RESERVATION_MALFORMED", () => {
  const hostile = null as unknown as BudgetAvailableView;
  expect(issueCodes(scheduler.reserveForAdmission(hostile, ADMISSION, GATE)))
    .toEqual(["BUDGET_RESERVATION_MALFORMED"]);
});

/**
 * Fairness contracts. A published TYPE is invisible to the count and namespace
 * guards above, which see runtime values only, so each one is proven by calling
 * through the bare specifier and annotating the returned value — an unpublished
 * type becomes a tsc error rather than a silently green test.
 */
const DISPATCHABILITY: FairnessDispatchabilityFact =
  { state: "DISPATCHABLE" satisfies FairnessDispatchabilityState, observationRef: "obs:wi-a" };
const FAIR_ITEM = {
  workItemId: "wi-a", dimensionId: "dim-1",
  priority: "P1" satisfies FairnessPriorityClass, resourceId: "res-a",
  dispatchability: DISPATCHABILITY,
};

/** Names both arms of the result union without any deep import. */
function fairnessCodes(
  result: FairnessContractResult<unknown>,
): readonly FairnessContractIssueCode[] {
  if (result.ok) return [];
  const refusal: FairnessContractRefusal = result;
  return refusal.issues.map(
    (issue: FairnessContractIssue): FairnessContractIssueCode => issue.code,
  );
}

it("validates every fairness family through the root exports", () => {
  const item = scheduler.validateWorkItem(FAIR_ITEM);
  if (!item.ok) throw new Error(fairnessCodes(item).join(","));
  const validated: FairnessWorkItem = item.value;
  expect([validated.workItemId, validated.dispatchability.observationRef])
    .toEqual(["wi-a", "obs:wi-a"]);
  expect(scheduler.validateWorkItemSet([FAIR_ITEM], "dim-1").ok).toBe(true);
  expect(scheduler.isFairnessIdentity("wi-a")).toBe(true);

  const ringResult = scheduler.validateRing({
    ringId: "ring-1", dimensionId: "dim-1",
    resources: [{ resourceId: "res-a", weight: 1 }],
    entries: [{ workItemId: "wi-a", resourceId: "res-a", deficitCounter: 0 }],
  });
  if (!ringResult.ok) throw new Error(fairnessCodes(ringResult).join(","));
  const ring: FairnessRing = ringResult.value;
  const resources: readonly FairnessRingResource[] = ring.resources;
  const entries: readonly FairnessRingQueueEntry[] = ring.entries;
  expect([resources.length, entries.length]).toEqual([1, 1]);
  expect(scheduler.validateRingResource(resources[0]).ok).toBe(true);

  const attestation: FairnessOpportunityAttestation =
    { opportunityRef: "opp-1", winnerWorkItemId: "wi-b", observationRef: "obs-1" };
  const claim: FairnessBypassClaim =
    { workItemId: "wi-a", claimedBypasses: 1, attestations: [attestation] };
  const proven = scheduler.validateBypassClaim(claim);
  if (!proven.ok) throw new Error(fairnessCodes(proven).join(","));
  const bypasses: FairnessProvenBypasses = proven.value;
  expect(bypasses.provenBypasses).toBe(1);

  const migration: FairnessCapMigration =
    { workItemId: "wi-a", boundAtMost: 2, currentBoundAtMost: 4 };
  const revised = scheduler.validateCapRevision({
    revisionRef: "rev-1", dimensionId: "dim-1", fromCapUnits: 4, toCapUnits: 8,
    drainedWorkItemIds: [], migrations: [migration],
  });
  if (!revised.ok) throw new Error(fairnessCodes(revised).join(","));
  const revision: FairnessCapRevision = revised.value;
  expect(revision.migrations.length).toBe(1);
});

/**
 * Rotation and aging are exercised through the bare specifier for the same
 * reason the families above are: the export-count guards see runtime values
 * only, so a type published nowhere would leave them green. Annotating each
 * returned value turns an unpublished type into a tsc error.
 */
it("rotates and ages through the root exports", () => {
  const ringInput = {
    ringId: "ring-1", dimensionId: "dim-1",
    resources: [{ resourceId: "res-a", weight: 2 }],
    entries: [{ workItemId: "wi-a", resourceId: "res-a", deficitCounter: 0 }],
  };
  const capacity: FairnessResourceCapacity =
    { resourceId: "res-a", capacityUnits: 4, inFlightUnits: 0 };
  const rotated = scheduler.rotateOnce({
    ring: ringInput, workItems: [FAIR_ITEM], capacities: [capacity],
    forcedHead: null, capRevision: null,
  });
  if (!rotated.ok) throw new Error(fairnessCodes(rotated).join(","));
  const outcome: FairnessRotationOutcome = rotated.value;
  const disposition: FairnessRotationDisposition = outcome.disposition;
  const selection: FairnessRotationSelection | null = outcome.selection;
  expect([disposition, selection?.workItemId]).toEqual(["SELECTED", "wi-a"]);
  expect(scheduler.FAIRNESS_ROTATION_DISPOSITIONS).toContain(disposition);

  const inputs = scheduler.validateRotationRequest({
    ring: ringInput, workItems: [FAIR_ITEM], capacities: [capacity],
    forcedHead: null, capRevision: null,
  });
  if (!inputs.ok) throw new Error(fairnessCodes(inputs).join(","));
  const validated: FairnessRotationInputs = inputs.value;
  expect(validated.totalInFlight).toBe(0);
  const order = scheduler.resourceRotationOrder(ringInput);
  expect(order.ok && order.value).toEqual(["res-a"]);
  expect(scheduler.validateResourceCapacity(capacity).ok).toBe(true);

  const aged = scheduler.ageWorkItem({
    workItem: FAIR_ITEM, capacity, capRevision: null, forcedHead: null,
    bypassClaim: {
      workItemId: "wi-a", claimedBypasses: 8,
      attestations: Array.from({ length: 8 }, (_, index) => ({
        opportunityRef: `opp-${index}`, winnerWorkItemId: "wi-b",
        observationRef: `obs-${index}`,
      })),
    },
  });
  if (!aged.ok) throw new Error(fairnessCodes(aged).join(","));
  const standing: FairnessAgedStanding = aged.value;
  // FAIR_ITEM is P1, so one quantum promotes it to P0 and forcing needs two.
  expect([standing.effectivePriority, standing.forced]).toEqual(["P0", false]);
  expect(scheduler.bypassesToForced("P1")).toBe(scheduler.FAIRNESS_BYPASSES_PER_LEVEL * 2);
  expect([scheduler.FAIRNESS_DIMENSION_CEILING, scheduler.FAIRNESS_SERVICE_COST])
    .toEqual([10_000, 1]);
  expect(scheduler.FAIRNESS_FORCED_BYPASS_BOUND).toBe(32);
  expect(scheduler.FAIRNESS_PRIORITY_LADDER).toEqual(["P0", "P1", "P2", "P3"]);
});

it("refuses hostile fairness input from the root and names the refusing layer", () => {
  const refused = scheduler.validateWorkItem(null);
  expect(fairnessCodes(refused)).toEqual(["FAIRNESS_CONTRACT_MALFORMED_INPUT"]);
  if (refused.ok) throw new Error("expected a refusal");
  const layers: readonly FairnessContractLayer[] = refused.issues.map((issue) => issue.layer);
  expect(layers).toEqual(["WORK_ITEM"]);
  expect(refused.disposition).toBe("REFUSED");
});

it("refuses an unprovable bypass claim from the root, not merely a malformed one", () => {
  const unproven =
    scheduler.validateBypassClaim({ workItemId: "wi-a", claimedBypasses: 3, attestations: [] });
  expect(fairnessCodes(unproven)).toEqual(["FAIRNESS_CONTRACT_BYPASS_EVIDENCE_MISSING"]);
});

it("publishes the fairness vocabularies as frozen closed sets", () => {
  expect([...scheduler.FAIRNESS_CONTRACT_LAYERS]).toContain("WORK_ITEM");
  expect([...scheduler.FAIRNESS_PRIORITY_CLASSES]).toContain("P1");
  expect([...scheduler.FAIRNESS_DISPATCHABILITY_STATES]).toContain("NOT_DISPATCHABLE");
  expect(scheduler.FAIRNESS_CONTRACT_ISSUE_CODES)
    .toContain("FAIRNESS_CONTRACT_ITEM_IN_MULTIPLE_QUEUES");
  for (const vocabulary of [
    scheduler.FAIRNESS_CONTRACT_ISSUE_CODES, scheduler.FAIRNESS_CONTRACT_LAYERS,
    scheduler.FAIRNESS_DISPATCHABILITY_STATES, scheduler.FAIRNESS_PRIORITY_CLASSES,
  ]) {
    expect(Object.isFrozen(vocabulary)).toBe(true);
  }
});

it("publishes the admission purpose vocabularies and their contract mapping", () => {
  const contract: Readonly<Record<AdmissionPurpose, BudgetReservePurpose | null>> =
    scheduler.ADMISSION_PURPOSE_RESERVE_CONTRACT;
  expect(contract.EXECUTION).toBeNull();
  expect(contract.INDEPENDENT_REVIEW).toBe("REVIEW");
  expect([...scheduler.PROTECTED_ADMISSION_PURPOSES]).not.toContain("EXECUTION");
  expect(scheduler.BUDGET_RESERVATION_ISSUE_CODES)
    .toContain("BUDGET_RESERVATION_NEVER_STARTED_PROOF_MISSING");
});

/**
 * Supersession dispositions. Same rule as the fairness block: a published TYPE
 * is invisible to the count and namespace guards, so every one is annotated on
 * a value that passes through the bare specifier — an unpublished type becomes
 * a tsc error rather than a silently green test.
 */
const BOUND_FIELD: SupersessionBoundDispositionField = "outcome";
const RESOURCE_FACTS: SupersessionResourceFacts =
  { drainDisposition: null, release: null, slotState: null, successorCapacity: null };
const BUDGET_FACTS: SupersessionBudgetFacts = {
  expectedVersion: 0, neverStartedProofRef: null, reservation: null, settlementState: null,
  successorAttemptRef: "attempt:1", view: null,
};
const ADD_NODE: SupersessionNodeFacts = {
  attemptLifecycle: "CREATED", budget: null, effectsTerminal: true, kind: "ADD",
  nodeKey: "node:add", resource: RESOURCE_FACTS,
};

/** Names both arms of the result union without any deep import. */
function supersessionRefusal(result: SupersessionDispositionResult): SupersessionCarryRefusal {
  if (result.ok) {
    const set: SupersessionDispositionSet = result;
    const first: SupersessionFamilyDisposition | undefined = set.dispositions[0];
    throw new Error(`expected a refusal, got ${set.dispositions.length} from ${String(first?.kind)}`);
  }
  return result;
}

it("refuses an incomplete supersession set from the root, naming code and layer", () => {
  const refused = supersessionRefusal(scheduler.buildSupersessionDispositions([ADD_NODE]));
  const code: SupersessionRefusalCode = refused.code;
  const layer: SupersessionDispositionLayer = refused.layer;
  expect([code, layer]).toEqual(["PLANNING_DISPOSITION_UNKNOWN", "SCHEDULER_SUPERSESSION_SET"]);
  expect(scheduler.SUPERSESSION_REFUSAL_CODES).toContain(code);
  expect(scheduler.SUPERSESSION_DISPOSITION_LAYERS).toContain(layer);
});

it("refuses a malformed wait projection through the root consumer edge", () => {
  const refused = supersessionRefusal(scheduler.carryWaitProjection(null, [ADD_NODE]));
  expect([refused.code, refused.layer])
    .toEqual(["INPUT_INVALID", "SCHEDULER_SUPERSESSION_SET"]);
});

it("publishes the supersession vocabularies as frozen closed sets", () => {
  const family: SupersessionDispositionFamily = "RESOURCE";
  expect([...scheduler.SUPERSESSION_DISPOSITION_FAMILIES]).toContain(family);
  expect([...scheduler.SUPERSESSION_BOUND_DISPOSITION_FIELDS]).toContain(BOUND_FIELD);
  expect(BUDGET_FACTS.successorAttemptRef).toBe("attempt:1");
  for (const vocabulary of [
    scheduler.SUPERSESSION_BOUND_DISPOSITION_FIELDS, scheduler.SUPERSESSION_DISPOSITION_FAMILIES,
    scheduler.SUPERSESSION_DISPOSITION_LAYERS, scheduler.SUPERSESSION_REFUSAL_CODES,
  ]) {
    expect(Object.isFrozen(vocabulary)).toBe(true);
  }
});

/**
 * Expansion admission. Same rule as the two blocks above, and it is the whole
 * reason a happy path is driven here rather than only in the cross-package
 * integration suite: `tests/` is collected by vitest but typechecked by NO gate,
 * so a type published nowhere would leave an annotation there silently green.
 * Every expansion type is therefore annotated HERE, on a value that came through
 * the bare specifier, where `pnpm --filter @moe/scheduler typecheck` can see it.
 *
 * The fixtures are rebuilt inline rather than imported from
 * ../admission/admission-fixtures.js on purpose: the package `exports` map is
 * exclusive, so a real consumer could not reach them either, and a surface test
 * that leaned on an unreachable helper would be proving the wrong reachability.
 */
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function healthyReceipt(): Record<string, unknown> {
  return {
    proposalId: "prop-1", revision: 3, goalVersion: 7, graphEpoch: 11,
    observedAtSequence: 100, horizonSequence: 90,
    parentScope: ["a", "b", "c", "d"],
    childScopes: [
      {
        childKey: "child-1", scope: ["a", "b"], oracleKind: "OBSERVED", completion: "CLOSED",
        inputs: [{ inputKey: "in-1", materialization: "MATERIALIZED", digest: DIGEST_A }],
      },
      {
        childKey: "child-2", scope: ["c"], oracleKind: "DERIVED", completion: "CLOSED",
        inputs: [{ inputKey: "in-2", materialization: "MATERIALIZED", digest: DIGEST_B }],
      },
    ],
    sourceDigests: [DIGEST_A, DIGEST_B],
  };
}

function contractFor(producerNodeKey: string, consumerNodeKey: string): Record<string, unknown> {
  return {
    producerNodeKey, consumerNodeKey, edgeKind: "ARTIFACT_CONSUMPTION",
    graphBindingDigest: "c".repeat(64),
    producer: {
      kind: "ARTIFACT_CONSUMPTION", artifactOrInterfaceRef: "artifact:shared", digest: DIGEST_B,
    },
    consumer: {
      kind: "PRECONDITION", criterionRef: `criterion:${consumerNodeKey}`, contractHash: DIGEST_A,
    },
    minimumQualifyingMilestone: "RESULT_SEALED",
    satisfactionPredicate: {
      predicateRef: "predicate:sealed", schemaId: "moe.predicate.sealed", schemaVersion: 1,
      parametersDigest: DIGEST_B,
    },
    stability: "REVOCABLE",
    satisfactionWitnesses: [{
      witnessRef: `witness:${producerNodeKey}`, witnessVersion: 1, witnessDigest: DIGEST_A,
      sourceOperationClass: "ARTIFACT_SEAL",
    }],
    consumptionHorizon: "RESULT_SEAL",
    necessity: {
      failedConsumerCriterionRef: `criterion:${consumerNodeKey}`, failureKind: "MISSING_ARTIFACT",
      truthClass: "DAEMON_VERIFIED",
    },
    alternativeRuling: { kind: "NOT_APPLICABLE", reason: "no compatible substitute" },
    alternateProducers: [], truthClass: "DAEMON_VERIFIED",
    invalidationFacts: [{
      sourceFactRef: `fact:${producerNodeKey}`, sourceFactVersion: 1, sourceFactDigest: DIGEST_A,
    }],
    recheckPredicateRef: "predicate:sealed",
  };
}

/** dev-node-a -> dev-node-b -> dev-node-c, completion dev-node-c. */
function graphPart(): Record<string, unknown> {
  const edges = [
    { edgeKey: "dev-edge-ab", producerNodeKey: "dev-node-a", consumerNodeKey: "dev-node-b", kind: "HARD" },
    { edgeKey: "dev-edge-bc", producerNodeKey: "dev-node-b", consumerNodeKey: "dev-node-c", kind: "HARD" },
  ];
  const snapshot = {
    nodes: ["dev-node-a", "dev-node-b", "dev-node-c"].map((nodeKey) => ({ nodeKey, executionBearing: true })),
    edges, completionNodeKey: "dev-node-c",
  };
  return {
    proposedSnapshot: snapshot, sequentialBaselineSnapshot: snapshot,
    contracts: edges.map((edge) => ({
      edgeKey: edge.edgeKey, edgeKind: "ARTIFACT_CONSUMPTION",
      contract: contractFor(edge.producerNodeKey, edge.consumerNodeKey),
      necessityWitness: { edgeKey: edge.edgeKey, truthClass: "DAEMON_VERIFIED" },
    })),
  };
}

function admissionRequest(): ExpansionAdmissionRequest {
  return {
    receipt: healthyReceipt(),
    lineage: { expansionDepth: 2, nodesAddedInExpansion: 2 },
    graph: graphPart(),
    rotation: {
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
    },
    bypassClaim: null,
    budget: {
      view: {
        accountId: "acct.1", state: "OPEN", version: 4,
        meters: [{ meter: "tokens", available: 1000, reserved: 0, quarantined: 0, committed: 0 }],
      },
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
    },
    resources: {
      requestId: "req.1",
      declaredResources: [{ resourceId: "res.a", capacityUnits: 1, external: false, fenceable: true }],
      capacitySnapshot: { "res.a": 4 }, epoch: 1,
      eligibilityEventSequenceRef: "seq.1", continuouslyEligibleSinceRef: "since.1",
      callerObservation: "obs.1",
    },
  };
}

it("derives expansion evidence through the root and names every derived type", () => {
  const result: ExpansionEvidenceResult = scheduler.deriveExpansionEvidence(healthyReceipt());
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  const evidence: DerivedExpansionEvidence = result.value;
  const children: readonly ExpansionChildFacts[] = evidence.childFacts;
  const inputs: readonly ExpansionInputFact[] = children[0]!.inputs;
  expect([evidence.proposalId, evidence.childWidth, evidence.childKeys.length]).toEqual(["prop-1", 2, 2]);
  expect([children.length, inputs[0]!.inputKey]).toEqual([2, "in-1"]);
});

it("refuses a caller-declared verdict from the root, naming code and layer", () => {
  const refused = scheduler.deriveExpansionEvidence({ ...healthyReceipt(), eligible: true });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("expected a refusal");
  const refusal: ExpansionEvidenceRefusal = refused;
  const issue: ExpansionEvidenceIssue = refusal.issues[0]!;
  const code: ExpansionEvidenceIssueCode = issue.code;
  const layer: ExpansionEvidenceLayer = issue.layer;
  expect([code, layer, refusal.disposition]).toEqual([
    "EXPANSION_CALLER_DECLARED_VERDICT", "EVIDENCE", "REFUSED",
  ]);
  expect(scheduler.EXPANSION_EVIDENCE_ISSUE_CODES).toContain(code);
  expect(scheduler.EXPANSION_EVIDENCE_LAYERS).toContain(layer);
});

it("admits one expansion through the root and names every prepared type", () => {
  const result: ExpansionAdmissionResult = scheduler.admitExpansion(admissionRequest());
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  const preparation: ExpansionPreparation = result.preparation;
  const bound: ExpansionBoundFacts = preparation.bound;
  const lineage: ExpansionLineageFacts = bound.lineage;
  const fairness: ExpansionFairnessFacts = bound.fairness;
  const capacities: readonly ExpansionCapacityFact[] = bound.capacitySnapshot;
  const budget: ExpansionBudgetFacts = bound.budgetReservation;
  const resources: ExpansionResourceFacts = bound.resourceReservation;
  expect(preparation.identity).toMatch(/^[0-9a-f]{64}$/u);
  // childWidth is DERIVED from the receipt; the caller supplied only the other two.
  expect(lineage).toEqual({ expansionDepth: 2, childWidth: 2, nodesAddedInExpansion: 2 });
  expect([fairness.disposition, fairness.capRevisionRef]).toEqual(["SELECTED", null]);
  expect(capacities.map((one) => one.resourceId)).toEqual(["res.a", "res.b"]);
  expect([budget.accountId, budget.admissionRef]).toEqual(["acct.1", "adm.1"]);
  expect(resources.resourceIds).toEqual(["res.a"]);
  // Reservation is not activation: no run, lease, effect or slot appears anywhere.
  expect(JSON.stringify(bound)).not.toMatch(/lease|dispatch|activat/iu);
});

it("refuses a malformed admission from the root and holds nothing back", () => {
  const result: ExpansionAdmissionResult = scheduler.admitExpansion(null);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ExpansionAdmissionRefusal = result;
  const issue: ExpansionAdmissionIssue = refusal.issues[0]!;
  const origin: ExpansionAdmissionOrigin = issue.origin;
  const unwind: ExpansionAdmissionUnwind = refusal.unwind;
  const restored: readonly ExpansionRestoredMeter[] | null = unwind.restoredMeters;
  const code: ExpansionAdmissionIssueCode = "EXPANSION_ADMISSION_REQUEST_MALFORMED";
  expect([issue.code, origin, refusal.disposition]).toEqual([code, "REQUEST", "REFUSED"]);
  // Nothing was reserved before the parse, so nothing can have been given back.
  expect([unwind.budgetReservationCancelled, restored]).toEqual([false, null]);
  expect(scheduler.EXPANSION_ADMISSION_ISSUE_CODES).toContain(code);
  expect(scheduler.EXPANSION_ADMISSION_ORIGINS).toContain(origin);
});

it("publishes the expansion vocabularies as frozen closed sets", () => {
  expect([...scheduler.FORBIDDEN_VERDICT_KEYS]).toContain("oracleEligible");
  for (const vocabulary of [
    scheduler.EXPANSION_ADMISSION_ISSUE_CODES, scheduler.EXPANSION_ADMISSION_ORIGINS,
    scheduler.EXPANSION_EVIDENCE_ISSUE_CODES, scheduler.EXPANSION_EVIDENCE_LAYERS,
    scheduler.FORBIDDEN_VERDICT_KEYS,
  ]) {
    expect(Object.isFrozen(vocabulary)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// The admission-to-preparation binding, driven from the bare package root.
//
// Every refusal below pins the exact code AND the refusing layer, and for a
// DELEGATED one also the origin, because more than one layer can refuse here:
// the fairness contract, the core hold reducer and this bridge all speak.
// ---------------------------------------------------------------------------

const HANDOFF = { digest: DIGEST_B, ref: "handoff:worker" };

function holdCommand(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    commandId: "command:create", deadline: 4_000, expectedVersion: 0, generation: 1,
    graphEpoch: 11, holdId: "hold:expansion:1", kind: "graph.request_expansion",
    parentNodeRef: "node:parent", parentRevisionRef: "revision:active",
    parentRunRef: "run:parent", planningRunRef: "planning:expansion:1",
    proposalBaseHash: DIGEST_A,
    rationale: { text: "split bounded independent work", truthClass: "AGENT_REPORTED" },
    release: {
      attemptRef: "attempt:released", attemptState: "RELEASED",
      disposition: {
        resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
      },
      effectsTerminal: true, handoff: { ...HANDOFF },
      leaseRef: "lease:released", leaseState: "RELEASED",
      observationRef: "observation:safe-boundary", providerSlotRef: "slot:released",
      providerSlotState: "RELEASED", reason: "WORK_RELEASE_OR_PAUSE",
      receiptRef: "receipt:release", resourcesTerminal: true, safeBoundaryObserved: true,
      terminalEffectRefs: ["effect:terminal"], terminalResourceRefs: ["resource:terminal"],
      truthClass: "DAEMON_VERIFIED",
    },
    sourceFingerprint: DIGEST_B, workerHandoff: { ...HANDOFF },
    ...overrides,
  };
}

function activeHold(overrides: Readonly<Record<string, unknown>> = {}): ExpansionPlanningHoldState {
  const result = reduceExpansionPlanningHold(undefined, holdCommand(overrides));
  if (!result.ok) throw new Error(`hold refused: ${result.code}`);
  return result.state;
}

function admittedPreparation(): ExpansionPreparation {
  const result = scheduler.admitExpansion(admissionRequest());
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  return result.preparation;
}

const OPPORTUNITY = {
  opportunityRef: "opportunity.round.7", winnerWorkItemId: "item.a",
  observationRef: "observation.round.7",
};

const CURRENT: ExpansionCurrentAuthority = {
  goalVersion: 7, graphEpoch: 11, holdId: "hold:expansion:1", holdVersion: 1,
  planningRunRef: "planning:expansion:1",
};

/** The exact production request type, named so a shape change breaks here. */
function baseRequest(): ExpansionBindingRequest {
  return {
    currentAuthority: { ...CURRENT }, hold: activeHold(), opportunity: { ...OPPORTUNITY },
    preparation: admittedPreparation(),
  };
}

function bindingRequest(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return { ...baseRequest(), ...overrides };
}

/** The single issue a refusal carried, failing loudly if there was not exactly one. */
function onlyBindingIssue(result: ExpansionBindingResult): ExpansionBindingIssue {
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ExpansionBindingRefusal = result;
  expect(refusal.issues).toHaveLength(1);
  return refusal.issues[0] as ExpansionBindingIssue;
}

it("validates one fairness opportunity attestation through the root, detached and frozen", () => {
  const source = { ...OPPORTUNITY };
  const result: FairnessContractResult<FairnessOpportunityAttestation> =
    scheduler.validateOpportunityAttestation(source);
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  const attestation: FairnessOpportunityAttestation = result.value;
  expect(attestation).toEqual({ ...OPPORTUNITY });
  expect(Object.isFrozen(attestation)).toBe(true);
  // Detached: mutating the caller's own record cannot move the validated one.
  source.opportunityRef = "opportunity.round.8";
  expect(attestation.opportunityRef).toBe("opportunity.round.7");
});

/**
 * The bypass rule and the selection rule are DIFFERENT rules over the same
 * shape. `validateBypassClaim` refuses a self-attested winner because a work
 * item cannot bypass itself; a SELECTION attestation names the winner, and here
 * that winner is the admitted item. Pinning both sides keeps the split honest.
 */
it("accepts a self-named winner that the bypass validator refuses", () => {
  const selected = scheduler.validateOpportunityAttestation(
    { ...OPPORTUNITY, winnerWorkItemId: "item.a" },
  );
  expect(selected.ok).toBe(true);
  const claim: FairnessBypassClaim = {
    workItemId: "item.a", claimedBypasses: 1,
    attestations: [{ ...OPPORTUNITY, winnerWorkItemId: "item.a" }],
  };
  const bypass = scheduler.validateBypassClaim(claim);
  expect(bypass.ok).toBe(false);
  if (bypass.ok) throw new Error("expected a refusal");
  expect([bypass.issues[0]?.code, bypass.issues[0]?.layer])
    .toEqual(["FAIRNESS_CONTRACT_BYPASS_SELF_ATTESTED", "OPPORTUNITY_EVIDENCE"]);
});

const ATTESTATION_CASES: readonly (readonly [string, unknown, string, string, string])[] = [
  ["a non-record", null, "FAIRNESS_CONTRACT_MALFORMED_INPUT", "OPPORTUNITY_EVIDENCE", "REFUSED"],
  ["an extra key", { ...OPPORTUNITY, extra: 1 }, "FAIRNESS_CONTRACT_MALFORMED_INPUT",
    "OPPORTUNITY_EVIDENCE", "REFUSED"],
  ["an unsafe opportunity identity", { ...OPPORTUNITY, opportunityRef: "opp ref" },
    "FAIRNESS_CONTRACT_INVALID_IDENTITY", "OPPORTUNITY_EVIDENCE", "REFUSED"],
  ["an unsafe winner identity", { ...OPPORTUNITY, winnerWorkItemId: "" },
    "FAIRNESS_CONTRACT_INVALID_IDENTITY", "OPPORTUNITY_EVIDENCE", "REFUSED"],
  ["an unsafe observation identity", { ...OPPORTUNITY, observationRef: 7 },
    "FAIRNESS_CONTRACT_INVALID_IDENTITY", "OPPORTUNITY_EVIDENCE", "REFUSED"],
  ["an unobserved opportunity", { ...OPPORTUNITY, observationRef: null },
    "FAIRNESS_CONTRACT_OPPORTUNITY_UNOBSERVED", "OPPORTUNITY_EVIDENCE", "UNKNOWN"],
];

it("generated one attestation case per enumerated perturbation", () => {
  expect(ATTESTATION_CASES.map(([name]) => name)).toEqual([
    "a non-record", "an extra key", "an unsafe opportunity identity", "an unsafe winner identity",
    "an unsafe observation identity", "an unobserved opportunity",
  ]);
});

it.each(ATTESTATION_CASES)("refuses %s with its own code and layer",
  (_name, value, code, layer, disposition) => {
    const result = scheduler.validateOpportunityAttestation(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    const refusal: FairnessContractRefusal = result;
    const issue: FairnessContractIssue = refusal.issues[0] as FairnessContractIssue;
    const issueCode: FairnessContractIssueCode = issue.code;
    const issueLayer: FairnessContractLayer = issue.layer;
    expect([issueCode, issueLayer, refusal.disposition]).toEqual([code, layer, disposition]);
    expect(scheduler.FAIRNESS_CONTRACT_ISSUE_CODES).toContain(issueCode);
    // An UNKNOWN must name the input it is missing; a REFUSED names none.
    expect(issue.missingInput === null).toBe(disposition === "REFUSED");
  });

it("binds one admitted expansion to the core admitted facts and the hold contract", () => {
  const result: ExpansionBindingResult = scheduler.bindExpansionAdmission(bindingRequest());
  if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
  const binding: ExpansionAdmissionBinding = result.binding;
  expect(result.schedulerPreparationIdentity).toBe(admittedPreparation().identity);
  expect(binding.admitted.truthClass).toBe("DAEMON_VERIFIED");
  expect(binding.admitted.evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
  // The opportunity is the VALIDATED one, never synthesised from the work item.
  expect(binding.admitted.fairness).toEqual({
    capRevisionRef: null, opportunityRef: "opportunity.round.7", resourceId: "res.a",
    workItemId: "item.a",
  });
  expect(binding.admitted.budgetReservation.state).toBe("RESERVED");
  expect(binding.admitted.resourceReservation.state).toBe("HELD");
  expect(binding.planningHoldBinding).toEqual({
    generation: 1, goalVersion: 7, graphEpoch: 11, holdId: "hold:expansion:1",
    lifecycle: "ACTIVE", parentNodeRef: "node:parent", parentRunRef: "run:parent",
    proposalBaseHash: DIGEST_A, sourceFingerprint: DIGEST_B, truthClass: "DAEMON_VERIFIED",
    workerHandoff: { digest: DIGEST_B, ref: "handoff:worker" },
  });
  expect(Object.isFrozen(binding.admitted.fairness)).toBe(true);
});

/**
 * ONE PRODUCER, not two. The composer's `planningHoldBinding` must be the very thing the
 * standalone current-hold binder returns for the same hold and the same current authority —
 * byte for byte. A second hand-rolled projection inside the composer would drift silently,
 * and this is the assertion that would go red the moment it did.
 */
it("projects the same hold binding the standalone current-hold binder returns", () => {
  const composed = scheduler.bindExpansionAdmission(bindingRequest());
  if (!composed.ok) throw new Error(composed.issues.map((one) => one.code).join(","));
  const request: ExpansionCurrentHoldRequest = {
    currentAuthority: { ...CURRENT }, hold: activeHold(),
  };
  const direct: ExpansionCurrentHoldResult = scheduler.bindCurrentExpansionHold(request);
  if (!direct.ok) throw new Error(direct.issues.map((one) => one.code).join(","));
  const binding: PlanningExpansionHoldBinding = direct.binding;
  expect(composed.binding.planningHoldBinding).toEqual(binding);
  expect(Object.keys(composed.binding.planningHoldBinding).sort())
    .toEqual(Object.keys(binding).sort());
});

it("mints no run, child, lease, effect, slot or activation authority", () => {
  const result = scheduler.bindExpansionAdmission(bindingRequest());
  if (!result.ok) throw new Error("expected an accepted binding");
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) { keys.add(key); walk(nested); }
  };
  walk(result.binding);
  // `parentRunRef` names the PARENT work the hold was taken from. Nothing else
  // in the output matches, so no effect intent, lease or slot escaped.
  expect([...keys].filter((key) => /run|lease|effect|slot|allocation|dispatch|activat/iu.test(key)))
    .toEqual(["parentRunRef"]);
});

const BINDING_CASES: readonly (readonly [string, () => unknown, string, string, string])[] = [
  ["a non-record request", () => null, "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST", "BRIDGE"],
  ["an extra request key", () => ({ ...bindingRequest() as object, extra: 1 }),
    "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST", "BRIDGE"],
  ["a preparation carrying a getter", () => ({
    ...bindingRequest() as object,
    preparation: Object.defineProperty(
      { bound: admittedPreparation().bound }, "identity",
      { enumerable: true, get: () => admittedPreparation().identity },
    ),
  }), "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST", "BRIDGE"],
  ["a preparation whose identity does not cover its bound facts", () => ({
    ...bindingRequest() as object,
    preparation: { bound: admittedPreparation().bound, identity: DIGEST_A },
  }), "EXPANSION_BINDING_PREPARATION_IDENTITY_MISMATCH", "PREPARATION", "BRIDGE"],
  ["a preparation whose bound facts were edited under a correct identity", () => {
    const source = admittedPreparation();
    return {
      ...bindingRequest() as object,
      preparation: {
        bound: { ...source.bound, goalVersion: source.bound.goalVersion + 1 },
        identity: source.identity,
      },
    };
  }, "EXPANSION_BINDING_PREPARATION_IDENTITY_MISMATCH", "PREPARATION", "BRIDGE"],
  ["an opportunity naming a different winner",
    () => bindingRequest({ opportunity: { ...OPPORTUNITY, winnerWorkItemId: "item.b" } }),
    "EXPANSION_BINDING_OPPORTUNITY_WINNER_MISMATCH", "FAIRNESS", "BRIDGE"],
  ["a hold that is not a hold record", () => bindingRequest({ hold: { holdId: "hold:1" } }),
    "EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST", "BRIDGE"],
  ["a terminated hold", () => bindingRequest({
    hold: { ...activeHold(), lifecycle: "RESOLVED", version: 2 },
  }), "EXPANSION_BINDING_HOLD_INACTIVE", "HOLD", "BRIDGE"],
  /**
   * WHICH GATE ANSWERS, not merely that one does. Both of these would ALSO be caught by the
   * presented-versus-replayed comparison further down, with a different code — so without these
   * two cases the outer lifecycle gate's version and terminal-receipt checks could be deleted
   * and the suite would stay green. A hold that claims ACTIVE while carrying a successor
   * version, or a terminal receipt, is a lifecycle contradiction and is named as one.
   */
  ["an ACTIVE hold at a version the create reducer never mints",
    () => bindingRequest({ hold: { ...activeHold(), version: 2 } }),
    "EXPANSION_BINDING_HOLD_INACTIVE", "HOLD", "BRIDGE"],
  ["an ACTIVE hold carrying a terminal receipt", () => bindingRequest({
    hold: { ...activeHold(), terminalReceipt: { command: holdCommand() } },
  }), "EXPANSION_BINDING_HOLD_INACTIVE", "HOLD", "BRIDGE"],
  ["a current goalVersion the scheduler did not admit",
    () => bindingRequest({ currentAuthority: { ...CURRENT, goalVersion: 8 } }),
    "EXPANSION_BINDING_GOAL_VERSION_MISMATCH", "CURRENT_AUTHORITY", "BRIDGE"],
  ["a current graphEpoch the hold was not taken at",
    () => bindingRequest({ currentAuthority: { ...CURRENT, graphEpoch: 12 } }),
    "EXPANSION_BINDING_GRAPH_EPOCH_MISMATCH", "CURRENT_AUTHORITY", "BRIDGE"],
  ["a current holdId naming another hold",
    () => bindingRequest({ currentAuthority: { ...CURRENT, holdId: "hold:expansion:2" } }),
    "EXPANSION_BINDING_HOLD_ID_MISMATCH", "CURRENT_AUTHORITY", "BRIDGE"],
  ["a current holdVersion ahead of the hold",
    () => bindingRequest({ currentAuthority: { ...CURRENT, holdVersion: 2 } }),
    "EXPANSION_BINDING_HOLD_VERSION_MISMATCH", "CURRENT_AUTHORITY", "BRIDGE"],
  ["a current planningRunRef naming another run",
    () => bindingRequest({ currentAuthority: { ...CURRENT, planningRunRef: "planning:other" } }),
    "EXPANSION_BINDING_PLANNING_RUN_MISMATCH", "CURRENT_AUTHORITY", "BRIDGE"],
];

it("generated one binding case per enumerated perturbation", () => {
  expect(BINDING_CASES.length).toBe(15);
  expect([...new Set(BINDING_CASES.map(([, , code]) => code))].length).toBe(9);
});

it.each(BINDING_CASES)("refuses %s with its own code, layer and origin",
  (_name, build, code, layer, origin) => {
    const issue = onlyBindingIssue(scheduler.bindExpansionAdmission(build()));
    const issueCode: string = issue.code;
    const issueLayer: string = issue.layer;
    const issueOrigin: ExpansionBindingOrigin = issue.origin;
    expect([issueCode, issueLayer, issueOrigin]).toEqual([code, layer, origin]);
    // A LOCAL refusal invents no provenance: it names no missing input and no delegated target.
    const issueTarget: string | null = issue.target;
    expect([issue.missingInput, issueTarget]).toEqual([null, null]);
    const local: ExpansionBindingIssueCode = code as ExpansionBindingIssueCode;
    expect(scheduler.EXPANSION_BINDING_ISSUE_CODES).toContain(local);
    const known: ExpansionBindingLayer = layer as ExpansionBindingLayer;
    expect(scheduler.EXPANSION_BINDING_LAYERS).toContain(known);
    expect(scheduler.EXPANSION_BINDING_ORIGINS).toContain(issueOrigin);
  });

/**
 * THE SECOND GRAPH OPERAND, which no other case can reach.
 *
 * `graphEpoch` is compared twice for two different reasons: against the HOLD (does the daemon
 * still hold what it thinks it holds) and against the scheduler's BOUND facts (is the admission
 * still the one that was prepared). Every other epoch case perturbs the daemon's value, so the
 * hold comparison answers first and the bound comparison could be deleted unnoticed. Here the
 * hold and the daemon AGREE at epoch 12 while the preparation was bound at 11, so only the
 * second operand can refuse — and it must still speak the same code and layer.
 */
it("refuses a hold and current authority that agree at an epoch the preparation did not bind", () => {
  const issue = onlyBindingIssue(scheduler.bindExpansionAdmission(bindingRequest({
    currentAuthority: { ...CURRENT, graphEpoch: 12 }, hold: activeHold({ graphEpoch: 12 }),
  })));
  expect([issue.code, issue.layer, issue.origin, issue.target]).toEqual([
    "EXPANSION_BINDING_GRAPH_EPOCH_MISMATCH", "CURRENT_AUTHORITY", "BRIDGE", null,
  ]);
  // Not vacuous: the same pair minus the preparation disagreement binds cleanly.
  const agreed = scheduler.bindCurrentExpansionHold({
    currentAuthority: { ...CURRENT, graphEpoch: 12 }, hold: activeHold({ graphEpoch: 12 }),
  });
  expect(agreed.ok).toBe(true);
});

/**
 * COMPOUND FAULTS. A gate order is only pinned by inputs that are wrong at more than one gate at
 * once; with one fault per case any order passes. Each case below is wrong at BOTH named gates
 * and asserts which one speaks.
 */
const PRECEDENCE_CASES: readonly (readonly [string, () => unknown, string])[] = [
  ["preparation identity over a bad opportunity and a dead hold", () => ({
    ...bindingRequest() as object,
    preparation: { bound: admittedPreparation().bound, identity: DIGEST_A },
    opportunity: { ...OPPORTUNITY, winnerWorkItemId: "item.b" },
    hold: { ...activeHold(), lifecycle: "RESOLVED", version: 2 },
  }), "EXPANSION_BINDING_PREPARATION_IDENTITY_MISMATCH"],
  ["the fairness winner over a dead hold", () => bindingRequest({
    opportunity: { ...OPPORTUNITY, winnerWorkItemId: "item.b" },
    hold: { ...activeHold(), lifecycle: "RESOLVED", version: 2 },
  }), "EXPANSION_BINDING_OPPORTUNITY_WINNER_MISMATCH"],
  ["proven hold evidence over an unreadable current authority", () => bindingRequest({
    hold: { ...activeHold(), lifecycle: "RESOLVED", version: 2 }, currentAuthority: null,
  }), "EXPANSION_BINDING_HOLD_INACTIVE"],
  /**
   * The one order this refactor CHANGED, pinned deliberately rather than left to drift: the
   * hold-backed comparisons now run inside `bindCurrentExpansionHold`, which is called before
   * the admission-only goalVersion fence. A compound goalVersion+holdId fault is therefore
   * answered by the hold-backed code. Isolated faults are unaffected.
   */
  ["a hold-backed mismatch over the admitted goal version", () => bindingRequest({
    currentAuthority: { ...CURRENT, goalVersion: 8, holdId: "hold:expansion:2" },
  }), "EXPANSION_BINDING_HOLD_ID_MISMATCH"],
];

it("generated one precedence case per compound-fault pair", () => {
  expect(PRECEDENCE_CASES.length).toBe(4);
  expect([...new Set(PRECEDENCE_CASES.map(([, , code]) => code))].length).toBe(4);
});

it.each(PRECEDENCE_CASES)("answers with %s", (_name, build, code) => {
  expect(onlyBindingIssue(scheduler.bindExpansionAdmission(build())).code).toBe(code);
});

const AUTHORITY_FIELDS: readonly string[] =
  ["goalVersion", "graphEpoch", "holdId", "holdVersion", "planningRunRef"];

it("generated one missing-authority case per current authority field", () => {
  expect(AUTHORITY_FIELDS.length).toBe(5);
});

it.each(AUTHORITY_FIELDS)("holds current authority UNKNOWN when %s is absent", (field) => {
  const current: Record<string, unknown> = { ...CURRENT };
  delete current[field];
  const result = scheduler.bindExpansionAdmission(bindingRequest({ currentAuthority: current }));
  const issue = onlyBindingIssue(result);
  if (result.ok) throw new Error("expected a refusal");
  // UNKNOWN, never REFUSED: the daemon supplied no authority to compare against,
  // which is the absence of a verdict rather than a verdict of mismatch.
  expect([result.disposition, issue.code, issue.layer, issue.missingInput, issue.target]).toEqual([
    "UNKNOWN", "EXPANSION_BINDING_CURRENT_AUTHORITY_UNKNOWN", "CURRENT_AUTHORITY",
    "currentAuthority", null,
  ]);
});

it("delegates an unobserved opportunity to the fairness layer verbatim", () => {
  const raw = { ...OPPORTUNITY, observationRef: null };
  const direct = scheduler.validateOpportunityAttestation(raw);
  expect(direct.ok).toBe(false);
  if (direct.ok) throw new Error("expected a refusal");
  const result = scheduler.bindExpansionAdmission(bindingRequest({ opportunity: raw }));
  const issue = onlyBindingIssue(result);
  if (result.ok) throw new Error("expected a refusal");
  // Compared against what the fairness surface says when called DIRECTLY, so a
  // re-coded delegation cannot pass by matching a literal transcribed twice.
  expect([issue.code, issue.layer, issue.origin, result.disposition, issue.missingInput]).toEqual([
    direct.issues[0]?.code, direct.issues[0]?.layer, "FAIRNESS", direct.disposition,
    direct.issues[0]?.missingInput,
  ]);
  // The fairness contract names no planning-expansion target, so none may be invented for it.
  expect(issue.target).toBe(null);
  expect(issue.code).toBe("FAIRNESS_CONTRACT_OPPORTUNITY_UNOBSERVED");
});

it("delegates a hold the core reducer refuses, keeping the reducer's code and layer", () => {
  const command = holdCommand();
  const release = command["release"] as Record<string, unknown>;
  const creation = { ...command, release: { ...release, safeBoundaryObserved: false } };
  const hold = { ...activeHold(), creationReceipt: { command: creation } };
  const direct = reduceExpansionPlanningHold(undefined, creation);
  expect(direct.ok).toBe(false);
  if (direct.ok) throw new Error("expected a refusal");
  const issue = onlyBindingIssue(scheduler.bindExpansionAdmission(bindingRequest({ hold })));
  expect([issue.code, issue.layer, issue.origin, issue.target])
    .toEqual([direct.code, direct.layer, "EXPANSION_HOLD", null]);
  expect(issue.code).toBe("EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN");
});

/**
 * The derived hold binding is not asserted, it is RE-INSPECTED by core's own
 * predicate. `goalVersion` 0 is a legal scheduler count and an illegal planning
 * binding version, so this is the one input that separates "the bridge built a
 * binding" from "core accepts the binding the bridge built".
 */
it("delegates a derived hold binding core refuses, keeping core's code and layer", () => {
  const request = bindingRequest({
    currentAuthority: { ...CURRENT, goalVersion: 0 },
    preparation: (() => {
      const result = scheduler.admitExpansion({
        ...admissionRequest(), receipt: { ...healthyReceipt(), goalVersion: 0 },
      });
      if (!result.ok) throw new Error(result.issues.map((one) => one.code).join(","));
      return result.preparation;
    })(),
  });
  const issue = onlyBindingIssue(scheduler.bindExpansionAdmission(request));
  // The inspector's own `target` is carried through the composer verbatim, so a consumer
  // can tell WHICH planning contract refused without re-deriving it from the code.
  expect([issue.code, issue.layer, issue.origin, issue.target])
    .toEqual(["PLANNING_EXPANSION_HOLD_BINDING_INVALID", "BINDING", "PLANNING_CONTRACT",
      "HOLD_BINDING"]);
  // The same predicate, called directly, agrees — so the refusal came from the
  // binding check and not from the inspector's target dispatch.
  expect(validExpansionHoldBinding({ generation: 1, goalVersion: 0 })).toBe(false);
});

/**
 * A TERMINATED hold that has been laundered back to ACTIVE carries no in-band
 * evidence of its own termination: strip the terminal receipt and the value is
 * byte-identical to what the reducer produces for a live hold, so replaying its
 * creation command reconstructs it happily. The DAEMON'S CURRENT HOLD VERSION is
 * what catches it — which is precisely why that comparison is a required input
 * rather than an optional one, and why this test asserts both halves.
 */
it("catches a terminated hold laundered back to ACTIVE, by the daemon's current version", () => {
  const active = activeHold();
  const terminated = reduceExpansionPlanningHold(active, {
    cause: "EXPANSION_REFUSED", commandId: "command:end", expectedVersion: 1,
    generation: active.generation, graphEpoch: active.graphEpoch, holdId: active.holdId,
    kind: "expansion.transition_hold", parentNodeRef: active.parentNodeRef,
    parentRevisionRef: active.parentRevisionRef, parentRunRef: active.parentRunRef,
    planningRunRef: active.planningRunRef, proposalBaseHash: active.proposalBaseHash,
    sourceFingerprint: active.sourceFingerprint, targetLifecycle: "RESOLVED",
    terminalProof: {
      authorityState: "TERMINAL", decisionRef: "decision:1", successorHoldRef: null,
      truthClass: "DAEMON_VERIFIED",
    },
  });
  if (!terminated.ok) throw new Error(`could not terminate: ${terminated.code}`);
  // Presented honestly, the terminal receipt is visible and the outer gate answers.
  const honest = onlyBindingIssue(
    scheduler.bindExpansionAdmission(bindingRequest({ hold: terminated.state })),
  );
  expect([honest.code, honest.layer]).toEqual(["EXPANSION_BINDING_HOLD_INACTIVE", "HOLD"]);
  const laundered = { ...terminated.state, lifecycle: "ACTIVE", version: 1, terminalReceipt: null };
  const issue = onlyBindingIssue(scheduler.bindExpansionAdmission(bindingRequest({
    currentAuthority: { ...CURRENT, holdVersion: 2 }, hold: laundered,
  })));
  expect([issue.code, issue.layer])
    .toEqual(["EXPANSION_BINDING_HOLD_VERSION_MISMATCH", "CURRENT_AUTHORITY"]);
});

/**
 * A LEAF THE IDENTITY HASH CANNOT SPEAK.
 *
 * `digestOf` is `JSON.stringify`: it THROWS on a BigInt and on a cycle, and it silently DROPS a
 * symbol, a function and an `undefined`. Either way an unchecked bound leaf defeats the identity
 * check — the first escapes the bridge as a raw `TypeError` (no code, no layer, nothing a caller
 * can fail closed on), the second vanishes from the very bytes the identity is supposed to cover.
 * Every leaf is therefore proven to be a string, a safe count or an explicit null BEFORE anything
 * hashes it, and the answer is the bridge's own REQUEST code rather than an identity verdict: a
 * value that cannot be canonicalised was never comparable in the first place.
 */
function boundOf(): Record<string, unknown> {
  return { ...admittedPreparation().bound } as unknown as Record<string, unknown>;
}

function nested(bound: Record<string, unknown>, key: string): Record<string, unknown> {
  return { ...(bound[key] as Record<string, unknown>) };
}

const HOSTILE_BOUND_LEAVES: readonly (readonly [string, () => Record<string, unknown>])[] = [
  ["a BigInt proposalId", () => ({ ...boundOf(), proposalId: 10n })],
  ["a BigInt budget line quantity", () => {
    const bound = boundOf(); const budget = nested(bound, "budgetReservation");
    const lines = budget["lines"] as readonly Record<string, unknown>[];
    return { ...bound, budgetReservation: { ...budget, lines: [{ ...lines[0], quantity: 1n }] } };
  }],
  ["a BigInt capacity unit", () => {
    const bound = boundOf();
    const rows = bound["capacitySnapshot"] as readonly Record<string, unknown>[];
    return { ...bound, capacitySnapshot: [{ ...rows[0], capacityUnits: 4n }] };
  }],
  ["a symbol fairness disposition", () => {
    const bound = boundOf();
    return {
      ...bound, fairness: { ...nested(bound, "fairness"), disposition: Symbol("SELECTED") },
    };
  }],
  ["an undefined provenBypasses", () => ({ ...boundOf(), provenBypasses: undefined })],
  ["a function qualityDigest", () => ({ ...boundOf(), qualityDigest: () => DIGEST_A })],
  ["a self-referential lineage depth", () => {
    const bound = boundOf(); const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    return { ...bound, lineage: { ...nested(bound, "lineage"), expansionDepth: cycle } };
  }],
  ["an evidenceDigest whose toJSON throws", () => ({
    ...boundOf(), evidenceDigest: { toJSON: (): never => { throw new Error("hostile leaf"); } },
  })],
  ["a negative revision", () => ({ ...boundOf(), revision: -1 })],
  ["a non-hex qualityDigest", () => ({ ...boundOf(), qualityDigest: "not a digest" })],
];

it("generated one hostile-leaf case per enumerated bound leaf", () => {
  expect(HOSTILE_BOUND_LEAVES.length).toBe(10);
  expect(HOSTILE_BOUND_LEAVES.map(([name]) => name)).toEqual([
    "a BigInt proposalId", "a BigInt budget line quantity", "a BigInt capacity unit",
    "a symbol fairness disposition", "an undefined provenBypasses", "a function qualityDigest",
    "a self-referential lineage depth", "an evidenceDigest whose toJSON throws",
    "a negative revision", "a non-hex qualityDigest",
  ]);
});

it.each(HOSTILE_BOUND_LEAVES)("contains %s as a stable refusal, never a thrown error",
  (_name, build) => {
    const request = bindingRequest({
      preparation: { bound: build(), identity: admittedPreparation().identity },
    });
    expect(() => scheduler.bindExpansionAdmission(request)).not.toThrow();
    const issue = onlyBindingIssue(scheduler.bindExpansionAdmission(request));
    expect([issue.code, issue.layer, issue.origin])
      .toEqual(["EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST", "BRIDGE"]);
  });

/**
 * THE PRESENTED HOLD IS NOT THE REPLAYED ONE.
 *
 * Replaying the creation command proves an ACTIVE hold CAN exist; it proves nothing about the
 * value actually presented. Binding the replayed state and discarding the presented bytes reads
 * as safe — the output is reducer-produced either way — but it means a forged field is accepted
 * in silence, and every later reader believes the daemon verified the value it was handed. So
 * the presented hold must EQUAL the state its own command produces, field for field and nested
 * value for nested value, before any byte of it is bound.
 */
const FORGED_HOLD_FIELDS:
  readonly (readonly [string, (hold: ExpansionPlanningHoldState) => unknown])[] = [
    ["deadline", (hold) => hold.deadline + 1],
    ["generation", (hold) => hold.generation + 1],
    ["graphEpoch", (hold) => hold.graphEpoch + 1],
    ["holdId", () => "hold:forged"],
    ["holdKind", () => "EXPANSION_PLANNING_FORGED"],
    ["parentNodeRef", () => "node:forged"],
    ["parentRevisionRef", () => "revision:forged"],
    ["parentRunRef", () => "run:forged"],
    ["planningRunRef", () => "planning:forged"],
    ["proposalBaseHash", () => DIGEST_B],
    ["rationale", (hold) => ({ ...hold.rationale, text: "forged rationale" })],
    ["release", (hold) => ({ ...hold.release, receiptRef: "receipt:forged" })],
    ["sourceFingerprint", () => DIGEST_A],
    ["workerHandoff", (hold) => ({ ...hold.workerHandoff, ref: "handoff:forged" })],
  ];

/**
 * The universe is the REDUCER'S own state keys, read from a live hold rather than transcribed,
 * minus the four an earlier gate already answers: the three the outer lifecycle gate refuses,
 * and the creation receipt, which is the command being replayed rather than a replayed field.
 */
it("generated one forged-hold case per hold field no earlier gate answers", () => {
  expect(FORGED_HOLD_FIELDS.length).toBe(14);
  const answeredEarlier = ["creationReceipt", "lifecycle", "terminalReceipt", "version"];
  expect([...FORGED_HOLD_FIELDS.map(([field]) => field), ...answeredEarlier].sort())
    .toEqual(Object.keys(activeHold()).sort());
});

it.each(FORGED_HOLD_FIELDS)("refuses a presented hold whose %s was forged", (field, forge) => {
  const honest = activeHold();
  const forged = forge(honest);
  // Not vacuous: the presented byte really differs from the one the reducer produces.
  expect(forged).not.toEqual((honest as unknown as Record<string, unknown>)[field]);
  const issue = onlyBindingIssue(
    scheduler.bindExpansionAdmission(bindingRequest({ hold: { ...honest, [field]: forged } })),
  );
  expect([issue.code, issue.layer, issue.origin, issue.target])
    .toEqual(["EXPANSION_BINDING_HOLD_STATE_MISMATCH", "HOLD", "BRIDGE", null]);
});

it("refuses a presented hold whose nested handoff hides behind an accessor", () => {
  const honest = activeHold();
  const workerHandoff = Object.defineProperty(
    { digest: honest.workerHandoff.digest }, "ref",
    { configurable: true, enumerable: true, get: () => honest.workerHandoff.ref },
  );
  const issue = onlyBindingIssue(
    scheduler.bindExpansionAdmission(bindingRequest({ hold: { ...honest, workerHandoff } })),
  );
  expect([issue.code, issue.layer, issue.origin, issue.target])
    .toEqual(["EXPANSION_BINDING_HOLD_STATE_MISMATCH", "HOLD", "BRIDGE", null]);
});

it("refuses a presented hold carrying an extra nested key", () => {
  const honest = activeHold();
  const release = { ...honest.release, extra: 1 };
  const issue = onlyBindingIssue(
    scheduler.bindExpansionAdmission(bindingRequest({ hold: { ...honest, release } })),
  );
  expect([issue.code, issue.layer, issue.origin, issue.target])
    .toEqual(["EXPANSION_BINDING_HOLD_STATE_MISMATCH", "HOLD", "BRIDGE", null]);
});

it("refuses a presented hold whose nested terminal effect list grew an entry", () => {
  const honest = activeHold();
  const release = {
    ...honest.release,
    terminalEffectRefs: [...honest.release.terminalEffectRefs, "effect:forged"],
  };
  const issue = onlyBindingIssue(
    scheduler.bindExpansionAdmission(bindingRequest({ hold: { ...honest, release } })),
  );
  expect([issue.code, issue.layer, issue.origin, issue.target])
    .toEqual(["EXPANSION_BINDING_HOLD_STATE_MISMATCH", "HOLD", "BRIDGE", null]);
});

/**
 * Usage-measurement semantics driven entirely through the bare package root.
 *
 * Every call below goes through `scheduler.normalizeUsageMeasurement` — this file holds no deep
 * import into ./budget/ — so a root that re-exported a stub rather than the production authority
 * would keep these green only until the mutation drill runs. The exact code/layer pairs are
 * transcribed from budget-measurement.test.ts, never re-derived here.
 */
const MEASURED_INTERVAL: ObservedIntervalRefs = { startRef: "event:1", endRef: "event:2" };
const COMPLETE_MEASUREMENT: UsageMeasurementRecord = {
  meter: "runner.authorized_ms", quantity: 1200,
  coverage: "COMPLETE" satisfies BudgetMeasurementCoverage,
  source: "PROVIDER_REPORTED_COMPLETE" satisfies BudgetMeasurementSource,
  providerRunRef: "run:abc", sourceParserVersion: 2, sequence: 7, rawReceiptDigest: DIGEST,
  observedInterval: MEASURED_INTERVAL,
};
const LIST_PRICE_BINDING: PricebookBinding = {
  pricebookRevisionRef: "pricebook:rev-9", unitPriceMicros: 2500, pricedAtRef: "event:1",
};
interface UsageEnvelope {
  readonly pricebookBinding?: PricebookBinding | null;
  readonly truncated?: boolean;
}
function usageObservation(
  overrides: Partial<UsageMeasurementRecord> = {}, envelope: UsageEnvelope = {},
): unknown {
  return {
    measurement: { ...COMPLETE_MEASUREMENT, ...overrides },
    pricebookBinding: envelope.pricebookBinding ?? null,
    truncated: envelope.truncated ?? false,
  };
}
/**
 * Narrows LayeredIssue on its `layer` discriminant. The arms carry different closed code
 * vocabularies, so this reads the code AND proves at typecheck time that the root published
 * enough of the closure to keep CONTRACT and MEASUREMENT codes distinguishable.
 */
function layeredCode(issue: LayeredIssue): BudgetIssueCode | MeasurementIssueCode {
  if (issue.layer === "CONTRACT") {
    const contractCode: BudgetIssueCode = issue.code;
    return contractCode;
  }
  const measurementCode: MeasurementIssueCode = issue.code;
  return measurementCode;
}
function normalizeAtRoot(
  input: unknown, prior?: NormalizedMeasurement | null,
): MeasurementResult<NormalizedMeasurement> {
  return scheduler.normalizeUsageMeasurement(input, prior);
}
function acceptedAtRoot(result: MeasurementResult<NormalizedMeasurement>): NormalizedMeasurement {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`root normalizer refused: ${JSON.stringify(result.issues)}`);
  return result.record;
}
function refusedAtRoot(
  result: MeasurementResult<NormalizedMeasurement>,
  layer: MeasurementIssueLayer, code: BudgetIssueCode | MeasurementIssueCode,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("root normalizer accepted what the authority must refuse");
  expect(result.issues.map((issue: LayeredIssue) => `${issue.layer}:${layeredCode(issue)}`))
    .toContain(`${layer}:${code}`);
}

it("accepts an UNKNOWN-coverage observation through the root and keeps its quantity null", () => {
  const record = acceptedAtRoot(
    normalizeAtRoot(usageObservation({ coverage: "UNKNOWN", source: "UNKNOWN", quantity: null })),
  );
  expect(record.measurement.coverage).toBe("UNKNOWN");
  expect(record.measurement.quantity).toBeNull();
  expect(record.measurement.observedInterval).toStrictEqual(MEASURED_INTERVAL);
  expect(record.pricebookBinding).toBeNull();
});

it("refuses at the CONTRACT layer when an UNKNOWN-coverage observation carries a quantity", () => {
  for (const quantity of [0, 1200]) {
    refusedAtRoot(
      normalizeAtRoot(usageObservation({ coverage: "UNKNOWN", source: "UNKNOWN", quantity })),
      "CONTRACT", "BUDGET_MEASUREMENT_COVERAGE_QUANTITY_MISMATCH",
    );
  }
});

it("keeps a PARTIAL observation an exact lower bound rather than promoting it", () => {
  for (const quantity of [0, 5]) {
    const record = acceptedAtRoot(normalizeAtRoot(usageObservation(
      { coverage: "PARTIAL", source: "PROVIDER_REPORTED_PARTIAL", quantity },
    )));
    expect(record.measurement.quantity).toBe(quantity);
    expect(record.measurement.coverage).toBe("PARTIAL");
  }
});

it("refuses at the MEASUREMENT layer when a source claims a coverage outside the matrix", () => {
  refusedAtRoot(
    normalizeAtRoot(usageObservation(
      { coverage: "UNKNOWN", source: "PROVIDER_REPORTED_COMPLETE", quantity: null },
    )),
    "MEASUREMENT", "BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH",
  );
  refusedAtRoot(
    normalizeAtRoot(usageObservation({ coverage: "COMPLETE", source: "UNKNOWN" })),
    "MEASUREMENT", "BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH",
  );
});

it("sweeps the root vocabularies over the full source-by-coverage matrix", () => {
  expect(scheduler.BUDGET_MEASUREMENT_SOURCES.length).toBe(6);
  expect(scheduler.BUDGET_MEASUREMENT_COVERAGES.length).toBe(3);
  const CONSISTENT = new Set([
    "PROVIDER_REPORTED_COMPLETE|COMPLETE", "PROVIDER_REPORTED_PARTIAL|PARTIAL",
    "DERIVED_LIST_PRICE|COMPLETE", "DERIVED_LIST_PRICE|PARTIAL", "SUBSCRIPTION_QUOTA|COMPLETE",
    "SUBSCRIPTION_QUOTA|PARTIAL", "ACTUAL_BILLED|COMPLETE", "ACTUAL_BILLED|PARTIAL",
    "UNKNOWN|UNKNOWN",
  ]);
  let ran = 0;
  let accepts = 0;
  let refusals = 0;
  for (const source of scheduler.BUDGET_MEASUREMENT_SOURCES) {
    for (const coverage of scheduler.BUDGET_MEASUREMENT_COVERAGES) {
      ran += 1;
      const candidate = usageObservation(
        { source, coverage, quantity: coverage === "UNKNOWN" ? null : 3 },
        { pricebookBinding: source === "DERIVED_LIST_PRICE" ? LIST_PRICE_BINDING : null },
      );
      if (CONSISTENT.has(`${source}|${coverage}`)) {
        acceptedAtRoot(normalizeAtRoot(candidate));
        accepts += 1;
      } else {
        refusedAtRoot(normalizeAtRoot(candidate),
          "MEASUREMENT", "BUDGET_OBSERVATION_SOURCE_COVERAGE_MISMATCH");
        refusals += 1;
      }
    }
  }
  expect(ran).toBe(18);
  expect([accepts, refusals]).toStrictEqual([9, 9]);
});

it("never lets a truncated receipt claim COMPLETE coverage through the root", () => {
  refusedAtRoot(normalizeAtRoot(usageObservation({}, { truncated: true })),
    "MEASUREMENT", "BUDGET_OBSERVATION_TRUNCATED_COMPLETION_CLAIM");
  const partial = acceptedAtRoot(normalizeAtRoot(usageObservation(
    { coverage: "PARTIAL", source: "PROVIDER_REPORTED_PARTIAL" }, { truncated: true },
  )));
  expect(partial.truncated).toBe(true);
});

it("separates a malformed envelope from a malformed measurement by refusing layer", () => {
  const hostile: readonly unknown[] = [undefined, new Proxy({ ...COMPLETE_MEASUREMENT }, {}), {
    measurement: { ...COMPLETE_MEASUREMENT }, pricebookBinding: null, truncated: false, extra: 1,
  }];
  expect(hostile.length).toBe(3);
  for (const envelope of hostile) {
    refusedAtRoot(normalizeAtRoot(envelope), "MEASUREMENT", "BUDGET_OBSERVATION_MALFORMED");
  }
  refusedAtRoot(
    normalizeAtRoot({
      measurement: new Proxy({ ...COMPLETE_MEASUREMENT }, {}),
      pricebookBinding: null, truncated: false,
    }),
    "CONTRACT", "BUDGET_MEASUREMENT_MALFORMED",
  );
  refusedAtRoot(normalizeAtRoot(usageObservation({ rawReceiptDigest: "ab" })),
    "CONTRACT", "BUDGET_MEASUREMENT_FIELD_INVALID");
});

it("refuses a derived price without a binding and an undeclared binding on a billed source", () => {
  refusedAtRoot(
    normalizeAtRoot(usageObservation({ source: "DERIVED_LIST_PRICE" }, { pricebookBinding: null })),
    "MEASUREMENT", "BUDGET_OBSERVATION_PRICEBOOK_BINDING_INVALID",
  );
  refusedAtRoot(
    normalizeAtRoot(usageObservation({ source: "ACTUAL_BILLED" },
      { pricebookBinding: LIST_PRICE_BINDING })),
    "MEASUREMENT", "BUDGET_OBSERVATION_UNCORRELATED_BILLING_CLAIM",
  );
});

it("treats a same-identity same-bytes redelivery as a deterministic no-op at the root", () => {
  const prior: NormalizedMeasurement = acceptedAtRoot(normalizeAtRoot(usageObservation()));
  expect(acceptedAtRoot(normalizeAtRoot(usageObservation(), prior))).toBe(prior);
  expect(acceptedAtRoot(normalizeAtRoot(usageObservation({ sequence: 8 }), prior))
    .measurement.sequence).toBe(8);
  refusedAtRoot(normalizeAtRoot(usageObservation({ sequence: 10 }), prior),
    "MEASUREMENT", "BUDGET_OBSERVATION_SEQUENCE_GAP");
});

/**
 * The design-765 release authority, reached through the bare package root. Same
 * rule as the fairness and expansion blocks: `releaseWork` is the only runtime
 * value, so its four types are proven by ANNOTATION on values that came through
 * `@moe/scheduler` — a type published nowhere becomes a tsc error rather than a
 * silently green test.
 */
const RELEASE_HANDOFF: ReleaseHandoff = {
  completedSteps: ["step:1"], activeProcessResourceFacts: [],
  inputDigest: DIGEST, worktreeDigest: DIGEST, contextDigest: DIGEST, journalDigest: DIGEST,
  artifactDigest: DIGEST, nextSafeAction: "action:resume", truthClass: "DAEMON_VERIFIED",
};
const RELEASE_REQUEST: ReleaseRequest = {
  reason: "WORK_RELEASE_OR_PAUSE", safeBoundaryObserved: true, effectsTerminal: true,
  resourcesTerminal: true, handoff: RELEASE_HANDOFF, intentRefs: ["intent:1"], disposition: null,
};

function releasedAtRoot(outcome: AuthorityOutcome<ReleaseResult>): ReleaseResult {
  if (!outcome.ok) throw new Error(authorityCodes(outcome).join(","));
  return outcome.value;
}

it("composes a RELEASED lease through the root release authority", () => {
  const result: ReleaseResult = releasedAtRoot(scheduler.releaseWork(LEASE, PROOF, RELEASE_REQUEST));
  if (result.outcome !== "RELEASED") throw new Error(`expected RELEASED, got ${result.outcome}`);
  const lease: LeaseRecord = result.lease;
  const disposition: DrainDisposition = result.disposition;
  const handoff: ReleaseHandoff = result.handoff;
  // The kernel decides the state and bumps the version; the caller supplied neither.
  expect([lease.state, lease.version, LEASE.version]).toEqual(["RELEASED", 8, 7]);
  expect([disposition.strongestReason, disposition.terminalTarget, disposition.resumable])
    .toEqual(["WORK_RELEASE_OR_PAUSE", "RELEASED", true]);
  expect([result.resumable, result.releasePending]).toEqual([true, false]);
  expect(handoff.nextSafeAction).toBe("action:resume");
});

it("keeps DRAINING a separate root outcome for every unsettled boundary flag", () => {
  const flags = ["safeBoundaryObserved", "effectsTerminal", "resourcesTerminal"] as const;
  let driven = 0;
  for (const flag of flags) {
    const result = releasedAtRoot(
      scheduler.releaseWork(LEASE, PROOF, { ...RELEASE_REQUEST, [flag]: false }));
    if (result.outcome !== "DRAINING") throw new Error(`${flag} did not drain`);
    expect([result.lease.state, result.resumable, result.releasePending])
      .toEqual(["DRAINING", false, true]);
    expect(result.intentRefs).toEqual(["intent:1"]);
    driven += 1;
  }
  // A sweep that generated nothing would pass every assertion above vacuously.
  expect(driven).toBe(3);
});

it("answers NO_OP for a lease the root release authority already terminated", () => {
  for (const state of ["RELEASED", "REVOKED"] as const) {
    const result = releasedAtRoot(
      scheduler.releaseWork({ ...LEASE, state }, PROOF, RELEASE_REQUEST));
    expect(result.outcome).toBe("NO_OP");
    // Idempotent, not a second transition: the version is untouched.
    expect([result.lease.state, result.lease.version]).toEqual([state, 7]);
  }
});

it("refuses a malformed release request and an uncommittable handoff from the root", () => {
  expect(authorityCodes(scheduler.releaseWork(LEASE, PROOF, { ...RELEASE_REQUEST, intentRefs: null })))
    .toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  expect(authorityCodes(scheduler.releaseWork(LEASE, PROOF, { ...RELEASE_REQUEST, handoff: null })))
    .toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  // A stale proof is fenced BEFORE any transition is composed, under its own code.
  expect(authorityCodes(scheduler.releaseWork(LEASE, { ...PROOF, epoch: 2 }, RELEASE_REQUEST)))
    .toEqual(["AUTHORITY_STALE_EPOCH"]);
});

it("publishes the measurement vocabularies as frozen non-empty closed sets", () => {
  expect(scheduler.MEASUREMENT_ISSUE_CODES.length).toBe(10);
  expect(scheduler.MEASUREMENT_ISSUE_LAYERS).toStrictEqual(["CONTRACT", "MEASUREMENT"]);
  expect(scheduler.SUPPORTED_SOURCE_PARSER_VERSIONS).toStrictEqual([1, 2]);
  expect(scheduler.BUDGET_ISSUE_CODES.length).toBeGreaterThan(0);
  const contract = new Set<string>(scheduler.BUDGET_ISSUE_CODES);
  for (const code of scheduler.MEASUREMENT_ISSUE_CODES) expect(contract.has(code)).toBe(false);
  for (const frozen of [scheduler.MEASUREMENT_ISSUE_CODES, scheduler.MEASUREMENT_ISSUE_LAYERS,
    scheduler.SUPPORTED_SOURCE_PARSER_VERSIONS, scheduler.BUDGET_ISSUE_CODES,
    scheduler.BUDGET_MEASUREMENT_COVERAGES, scheduler.BUDGET_MEASUREMENT_SOURCES]) {
    expect(Object.isFrozen(frozen)).toBe(true);
  }
});

/**
 * The conserved budget ledger, reached only through the bare package root. Each published TYPE
 * below is invisible to the count and namespace guards above — a type publishes no runtime key —
 * so every one is proven by annotating a value the root transitions produce or consume. An
 * unpublished type becomes a tsc error here rather than a silently green test.
 */
const LEDGER_ATTEMPTS = "attempt.count";
const LEDGER_MS = "runner.authorized_ms";
const LEDGER_ROOT = "account:budget-root";
const LEDGER_CHILD = "account:budget-child";
const AUTHORIZED: readonly BudgetMeterAmount[] = [
  { meter: LEDGER_ATTEMPTS, amount: 10 }, { meter: LEDGER_MS, amount: 1000 },
];
const AUTHORIZATION: BudgetAuthorization = {
  rootAccountId: LEDGER_ROOT, ownerRef: "goal:1", graphRevisionRef: "graph:rev-1",
  amounts: AUTHORIZED,
};
const MOVE: BudgetMovementCommand = {
  parentAccountId: LEDGER_ROOT, childAccountId: LEDGER_CHILD, childOwnerRef: "node:1",
  expectedParentVersion: 0, expectedChildVersion: null,
  amounts: [{ meter: LEDGER_ATTEMPTS, amount: 4 }],
};
const zero = (meter: string, available: number): BudgetMeterBuckets =>
  ({ meter, available, reserved: 0, quarantined: 0, committed: 0 });

/** Names both arms of BudgetLedgerResult without any deep import. */
function ledgerState(result: BudgetLedgerResult): BudgetLedgerState {
  if (!result.ok) {
    throw new Error(result.issues.map((issue: BudgetAccountIssue) => issue.code).join(","));
  }
  return result.state;
}
function ledgerCodes(result: BudgetLedgerResult): readonly BudgetAccountIssueCode[] {
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  return result.issues.map((issue: BudgetAccountIssue) => issue.code);
}
const accountOf = (state: BudgetLedgerState, id: string): BudgetAccountRecord | undefined =>
  state.accounts.find((record: BudgetAccountRecord) => record.accountId === id);

it("opens, funds, drains and closes a conserved account through the root exports", () => {
  const opened: BudgetLedgerState = ledgerState(scheduler.openBudgetRoot(AUTHORIZATION));
  const first: BudgetLedgerEntry | undefined = opened.entries[0];
  const kind: BudgetLedgerEntryKind | undefined = first?.kind;
  expect(kind).toBe("ROOT_OPENED");
  expect(accountOf(opened, LEDGER_ROOT)?.meters)
    .toEqual([zero(LEDGER_ATTEMPTS, 10), zero(LEDGER_MS, 1000)]);

  // Real movement: exactly four attempt units leave the root and the sibling meter is untouched.
  const funded: BudgetLedgerState = ledgerState(scheduler.allocateToChild(opened, MOVE));
  const child: BudgetAccountRecord | undefined = accountOf(funded, LEDGER_CHILD);
  expect([child?.parentRef, child?.version, child?.state]).toEqual([LEDGER_ROOT, 0, "OPEN"]);
  expect(child?.meters).toEqual([zero(LEDGER_ATTEMPTS, 4)]);
  expect(accountOf(funded, LEDGER_ROOT)?.meters)
    .toEqual([zero(LEDGER_ATTEMPTS, 6), zero(LEDGER_MS, 1000)]);
  // The published roll-up, so a consumer never re-derives the subtree aggregation itself.
  const totals: readonly BudgetMeterAmount[] = scheduler.deriveSubtreeTotals(funded);
  expect([...totals]).toEqual([...AUTHORIZED]);

  const returned: BudgetLedgerState = ledgerState(scheduler.returnToParent(funded,
    { ...MOVE, expectedParentVersion: 1, expectedChildVersion: 0 }));
  expect(accountOf(returned, LEDGER_CHILD)?.meters).toEqual([zero(LEDGER_ATTEMPTS, 0)]);
  const close: BudgetCloseCommand = { accountId: LEDGER_CHILD, expectedVersion: 1 };
  const closed: BudgetLedgerState = ledgerState(scheduler.closeBudgetAccount(returned, close));
  expect(accountOf(closed, LEDGER_CHILD)?.state).toBe("CLOSED");
  // The recorded stream folds back to the same state through the same published core. Every
  // Movement commands in this walk touched one meter each. The root authorization is one
  // two-meter command, so its opening delta must stay grouped at that command boundary.
  expect(ledgerState(scheduler.replayBudgetLedger(AUTHORIZATION,
    [closed.entries.slice(0, AUTHORIZED.length),
      ...closed.entries.slice(AUTHORIZED.length).map((entry) => [entry])]))).toEqual(closed);
});

it("refuses a stale parent version from the root with BUDGET_ACCOUNT_STALE_VERSION", () => {
  const opened = ledgerState(scheduler.openBudgetRoot(AUTHORIZATION));
  // Duplicate-identity, unknown-account and counter-exhaustion all sit ABOVE the version fence
  // in allocateToChild, so a single-element array names the guard that ANSWERED rather than
  // merely recording that the move did not land.
  expect(ledgerCodes(scheduler.allocateToChild(opened, { ...MOVE, expectedParentVersion: 7 })))
    .toEqual(["BUDGET_ACCOUNT_STALE_VERSION"]);
  // An absent child on the return arm is answered by a DIFFERENT published code, so the
  // assertion above is not satisfied by a surface that answers one code for everything.
  expect(ledgerCodes(scheduler.returnToParent(opened, { ...MOVE, expectedChildVersion: 0 })))
    .toEqual(["BUDGET_ACCOUNT_UNKNOWN_ACCOUNT"]);
  expect(accountOf(opened, LEDGER_ROOT)?.version).toBe(0);
  expect(scheduler.MAX_BUDGET_VERSION).toBe(Number.MAX_SAFE_INTEGER - 1_000_000);
  expect([...scheduler.BUDGET_ACCOUNT_ISSUE_CODES]).toStrictEqual([
    "BUDGET_ACCOUNT_COMMAND_MALFORMED", "BUDGET_ACCOUNT_COUNTER_EXHAUSTED",
    "BUDGET_ACCOUNT_DUPLICATE_IDENTITY", "BUDGET_ACCOUNT_ILLEGAL_CLOSE",
    "BUDGET_ACCOUNT_INSUFFICIENT_AVAILABLE", "BUDGET_ACCOUNT_PARENT_MISMATCH",
    "BUDGET_ACCOUNT_STALE_VERSION", "BUDGET_ACCOUNT_UNKNOWN_ACCOUNT",
    "BUDGET_ACCOUNT_UNKNOWN_METER",
  ]);
});

/** The settlement view is sized so the whole admission is reserved and AVAILABLE reaches zero,
 * which is what `closeSettledView` requires — a hand-set view would not prove the chain. */
const SETTLE_VIEW: BudgetAvailableView = {
  accountId: "account:settle", state: "OPEN", version: 4, meters: [zero("usd", 10)],
};
const SETTLE_ADMISSION: AdmissionRequest = {
  admissionRef: "admission:settle", expectedVersion: 4, amounts: LINES,
};
function settlementOf(result: BudgetSettlementResult): SettlementRecord {
  if (!result.ok || result.settlement === null) {
    throw new Error(result.ok ? "no settlement"
      : result.issues.map((issue: BudgetSettlementIssue) => issue.code).join(","));
  }
  return result.settlement;
}
function settlementCodes(result: BudgetSettlementResult): readonly BudgetSettlementIssueCode[] {
  expect(result.ok).toBe(false);
  if (result.ok) return [];
  return result.issues.map((issue: BudgetSettlementIssue) => issue.code);
}
function settlementView(result: BudgetSettlementResult): BudgetAvailableView {
  expect(result.ok).toBe(true);
  return result.view;
}
/** Drives the published prefix so the settlement input is a real reservation, never a literal. */
function activated(): { reservation: ReservationRecord; view: BudgetAvailableView } {
  const admitted = scheduler.reserveForAdmission(SETTLE_VIEW, SETTLE_ADMISSION, GATE);
  if (!admitted.ok) throw new Error(admitted.issues.map((issue) => issue.code).join(","));
  const command: ReservationActivateCommand = { expectedVersion: 0, attemptRef: "attempt:1" };
  const live = scheduler.activateReservation(admitted.view, admitted.reservation, command);
  if (!live.ok) throw new Error(live.issues.map((issue) => issue.code).join(","));
  return { reservation: live.reservation, view: live.view };
}
const SETTLE_COMMAND: SettleCommand =
  { expectedViewVersion: 5, expectedReservationVersion: 1, prior: null };
const NO_EVIDENCE: SettleEvidence = { measurements: [] };
/** Settles with no receipt at all: the units are HELD, never silently committed or refunded. */
function quarantined(): { settlement: SettlementRecord; view: BudgetAvailableView } {
  const live = activated();
  const result = scheduler.settleReservation(live.view, live.reservation, NO_EVIDENCE,
    SETTLE_COMMAND);
  return { settlement: settlementOf(result), view: settlementView(result) };
}

it("settles an unmeasured reservation into a quarantined hold through the root exports", () => {
  const live = activated();
  const result = scheduler.settleReservation(live.view, live.reservation, NO_EVIDENCE,
    SETTLE_COMMAND);
  const settlement: SettlementRecord = settlementOf(result);
  const state: SettlementState = settlement.state;
  const line: SettlementLine | undefined = settlement.lines[0];
  const disposition: LineDisposition | undefined = line?.disposition;
  const overrun: readonly BudgetOverrun[] = settlement.overrun;
  expect([state, disposition]).toEqual(["QUARANTINED", "UNKNOWN_HELD"]);
  expect(line).toEqual({ meter: "usd", reserved: 10, committed: 0, refunded: 0, quarantined: 10,
    disposition: "UNKNOWN_HELD", identity: null, sequence: null });
  expect(settlement.settlementId)
    .toBe(scheduler.deriveSettlementId(live.reservation.reservationId));
  expect([...overrun]).toEqual([]);
  expect(settlementView(result).meters)
    .toEqual([{ meter: "usd", available: 0, reserved: 0, quarantined: 10, committed: 0 }]);
  expect(scheduler.SETTLEMENT_STATES).toStrictEqual(["QUARANTINED", "SETTLED", "WRITTEN_OFF"]);
  expect(scheduler.LINE_DISPOSITIONS).toStrictEqual(["EXACT", "LOWER_BOUND", "UNKNOWN_HELD",
    "CONSERVATIVE_WRITE_OFF", "NEVER_STARTED_REFUND"]);
});

it("reconciles, writes off and closes a quarantined hold through the root exports", () => {
  const held = quarantined();
  const proof: ReconcileEvidence = { measurements: null, neverStartedProofRef: "never:1" };
  const fence: SettlementCommand = { expectedViewVersion: 6, expectedSettlementVersion: 0 };
  const refunded = scheduler.reconcileSettlement(held.view, held.settlement, proof, fence);
  expect(settlementOf(refunded).state).toBe("SETTLED");
  expect(settlementOf(refunded).lines[0]?.disposition).toBe("NEVER_STARTED_REFUND");
  expect(settlementView(refunded).meters).toEqual([zero("usd", 10)]);

  // The other exit from the SAME hold: acknowledged conservative write-off commits the units.
  const ack: ConservativeCommand = { ...fence, acknowledgementRef: "ack:human:1",
    enforceableUpperBound: true };
  const written = scheduler.conservativeSettle(held.view, held.settlement, ack);
  const record: SettlementRecord = settlementOf(written);
  expect([record.state, record.lines[0]?.disposition, record.unknownExternalLiability])
    .toEqual(["WRITTEN_OFF", "CONSERVATIVE_WRITE_OFF", false]);
  const drained: BudgetAvailableView = settlementView(written);
  expect(drained.meters)
    .toEqual([{ meter: "usd", available: 0, reserved: 0, quarantined: 0, committed: 10 }]);
  const close: CloseCommand = { expectedVersion: 7 };
  expect(settlementView(scheduler.closeSettledView(drained, [record], close)).state).toBe("CLOSED");
});

it("refuses settling a reservation the root has not activated, by its own reason code", () => {
  const admitted = scheduler.reserveForAdmission(SETTLE_VIEW, SETTLE_ADMISSION, GATE);
  if (!admitted.ok) throw new Error("admission refused");
  // Identity mismatch is checked BEFORE the activation gate, so this single-element array names
  // the guard that answered — the reservation is honest in every way except its state.
  expect(settlementCodes(scheduler.settleReservation(admitted.view, admitted.reservation,
    NO_EVIDENCE, { ...SETTLE_COMMAND, expectedReservationVersion: 0 })))
    .toEqual(["BUDGET_SETTLEMENT_NOT_ACTIVATED"]);
  // A still-quarantined settlement is not closable, under a DIFFERENT published code.
  const held = quarantined();
  expect(settlementCodes(scheduler.closeSettledView(held.view, [held.settlement],
    { expectedVersion: 6 }))).toEqual(["BUDGET_SETTLEMENT_ILLEGAL_CLOSE"]);
  expect(scheduler.BUDGET_SETTLEMENT_ISSUE_CODES).toContain("BUDGET_SETTLEMENT_NOT_ACTIVATED");
  expect(scheduler.BUDGET_SETTLEMENT_ISSUE_CODES.length).toBe(16);
});
