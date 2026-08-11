/**
 * The Expansion admission protocol, driven end to end through PRODUCTION ROOT
 * SURFACES ONLY.
 *
 * WHY THESE ARE RELATIVE SPECIFIERS AND NOT BARE `@moe/*` ONES. pnpm links
 * workspace packages into each CONSUMING package's node_modules, never into the
 * repo root, and `tests/` belongs to no package — so `import "@moe/core"` here
 * fails with ERR_MODULE_NOT_FOUND for every package in the workspace, including
 * ones that have shipped correct bridges for months. Every existing suite under
 * tests/integration/ therefore reaches its package by relative path, and this
 * file follows that convention.
 *
 * It is not a deep-import workaround, and the guard at the bottom of this file
 * makes that mechanical rather than a promise: the ONLY two non-stdlib
 * specifiers permitted are the two package ROOT ENTRIES, exactly the modules the
 * `exports` maps publish. A symbol the barrels do not export is unreachable here
 * for the same reason it is unreachable for a real consumer, which is the
 * property that matters. That a REAL consumer resolves those roots through the
 * exports map is proven separately, and more strongly, by the bare-specifier
 * probes in packages/core/src/index-surface.test.ts and the bare `@moe/scheduler`
 * imports in packages/scheduler/src/index-surface.test.ts.
 *
 * WHAT THIS FILE IS AND IS NOT. It certifies capability that five sibling tasks
 * shipped. It therefore reimplements NO acceptance predicate: every verdict is
 * produced by a production function and this file only compares bytes. The
 * fixtures are inputs — a receipt, a policy slice, a graph snapshot — and none of
 * them decides whether anything is admissible.
 *
 * WHY IDENTITIES ARE BYTE-COMPARED RATHER THAN SHAPE-CHECKED. The protocol's
 * whole guarantee is that one identity binds one exact set of facts. A shape
 * assertion stays green while the binding drifts, so each stage asserts exact
 * equality for the unchanged case AND exact inequality for a single perturbed
 * byte.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXPANSION_APPROVAL_CODES, EXPANSION_HOLD_CAUSES, EXPANSION_PREPARATION_CODES,
  approveExpansionManually, inspectPlanningExpansionContract, prepareExpansion,
  reduceExpansionPlanningHold, reducePlanningRun, snapshotPlanningRunContractState,
  validExpansionHoldBinding, validExpansionProposalIdentity, validExpansionProposeCommand,
  validExpansionSealedEvent,
} from "../../packages/core/src/index.js";
import {
  EXPANSION_ADMISSION_ISSUE_CODES, EXPANSION_EVIDENCE_ISSUE_CODES, FORBIDDEN_VERDICT_KEYS,
  admitExpansion, deriveExpansionEvidence,
} from "../../packages/scheduler/src/index.js";

const hex = (character: string): string => character.repeat(64);
const HASH_A = hex("a");
const HASH_B = hex("b");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ---------------------------------------------------------------------------
// STAGE 1 fixtures — the runner-safe expansion request and its planning hold.
// ---------------------------------------------------------------------------

function holdCreateCommand(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    commandId: "command:create", deadline: 4_000, expectedVersion: 0, generation: 1,
    graphEpoch: 7, holdId: "hold:expansion:1", kind: "graph.request_expansion",
    parentNodeRef: "node:parent", parentRevisionRef: "revision:active",
    parentRunRef: "run:parent", planningRunRef: "planning:expansion:1",
    proposalBaseHash: HASH_A,
    rationale: { text: "split bounded independent work", truthClass: "AGENT_REPORTED" },
    release: {
      attemptRef: "attempt:released", attemptState: "RELEASED",
      disposition: {
        resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
      },
      effectsTerminal: true, handoff: { digest: HASH_B, ref: "handoff:worker" },
      leaseRef: "lease:released", leaseState: "RELEASED",
      observationRef: "observation:safe-boundary", providerSlotRef: "slot:released",
      providerSlotState: "RELEASED", reason: "WORK_RELEASE_OR_PAUSE",
      receiptRef: "receipt:release", resourcesTerminal: true, safeBoundaryObserved: true,
      terminalEffectRefs: ["effect:terminal"], terminalResourceRefs: ["resource:terminal"],
      truthClass: "DAEMON_VERIFIED",
    },
    sourceFingerprint: HASH_B, workerHandoff: { digest: HASH_B, ref: "handoff:worker" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// STAGE 2 fixtures — the hold-bound EXPANSION PlanningRun.
// ---------------------------------------------------------------------------

const seed = (value: string): string => value.repeat(64).slice(0, 64);
const SUBMISSION_HASH = seed("77");

const HOLD_BINDING = {
  generation: 2, goalVersion: 3, graphEpoch: 4, holdId: "hold-1", lifecycle: "ACTIVE",
  parentNodeRef: "node-parent-1", parentRunRef: "planning-run-0", proposalBaseHash: seed("99"),
  sourceFingerprint: seed("aa"), truthClass: "DAEMON_VERIFIED",
  workerHandoff: { digest: seed("bb"), ref: "handoff-1" },
};
const PROPOSAL_IDENTITY = {
  proposalHash: SUBMISSION_HASH, proposalRef: "submission-1", truthClass: "DAEMON_VERIFIED",
};
const SUBMISSION_WITNESS = {
  attemptRef: "attempt-1", submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED",
};

function expansionCreate(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    commandId: "cmd-planning.create_draft", expansion: clone(HOLD_BINDING), expectedVersion: 0,
    goalRef: "goal-1", kind: "planning.create_draft", runId: "planning-run-1",
    runKind: "EXPANSION", ...overrides,
  };
}

function expansionPropose(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    commandId: "cmd-plan.propose", expansion: clone(HOLD_BINDING), expectedVersion: 7,
    kind: "plan.propose", proposalKind: "EXPANSION", sealedProposal: clone(PROPOSAL_IDENTITY),
    submissionHash: SUBMISSION_HASH, witness: SUBMISSION_WITNESS, ...overrides,
  };
}

/** The PLANNING-lifecycle EXPANSION run a propose command is applied to. */
function expansionPlanningState(): Record<string, unknown> {
  return {
    approvedHashes: null, attemptRef: "attempt-1", expansion: clone(HOLD_BINDING),
    facets: { leaseSuspect: false, livePlannerEffect: false, owned: true, resumable: false },
    goalRef: "goal-1", graphRevisionRef: null, leaseRef: "lease-1", lifecycle: "PLANNING",
    runId: "planning-run-1", runKind: "EXPANSION", sealedHashes: null, sealedProposal: null,
    submissionHash: null, version: 7,
  };
}

// ---------------------------------------------------------------------------
// STAGE 3 fixtures — the sealed receipt and the scheduler admission request.
// ---------------------------------------------------------------------------

function healthyReceipt(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    proposalId: "prop-1", revision: 3, goalVersion: 7, graphEpoch: 11,
    observedAtSequence: 100, horizonSequence: 90, parentScope: ["a", "b", "c", "d"],
    childScopes: [
      {
        childKey: "child-1", scope: ["a", "b"], oracleKind: "OBSERVED", completion: "CLOSED",
        inputs: [{ inputKey: "in-1", materialization: "MATERIALIZED", digest: HASH_A }],
      },
      {
        childKey: "child-2", scope: ["c"], oracleKind: "DERIVED", completion: "CLOSED",
        inputs: [{ inputKey: "in-2", materialization: "MATERIALIZED", digest: HASH_B }],
      },
    ],
    sourceDigests: [HASH_A, HASH_B], ...overrides,
  };
}

/** A receipt with `width` children, one parent-scope key and one digest each. */
function wideReceipt(width: number): Record<string, unknown> {
  const keys = Array.from({ length: width }, (_, index) => `k${index}`);
  const digests = keys.map((_, index) => String(index % 10).repeat(64));
  return {
    ...healthyReceipt(), parentScope: keys, sourceDigests: digests,
    childScopes: keys.map((key, index) => ({
      childKey: `child-${index}`, scope: [key], oracleKind: "OBSERVED", completion: "CLOSED",
      inputs: [{ inputKey: `in-${index}`, materialization: "MATERIALIZED", digest: digests[index] }],
    })),
  };
}

function contractFor(producerNodeKey: string, consumerNodeKey: string): Record<string, unknown> {
  return {
    producerNodeKey, consumerNodeKey, edgeKind: "ARTIFACT_CONSUMPTION",
    graphBindingDigest: hex("c"),
    producer: {
      kind: "ARTIFACT_CONSUMPTION", artifactOrInterfaceRef: "artifact:shared", digest: HASH_B,
    },
    consumer: {
      kind: "PRECONDITION", criterionRef: `criterion:${consumerNodeKey}`, contractHash: HASH_A,
    },
    minimumQualifyingMilestone: "RESULT_SEALED",
    satisfactionPredicate: {
      predicateRef: "predicate:sealed", schemaId: "moe.predicate.sealed", schemaVersion: 1,
      parametersDigest: HASH_B,
    },
    stability: "REVOCABLE",
    satisfactionWitnesses: [{
      witnessRef: `witness:${producerNodeKey}`, witnessVersion: 1, witnessDigest: HASH_A,
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
      sourceFactRef: `fact:${producerNodeKey}`, sourceFactVersion: 1, sourceFactDigest: HASH_A,
    }],
    recheckPredicateRef: "predicate:sealed",
  };
}

/** dev-node-a -> dev-node-b -> dev-node-c, completion dev-node-c. */
function graphPart(): Record<string, unknown> {
  const edges = [
    {
      edgeKey: "dev-edge-ab", producerNodeKey: "dev-node-a", consumerNodeKey: "dev-node-b",
      kind: "HARD",
    },
    {
      edgeKey: "dev-edge-bc", producerNodeKey: "dev-node-b", consumerNodeKey: "dev-node-c",
      kind: "HARD",
    },
  ];
  const snapshot = {
    nodes: ["dev-node-a", "dev-node-b", "dev-node-c"]
      .map((nodeKey) => ({ nodeKey, executionBearing: true })),
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

function rotationPart(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
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
    forcedHead: null, capRevision: null, ...overrides,
  };
}

function budgetPart(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

function resourcesPart(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    requestId: "req.1",
    declaredResources: [
      { resourceId: "res.a", capacityUnits: 1, external: false, fenceable: true },
    ],
    capacitySnapshot: { "res.a": 4 }, epoch: 1, eligibilityEventSequenceRef: "seq.1",
    continuouslyEligibleSinceRef: "since.1", callerObservation: "obs.1", ...overrides,
  };
}

function admissionRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    receipt: healthyReceipt(), lineage: { expansionDepth: 2, nodesAddedInExpansion: 2 },
    graph: graphPart(), rotation: rotationPart(), bypassClaim: null, budget: budgetPart(),
    resources: resourcesPart(), ...overrides,
  };
}

// ---------------------------------------------------------------------------
// STAGE 4 fixtures — the core-side supersession, policy and approval facts.
// ---------------------------------------------------------------------------

const PREDECESSOR = { graphContentHash: hex("a"), graphEpoch: 7, revisionId: "revision-1" };
const SUCCESSOR = {
  graphContentHash: hex("b"), graphEpoch: 8,
  predecessorGraphContentHash: PREDECESSOR.graphContentHash,
  predecessorRevisionId: PREDECESSOR.revisionId, revisionId: "revision-2",
};

/** Tier R2 is human-only (design 710), so this evaluates to REQUIRE_HUMAN_APPROVAL. */
function policyInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    action: "graph.expand", actor: "human:reviewer-1", callerRiskHint: null,
    decisionDigest: hex("c"), evaluatedAtEpochMs: 1_700_000_000_000,
    evaluatorVersion: "policy-evaluator-v1",
    facts: [{ factId: "fact-risk", tier: "R2", truthClass: "DAEMON_VERIFIED" }],
    graphNodeRevisionRefs: ["revision-1"], policyRevisionRef: hex("d"),
    requiredFactIds: ["fact-risk"], scope: ["child-a", "child-b"],
    sliceChain: [{
      autoApprovalOptIns: [], sliceRef: "slice-root",
      rules: [
        { effect: "ALLOW", obligations: [], requiredFactIds: ["fact-risk"], ruleId: "rule-1" },
      ],
    }],
    waivers: [], ...overrides,
  };
}

function supersessionInput(): Record<string, unknown> {
  return {
    dispositions: [{
      kind: "ADD", nodeKey: "node-add", predecessorAuthorityHash: null, safeCarry: null,
      successorAuthorityHash: hex("1"),
    }],
    expectedPredecessor: { ...PREDECESSOR }, successor: { ...SUCCESSOR },
    supportedCanonicalizerVersions: ["canon-v1"],
  };
}

/**
 * THE CONSUMER EDGE THIS TASK CERTIFIES.
 *
 * @moe/core declares only @moe/contracts and @moe/scheduler depends on core, so
 * an admitted expansion can only reach core as INBOUND DATA under a core-owned
 * closed shape. This function is that mapping and nothing more: it moves the
 * scheduler's bound facts into core's `admitted` shape and decides nothing. Both
 * ends are production types; a field that stopped existing on either side breaks
 * here rather than silently dropping out of the identity.
 */
function admittedFrom(bound: Record<string, any>): Record<string, unknown> {
  return {
    budgetReservation: {
      accountId: bound["budgetReservation"].accountId,
      admissionRef: bound["budgetReservation"].admissionRef,
      reservationId: bound["budgetReservation"].reservationId,
      state: "RESERVED",
    },
    childKeys: [...bound["childKeys"]],
    evidenceDigest: bound["evidenceDigest"],
    fairness: {
      capRevisionRef: bound["fairness"].capRevisionRef,
      opportunityRef: `opportunity:${bound["fairness"].workItemId}`,
      resourceId: bound["fairness"].resourceId,
      workItemId: bound["fairness"].workItemId,
    },
    goalVersion: bound["goalVersion"],
    observedAtSequence: bound["observedAtSequence"],
    proposalId: bound["proposalId"],
    qualityDigest: bound["qualityDigest"],
    resourceReservation: {
      epoch: bound["resourceReservation"].epoch,
      resourceIds: [...bound["resourceReservation"].resourceIds],
      state: "HELD",
    },
    revision: bound["revision"],
    sourceDigests: [...bound["sourceDigests"]],
    truthClass: "DAEMON_VERIFIED",
  };
}

function preparationInput(
  admitted: Record<string, unknown>,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    admitted,
    criteria: {
      approvalRef: "approval-1", budgetRef: hex("4"), criteriaRef: hex("5"),
      dependencyChanges: { additions: ["dependency-a"], challenges: [], removals: [] },
      riskTier: "R2",
    },
    deadlineEpochMs: 1_700_000_600_000,
    fence: {
      authorityFencedRef: "fenced-authority-1", fencedAtEpoch: 7, subordinateAuthorityFenced: true,
    },
    funding: {
      fundingRef: "funding-1", meter: "EXECUTION", quantity: 9,
      reservationId: "funding-reservation-1", state: "RESERVED",
    },
    graphLifecycle: "ACTIVE", policy: policyInput(), supersession: supersessionInput(),
    ...overrides,
  };
}

function humanApproval(
  preparation: Record<string, any>,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    actor: "human:reviewer-1", actorKind: "HUMAN", applicablePolicyRef: hex("d"),
    approvalRef: "approval-1",
    approvedNodeScope: [...preparation["bound"].admitted.childKeys],
    budgetRef: hex("4"), criteriaRef: hex("5"), decision: null, decisionReason: null,
    dependencyChanges: { additions: ["dependency-a"], challenges: [], removals: [] },
    exactRevisionHash: hex("b"), lifecycle: "PENDING",
    planQualityAssessmentRef: preparation["bound"].admitted.qualityDigest,
    policyDecisionRef: hex("c"), riskTier: "R2", stepUpAuthRef: "step-up-1",
    truthClass: "HUMAN_APPROVED", validity: "CURRENT", ...overrides,
  };
}

function claimFor(preparation: Record<string, any>): Record<string, unknown> {
  return {
    budgetReservationId: preparation["bound"].admitted.budgetReservation.reservationId,
    budgetReservationState: preparation["bound"].admitted.budgetReservation.state,
    preparationIdentity: preparation["identity"],
    resourceEpoch: preparation["bound"].admitted.resourceReservation.epoch,
    resourceIds: [...preparation["bound"].admitted.resourceReservation.resourceIds],
    resourceReservationState: preparation["bound"].admitted.resourceReservation.state,
    supersessionAuthorityHash: preparation["bound"].supersessionAuthorityHash,
  };
}

// ---------------------------------------------------------------------------
// Narrow readers. They fail LOUDLY with the production reason code rather than
// returning a fallback, so a broken fixture can never be mistaken for a passing
// stage further down the journey.
// ---------------------------------------------------------------------------

function heldHold(command: Record<string, unknown>): Record<string, any> {
  const result = reduceExpansionPlanningHold(undefined, command as never) as Record<string, any>;
  if (!result["ok"]) throw new Error(`hold refused: ${String(result["code"])}`);
  return result;
}

function acceptedRun(state: unknown, command: Record<string, unknown>): Record<string, any> {
  const result = reducePlanningRun(state as never, command as never) as Record<string, any>;
  if (!result["ok"]) {
    throw new Error(`planning run refused: ${JSON.stringify(result["error"] ?? result)}`);
  }
  return result;
}

function admitted(request: Record<string, unknown>): Record<string, any> {
  const result = admitExpansion(request) as Record<string, any>;
  if (!result["ok"]) {
    throw new Error(`admission refused: ${result["issues"].map((i: any) => i.code).join(",")}`);
  }
  return result["preparation"];
}

function prepared(input: Record<string, unknown>): Record<string, any> {
  const result = prepareExpansion(input) as Record<string, any>;
  if (!result["ok"]) throw new Error(`preparation refused: ${String(result["code"])}`);
  return result["preparation"];
}

/** The whole journey, stage by stage, so every test starts from the same bytes. */
function journey(): Record<string, any> {
  const hold = heldHold(holdCreateCommand());
  const draft = acceptedRun(undefined, expansionCreate());
  const sealed = acceptedRun(expansionPlanningState(), expansionPropose());
  const admission = admitted(admissionRequest());
  const preparation = prepared(preparationInput(admittedFrom(admission["bound"])));
  const approval = approveExpansionManually({
    approval: humanApproval(preparation), claim: claimFor(preparation),
    command: {
      decision: "APPROVE", decisionReason: "approved after review", kind: "approval.decide",
      stepUpAuthRef: "step-up-1",
    },
    nowEpochMs: 1_700_000_300_000, preparation,
  }) as Record<string, any>;
  return { admission, approval, draft, hold, preparation, sealed };
}

describe("the pure expansion protocol runs end to end from the package roots", () => {
  it("holds one expansion request and binds the release evidence verbatim", () => {
    const command = holdCreateCommand();
    const { event, state } = heldHold(command);
    expect([event.kind, event.lifecycle, event.version])
      .toEqual(["EXPANSION_HOLD_CREATED", "ACTIVE", 1]);
    expect(state.holdKind).toBe("EXPANSION_PLANNING");
    // Byte-compared, not shape-checked: the hold IS the caller's request plus a
    // lifecycle, so any normalisation of these fields is a defect.
    expect([state.proposalBaseHash, state.sourceFingerprint]).toEqual([HASH_A, HASH_B]);
    expect(state.creationReceipt.command).toEqual(command);
    expect(state.release.leaseState).toBe("RELEASED");
  });

  /**
   * Two causes, two DIFFERENT layers, and that difference is the assertion.
   *
   * My first draft asserted only `ok === false` plus `typeof code === "string"`,
   * which the DoD-4 drill then showed to be vacuous: deleting the cause
   * membership check leaves the transition still refused — by the later
   * causeTarget guard, with a different code — so the test stayed green while no
   * longer testing its subject. Pinning WHICH layer answered is what makes the
   * schema guard falsifiable.
   */
  const transition = (cause: string): Record<string, any> => {
    const { state } = heldHold(holdCreateCommand());
    return reduceExpansionPlanningHold(state as never, {
      cause, commandId: "command:terminate", expectedVersion: 1,
      generation: state.generation, graphEpoch: state.graphEpoch, holdId: state.holdId,
      kind: "expansion.transition_hold", parentNodeRef: state.parentNodeRef,
      parentRevisionRef: state.parentRevisionRef, parentRunRef: state.parentRunRef,
      planningRunRef: state.planningRunRef, proposalBaseHash: state.proposalBaseHash,
      sourceFingerprint: state.sourceFingerprint, targetLifecycle: "RESOLVED",
      terminalProof: null,
    } as never) as Record<string, any>;
  };

  it("refuses an undeclared hold cause at the INPUT layer, before any transition rule", () => {
    expect(EXPANSION_HOLD_CAUSES).not.toContain("NOT_A_DECLARED_CAUSE");
    const result = transition("NOT_A_DECLARED_CAUSE");
    expect([result["ok"], result["code"], result["layer"]])
      .toEqual([false, "EXPANSION_HOLD_INPUT_INVALID", "INPUT"]);
  });

  it("refuses a DECLARED cause with no terminal proof at its own later layer", () => {
    expect(EXPANSION_HOLD_CAUSES).toContain("EXPANSION_REFUSED");
    const result = transition("EXPANSION_REFUSED");
    expect([result["ok"], result["code"], result["layer"]])
      .toEqual([false, "EXPANSION_HOLD_TERMINAL_PROOF_REQUIRED", "TERMINAL_PROOF"]);
  });

  it("creates a hold-bound EXPANSION run and seals one immutable proposal identity", () => {
    const draft = acceptedRun(undefined, expansionCreate());
    expect([draft.state.runKind, draft.state.lifecycle]).toEqual(["EXPANSION", "DRAFT"]);
    // The hold binding arrives byte-identical; a copy that normalised a field
    // would break the identity comparison the propose command makes later.
    expect(draft.state.expansion).toEqual(HOLD_BINDING);
    expect(validExpansionHoldBinding(draft.state.expansion)).toBe(true);

    const sealed = acceptedRun(expansionPlanningState(), expansionPropose());
    expect(sealed.state.submissionHash).toBe(SUBMISSION_HASH);
    expect(sealed.state.sealedProposal).toEqual(PROPOSAL_IDENTITY);
    expect(validExpansionProposalIdentity(sealed.state.sealedProposal)).toBe(true);
    expect(validExpansionSealedEvent(sealed.events[0])).toBe(true);
    // The seal binds the SUBMITTED hash, not a second free identity.
    expect(sealed.state.sealedProposal.proposalHash).toBe(sealed.state.submissionHash);
  });

  it("certifies the sealed run through the production contract inspector, not a local one", () => {
    const sealed = acceptedRun(expansionPlanningState(), expansionPropose());
    const snapshot = snapshotPlanningRunContractState(sealed.state);
    expect(snapshot).toBeDefined();
    // Each target is inspected by the SHIPPED inspector. Re-deriving "is this a
    // valid contract state" here would assert this file against itself.
    for (const [target, value] of [
      ["CONTRACT_STATE", snapshot], ["HOLD_BINDING", sealed.state.expansion],
      ["PROPOSAL_IDENTITY", sealed.state.sealedProposal],
      ["PROPOSE_COMMAND", expansionPropose()], ["SEALED_EVENT", sealed.events[0]],
    ] as const) {
      const inspection = inspectPlanningExpansionContract(target, value) as Record<string, any>;
      expect(`${target}:${String(inspection["ok"])}`).toBe(`${target}:true`);
    }
  });

  it("the inspector refuses a perturbed identity by its own code and layer", () => {
    const sealed = acceptedRun(expansionPlanningState(), expansionPropose());
    const perturbed = { ...sealed.state.sealedProposal, proposalHash: "not-a-hash" };
    const inspection = inspectPlanningExpansionContract("PROPOSAL_IDENTITY", perturbed) as
      Record<string, any>;
    expect([inspection["ok"], inspection["code"], inspection["layer"]])
      .toEqual([false, "PLANNING_EXPANSION_PROPOSAL_IDENTITY_INVALID", "IDENTITY"]);
    // The same predicate, called directly, agrees — so the refusal above came
    // from the identity check and not from the inspector's target dispatch.
    expect(validExpansionProposalIdentity(perturbed)).toBe(false);
    expect(validExpansionProposeCommand(expansionPropose())).toBe(true);
  });

  it("derives evidence, admits one expansion, and binds every derived fact once", () => {
    const evidence = deriveExpansionEvidence(healthyReceipt()) as Record<string, any>;
    expect(evidence["ok"]).toBe(true);
    const preparation = admitted(admissionRequest());
    const bound = preparation.bound;
    expect(preparation.identity).toMatch(/^[0-9a-f]{64}$/u);
    // The admission's bound facts are the DERIVED evidence, byte for byte —
    // never the receipt's own claims about itself.
    expect(bound.childKeys).toEqual(evidence["value"].childKeys);
    expect(bound.sourceDigests).toEqual(evidence["value"].sourceDigests);
    expect(bound.lineage.childWidth).toBe(evidence["value"].childWidth);
    expect([bound.proposalId, bound.revision, bound.goalVersion]).toEqual(["prop-1", 3, 7]);
  });

  it("binds the admitted expansion into one core preparation identity and approves it", () => {
    const { admission, approval, preparation } = journey();
    expect(approval["ok"]).toBe(true);
    const binding = approval["binding"];
    // Three byte-comparisons across three packages' worth of stages. Each is an
    // exact string equality, so a re-derived-but-equal identity still passes and
    // a drifted one cannot.
    expect(binding.preparationIdentity).toBe(preparation["identity"]);
    expect(preparation["bound"].admitted.evidenceDigest).toBe(admission["bound"].evidenceDigest);
    expect(preparation["bound"].admitted.proposalId).toBe(admission["bound"].proposalId);
    expect(binding.identity).toMatch(/^[0-9a-f]{64}$/u);
    expect(binding.decidedApproval.decision).toBe("APPROVE");
    expect(binding.approvalRef).toBe("approval-1");
  });

  it("is deterministic: the same bytes twice produce the same two identities", () => {
    const first = journey();
    const second = journey();
    expect(second["admission"].identity).toBe(first["admission"].identity);
    expect(second["preparation"]["identity"]).toBe(first["preparation"]["identity"]);
    expect(second["approval"]["binding"].identity).toBe(first["approval"]["binding"].identity);
  });
});

describe("one perturbed byte moves the identity it is bound into", () => {
  const base = journey();

  /** Each entry changes ONE byte of ONE stage's input. */
  const SCHEDULER_PERTURBATIONS: readonly (readonly [string, () => Record<string, unknown>])[] = [
    ["proposalId", () => admissionRequest({ receipt: healthyReceipt({ proposalId: "prop-2" }) })],
    ["revision", () => admissionRequest({ receipt: healthyReceipt({ revision: 4 }) })],
    ["goalVersion", () => admissionRequest({ receipt: healthyReceipt({ goalVersion: 8 }) })],
    ["graphEpoch", () => admissionRequest({ receipt: healthyReceipt({ graphEpoch: 12 }) })],
    ["observedAtSequence",
      () => admissionRequest({ receipt: healthyReceipt({ observedAtSequence: 101 }) })],
    ["lineage.expansionDepth",
      () => admissionRequest({ lineage: { expansionDepth: 1, nodesAddedInExpansion: 2 } })],
    ["lineage.nodesAdded",
      () => admissionRequest({ lineage: { expansionDepth: 2, nodesAddedInExpansion: 3 } })],
    ["budget.admissionRef", () => {
      const base = budgetPart()["admission"] as Record<string, unknown>;
      return admissionRequest({
        budget: budgetPart({ admission: { ...base, admissionRef: "adm.2" } }),
      });
    }],
    ["resources.requestId",
      () => admissionRequest({ resources: resourcesPart({ requestId: "req.2" }) })],
  ];

  it("generated a non-empty scheduler perturbation set", () => {
    // A sweep that silently produced zero cases would pass every assertion below.
    expect(SCHEDULER_PERTURBATIONS.length).toBe(9);
  });

  it.each(SCHEDULER_PERTURBATIONS)(
    "moves the admission identity when %s changes",
    (_name, build) => {
      const moved = admitExpansion(build()) as Record<string, any>;
      // A perturbation that REFUSED would also "not equal" the base identity and
      // would prove nothing about the binding, so acceptance is asserted first.
      expect(moved["ok"]).toBe(true);
      expect(moved["preparation"].identity).not.toBe(base["admission"].identity);
    },
  );

  /**
   * TWO CASES ADDED BY THE DoD-4 DRILL, not by design.
   *
   * The adversarial sweep mutated `capacitySnapshot` in two ways and BOTH
   * survived the whole 1797-test suite. Neither was a strong guard: every
   * fixture on this board — the sibling's included — supplies capacities already
   * in sorted order and with inFlightUnits 0, so `facts.sort(...)` and
   * `inFlightUnits: capacity.value.inFlightUnits` were no-ops nothing could
   * observe. The sibling's own "capacity snapshot" perturbation moves
   * capacityUnits only (expansion-admission.test.ts:603-609).
   *
   * These two close that: the identity must be INDEPENDENT of the order the
   * capacities arrive in, and DEPENDENT on every field they carry.
   */
  it("binds inFlightUnits into the identity, not just the resource and its cap", () => {
    const moved = admitExpansion(admissionRequest({
      rotation: rotationPart({
        capacities: [
          { resourceId: "res.a", capacityUnits: 4, inFlightUnits: 1 },
          { resourceId: "res.b", capacityUnits: 4, inFlightUnits: 0 },
        ],
      }),
    })) as Record<string, any>;
    expect(moved["ok"]).toBe(true);
    expect(moved["preparation"].bound.capacitySnapshot[0].inFlightUnits).toBe(1);
    expect(moved["preparation"].identity).not.toBe(base["admission"].identity);
  });

  it("is INDEPENDENT of the order the capacities arrive in", () => {
    const reversed = admitExpansion(admissionRequest({
      rotation: rotationPart({
        capacities: [
          { resourceId: "res.b", capacityUnits: 4, inFlightUnits: 0 },
          { resourceId: "res.a", capacityUnits: 4, inFlightUnits: 0 },
        ],
      }),
    })) as Record<string, any>;
    expect(reversed["ok"]).toBe(true);
    // Derived, then sorted — so a caller cannot move the identity by reordering
    // a set. Asserted on the bound facts AND on the identity, because either one
    // alone leaves the other free to drift.
    expect(reversed["preparation"].bound.capacitySnapshot.map((one: any) => one.resourceId))
      .toEqual(["res.a", "res.b"]);
    expect(reversed["preparation"].identity).toBe(base["admission"].identity);
  });

  it("gives every scheduler perturbation its own identity, not merely a different one", () => {
    const identities = new Set(SCHEDULER_PERTURBATIONS.map(([, build]) => {
      const moved = admitExpansion(build()) as Record<string, any>;
      return moved["preparation"].identity as string;
    }));
    identities.add(base["admission"].identity as string);
    expect(identities.size).toBe(SCHEDULER_PERTURBATIONS.length + 1);
  });

  const CORE_PERTURBATIONS: readonly (readonly [string, Record<string, unknown>])[] = [
    ["criteria.riskTier", { criteria: {
      approvalRef: "approval-1", budgetRef: hex("4"), criteriaRef: hex("5"),
      dependencyChanges: { additions: ["dependency-a"], challenges: [], removals: [] },
      riskTier: "R1",
    } }],
    ["deadlineEpochMs", { deadlineEpochMs: 1_700_000_700_000 }],
    ["fence.fencedAtEpoch", { fence: {
      authorityFencedRef: "fenced-authority-1", fencedAtEpoch: 8, subordinateAuthorityFenced: true,
    } }],
    ["funding.quantity", { funding: {
      fundingRef: "funding-1", meter: "EXECUTION", quantity: 10,
      reservationId: "funding-reservation-1", state: "RESERVED",
    } }],
    ["policy.decisionDigest", { policy: policyInput({ decisionDigest: hex("e") }) }],
  ];

  it("generated a non-empty core perturbation set", () => {
    expect(CORE_PERTURBATIONS.length).toBe(5);
  });

  it.each(CORE_PERTURBATIONS)(
    "moves the core preparation identity when %s changes",
    (_name, override) => {
      const admittedFacts = admittedFrom(base["admission"].bound);
      const moved = prepared(preparationInput(admittedFacts, override));
      expect(moved["identity"]).not.toBe(base["preparation"]["identity"]);
    },
  );

  it("requires re-approval when a bound byte moved: the stale claim is refused by code", () => {
    const admittedFacts = admittedFrom(base["admission"].bound);
    const moved = prepared(preparationInput(admittedFacts, { deadlineEpochMs: 1_700_000_700_000 }));
    // The approval carries the ORIGINAL claim against the MOVED preparation.
    const result = approveExpansionManually({
      approval: humanApproval(moved), claim: claimFor(base["preparation"]),
      command: {
        decision: "APPROVE", decisionReason: "approved after review", kind: "approval.decide",
        stepUpAuthRef: "step-up-1",
      },
      nowEpochMs: 1_700_000_300_000, preparation: moved,
    }) as Record<string, any>;
    expect(result["ok"]).toBe(false);
    expect(result["code"]).toBe("EXPANSION_APPROVAL_PREPARATION_MISMATCH");
    expect(EXPANSION_APPROVAL_CODES).toContain(result["code"]);
  });
});

/**
 * DoD 2's zero-authority clause, asserted POSITIVELY.
 *
 * A blanket "no key matches /run|lease|effect|slot/" sweep would be wrong here
 * and is the reason this is an inventory instead. The HOLD legitimately carries
 * `leaseRef`, `providerSlotRef` and `terminalEffectRefs` — that is RELEASE
 * EVIDENCE, the proof that authority was given UP, which is the opposite of
 * minting it. So each stage's authority-shaped key set is pinned by an exact,
 * hand-written list, every entry of which is justified below, and every one of
 * those keys is additionally required to describe a TERMINAL state. A newly
 * minted authority key anywhere fails the set equality; a live lease fails the
 * state assertion.
 */
const AUTHORITY_PATTERN = /run|lease|effect|slot|allocation|dispatch|activat/iu;

function authorityKeys(value: unknown, seen = new Set<object>(), out = new Set<string>()):
readonly string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [...out].sort();
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (AUTHORITY_PATTERN.test(key)) out.add(key);
    authorityKeys((value as Record<string, unknown>)[key], seen, out);
  }
  return [...out].sort();
}

describe("no pure stage exposes activation or dispatch authority", () => {
  it("the hold carries release evidence and nothing that could be acted on", () => {
    const { state } = heldHold(holdCreateCommand());
    expect(authorityKeys(state)).toEqual([
      // Identifiers of the PARENT work this expansion was requested from.
      "parentRunRef", "planningRunRef",
      // `release` is the evidence block itself — it matches only because the
      // word contains "lease", and it names authority given UP.
      "release",
      // Release evidence: every one names something already terminal.
      "effectsTerminal", "leaseRef", "leaseState", "providerSlotRef", "providerSlotState",
      "terminalEffectRefs",
    ].sort());
    // The semantic half: each of these describes a TERMINAL state, never a live one.
    expect([state.release.attemptState, state.release.leaseState, state.release.providerSlotState])
      .toEqual(["RELEASED", "RELEASED", "RELEASED"]);
    expect([state.release.effectsTerminal, state.release.resourcesTerminal]).toEqual([true, true]);
  });

  it("the sealed EXPANSION run mints no attempt, lease or effect of its own", () => {
    const sealed = acceptedRun(expansionPlanningState(), expansionPropose());
    expect(authorityKeys(sealed.state)).toEqual([
      // The run's OWN planning claim, carried in from the state it was applied
      // to. Sealing a proposal neither mints nor renews it.
      "leaseRef",
      // Facets: booleans about the PLANNER's own liveness, both false below.
      "leaseSuspect", "livePlannerEffect",
      // Identifiers — the hold's parent run, and this run's own identity.
      "parentRunRef", "runId", "runKind",
    ].sort());
    expect([sealed.state.facets.livePlannerEffect, sealed.state.facets.leaseSuspect])
      .toEqual([false, false]);
    // A sealed proposal is not an activated graph, and no child run was created.
    expect(sealed.state.graphRevisionRef).toBeNull();
    expect(sealed.state.leaseRef).toBe("lease-1");
  });

  it("the scheduler admission reserves and activates nothing", () => {
    const preparation = admitted(admissionRequest());
    // effectIntentRefs is an INTENT recorded against a reservation, not an
    // effect: reserveAll produced it and activateReservation was never called.
    expect(authorityKeys(preparation)).toEqual(["effectIntentRefs"]);
  });

  it("the core preparation and the approval binding mint no authority at all", () => {
    const { approval, preparation } = journey();
    // `sources` is excluded: it echoes the caller's own evidence verbatim, and a
    // policy rule's `effect` field is a rule effect, not an execution effect.
    const bound = preparation["bound"];
    expect(authorityKeys(bound)).toEqual([]);
    expect(authorityKeys(approval["binding"])).toEqual([]);
  });

  it("the whole journey never yields a child run, node or graph mutation", () => {
    const { admission, approval, preparation, sealed } = journey();
    for (const stage of [admission, preparation, approval["binding"], sealed.state]) {
      const keys = Object.keys(stage as Record<string, unknown>);
      expect(keys).not.toContain("childRuns");
      expect(keys).not.toContain("activatedNodes");
      expect(keys).not.toContain("dispatch");
    }
  });
});

describe("this suite reaches nothing but the two published package roots", () => {
  const SELF = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const ROOT_ENTRIES = [
    "../../packages/core/src/index.js", "../../packages/scheduler/src/index.js",
  ];
  const ALLOWED = new Set(["node:fs", "node:url", "vitest", ...ROOT_ENTRIES]);
  /**
   * Anchored on the STATEMENT, never on a bare quoted string. My first draft
   * scanned for any quoted `@moe/...` and went red on the prose in this file's
   * own header comment — a boundary check that reads prose reports the wrong
   * thing in both directions.
   */
  const specifiers = [...SELF.matchAll(/^\s*(?:import|export)[^"']*from\s+"([^"]+)"/gmu)]
    .map((match) => match[1] as string);

  it("imports only stdlib, vitest, and the two package root entries", () => {
    // A scrape that produced zero specifiers would pass while checking nothing.
    expect(specifiers.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(specifiers)].filter((one) => !ALLOWED.has(one))).toEqual([]);
  });

  it("reaches no package internal: every workspace specifier is a root entry", () => {
    const workspace = specifiers.filter((one) => one.includes("packages/") || one.startsWith("@moe/"));
    // Positive control. An empty `workspace` would satisfy the equality below
    // while proving nothing, so the count is pinned to the two real imports
    // first — this is the check that would catch the filter silently matching
    // nothing after a rename.
    expect(workspace.sort()).toEqual([...ROOT_ENTRIES].sort());
  });
});

describe("the published vocabularies are the ones the journey actually speaks", () => {
  it("every refusal code the journey can produce is in a published frozen set", () => {
    for (const vocabulary of [
      EXPANSION_ADMISSION_ISSUE_CODES, EXPANSION_APPROVAL_CODES, EXPANSION_EVIDENCE_ISSUE_CODES,
      EXPANSION_HOLD_CAUSES, EXPANSION_PREPARATION_CODES, FORBIDDEN_VERDICT_KEYS,
    ]) {
      expect(Object.isFrozen(vocabulary)).toBe(true);
      expect(vocabulary.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// DoD 3 — the generated refusal/race matrix.
//
// Coverage is asserted against the PRODUCTION vocabularies, not a transcript:
// each table's produced code set must equal the published frozen array exactly.
// That alone would still be self-policing — deleting a code from production AND
// from the table keeps both sides equal and the suite green — so every
// vocabulary's LENGTH is also pinned to a hand-written number below.
// ===========================================================================

interface RefusalCase {
  readonly apply: (subject: Record<string, any>) => void;
  readonly code: string;
  readonly layer: string;
  readonly name: string;
}

/** The single issue a refusal carried, failing loudly if there was not exactly one. */
function onlyIssue(value: unknown): Record<string, any> {
  const result = value as Record<string, any>;
  expect(result["ok"]).toBe(false);
  expect(result["issues"]).toHaveLength(1);
  return result["issues"][0] as Record<string, any>;
}

const EVIDENCE_CASES: readonly RefusalCase[] = [
  { name: "caller-declared verdict", code: "EXPANSION_CALLER_DECLARED_VERDICT", layer: "EVIDENCE",
    apply: (receipt) => { receipt["eligible"] = true; } },
  { name: "overlapping child scopes", code: "EXPANSION_SCOPE_OVERLAP", layer: "SCOPE",
    apply: (receipt) => { receipt["childScopes"][1].scope = ["b", "c"]; } },
  { name: "child scope outside the parent", code: "EXPANSION_CONTAINMENT_VIOLATED",
    layer: "CONTAINMENT", apply: (receipt) => { receipt["childScopes"][1].scope = ["z"]; } },
  { name: "ineligible oracle", code: "EXPANSION_ORACLE_INELIGIBLE", layer: "ORACLE",
    apply: (receipt) => { receipt["childScopes"][0].oracleKind = "NONE"; } },
  { name: "input not materializable", code: "EXPANSION_INPUT_NOT_MATERIALIZABLE", layer: "INPUT",
    apply: (receipt) => {
      receipt["childScopes"][0].inputs =
        [{ inputKey: "in-1", materialization: "PENDING", digest: null }];
    } },
  { name: "completion not closed", code: "EXPANSION_COMPLETION_NOT_CLOSED", layer: "CONTAINMENT",
    apply: (receipt) => { receipt["childScopes"][1].completion = "OPEN"; } },
  { name: "receipt observed before its horizon", code: "EXPANSION_RECEIPT_STALE",
    layer: "FRESHNESS", apply: (receipt) => { receipt["observedAtSequence"] = 89; } },
  { name: "input digest absent from the sources", code: "EXPANSION_SOURCE_DIGEST_MISMATCH",
    layer: "SOURCE", apply: (receipt) => {
      receipt["childScopes"][0].inputs =
        [{ inputKey: "in-1", materialization: "MATERIALIZED", digest: hex("c") }];
    } },
  // Layer EVIDENCE, not INPUT: "an input needed to classify is absent" is a
  // statement about the evidence as a whole, not a verdict on the input's value.
  { name: "unclassifiable materialization", code: "EXPANSION_EVIDENCE_UNKNOWN", layer: "EVIDENCE",
    apply: (receipt) => {
      receipt["childScopes"][0].inputs =
        [{ inputKey: "in-1", materialization: "UNKNOWN", digest: null }];
    } },
  { name: "unknown extra key", code: "EXPANSION_EVIDENCE_MALFORMED", layer: "EVIDENCE",
    apply: (receipt) => { receipt["somethingNew"] = 1; } },
  { name: "required key missing", code: "EXPANSION_EVIDENCE_MISSING", layer: "EVIDENCE",
    apply: (receipt) => { delete receipt["sourceDigests"]; } },
];

const EVIDENCE_CASE_NAMES: readonly string[] = [
  "caller-declared verdict", "overlapping child scopes", "child scope outside the parent",
  "ineligible oracle", "input not materializable", "completion not closed",
  "receipt observed before its horizon", "input digest absent from the sources",
  "unclassifiable materialization", "unknown extra key", "required key missing",
];

describe("every declared evidence code is produced by a real perturbation", () => {
  it("generated one case per enumerated perturbation", () => {
    // Hand-written names, so a table that silently lost an entry cannot pass by
    // emitting fewer cases and comparing itself to what it emitted.
    expect(EVIDENCE_CASES.map((one) => one.name)).toEqual(EVIDENCE_CASE_NAMES);
    expect(EVIDENCE_CASES.length).toBe(11);
  });

  it("covers the published vocabulary exactly, with a hand-pinned size", () => {
    expect(EXPANSION_EVIDENCE_ISSUE_CODES.length).toBe(11);
    expect([...new Set(EVIDENCE_CASES.map((one) => one.code))].sort())
      .toEqual([...EXPANSION_EVIDENCE_ISSUE_CODES].sort());
  });

  it.each(EVIDENCE_CASES)("refuses $name with $code from $layer", ({ apply, code, layer }) => {
    const receipt = clone(healthyReceipt());
    apply(receipt);
    const issue = onlyIssue(deriveExpansionEvidence(receipt));
    expect([issue["code"], issue["layer"]]).toEqual([code, layer]);
  });

  it.each(EVIDENCE_CASES)(
    "passes $code through admitExpansion VERBATIM, code and layer alike",
    ({ apply }) => {
      const receipt = clone(healthyReceipt());
      apply(receipt);
      // The delegated refusal is compared to what the underlying surface says
      // when called DIRECTLY, rather than to a literal transcribed here. A
      // re-coded delegation loses which layer refused, and pinning literals on
      // both sides would not notice the two drifting together.
      const direct = onlyIssue(deriveExpansionEvidence(receipt));
      const composed = onlyIssue(admitExpansion(admissionRequest({ receipt })));
      expect([composed["code"], composed["layer"], composed["origin"]])
        .toEqual([direct["code"], direct["layer"], "EVIDENCE"]);
    },
  );
});

const ADMISSION_LOCAL_CASES: readonly RefusalCase[] = [
  { name: "malformed request", code: "EXPANSION_ADMISSION_REQUEST_MALFORMED", layer: "REQUEST",
    apply: (request) => { request["lineage"] = { expansionDepth: -1, nodesAddedInExpansion: 2 }; } },
  { name: "no fairness opportunity", code: "EXPANSION_ADMISSION_NO_FAIRNESS_OPPORTUNITY",
    layer: "FAIRNESS", apply: (request) => {
      request["rotation"] = rotationPart({
        capacities: [
          { resourceId: "res.a", capacityUnits: 1, inFlightUnits: 1 },
          { resourceId: "res.b", capacityUnits: 1, inFlightUnits: 1 },
        ],
      });
    } },
  { name: "resources unavailable", code: "EXPANSION_ADMISSION_RESOURCES_UNAVAILABLE",
    layer: "RESOURCE", apply: (request) => {
      request["resources"] = resourcesPart({ capacitySnapshot: { "res.a": 0 } });
    } },
];

describe("every declared admission code is produced, and delegated ones are not re-coded", () => {
  it("covers the published local vocabulary exactly, with a hand-pinned size", () => {
    expect(EXPANSION_ADMISSION_ISSUE_CODES.length).toBe(3);
    expect(ADMISSION_LOCAL_CASES.length).toBe(3);
    expect([...new Set(ADMISSION_LOCAL_CASES.map((one) => one.code))].sort())
      .toEqual([...EXPANSION_ADMISSION_ISSUE_CODES].sort());
  });

  it.each(ADMISSION_LOCAL_CASES)("mints $code at $layer where no surface can speak",
    ({ apply, code, layer }) => {
      const request = admissionRequest();
      apply(request);
      const issue = onlyIssue(admitExpansion(request));
      expect([issue["code"], issue["layer"], issue["origin"]]).toEqual([code, layer, layer]);
    });

  const DELEGATED: readonly (readonly [string, string, string, () => Record<string, unknown>])[] = [
    ["GRAPH", "ADMISSION_INPUT_MALFORMED", "GRAPH",
      () => admissionRequest({ graph: { proposedSnapshot: null, contracts: "nope" } })],
    ["FAIRNESS", "FAIRNESS_CONTRACT_UNDECLARED_RESOURCE", "RESOURCE",
      () => admissionRequest({
        rotation: rotationPart({
          capacities: [
            { resourceId: "res.a", capacityUnits: 4, inFlightUnits: 0 },
            { resourceId: "res.b", capacityUnits: 4, inFlightUnits: 0 },
            { resourceId: "res.z", capacityUnits: 4, inFlightUnits: 0 },
          ],
        }),
      })],
    ["BUDGET", "BUDGET_RESERVATION_STALE_VERSION", "BUDGET", () => {
      const base = budgetPart()["admission"] as Record<string, unknown>;
      return admissionRequest({ budget: budgetPart({
        admission: { ...base, expectedVersion: 99 },
      }) });
    }],
    ["RESOURCE", "AUTHORITY_MALFORMED_INPUT", "RESOURCE",
      () => admissionRequest({ resources: "not-a-request" })],
    ["LINEAGE", "ADMISSION_EXPANSION_DEPTH_EXCEEDED", "LINEAGE",
      () => admissionRequest({ lineage: { expansionDepth: 4, nodesAddedInExpansion: 2 } })],
  ];

  it("generated a delegated case for every composed origin but EVIDENCE", () => {
    // EVIDENCE is covered by its own verbatim-passthrough sweep above; the other
    // five origins are here, so all six declared origins are exercised.
    expect(DELEGATED.map(([origin]) => origin).sort())
      .toEqual(["BUDGET", "FAIRNESS", "GRAPH", "LINEAGE", "RESOURCE"]);
    expect([...new Set([...DELEGATED.map(([origin]) => origin), "EVIDENCE"])].length).toBe(6);
  });

  it.each(DELEGATED)("keeps the %s refusal's own code %s and layer %s", (origin, code, layer, build) => {
    const issue = onlyIssue(admitExpansion(build()));
    expect([issue["code"], issue["layer"], issue["origin"]]).toEqual([code, layer, origin]);
  });
});

describe("an UNKNOWN fact is denied, never upgraded to a positive", () => {
  it("keeps the UNKNOWN disposition and names the input that blocked the verdict", () => {
    const receipt = clone(healthyReceipt());
    receipt["childScopes"][0].inputs =
      [{ inputKey: "in-1", materialization: "UNKNOWN", digest: null }];
    const direct = deriveExpansionEvidence(receipt) as Record<string, any>;
    const composed = admitExpansion(admissionRequest({ receipt })) as Record<string, any>;
    // UNKNOWN is not REFUSED. Collapsing the two would let a missing fact read
    // as a refuted one, which is exactly how an UNKNOWN gains authority.
    expect([direct["disposition"], composed["disposition"]]).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(onlyIssue(composed)["missingInput"])
      .toBe("childScopes[0].inputs[0].materialization");
    expect(composed["ok"]).toBe(false);
  });

  it("an UNKNOWN never becomes an admitted preparation", () => {
    const receipt = clone(healthyReceipt());
    receipt["childScopes"][1].completion = "UNKNOWN";
    const composed = admitExpansion(admissionRequest({ receipt })) as Record<string, any>;
    expect(composed["disposition"]).toBe("UNKNOWN");
    expect(composed["preparation"]).toBeUndefined();
  });
});

describe("all-or-none: a late refusal leaves nothing held", () => {
  // Budget is reserved BEFORE resources, so a resource failure is the one
  // ordering in which a partial hold is reachable at all.
  const lateFailure = (): Record<string, any> => admitExpansion(admissionRequest({
    resources: resourcesPart({ capacitySnapshot: { "res.a": 0 } }),
  })) as Record<string, any>;

  it("returns no preparation, identity, reservation or rows", () => {
    const refusal = lateFailure();
    for (const key of ["preparation", "identity", "reservation", "rows"]) {
      expect(`${key}=${refusal[key] === undefined ? "absent" : "present"}`).toBe(`${key}=absent`);
    }
  });

  it("gives the reserved units BACK, proved by the meters and not by a flag", () => {
    const refusal = lateFailure();
    const unwind = refusal["unwind"];
    expect(unwind["budgetReservationCancelled"]).toBe(true);
    // The restored buckets are compared to the UNTOUCHED caller view. A boolean
    // alone is satisfied by an implementation that strands the units in RESERVED.
    const original = (budgetPart()["view"] as Record<string, any>)["meters"][0];
    expect(unwind["restoredMeters"]).toEqual([
      { meter: original.meter, available: original.available, reserved: original.reserved },
    ]);
  });

  it("an EARLY refusal never reserved anything, so it unwinds nothing", () => {
    const early = admitExpansion(admissionRequest({
      receipt: { ...healthyReceipt(), eligible: true },
    })) as Record<string, any>;
    expect(early["unwind"]).toEqual({ budgetReservationCancelled: false, restoredMeters: null });
  });
});

describe("the 3/6/9 limits are read out of production, never transcribed into it", () => {
  /**
   * Walks the dimension upward through admitExpansion until the NAMED limit code
   * appears, so production decides where the boundary is and this file only
   * records it. Any other refusal throws rather than being mistaken for the
   * limit — that is what stops an unrelated failure from reading as a boundary.
   */
  function boundary(
    code: string, build: (value: number) => Record<string, unknown>, from: number, to: number,
  ): { readonly firstRefused: number | null; readonly lastAdmitted: number | null } {
    let lastAdmitted: number | null = null;
    for (let value = from; value <= to; value += 1) {
      const result = admitExpansion(build(value)) as Record<string, any>;
      if (result["ok"]) { lastAdmitted = value; continue; }
      const codes = (result["issues"] as Record<string, any>[]).map((one) => one["code"]);
      if (codes.includes(code)) return { firstRefused: value, lastAdmitted };
      throw new Error(`unexpected refusal at ${value}: ${codes.join(",")}`);
    }
    return { firstRefused: null, lastAdmitted };
  }

  it("admits at depth 3 and refuses at 4, discovered from the landed checker", () => {
    expect(boundary("ADMISSION_EXPANSION_DEPTH_EXCEEDED",
      (expansionDepth) => admissionRequest({ lineage: { expansionDepth, nodesAddedInExpansion: 2 } }),
      0, 5)).toEqual({ firstRefused: 4, lastAdmitted: 3 });
  });

  it("admits at child width 6 and refuses at 7, from the DERIVED width", () => {
    expect(boundary("ADMISSION_EXPANSION_CHILD_WIDTH_EXCEEDED",
      (width) => admissionRequest({ receipt: wideReceipt(width) }),
      1, 8)).toEqual({ firstRefused: 7, lastAdmitted: 6 });
  });

  it("admits at 9 nodes per expansion and refuses at 10", () => {
    expect(boundary("ADMISSION_EXPANSION_FANOUT_EXCEEDED",
      (nodesAddedInExpansion) =>
        admissionRequest({ lineage: { expansionDepth: 2, nodesAddedInExpansion } }),
      0, 11)).toEqual({ firstRefused: 10, lastAdmitted: 9 });
  });
});

const PREPARATION_CASES: readonly (readonly [string, string, string, Record<string, unknown>])[] = [
  ["EXPANSION_PREPARATION_INPUT_INVALID", "INPUT", "EXPANSION_PREPARATION",
    { deadlineEpochMs: "not-a-number" }],
  ["EXPANSION_PREPARATION_GRAPH_NOT_SUPERSEDABLE", "LIFECYCLE", "GRAPH_REVISION",
    { graphLifecycle: "SUPERSEDED" }],
  ["EXPANSION_PREPARATION_FENCE_UNPROVEN", "FENCE", "EXPANSION_PREPARATION",
    { fence: {
      authorityFencedRef: "fenced-authority-1", fencedAtEpoch: 7, subordinateAuthorityFenced: false,
    } }],
  ["EXPANSION_PREPARATION_FUNDING_NOT_RESERVED", "FUNDING", "EXPANSION_PREPARATION",
    { funding: {
      fundingRef: "funding-1", meter: "EXECUTION", quantity: 9,
      reservationId: "funding-reservation-1", state: "RELEASED",
    } }],
  ["EXPANSION_PREPARATION_POLICY_INPUT_INVALID", "POLICY", "POLICY_EVALUATION",
    { policy: policyInput({ sliceChain: [] }) }],
  ["EXPANSION_PREPARATION_POLICY_NOT_ELIGIBLE", "POLICY", "POLICY_EVALUATION",
    { policy: policyInput({ facts: [] }) }],
];

describe("every declared preparation code is produced with its own component and layer", () => {
  const ADMITTED_CASES: readonly (readonly [string, string, string, Record<string, unknown>])[] = [
    ["EXPANSION_PREPARATION_EVIDENCE_UNKNOWN", "EVIDENCE", "EXPANSION_PREPARATION",
      { truthClass: "UNKNOWN" }],
    ["EXPANSION_PREPARATION_BUDGET_NOT_RESERVED", "BUDGET", "EXPANSION_PREPARATION",
      { budgetReservation: {
        accountId: "acct.1", admissionRef: "adm.1", reservationId: "r-1", state: "RELEASED",
      } }],
    ["EXPANSION_PREPARATION_RESOURCES_NOT_HELD", "RESOURCE", "EXPANSION_PREPARATION",
      { resourceReservation: { epoch: 1, resourceIds: ["res.a"], state: "RELEASED" } }],
  ];

  function refusalOfPreparation(input: Record<string, unknown>): Record<string, any> {
    const result = prepareExpansion(input) as Record<string, any>;
    expect(result["ok"]).toBe(false);
    return result;
  }

  const base = (): Record<string, unknown> => admittedFrom(journey()["admission"].bound);

  it("covers the published vocabulary exactly, with a hand-pinned size", () => {
    expect(EXPANSION_PREPARATION_CODES.length).toBe(9);
    const produced = [
      ...PREPARATION_CASES.map(([code]) => code), ...ADMITTED_CASES.map(([code]) => code),
    ];
    expect(produced.length).toBe(9);
    expect([...new Set(produced)].sort()).toEqual([...EXPANSION_PREPARATION_CODES].sort());
  });

  it.each(PREPARATION_CASES)("refuses with %s from %s, owned by %s",
    (code, layer, component, override) => {
      const refusal = refusalOfPreparation(preparationInput(base(), override));
      expect([refusal["code"], refusal["layer"], refusal["component"]])
        .toEqual([code, layer, component]);
    });

  it.each(ADMITTED_CASES)("refuses with %s from %s, owned by %s",
    (code, layer, component, admittedOverride) => {
      const refusal =
        refusalOfPreparation(preparationInput({ ...base(), ...admittedOverride }));
      expect([refusal["code"], refusal["layer"], refusal["component"]])
        .toEqual([code, layer, component]);
    });
});

interface ApprovalCase {
  readonly apply: (request: Record<string, any>) => void;
  readonly code: string;
  readonly component: string;
  readonly layer: string;
  readonly name: string;
}

const APPROVAL_CASES: readonly ApprovalCase[] = [
  { name: "criteria byte moved", code: "EXPANSION_APPROVAL_CRITERIA_MISMATCH", layer: "BINDING",
    component: "EXPANSION_APPROVAL",
    apply: (request) => { request["approval"].approvalRef = "approval-2"; } },
  { name: "budget ref moved", code: "EXPANSION_APPROVAL_BUDGET_MISMATCH", layer: "BINDING",
    component: "EXPANSION_APPROVAL",
    apply: (request) => { request["approval"].budgetRef = hex("6"); } },
  { name: "approved scope narrowed", code: "EXPANSION_APPROVAL_SCOPE_MISMATCH", layer: "BINDING",
    component: "EXPANSION_APPROVAL",
    apply: (request) => { request["approval"].approvedNodeScope = ["child-1"]; } },
  { name: "quality ref moved", code: "EXPANSION_APPROVAL_QUALITY_MISMATCH", layer: "BINDING",
    component: "EXPANSION_APPROVAL",
    apply: (request) => { request["approval"].planQualityAssessmentRef = hex("7"); } },
  { name: "dependency delta moved", code: "EXPANSION_APPROVAL_DEPENDENCY_MISMATCH",
    layer: "BINDING", component: "EXPANSION_APPROVAL",
    apply: (request) => { request["approval"].dependencyChanges.removals = ["dependency-z"]; } },
  { name: "policy ref moved", code: "EXPANSION_APPROVAL_POLICY_MISMATCH", layer: "BINDING",
    component: "EXPANSION_APPROVAL",
    apply: (request) => { request["approval"].applicablePolicyRef = hex("0"); } },
  { name: "revision hash moved", code: "EXPANSION_APPROVAL_REVISION_MISMATCH", layer: "BINDING",
    component: "EXPANSION_APPROVAL",
    apply: (request) => { request["approval"].exactRevisionHash = hex("9"); } },
  { name: "claimed supersession hash moved", code: "EXPANSION_APPROVAL_SUPERSESSION_MISMATCH",
    layer: "BINDING", component: "EXPANSION_APPROVAL",
    apply: (request) => { request["claim"].supersessionAuthorityHash = hex("3"); } },
  { name: "RACE: budget released after preparation", code: "EXPANSION_APPROVAL_BUDGET_MISMATCH",
    layer: "BINDING", component: "EXPANSION_APPROVAL",
    apply: (request) => { request["claim"].budgetReservationState = "RELEASED"; } },
  { name: "RACE: resources released after preparation",
    code: "EXPANSION_APPROVAL_RESOURCE_MISMATCH", layer: "BINDING",
    component: "EXPANSION_APPROVAL",
    apply: (request) => { request["claim"].resourceReservationState = "RELEASED"; } },
  { name: "RACE: approval invalidated after preparation",
    code: "EXPANSION_APPROVAL_RECORD_INVALIDATED", layer: "LIFECYCLE",
    component: "EXPANSION_APPROVAL",
    apply: (request) => { request["approval"].validity = "INVALIDATED"; } },
  { name: "RACE: prepared deadline expired", code: "EXPANSION_APPROVAL_DEADLINE_EXPIRED",
    layer: "DEADLINE", component: "EXPANSION_APPROVAL",
    apply: (request) => { request["nowEpochMs"] = request["preparation"].bound.deadlineEpochMs + 1; } },
  { name: "RACE: stored preparation no longer matches its identity",
    code: "EXPANSION_APPROVAL_PREPARATION_STALE", layer: "IDENTITY",
    component: "EXPANSION_PREPARATION",
    apply: (request) => { request["preparation"].bound.admitted.goalVersion = 99; } },
  { name: "RACE: the claim names a re-prepared identity",
    code: "EXPANSION_APPROVAL_PREPARATION_MISMATCH", layer: "IDENTITY",
    component: "EXPANSION_APPROVAL",
    apply: (request) => {
      const reprepared = prepared(preparationInput(
        { ...admittedFrom(journey()["admission"].bound), revision: 99 },
      ));
      request["claim"].preparationIdentity = reprepared["identity"];
    } },
  { name: "RACE: supersession re-derived to a different authority",
    code: "EXPANSION_APPROVAL_SUPERSESSION_CHANGED", layer: "SUPERSESSION_KERNEL",
    component: "SUPERSESSION_ENGINE",
    apply: (request) => {
      request["preparation"].sources.supersession.successor.revisionId = "revision-9";
    } },
  { name: "RACE: stored policy no longer yields the bound decision",
    code: "EXPANSION_APPROVAL_POLICY_CHANGED", layer: "POLICY", component: "POLICY_EVALUATION",
    apply: (request) => { request["preparation"].sources.policy.decisionDigest = hex("e"); } },
  { name: "a REJECT decision", code: "EXPANSION_APPROVAL_NOT_APPROVED", layer: "LIFECYCLE",
    component: "EXPANSION_APPROVAL",
    apply: (request) => { request["command"].decision = "REJECT"; } },
  { name: "a non-human actor", code: "EXPANSION_APPROVAL_MANUAL_REQUIRED", layer: "ACTOR",
    component: "EXPANSION_APPROVAL",
    apply: (request) => {
      request["approval"] = {
        ...request["approval"], actor: `policy:${hex("f")}`, actorKind: "SYSTEM_POLICY",
        policyDecisionRef: hex("c"), riskTier: "R0", stepUpAuthRef: null,
        truthClass: "DAEMON_VERIFIED",
      };
      request["command"] = { ...request["command"], stepUpAuthRef: null };
    } },
  { name: "a request member missing", code: "EXPANSION_APPROVAL_INPUT_INVALID", layer: "INPUT",
    component: "EXPANSION_APPROVAL", apply: (request) => { delete request["claim"]; } },
  { name: "a structurally invalid approval record", code: "EXPANSION_APPROVAL_RECORD_INVALID",
    layer: "INPUT", component: "APPROVAL_VALIDATION",
    apply: (request) => { request["approval"].actor = ""; } },
  { name: "an illegal approval transition", code: "EXPANSION_APPROVAL_COMMAND_REFUSED",
    layer: "LIFECYCLE", component: "APPROVAL_COMMAND",
    apply: (request) => {
      request["approval"].lifecycle = "DECIDED";
      request["approval"].decision = "APPROVE";
    } },
];

describe("every declared approval code is produced, races included", () => {
  const request = (): Record<string, any> => {
    const preparation = prepared(preparationInput(admittedFrom(journey()["admission"].bound)));
    return clone({
      approval: humanApproval(preparation), claim: claimFor(preparation),
      command: {
        decision: "APPROVE", decisionReason: "approved after review", kind: "approval.decide",
        stepUpAuthRef: "step-up-1",
      },
      nowEpochMs: 1_700_000_300_000, preparation,
    });
  };

  it("the unperturbed request is APPROVED, so every refusal below is its own doing", () => {
    expect((approveExpansionManually(request()) as Record<string, any>)["ok"]).toBe(true);
  });

  it("covers the published vocabulary exactly, with a hand-pinned size", () => {
    expect(EXPANSION_APPROVAL_CODES.length).toBe(20);
    // 21 cases, 20 distinct codes: BUDGET_MISMATCH is reached twice, once by a
    // moved binding byte and once by the release race, and both are worth having.
    expect(APPROVAL_CASES.length).toBe(21);
    expect([...new Set(APPROVAL_CASES.map((one) => one.code))].sort())
      .toEqual([...EXPANSION_APPROVAL_CODES].sort());
  });

  it("names every post-preparation race the protocol has to survive", () => {
    expect(APPROVAL_CASES.filter((one) => one.name.startsWith("RACE:")).map((one) => one.code))
      .toEqual([
        "EXPANSION_APPROVAL_BUDGET_MISMATCH", "EXPANSION_APPROVAL_RESOURCE_MISMATCH",
        "EXPANSION_APPROVAL_RECORD_INVALIDATED", "EXPANSION_APPROVAL_DEADLINE_EXPIRED",
        "EXPANSION_APPROVAL_PREPARATION_STALE", "EXPANSION_APPROVAL_PREPARATION_MISMATCH",
        "EXPANSION_APPROVAL_SUPERSESSION_CHANGED", "EXPANSION_APPROVAL_POLICY_CHANGED",
      ]);
  });

  it.each(APPROVAL_CASES)("refuses $name with $code from $layer, owned by $component",
    ({ apply, code, component, layer }) => {
      const subject = request();
      apply(subject);
      const before = JSON.stringify(subject);
      const result = approveExpansionManually(subject) as Record<string, any>;
      expect([result["code"], result["layer"], result["component"]])
        .toEqual([code, layer, component]);
      // ALL-OR-NONE on the approval side: a refusal leaves no binding behind and
      // mutates no caller byte.
      expect(result["binding"]).toBeUndefined();
      expect(JSON.stringify(subject)).toBe(before);
    });
});
