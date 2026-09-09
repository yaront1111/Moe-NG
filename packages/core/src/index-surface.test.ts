/**
 * Package-ROOT reachability contract for @moe/core.
 *
 * Every specifier here is the bare package root. `packages/core/package.json`
 * pins `"exports": { ".": "./src/index.ts" }` — an exclusive map — so a deep
 * subpath would not resolve for a real consumer and testing one would prove
 * nothing. The expected namespace below is hand-transcribed, never derived from
 * the namespace under test, so a removed export AND an unreviewed addition both
 * go red.
 *
 * THREE GUARDS, EACH BLIND TO WHAT THE OTHER TWO SEE.
 *  1. The count and name-set pins below see RUNTIME VALUES only. A published
 *     `export type` is invisible to them.
 *  2. The type block therefore annotates each published type on a value that
 *     came through the bare specifier, so an unpublished type is a tsc error
 *     rather than a silently green test.
 *  3. Neither of those runs in real Node. vitest rewrites a `./foo.js`
 *     specifier back to `foo.ts`; Node does not, and `--experimental-strip-types`
 *     ERASES every `export type`. A closure published only as types satisfies
 *     tsc and leaves NOTHING importable. Only the child-process probes at the
 *     bottom can tell those apart.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import * as core from "@moe/core";
import type {
  ExpansionAdmittedFacts, ExpansionApprovalBinding, ExpansionApprovalClaim, ExpansionApprovalCode,
  ExpansionApprovalComponent, ExpansionApprovalCriteria, ExpansionApprovalLayer,
  ExpansionApprovalRefusal, ExpansionApprovalRequest, ExpansionApprovalResult,
  ExpansionBudgetReservationFacts, ExpansionFairnessFacts, ExpansionFenceFacts,
  ExpansionFundingFacts, ExpansionPolicyFacts, ExpansionPreparation, ExpansionPreparationCode,
  ExpansionPreparationComponent, ExpansionPreparationInput, ExpansionPreparationLayer,
  ExpansionPreparationRefusal, ExpansionPreparationResult, ExpansionPreparationSources,
  ExpansionPreparedFacts, ExpansionResourceReservationFacts,
} from "@moe/core";
import type {
  ApprovalDecisionRecord, PolicyEvaluationInput, PolicySliceDigestAcceptedResult,
  PolicySliceDigestCode, PolicySliceDigestLayer, PolicySliceDigestRefusal,
  PolicySliceDigestResult,
} from "@moe/core";
import type {
  GraphRevisionEventKind, GraphRevisionReplayAcceptedResult, GraphRevisionReplayCode,
  GraphRevisionReplayRefusal, GraphRevisionReplayResult,
} from "@moe/core";
import type {
  ApprovalAuthorityCode, ApprovalAuthorityDecision, ApprovalAuthorityLayer,
  ApprovalAuthorityRefusal, ApprovalAuthorityRequest, ApprovalAuthorityResult, ApprovalPolicy,
  ApprovalPolicyKind, HumanAuthorityGate, HumanAuthorityGrant, HumanAuthorityGrantResult,
} from "@moe/core";
import type {
  ProjectConfigurationCodecCode, ProjectConfigurationCodecLayer,
  ProjectConfigurationCodecRefusal, ProjectConfigurationManifestCreateResult,
  ProjectConfigurationManifestDecodeResult, ProjectConfigurationManifestEncodeResult,
} from "@moe/core";
import type {
  AcceptanceContract, AcceptanceContractApplicability, AcceptanceContractCode,
  AcceptanceContractCreateResult, AcceptanceContractDecodeResult, AcceptanceContractDigestResult,
  AcceptanceContractDraft, AcceptanceContractEncodeResult, AcceptanceContractLayer,
  AcceptanceContractRefusal, AcceptanceCriteriaContent, AcceptanceCriteriaContentDecodeResult,
  AcceptanceCriteriaContentEncodeResult, AcceptanceCriterionContent,
  AcceptanceCriterionContentCreateResult, AcceptanceCriterionContentDraft,
  AcceptanceCriterionContentResult, AcceptanceCriterionObligation, AcceptanceEvidenceRequirement,
  PlanExecutionContent, PlanExecutionContentCreateResult, PlanExecutionContentDecodeResult,
  PlanExecutionContentDraft, PlanExecutionContentEncodeResult, PlanExecutionContentResult,
  PlanRevision, PlanRevisionCode, PlanRevisionCreateResult, PlanRevisionDecodeResult,
  PlanRevisionDigestResult, PlanRevisionDraft, PlanRevisionEncodeResult, PlanRevisionGraphBinding,
  PlanRevisionLayer, PlanRevisionRefusal, PlanRevisionStep,
  SourceSnapshot, SourceSnapshotCode, SourceSnapshotCreateResult, SourceSnapshotDecodeResult,
  SourceSnapshotDigestResult, SourceSnapshotDraft, SourceSnapshotEncodeResult,
  SourceSnapshotLayer, SourceSnapshotRef, SourceSnapshotRefAdmission, SourceSnapshotRefusal,
} from "@moe/core";
import type {
  ProductAcceptanceBindingRequest, ProductAcceptanceBindingResult,
  ProductContractAmendmentResult, ProductContractClarification,
  ProductContractClarificationOption, ProductContractCode, ProductContractCreateResult,
  ProductContractCriterion, ProductContractDecodeResult, ProductContractDigestResult,
  ProductContractEncodeResult, ProductContractGate1Result,
  ProductContractGraphBinding, ProductContractLayer, ProductContractLineage,
  ProductContractMaterialityResult, ProductContractProjection, ProductContractProjectionDigest,
  ProductContractRefusal, ProductContractRequirement, ProductContractRevision,
  ProductContractRevisionDraft,
} from "@moe/core";
import type {
  ProductAcceptanceBindingV2Request, ProductAcceptanceBindingV2Result,
  ProductContractCurrentRevisionSlotV2, ProductContractCurrentRevisionSlotV2EncodeResult,
  ProductContractCurrentRevisionSlotV2Result,
  ProductContractRevisionV2, ProductContractRevisionV2Draft,
  ProductContractV2Assumption, ProductContractV2Budget, ProductContractV2BudgetKind,
  ProductContractV2Code, ProductContractV2CreateResult, ProductContractV2Criterion,
  ProductContractRevisionV2Ref, ProductContractV2DecisionOption,
  ProductContractV2DecodeResult, ProductContractV2DigestResult,
  ProductContractV2AmendmentResult,
  ProductContractV2EncodeResult, ProductContractV2Journey, ProductContractV2Layer,
  ProductContractV2Lineage, ProductContractV2MaterialDecision,
  ProductContractV2NegativeScope, ProductContractV2Objective, ProductContractV2Priority,
  ProductContractV2ProductCompleteDefinition, ProductContractV2Refusal,
  ProductContractV2Requirement, ProductContractV2SuccessMetric, ProductContractV2UserJob,
} from "@moe/core";
import {
  PROJECT_CONFIGURATION_LIMIT_KEYS, PROJECT_CONFIGURATION_SCHEMA_VERSION,
} from "@moe/contracts";
import type { ProjectConfigurationSettings } from "@moe/contracts";

type ExportKind = "array" | "function" | "record" | "string";
/**
 * Hand-transcribed: 20 pre-existing vocabulary values + 5 transition records +
 * 3 obligation/layer strings + 33 pre-existing functions + the 8 expansion
 * preparation and approval values + the 6 project-configuration codec values
 * (2 frozen vocabularies, 1 domain tag, 3 functions) published by task-bcea7056
 * + the 5 approval policy and human-authority values (3 frozen vocabularies,
 * 2 functions) published by task-5d8f11c8 + the 4 graph revision replay values
 * (2 frozen vocabularies, 1 layer tag, 1 function) published by task-ee27ed7c
 * + the 4 content-addressed policy-slice digest values + the 2 bounded product
 * contract revision REF values (1 frozen key roster, 1 admission) published by
 * task-ce8398e7; the two types beside them publish no runtime key.
 */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["ACCEPTANCE_CONTRACT_CODES", "array"], ["ACCEPTANCE_CONTRACT_DIGEST_DOMAIN", "string"],
  ["ACCEPTANCE_CONTRACT_LAYERS", "array"], ["ACCEPTANCE_CONTRACT_VERSION", "string"],
  ["ACCEPTANCE_CRITERION_CONTENT_DOMAIN", "string"],
  ["APPROVAL_ACTOR_KINDS", "array"],
  ["APPROVAL_AUTHORITY_CODES", "array"], ["APPROVAL_AUTHORITY_LAYERS", "array"],
  ["APPROVAL_COMMAND_KINDS", "array"], ["APPROVAL_POLICY_KINDS", "array"],
  ["BUILT_IN_DELIVERY_PROFILE_QUALIFICATIONS", "array"],
  ["BUILT_IN_DELIVERY_PROFILE_REVISIONS", "array"],
  ["CAPABILITY_CATALOG_AUTHORITY_KINDS", "array"],
  ["CAPABILITY_CATALOG_CODES", "array"],
  ["CAPABILITY_CATALOG_CRITERION_CATEGORIES", "array"],
  ["CAPABILITY_CATALOG_DELIVERY_PROFILE_FAMILY_IDS", "array"],
  ["CAPABILITY_CATALOG_DIGEST_DOMAIN", "string"],
  ["CAPABILITY_CATALOG_LAYERS", "array"],
  ["CAPABILITY_CATALOG_LIMITS", "record"],
  ["CAPABILITY_CATALOG_REQUIRED_VERIFIER_ROLES", "array"],
  ["CAPABILITY_CATALOG_RESOURCE_KINDS", "array"],
  ["CAPABILITY_CATALOG_ROLES", "array"],
  ["CAPABILITY_CATALOG_VERSION", "string"],
  ["CARRY_FORWARD_REASON_CODES", "array"], ["CORE_DECISION_REASON_OBLIGATION", "string"],
  ["CORE_GRAPH_REVISION_REPLAY", "string"], ["CORE_STEP_UP_OBLIGATION", "string"],
  ["CUTOVER_COMMAND_KINDS", "array"], ["CUTOVER_TRANSITIONS", "record"],
  ["DELIVERY_PROFILE_BENCHMARK_VERDICTS", "array"],
  ["DELIVERY_PROFILE_CODES", "array"],
  ["DELIVERY_PROFILE_DIGEST_DOMAIN", "string"],
  ["DELIVERY_PROFILE_FAMILY_DEFINITIONS", "array"],
  ["DELIVERY_PROFILE_FAMILY_DEFINITION_DIGEST_DOMAIN", "string"],
  ["DELIVERY_PROFILE_FAMILY_IDS", "array"],
  ["DELIVERY_PROFILE_LAYERS", "array"],
  ["DELIVERY_PROFILE_LIMITS", "record"],
  ["DELIVERY_PROFILE_MODEL_PROVIDER_CAPABILITIES", "array"],
  ["DELIVERY_PROFILE_OPERATOR_DECISIONS", "array"],
  ["DELIVERY_PROFILE_POLICY_KINDS", "array"],
  ["DELIVERY_PROFILE_QUALIFICATION_DIGEST_DOMAIN", "string"],
  ["DELIVERY_PROFILE_QUALIFICATION_VALIDITIES", "array"],
  ["DELIVERY_PROFILE_QUALIFICATION_VERSION", "string"],
  ["DELIVERY_PROFILE_RECIPE_DIGEST_DOMAIN", "string"],
  ["DELIVERY_PROFILE_RECIPE_KINDS", "array"],
  ["DELIVERY_PROFILE_RESOURCE_CLASSES", "array"],
  ["DELIVERY_PROFILE_STACK_ROLES", "array"],
  ["DELIVERY_PROFILE_VERSION", "string"],
  ["EXECUTION_ISOLATION_BUILD_AGENT_MOUNT_SHAPE", "array"],
  ["EXECUTION_ISOLATION_FRESH_VERIFIER_MOUNT_SHAPE", "array"],
  ["EXECUTION_ISOLATION_NETWORK_ACCESS_MODES", "array"],
  ["EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES", "array"],
  ["EXECUTION_ISOLATION_PROFILE_CODES", "array"],
  ["EXECUTION_ISOLATION_PROFILE_DEFAULT_PLANE", "string"],
  ["EXECUTION_ISOLATION_PROFILE_DIGEST_DOMAIN", "string"],
  ["EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS", "array"],
  ["EXECUTION_ISOLATION_PROFILE_LAYERS", "array"],
  ["EXECUTION_ISOLATION_PROFILE_LIMITS", "record"],
  ["EXECUTION_ISOLATION_PROFILE_PLANES", "array"],
  ["EXECUTION_ISOLATION_PROFILE_PURPOSES", "array"],
  ["EXECUTION_ISOLATION_PROFILE_VERSION", "string"],
  ["EXPANSION_APPROVAL_CODES", "array"], ["EXPANSION_APPROVAL_COMPONENTS", "array"],
  ["EXPANSION_APPROVAL_LAYERS", "array"],
  ["EXPANSION_HOLD_CAUSES", "array"], ["EXPANSION_HOLD_COMMAND_KINDS", "array"],
  ["EXPANSION_HOLD_ERROR_CODES", "array"], ["EXPANSION_HOLD_LAYERS", "array"],
  ["EXPANSION_PREPARATION_CODES", "array"], ["EXPANSION_PREPARATION_COMPONENTS", "array"],
  ["EXPANSION_PREPARATION_LAYERS", "array"],
  ["GOAL_COMMAND_KINDS", "array"], ["GOAL_TRANSITIONS", "record"],
  ["GRAPH_REVISION_COMMAND_KINDS", "array"], ["GRAPH_REVISION_EVENT_KINDS", "array"],
  ["GRAPH_REVISION_REPLAY_CODES", "array"], ["GRAPH_REVISION_TRANSITIONS", "record"],
  ["LIVE_QUIESCE_EVIDENCE_LAYER", "string"], ["LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES", "array"],
  ["PLANNING_EXPANSION_ERROR_CODES", "array"], ["PLANNING_EXPANSION_LAYERS", "array"],
  ["PLANNING_EXPANSION_TARGETS", "array"], ["PLANNING_RUN_COMMAND_KINDS", "array"],
  ["PLANNING_RUN_TRANSITIONS", "record"],
  ["PLAN_EXECUTION_CONTENT_DOMAIN", "string"], ["PLAN_REVISION_CODES", "array"],
  ["PLAN_REVISION_DIGEST_DOMAIN", "string"], ["PLAN_REVISION_LAYERS", "array"],
  ["PLAN_REVISION_VERSION", "string"],
  ["POLICY_AUTO_APPROVAL_TIERS", "array"], ["POLICY_CLASSIFIED_SLICE_KEYS", "array"],
  ["POLICY_OBLIGATION_KINDS", "array"],
  ["POLICY_OUTCOMES", "array"], ["POLICY_OUTCOME_DOMINANCE", "array"],
  ["POLICY_REASON_CODES", "array"], ["POLICY_RISK_TIERS", "array"],
  ["POLICY_RULE_EFFECTS", "array"], ["POLICY_SLICE_DIGEST_CODES", "array"],
  ["POLICY_SLICE_DIGEST_LAYERS", "array"], ["POLICY_SLICE_DIGEST_VERSION", "string"],
  ["POLICY_SLICE_KEYS", "array"],
  ["PRINCIPAL_KINDS", "array"],
  ["PRODUCT_CONTRACT_CODES", "array"],
  ["PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_DIGEST_DOMAIN", "string"],
  ["PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION", "string"],
  ["PRODUCT_CONTRACT_DIGEST_DOMAIN", "string"],
  ["PRODUCT_CONTRACT_LAYERS", "array"],
  ["PRODUCT_CONTRACT_PROJECTION_DIGEST_DOMAIN", "string"],
  ["PRODUCT_CONTRACT_REVISION_REF_KEYS", "array"],
  ["PRODUCT_CONTRACT_V2_BUDGET_KINDS", "array"],
  ["PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_CODES", "array"],
  ["PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER", "string"],
  ["PRODUCT_CONTRACT_V2_CLARIFICATION_PROJECTION_DIGEST_DOMAIN", "string"],
  ["PRODUCT_CONTRACT_V2_CODES", "array"],
  ["PRODUCT_CONTRACT_V2_DIGEST_DOMAIN", "string"],
  ["PRODUCT_CONTRACT_V2_LAYERS", "array"],
  ["PRODUCT_CONTRACT_V2_LIMITS", "record"],
  ["PRODUCT_CONTRACT_V2_PRIORITIES", "array"],
  ["PRODUCT_CONTRACT_V2_VERSION", "string"],
  ["PRODUCT_CONTRACT_VERSION", "string"],
  ["PROJECT_COMMAND_KINDS", "array"],
  ["PROJECT_CONFIGURATION_CODEC_CODES", "array"],
  ["PROJECT_CONFIGURATION_CODEC_LAYERS", "array"],
  ["PROJECT_CONFIGURATION_SETTINGS_DIGEST_DOMAIN", "string"],
  ["PROJECT_TRANSITIONS", "record"],
  ["SESSION_AUTH_LAYERS", "array"], ["SESSION_STATUSES", "array"],
  ["SOURCE_SNAPSHOT_CODES", "array"], ["SOURCE_SNAPSHOT_DIGEST_DOMAIN", "string"],
  ["SOURCE_SNAPSHOT_LAYERS", "array"], ["SOURCE_SNAPSHOT_LIMITS", "record"],
  ["SOURCE_SNAPSHOT_REF_KEYS", "array"], ["SOURCE_SNAPSHOT_VERSION", "string"],
  ["SUPERSESSION_DISPOSITION_KINDS", "array"], ["SUPERSESSION_KERNEL_LAYER", "string"],
  ["VERIFICATION_RECIPE_BUILD_AGENT_SAFE_ENVIRONMENT_NAMES", "array"],
  ["VERIFICATION_RECIPE_CODES", "array"],
  ["VERIFICATION_RECIPE_DIGEST_DOMAIN", "string"],
  ["VERIFICATION_RECIPE_FORBIDDEN_SHELL_TOOLS", "array"],
  ["VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES", "array"],
  ["VERIFICATION_RECIPE_LAYERS", "array"],
  ["VERIFICATION_RECIPE_LIMITS", "record"],
  ["VERIFICATION_RECIPE_NETWORK_ACCESS_MODES", "array"],
  ["VERIFICATION_RECIPE_NETWORK_PLANE_IDENTITIES", "array"],
  ["VERIFICATION_RECIPE_OUTPUT_MOUNTS", "array"],
  ["VERIFICATION_RECIPE_VERSION", "string"],
  ["admitProductContractRevisionRef", "function"], ["admitSourceSnapshotRef", "function"],
  ["admitVerificationRecipeForExecutionProfile", "function"],
  ["advanceProductContractCurrentRevisionSlotV2", "function"],
  ["applyApprovalCommand", "function"], ["applyApprovalInvalidation", "function"],
  ["approveExpansionManually", "function"], ["assessClarificationMateriality", "function"],
  ["assessProductContractClarificationMaterialityV2", "function"],
  ["authenticateCommand", "function"],
  ["authenticateSession", "function"], ["canonicalizeCapabilities", "function"],
  ["computeDeliveryProfileRecipeDigest", "function"],
  ["createAcceptanceContract", "function"], ["createAcceptanceCriterionContent", "function"],
  ["createCapabilityCatalogRevision", "function"], ["createCredential", "function"],
  ["createDeliveryProfileQualification", "function"],
  ["createDeliveryProfileRevision", "function"],
  ["createExecutionIsolationProfileRevision", "function"],
  ["createPlanExecutionContent", "function"],
  ["createPlanRevision", "function"], ["createPrincipal", "function"],
  ["createProductContractCurrentRevisionSlotV2", "function"],
  ["createProductContractRevision", "function"],
  ["createProductContractRevisionV2", "function"],
  ["createProjectConfigurationManifest", "function"], ["createSession", "function"],
  ["createSourceSnapshot", "function"],
  ["createVerificationRecipeRevision", "function"],
  ["decideApprovalAuthority", "function"], ["decideSupersession", "function"],
  ["decodeAcceptanceContractBytes", "function"],
  ["decodeAcceptanceCriteriaContentBytes", "function"],
  ["decodeCapabilityCatalogRevisionBytes", "function"],
  ["decodeDeliveryProfileQualificationBytes", "function"],
  ["decodeDeliveryProfileRevisionBytes", "function"],
  ["decodeExecutionIsolationProfileRevisionBytes", "function"],
  ["decodePlanExecutionContentBytes", "function"],
  ["decodePlanRevisionBytes", "function"],
  ["decodeProductContractCurrentRevisionSlotV2Bytes", "function"],
  ["decodeProductContractRevisionBytes", "function"],
  ["decodeProductContractRevisionV2Bytes", "function"],
  ["decodeProjectConfigurationManifestBytes", "function"],
  ["decodeSourceSnapshotBytes", "function"],
  ["decodeVerificationRecipeRevisionBytes", "function"],
  ["deliveryProfileFamilyDefinition", "function"],
  ["deriveAcceptanceContractDigest", "function"],
  ["deriveAcceptanceCriterionContent", "function"],
  ["deriveCapabilityCatalogRevisionDigest", "function"],
  ["deriveLiveQuiesceEvidenceDigest", "function"],
  ["derivePlanExecutionContent", "function"], ["derivePlanRevisionDigest", "function"],
  ["derivePolicySliceDigest", "function"],
  ["deriveProductContractClarificationProjectionDigestV2", "function"],
  ["deriveProductContractRevisionDigest", "function"],
  ["deriveProductContractRevisionV2Digest", "function"],
  ["deriveSourceSnapshotDigest", "function"],
  ["encodeAcceptanceContract", "function"],
  ["encodeAcceptanceCriteriaContent", "function"],
  ["encodeCapabilityCatalogRevision", "function"],
  ["encodeDeliveryProfileQualification", "function"],
  ["encodeDeliveryProfileRevision", "function"],
  ["encodeExecutionIsolationProfileRevision", "function"],
  ["encodePlanExecutionContent", "function"],
  ["encodePlanRevision", "function"],
  ["encodeProductContractCurrentRevisionSlotV2", "function"],
  ["encodeProductContractRevision", "function"],
  ["encodeProductContractRevisionV2", "function"],
  ["encodeProjectConfigurationManifest", "function"],
  ["encodeSourceSnapshot", "function"],
  ["encodeVerificationRecipeRevision", "function"],
  ["evaluateCarryForward", "function"], ["evaluatePolicy", "function"],
  ["grantHumanAuthority", "function"],
  ["inspectPlanningExpansionContract", "function"], ["isCurrentGeneration", "function"],
  ["isSessionUsableAt", "function"], ["matchCapability", "function"],
  ["prepareExpansion", "function"], ["productContractGate1Authority", "function"],
  ["reduceCutover", "function"], ["reduceExpansionPlanningHold", "function"],
  ["reduceGoal", "function"], ["reduceGraphRevision", "function"],
  ["reducePlanningRun", "function"], ["reduceProject", "function"],
  ["rejectRun", "function"],
  ["replayGraphRevisionEvents", "function"],
  ["resolveCapabilityCatalogEntry", "function"],
  ["resolveQualifiedDeliveryProfile", "function"],
  ["rotateCredential", "function"],
  ["serializeLiveQuiesceEvidenceCanonical", "function"],
  ["snapshotPlanningRunContractState", "function"],
  ["snapshotProjectState", "function"],
  ["validExpansionCreateCommand", "function"], ["validExpansionCreatedEvent", "function"],
  ["validExpansionHoldBinding", "function"], ["validExpansionProposalIdentity", "function"],
  ["validExpansionProposeCommand", "function"], ["validExpansionSealedEvent", "function"],
  ["validPlanningRunContractState", "function"],
  ["validateApprovalDependencyChanges", "function"], ["validateApprovalRecord", "function"],
  ["validateProductAcceptanceBinding", "function"],
  ["validateProductAcceptanceBindingV2", "function"],
  ["validateProductContractAmendment", "function"],
  ["validateProductContractGate1", "function"],
  ["validateProductContractGate1V2", "function"],
  ["validateProductContractV2Amendment", "function"],
];
const surface: Readonly<Record<string, unknown>> = core;

it("generates one expectation per published root export", () => {
  expect(EXPECTED_EXPORTS.length).toBe(256);
});

it("publishes exactly the reviewed root namespace, with no loss and no addition", () => {
  expect(Object.keys(core).filter((key) => key !== "default").sort())
    .toEqual(EXPECTED_EXPORTS.map(([name]) => name));
});

// The daemon re-validates the policy slice shape against its own exact roster, so the two
// tuples core publishes are the single source both sides read. Asserted as SET EQUALITY in
// both directions rather than as a subset: a key added to one tuple and not the other is the
// exact drift a subset check keeps green, and it is what the mirror would then copy.
it("publishes two slice-key rosters that agree in both directions and are frozen", () => {
  expect([...core.POLICY_CLASSIFIED_SLICE_KEYS].sort())
    .toEqual([...core.POLICY_SLICE_KEYS, "riskClassifications"].sort());
  // The exact CARDINALITIES the daemon's two exactObject calls compare against: pinning them
  // is what makes that pair mean "exactly three OR exactly four" rather than "at least three".
  expect(core.POLICY_SLICE_KEYS).toHaveLength(3);
  expect(core.POLICY_CLASSIFIED_SLICE_KEYS).toHaveLength(4);
  expect(Object.isFrozen(core.POLICY_CLASSIFIED_SLICE_KEYS)).toBe(true);
  expect(Object.isFrozen(core.POLICY_SLICE_KEYS)).toBe(true);
});

it.each(EXPECTED_EXPORTS)("publishes %s on the package root as a %s", (name, kind) => {
  const value = surface[name];
  // Checked FIRST and by name: an import cycle yields a TDZ-undefined binding
  // that satisfies every `typeof` check below by reporting "undefined".
  expect(`${name}=${value === undefined ? "undefined" : "defined"}`).toBe(`${name}=defined`);
  if (kind === "array") expect(Array.isArray(value)).toBe(true);
  else if (kind === "record") {
    expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
  } else expect(typeof value).toBe(kind);
});

/**
 * The expansion closure this task published, exercised through the bare
 * specifier. Fixtures are rebuilt inline: expansion-approval.test.ts is not
 * importable through the exclusive `exports` map, so a real consumer could not
 * reach its helpers either. They are fixture DATA — every verdict below is
 * decided by the production surface, never re-derived here.
 */
const hex = (character: string): string => character.repeat(64);

const PREDECESSOR = { graphContentHash: hex("a"), graphEpoch: 7, revisionId: "revision-1" };
const SUCCESSOR = {
  graphContentHash: hex("b"), graphEpoch: 8,
  predecessorGraphContentHash: PREDECESSOR.graphContentHash,
  predecessorRevisionId: PREDECESSOR.revisionId, revisionId: "revision-2",
};

/** Tier R2 is human-only (design 710), so this evaluates to REQUIRE_HUMAN_APPROVAL. */
const policyInput = (): PolicyEvaluationInput => ({
  action: "graph.expand", actor: "human:reviewer-1", callerRiskHint: null,
  decisionDigest: hex("c"), evaluatedAtEpochMs: 1_700_000_000_000,
  evaluatorVersion: "policy-evaluator-v1",
  facts: [{ factId: "fact-risk", tier: "R2", truthClass: "DAEMON_VERIFIED" }],
  graphNodeRevisionRefs: ["revision-1"], policyRevisionRef: hex("d"),
  requiredFactIds: ["fact-risk"], scope: ["child-a", "child-b"],
  sliceChain: [{
    autoApprovalOptIns: [], sliceRef: "slice-root",
    rules: [{ effect: "ALLOW", obligations: [], requiredFactIds: ["fact-risk"], ruleId: "rule-1" }],
  }],
  waivers: [],
});

it("publishes the policy-slice digest authority and every result type", () => {
  const result: PolicySliceDigestResult = core.derivePolicySliceDigest({
    autoApprovalOptIns: [], rules: [], sliceRef: "slice-root",
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    const accepted: PolicySliceDigestAcceptedResult = result;
    expect(accepted.digest).toMatch(/^[0-9a-f]{64}$/);
  } else {
    const refusal: PolicySliceDigestRefusal = result;
    const code: PolicySliceDigestCode = refusal.code;
    const layer: PolicySliceDigestLayer = refusal.layer;
    expect([code, layer]).toEqual(["POLICY_SLICE_INVALID", "POLICY_SLICE_CODEC"]);
  }
});

/**
 * Typed as the PUBLISHED ExpansionPreparationInput rather than cast into it. A
 * cast would assert the shape instead of checking it, and the point of the
 * annotation is that tsc rejects the fixture if the published type drifts from
 * what prepareExpansion actually accepts.
 */
const preparationInput = (): ExpansionPreparationInput => ({
  admitted: {
    budgetReservation: {
      accountId: "account-1", admissionRef: "admission-1",
      reservationId: "budget-reservation-1", state: "RESERVED",
    },
    childKeys: ["child-a", "child-b"], evidenceDigest: hex("1"),
    fairness: {
      capRevisionRef: "cap-revision-3", opportunityRef: "opportunity-1",
      resourceId: "resource-1", workItemId: "work-item-1",
    },
    goalVersion: 4, observedAtSequence: 12, proposalId: "proposal-1", qualityDigest: hex("2"),
    resourceReservation: { epoch: 5, resourceIds: ["resource-1"], state: "HELD" },
    revision: 3, sourceDigests: [hex("3")], truthClass: "DAEMON_VERIFIED",
  },
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
  graphLifecycle: "ACTIVE", policy: policyInput(),
  supersession: {
    dispositions: [{
      kind: "ADD", nodeKey: "node-add", predecessorAuthorityHash: null,
      safeCarry: null, successorAuthorityHash: hex("1"),
    }],
    expectedPredecessor: { ...PREDECESSOR }, successor: { ...SUCCESSOR },
    supportedCanonicalizerVersions: ["canon-v1"],
  },
});

function preparedFrom(input: unknown): ExpansionPreparation {
  const result: ExpansionPreparationResult = core.prepareExpansion(input);
  if (!result.ok) throw new Error(`fixture preparation refused with ${result.code}`);
  return result.preparation;
}

it("prepares an expansion through the root and names every prepared type", () => {
  const preparation: ExpansionPreparation = preparedFrom(preparationInput());
  const bound: ExpansionPreparedFacts = preparation.bound;
  const sources: ExpansionPreparationSources = preparation.sources;
  const admitted: ExpansionAdmittedFacts = bound.admitted;
  const criteria: ExpansionApprovalCriteria = bound.criteria;
  const fence: ExpansionFenceFacts = bound.fence;
  const funding: ExpansionFundingFacts = bound.funding;
  const policy: ExpansionPolicyFacts = bound.policyDecision;
  const budget: ExpansionBudgetReservationFacts = admitted.budgetReservation;
  const resources: ExpansionResourceReservationFacts = admitted.resourceReservation;
  const fairness: ExpansionFairnessFacts = admitted.fairness;

  expect(preparation.identity).toMatch(/^[0-9a-f]{64}$/u);
  expect(bound.supersessionAuthorityHash).toMatch(/^[0-9a-f]{64}$/u);
  expect(policy.decision).toBe("REQUIRE_HUMAN_APPROVAL");
  expect(policy.policyRevisionRef).toBe(hex("d"));
  expect([budget.state, resources.state, funding.state]).toEqual(["RESERVED", "HELD", "RESERVED"]);
  expect([criteria.riskTier, fence.subordinateAuthorityFenced]).toEqual(["R2", true]);
  expect([fairness.workItemId, admitted.truthClass]).toEqual(["work-item-1", "DAEMON_VERIFIED"]);
  expect(sources.supersession.expectedPredecessor.revisionId).toBe("revision-1");
});

it("refuses a preparation from the root, naming code, component and layer", () => {
  const input = { ...preparationInput(), graphLifecycle: "SUPERSEDED" };
  const result: ExpansionPreparationResult = core.prepareExpansion(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ExpansionPreparationRefusal = result;
  const code: ExpansionPreparationCode = "EXPANSION_PREPARATION_GRAPH_NOT_SUPERSEDABLE";
  const component: ExpansionPreparationComponent = refusal.component;
  const layer: ExpansionPreparationLayer = refusal.layer;
  expect([refusal.code, component, layer]).toEqual([code, "GRAPH_REVISION", "LIFECYCLE"]);
  expect(core.EXPANSION_PREPARATION_CODES).toContain(code);
  expect(core.EXPANSION_PREPARATION_COMPONENTS).toContain(component);
  expect(core.EXPANSION_PREPARATION_LAYERS).toContain(layer);
});

/**
 * Composition control: the history is produced by the ROOT's own `reduceGraphRevision` and fed to
 * the ROOT's `replayGraphRevisionEvents`, so this proves the published replay surface composes with
 * the published command surface — not merely that both names resolve.
 */
it("replays a graph revision history from the root, naming code, layer and vocabularies", () => {
  const created = core.reduceGraphRevision(undefined, {
    commandId: "cmd-create", expectedVersion: 0, goalRef: "goal-1",
    graphContentHash: hex("2"), kind: "graph_revision.create", planHash: hex("1"),
    revisionId: "revision-1",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("expected an accepted create");
  const replayed: GraphRevisionReplayResult = core.replayGraphRevisionEvents(created.events);
  expect(replayed.ok).toBe(true);
  if (!replayed.ok) throw new Error("expected an accepted replay");
  const hydrated: GraphRevisionReplayAcceptedResult = replayed;
  const eventKind: GraphRevisionEventKind = "GraphRevisionCreated";
  expect([hydrated.state.lifecycle, hydrated.events[0]?.kind]).toEqual(["DRAFT", eventKind]);
  expect(hydrated.state).toEqual(created.state);

  const refused: GraphRevisionReplayResult = core.replayGraphRevisionEvents([]);
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("expected a refusal");
  const refusal: GraphRevisionReplayRefusal = refused;
  const code: GraphRevisionReplayCode = "GRAPH_REVISION_REPLAY_MISSING_CREATE";
  expect([refusal.code, refusal.layer]).toEqual([code, core.CORE_GRAPH_REVISION_REPLAY]);
  expect(core.GRAPH_REVISION_REPLAY_CODES).toContain(code);
  expect(core.GRAPH_REVISION_EVENT_KINDS).toContain(eventKind);
});

const humanApproval = (): ApprovalDecisionRecord => ({
  actor: "human:reviewer-1", actorKind: "HUMAN", applicablePolicyRef: hex("d"),
  approvalRef: "approval-1", approvedNodeScope: ["child-a", "child-b"], budgetRef: hex("4"),
  criteriaRef: hex("5"), decision: null, decisionReason: null,
  dependencyChanges: { additions: ["dependency-a"], challenges: [], removals: [] },
  exactRevisionHash: hex("b"), lifecycle: "PENDING", planQualityAssessmentRef: hex("2"),
  policyDecisionRef: hex("c"), riskTier: "R2", stepUpAuthRef: "step-up-1",
  truthClass: "HUMAN_APPROVED", validity: "CURRENT",
});

function approvalRequest(): ExpansionApprovalRequest {
  const preparation = preparedFrom(preparationInput());
  const claim: ExpansionApprovalClaim = {
    budgetReservationId: preparation.bound.admitted.budgetReservation.reservationId,
    budgetReservationState: preparation.bound.admitted.budgetReservation.state,
    preparationIdentity: preparation.identity,
    resourceEpoch: preparation.bound.admitted.resourceReservation.epoch,
    resourceIds: [...preparation.bound.admitted.resourceReservation.resourceIds],
    resourceReservationState: preparation.bound.admitted.resourceReservation.state,
    supersessionAuthorityHash: preparation.bound.supersessionAuthorityHash,
  };
  return {
    approval: humanApproval(), claim,
    command: {
      decision: "APPROVE", decisionReason: "approved after review",
      kind: "approval.decide", stepUpAuthRef: "step-up-1",
    },
    nowEpochMs: 1_700_000_300_000, preparation,
  };
}

it("approves an expansion manually through the root and names every approval type", () => {
  const request: ExpansionApprovalRequest = approvalRequest();
  const result: ExpansionApprovalResult = core.approveExpansionManually(request);
  if (!result.ok) throw new Error(`unexpected refusal ${result.code}`);
  const binding: ExpansionApprovalBinding = result.binding;
  expect(binding.approvalRef).toBe("approval-1");
  expect(binding.preparationIdentity).toBe(request.preparation.identity);
  expect(binding.identity).toMatch(/^[0-9a-f]{64}$/u);
  expect(binding.decidedApproval.decision).toBe("APPROVE");
});

it("refuses a non-human approval from the root, naming code, component and layer", () => {
  const request: ExpansionApprovalRequest = {
    ...approvalRequest(), approval: { ...humanApproval(), actorKind: "SYSTEM_POLICY" },
  };
  const result: ExpansionApprovalResult = core.approveExpansionManually(request);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ExpansionApprovalRefusal = result;
  const code: ExpansionApprovalCode = refusal.code;
  const component: ExpansionApprovalComponent = refusal.component;
  const layer: ExpansionApprovalLayer = refusal.layer;
  expect(core.EXPANSION_APPROVAL_CODES).toContain(code);
  expect(core.EXPANSION_APPROVAL_COMPONENTS).toContain(component);
  expect(core.EXPANSION_APPROVAL_LAYERS).toContain(layer);
  expect([code, layer]).toEqual(["EXPANSION_APPROVAL_RECORD_INVALID", "INPUT"]);
});

it("publishes the core expansion vocabularies as frozen closed sets", () => {
  for (const vocabulary of [
    core.EXPANSION_APPROVAL_CODES, core.EXPANSION_APPROVAL_COMPONENTS,
    core.EXPANSION_APPROVAL_LAYERS, core.EXPANSION_PREPARATION_CODES,
    core.EXPANSION_PREPARATION_COMPONENTS, core.EXPANSION_PREPARATION_LAYERS,
  ]) {
    expect(Object.isFrozen(vocabulary)).toBe(true);
  }
});

/**
 * Typed as the PUBLISHED contract shape rather than cast into it, for the same
 * reason as the expansion fixture above: a cast would assert the shape instead
 * of checking it against what the codec actually accepts.
 */
const configurationSettings = (): ProjectConfigurationSettings => ({
  isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
  limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key, index) => ({ key, value: index + 1 })),
  network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
  orchestrationSource: { objectFormat: "sha256", sourceSha: hex("2") },
  policy: {
    acceptanceGate: "MANUAL_HUMAN_APPROVAL", autoApprovalOptInDigest: null,
    evaluatorVersion: "policy-evaluator-v1", expansionGate: "MANUAL_HUMAN_APPROVAL",
    planningGate: "MANUAL_HUMAN_APPROVAL", policyRevisionId: "policy-revision-7", revision: 3,
  },
  schemaVersions: {
    commandSchemaVersion: "moe-command/1", errorSchemaVersion: "moe-error/1",
    querySchemaVersion: "moe-query/1",
  },
  selection: {
    modelRef: "model-1", profileRef: "profile-1", providerRef: "provider-1",
    reasoningEffortRef: "effort-1", runtimeRef: "runtime-1", snapshotRef: "snapshot-1",
    structuredOutputSchemaRef: "schema-1",
  },
});

it("round-trips a project configuration manifest through the root", () => {
  const created: ProjectConfigurationManifestCreateResult =
    core.createProjectConfigurationManifest("project-root", configurationSettings());
  if (!created.ok) throw new Error(`unexpected refusal ${created.code}`);
  const encoded: ProjectConfigurationManifestEncodeResult =
    core.encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`unexpected refusal ${encoded.code}`);
  const decoded: ProjectConfigurationManifestDecodeResult =
    core.decodeProjectConfigurationManifestBytes(encoded.bytes);
  if (!decoded.ok) throw new Error(`unexpected refusal ${decoded.code}`);

  expect(created.manifest.settingsDigest).toMatch(/^[0-9a-f]{64}$/u);
  expect(decoded.manifest.settingsDigest).toBe(created.manifest.settingsDigest);
  expect(decoded.manifest.schemaVersion).toBe(PROJECT_CONFIGURATION_SCHEMA_VERSION);
  expect(decoded.manifest.projectId).toBe("project-root");
});

it("refuses undecodable configuration bytes from the root, naming code and layer", () => {
  const result = core.decodeProjectConfigurationManifestBytes(new TextEncoder().encode("{"));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ProjectConfigurationCodecRefusal = result;
  const code: ProjectConfigurationCodecCode = "PROJECT_CONFIGURATION_BYTES_INVALID";
  const layer: ProjectConfigurationCodecLayer = "PROJECT_CONFIGURATION_CODEC";
  expect([refusal.code, refusal.layer, refusal.upstream]).toEqual([code, layer, null]);
  expect(core.PROJECT_CONFIGURATION_CODEC_CODES).toContain(code);
  expect(core.PROJECT_CONFIGURATION_CODEC_LAYERS).toContain(layer);
  expect(Object.isFrozen(core.PROJECT_CONFIGURATION_CODEC_CODES)).toBe(true);
  expect(Object.isFrozen(core.PROJECT_CONFIGURATION_CODEC_LAYERS)).toBe(true);
  expect(core.PROJECT_CONFIGURATION_SETTINGS_DIGEST_DOMAIN)
    .toBe("moe-project-configuration-settings/1");
});

/**
 * The approval closure, exercised through the bare specifier and naming every
 * published type. The gate below is an OTHERWISE-ORDINARY unit of work whose
 * only defect is that no human has granted its authority, so the refusal is
 * attributable to the gate and to nothing upstream of it.
 */
const authorityGate = (): HumanAuthorityGate =>
  ({ gateId: "GO_ACTIVATE", grant: null, workRef: "task-09008b4c" });

it("refuses gated work from the root under every published policy member", () => {
  const kinds: readonly ApprovalPolicyKind[] = core.APPROVAL_POLICY_KINDS;
  const code: ApprovalAuthorityCode = "APPROVAL_HUMAN_AUTHORITY_REQUIRED";
  const layer: ApprovalAuthorityLayer = "HUMAN_AUTHORITY_GATE";
  const policies: readonly ApprovalPolicy[] = [
    { delayMs: 2_000, kind: "PROCEED_WITHOUT_HUMAN" }, { kind: "REQUIRE_HUMAN" },
  ];
  expect(policies.length).toBe(kinds.length);
  expect(policies.length).toBeGreaterThan(0);
  expect(policies.map((policy) => {
    const request: ApprovalAuthorityRequest = { gate: authorityGate(), policy };
    const result: ApprovalAuthorityResult = core.decideApprovalAuthority(request);
    if (result.ok) return `${policy.kind}:APPROVED`;
    const refusal: ApprovalAuthorityRefusal = result;
    return `${policy.kind}:${refusal.code}@${refusal.layer}`;
  })).toEqual(kinds.map((kind) => `${kind}:${code}@${layer}`));
  expect(core.APPROVAL_AUTHORITY_CODES).toContain(code);
  expect(core.APPROVAL_AUTHORITY_LAYERS).toContain(layer);
});

it("grants and then honours human authority through the root", () => {
  const granted: HumanAuthorityGrantResult = core.grantHumanAuthority(
    authorityGate(), { kind: "HUMAN", principalId: "human:yaron" }, 1_755_216_000_000,
  );
  if (!granted.ok) throw new Error(`unexpected refusal ${granted.code}`);
  const grant: HumanAuthorityGrant | null = granted.gate.grant;
  const result = core.decideApprovalAuthority({
    gate: granted.gate, policy: { kind: "REQUIRE_HUMAN" },
  });
  if (!result.ok) throw new Error(`unexpected refusal ${result.code}`);
  const decision: ApprovalAuthorityDecision = result;
  expect([grant?.principalId, grant?.principalKind]).toEqual(["human:yaron", "HUMAN"]);
  expect([decision.delayMs, decision.grant?.grantedAtEpochMs]).toEqual([0, 1_755_216_000_000]);
});

/**
 * The two planning-authority records, exercised through the bare specifier and
 * naming every published type. Guard 1 is blind to all 26 of them: deleting an
 * `export type` line from index.ts leaves the runtime count at 105 and the name
 * set untouched, and guard 3 never sees them because strip-types ERASES them.
 * This block is therefore the only thing between the published type surface and
 * a silent disappearance, and it fails at `pnpm --filter @moe/core typecheck`
 * rather than in vitest, which does not typecheck.
 *
 * Every fixture is ANNOTATED as the published draft shape rather than cast into
 * it, for the same reason as the expansion and configuration fixtures above: a
 * cast asserts the shape instead of checking it against what the codec admits.
 */
const planStep = (
  stepId: string, kind: PlanRevisionStep["kind"], description: string,
): PlanRevisionStep => ({ description, kind, stepId });
const planGraphBinding = (): PlanRevisionGraphBinding =>
  ({ graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a" });
const planDraft = (): PlanRevisionDraft => ({
  affectedCriterionIds: ["criterion-a"], affectedNodeIds: ["node-a"], approvalState: "APPROVED",
  authorRef: "principal-a", graphBinding: planGraphBinding(), parentRevisionId: null,
  rejectionRef: null, revisionId: "plan-revision-a",
  steps: [
    planStep("step-a", "ANALYSIS", "Analyse the graph."),
    planStep("step-b", "IMPLEMENTATION", "Implement the change."),
  ],
  verificationRecipeRefs: ["verify-a"],
});
const evidenceRequirement = (): AcceptanceEvidenceRequirement =>
  ({ evidenceRef: "artifact-a", kind: "ARTIFACT", requirementId: "requirement-a" });
const criterionObligation = (): AcceptanceCriterionObligation => ({
  criterionId: "criterion-a", evidenceRequirements: [evidenceRequirement()],
  statement: "The build passes its focused verification.",
  verificationRecipeRefs: ["recipe-a", "recipe-b"],
});
const contractApplicability = (): AcceptanceContractApplicability => ({
  graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a",
  nodeIds: ["node-a", "node-b"], nodeKind: "LEAF",
});
const contractDraft = (): AcceptanceContractDraft => ({
  applicability: contractApplicability(), authorRef: "principal-a", contractId: "contract-a",
  obligations: [criterionObligation()],
});

it("round-trips a plan revision through the root and names every published plan type", () => {
  const executionDraft: PlanExecutionContentDraft = {
    affectedCriterionIds: planDraft().affectedCriterionIds,
    affectedNodeIds: planDraft().affectedNodeIds, steps: planDraft().steps,
    verificationRecipeRefs: planDraft().verificationRecipeRefs,
  };
  const executionCreated: PlanExecutionContentCreateResult =
    core.createPlanExecutionContent(executionDraft);
  if (!executionCreated.ok) throw new Error(`unexpected refusal ${executionCreated.code}`);
  const executionBody: PlanExecutionContent = executionCreated.content;
  const executionEncoded: PlanExecutionContentEncodeResult =
    core.encodePlanExecutionContent(executionBody);
  if (!executionEncoded.ok) throw new Error(`unexpected refusal ${executionEncoded.code}`);
  const executionDecoded: PlanExecutionContentDecodeResult =
    core.decodePlanExecutionContentBytes(executionEncoded.bytes);
  if (!executionDecoded.ok) throw new Error(`unexpected refusal ${executionDecoded.code}`);
  const created: PlanRevisionCreateResult = core.createPlanRevision(planDraft());
  if (!created.ok) throw new Error(`unexpected refusal ${created.code}`);
  const revision: PlanRevision = created.revision;
  const encoded: PlanRevisionEncodeResult = core.encodePlanRevision(revision);
  if (!encoded.ok) throw new Error(`unexpected refusal ${encoded.code}`);
  const decoded: PlanRevisionDecodeResult = core.decodePlanRevisionBytes(encoded.bytes);
  if (!decoded.ok) throw new Error(`unexpected refusal ${decoded.code}`);
  const digest: PlanRevisionDigestResult = core.derivePlanRevisionDigest(revision);
  if (!digest.ok) throw new Error(`unexpected refusal ${digest.code}`);
  const content: PlanExecutionContentResult = core.derivePlanExecutionContent(revision);
  if (!content.ok) throw new Error(`unexpected refusal ${content.code}`);
  const binding: PlanRevisionGraphBinding = revision.graphBinding;
  const step: PlanRevisionStep | undefined = revision.steps[0];

  expect(revision.version).toBe(core.PLAN_REVISION_VERSION);
  expect([digest.planHash, decoded.revision.planHash]).toEqual([revision.planHash, revision.planHash]);
  expect([binding.graphContentHash, binding.graphRevisionRef])
    .toEqual([hex("a"), "graph-revision-a"]);
  expect([step?.stepId, step?.kind]).toEqual(["step-a", "ANALYSIS"]);
  // A DIFFERENT digest under a DIFFERENT domain: the graph-independent projection
  // is what a nodeAuthorityHash embeds, so proving it is not the planHash matters.
  expect(content.digest).toMatch(/^[0-9a-f]{64}$/u);
  expect(executionCreated.planExecutionContentDigest).toBe(content.digest);
  expect(executionDecoded.planExecutionContentDigest).toBe(content.digest);
  expect(executionBody.version).toBe(core.PLAN_REVISION_VERSION);
  expect(content.digest).not.toBe(revision.planHash);
  expect([core.PLAN_REVISION_DIGEST_DOMAIN, core.PLAN_EXECUTION_CONTENT_DOMAIN])
    .toEqual(["moe-plan-revision-digest/1", "@moe/core.plan-execution-content/1"]);
});

/**
 * A DUPLICATE step id, not an empty `steps`, because both malformed-shape paths
 * answer PLAN_REVISION_MALFORMED@PLAN_REVISION_ADMISSION and could not tell me
 * WHICH guard refused. Only the step-id uniqueness guard answers DUPLICATE_ID@
 * PLAN_REVISION_LIMITS, and the round-trip above is its positive control: the
 * same fixture without the override is admitted, so the refusal is attributable
 * to the override and not to a fixture that quietly went invalid.
 */
it("refuses a plan revision with a duplicate step id from the root, naming code and layer", () => {
  const result: PlanRevisionCreateResult = core.createPlanRevision({
    ...planDraft(),
    steps: [planStep("step-a", "ANALYSIS", "First."), planStep("step-a", "REVIEW", "Second.")],
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: PlanRevisionRefusal = result;
  const code: PlanRevisionCode = "PLAN_REVISION_DUPLICATE_ID";
  const layer: PlanRevisionLayer = "PLAN_REVISION_LIMITS";
  expect([refusal.code, refusal.layer]).toEqual([code, layer]);
  expect(core.PLAN_REVISION_CODES).toContain(code);
  expect(core.PLAN_REVISION_LAYERS).toContain(layer);
  expect([Object.isFrozen(core.PLAN_REVISION_CODES), Object.isFrozen(core.PLAN_REVISION_LAYERS)])
    .toEqual([true, true]);
});

it("round-trips an acceptance contract through the root and names every published contract type",
  () => {
    const criterionDraft: AcceptanceCriterionContentDraft = {
      nodeKind: contractDraft().applicability.nodeKind,
      obligations: contractDraft().obligations,
    };
    const criterionCreated: AcceptanceCriterionContentCreateResult =
      core.createAcceptanceCriterionContent(criterionDraft);
    if (!criterionCreated.ok) throw new Error(`unexpected refusal ${criterionCreated.code}`);
    const criterionBody: AcceptanceCriteriaContent = criterionCreated.content;
    const criterionEncoded: AcceptanceCriteriaContentEncodeResult =
      core.encodeAcceptanceCriteriaContent(criterionBody);
    if (!criterionEncoded.ok) throw new Error(`unexpected refusal ${criterionEncoded.code}`);
    const criterionDecoded: AcceptanceCriteriaContentDecodeResult =
      core.decodeAcceptanceCriteriaContentBytes(criterionEncoded.bytes);
    if (!criterionDecoded.ok) throw new Error(`unexpected refusal ${criterionDecoded.code}`);
    const created: AcceptanceContractCreateResult = core.createAcceptanceContract(contractDraft());
    if (!created.ok) throw new Error(`unexpected refusal ${created.code}`);
    const contract: AcceptanceContract = created.contract;
    const encoded: AcceptanceContractEncodeResult = core.encodeAcceptanceContract(contract);
    if (!encoded.ok) throw new Error(`unexpected refusal ${encoded.code}`);
    const decoded: AcceptanceContractDecodeResult =
      core.decodeAcceptanceContractBytes(encoded.bytes);
    if (!decoded.ok) throw new Error(`unexpected refusal ${decoded.code}`);
    const digest: AcceptanceContractDigestResult = core.deriveAcceptanceContractDigest(contract);
    if (!digest.ok) throw new Error(`unexpected refusal ${digest.code}`);
    const content: AcceptanceCriterionContentResult =
      core.deriveAcceptanceCriterionContent(contract);
    if (!content.ok) throw new Error(`unexpected refusal ${content.code}`);
    const applicability: AcceptanceContractApplicability = contract.applicability;
    const obligation: AcceptanceCriterionObligation | undefined = contract.obligations[0];
    const requirement: AcceptanceEvidenceRequirement | undefined =
      obligation?.evidenceRequirements[0];
    const criterion: AcceptanceCriterionContent | undefined = content.criteria[0];

    expect(contract.version).toBe(core.ACCEPTANCE_CONTRACT_VERSION);
    expect([digest.criteriaDigest, decoded.contract.criteriaDigest])
      .toEqual([contract.criteriaDigest, contract.criteriaDigest]);
    expect([applicability.nodeKind, applicability.graphContentHash]).toEqual(["LEAF", hex("a")]);
    expect([requirement?.kind, requirement?.requirementId]).toEqual(["ARTIFACT", "requirement-a"]);
    // Lengths first: `criterion?.x === obligation?.x` would pass on two undefineds.
    expect([contract.obligations.length, content.criteria.length]).toEqual([1, 1]);
    expect([criterion?.criterionId, obligation?.criterionId])
      .toEqual(["criterion-a", "criterion-a"]);
    expect(criterion?.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(criterionCreated.criteria).toStrictEqual(content.criteria);
    expect(criterionDecoded.criteria).toStrictEqual(content.criteria);
    expect(criterionBody.version).toBe(core.ACCEPTANCE_CONTRACT_VERSION);
    expect(criterion?.contentDigest).not.toBe(contract.criteriaDigest);
    expect([core.ACCEPTANCE_CONTRACT_DIGEST_DOMAIN, core.ACCEPTANCE_CRITERION_CONTENT_DOMAIN])
      .toEqual(["moe-acceptance-contract-digest/1", "@moe/core.acceptance-criterion-content/1"]);
  });

it("refuses an obligation-free acceptance contract from the root, naming code and layer", () => {
  const result: AcceptanceContractCreateResult =
    core.createAcceptanceContract({ ...contractDraft(), obligations: [] });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: AcceptanceContractRefusal = result;
  const code: AcceptanceContractCode = "ACCEPTANCE_CONTRACT_EMPTY_OBLIGATIONS";
  const layer: AcceptanceContractLayer = "ACCEPTANCE_CONTRACT_LIMITS";
  expect([refusal.code, refusal.layer]).toEqual([code, layer]);
  expect(core.ACCEPTANCE_CONTRACT_CODES).toContain(code);
  expect(core.ACCEPTANCE_CONTRACT_LAYERS).toContain(layer);
  expect([Object.isFrozen(core.ACCEPTANCE_CONTRACT_CODES),
    Object.isFrozen(core.ACCEPTANCE_CONTRACT_LAYERS)]).toEqual([true, true]);
});

it("round-trips a source snapshot through the root and names every public source type", () => {
  const draft: SourceSnapshotDraft = {
    baseRevisionHash: hex("a"), projectId: "project-a",
    repositoryBaseTree: "b".repeat(40), repositoryRef: "refs/heads/main",
    scopeRef: "services/api",
  };
  const created: SourceSnapshotCreateResult = core.createSourceSnapshot(draft);
  if (!created.ok) throw new Error(`unexpected refusal ${created.code}`);
  const snapshot: SourceSnapshot = created.snapshot;
  const encoded: SourceSnapshotEncodeResult = core.encodeSourceSnapshot(snapshot);
  if (!encoded.ok) throw new Error(`unexpected refusal ${encoded.code}`);
  const decoded: SourceSnapshotDecodeResult = core.decodeSourceSnapshotBytes(encoded.bytes);
  if (!decoded.ok) throw new Error(`unexpected refusal ${decoded.code}`);
  const digest: SourceSnapshotDigestResult = core.deriveSourceSnapshotDigest(snapshot);
  if (!digest.ok) throw new Error(`unexpected refusal ${digest.code}`);
  const ref: SourceSnapshotRef = { projectId: snapshot.projectId,
    sourceSnapshotDigest: snapshot.sourceSnapshotDigest };
  const refAdmission: SourceSnapshotRefAdmission = core.admitSourceSnapshotRef(ref);
  if (!refAdmission.ok) throw new Error(`unexpected refusal ${refAdmission.code}`);

  expect(decoded.snapshot).toStrictEqual(snapshot);
  expect(digest.sourceSnapshotDigest).toBe(snapshot.sourceSnapshotDigest);
  expect(refAdmission.ref).toStrictEqual(ref);
  expect([core.SOURCE_SNAPSHOT_VERSION, core.SOURCE_SNAPSHOT_DIGEST_DOMAIN])
    .toStrictEqual(["moe-source-snapshot/1", "moe-source-snapshot-digest/1"]);

  const refusalResult: SourceSnapshotCreateResult = core.createSourceSnapshot({
    ...draft, repositoryBaseTree: "B".repeat(40),
  });
  expect(refusalResult.ok).toBe(false);
  if (refusalResult.ok) throw new Error("expected a source snapshot refusal");
  const refusal: SourceSnapshotRefusal = refusalResult;
  const code: SourceSnapshotCode = "SOURCE_SNAPSHOT_MALFORMED";
  const layer: SourceSnapshotLayer = "SOURCE_SNAPSHOT_ADMISSION";
  expect([refusal.code, refusal.layer]).toStrictEqual([code, layer]);
});

const productRequirement = (
  requirementId: string, statement: string, supersedesRequirementId: string | null = null,
): ProductContractRequirement => ({ requirementId, statement, supersedesRequirementId });
const productCriterion = (
  criterionId: string, requirementId: string, statement: string,
  supersedesCriterionId: string | null = null,
): ProductContractCriterion => ({
  criterionId, requirementId, statement, supersedesCriterionId,
});
const productDraft = (): ProductContractRevisionDraft => ({
  authorRef: "principal-product", contractId: "product-contract-root",
  criteria: [productCriterion(
    "criterion-a", "requirement-a", "The build passes its focused verification.",
  )],
  lineage: null,
  requirements: [productRequirement("requirement-a", "The focused build passes.")],
  retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "product-revision-a",
  sourceDocumentDigests: [hex("d")],
});

it("publishes the immutable Product Contract kernel through the package root", () => {
  const created: ProductContractCreateResult = core.createProductContractRevision(productDraft());
  if (!created.ok) throw new Error(`unexpected refusal ${created.code}`);
  const revision: ProductContractRevision = created.revision;
  const digest: ProductContractDigestResult = core.deriveProductContractRevisionDigest(revision);
  if (!digest.ok) throw new Error(`unexpected refusal ${digest.code}`);
  const encoded: ProductContractEncodeResult = core.encodeProductContractRevision(revision);
  if (!encoded.ok) throw new Error(`unexpected refusal ${encoded.code}`);
  const decoded: ProductContractDecodeResult = core.decodeProductContractRevisionBytes(encoded.bytes);
  if (!decoded.ok) throw new Error(`unexpected refusal ${decoded.code}`);
  const projection: ProductContractProjection = {
    criteria: productDraft().criteria, requirements: productDraft().requirements,
  };
  const option: ProductContractClarificationOption = {
    label: "Baseline", optionId: "option-a", projection,
  };
  const clarification: ProductContractClarification = {
    clarificationId: "clarification-a", options: [option, {
      label: "Changed", optionId: "option-b", projection: {
        ...projection,
        requirements: [productRequirement("requirement-a", "The focused build is reproducible.")],
      },
    }], question: "Should the focused build also be reproducible?",
  };
  const materiality: ProductContractMaterialityResult =
    core.assessClarificationMateriality(clarification);
  if (!materiality.ok) throw new Error(`unexpected refusal ${materiality.code}`);
  const projectionDigest: ProductContractProjectionDigest | undefined = materiality.optionDigests[0];
  // Gate 1 is composed THROUGH THE ROOT from the authority, never from a caller
  // literal: the unsatisfied gate comes from the root, and only the root's own
  // grantHumanAuthority can satisfy it.
  const granted = core.grantHumanAuthority(
    core.productContractGate1Authority(revision),
    { kind: "HUMAN", principalId: "human:yaron" },
    1_787_516_800_000,
  );
  if (!granted.ok) throw new Error(`unexpected refusal ${granted.code}@${granted.layer}`);
  const gate: ProductContractGate1Result =
    core.validateProductContractGate1(revision, granted.gate);
  const graphBinding: ProductContractGraphBinding = {
    graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a",
  };
  const acceptanceCreated = core.createAcceptanceContract(contractDraft());
  if (!acceptanceCreated.ok) throw new Error(`unexpected refusal ${acceptanceCreated.code}`);
  const request: ProductAcceptanceBindingRequest = {
    acceptanceContract: acceptanceCreated.contract, gate1Approval: granted.gate, graphBinding,
    productContractRevision: revision,
  };
  const binding: ProductAcceptanceBindingResult = core.validateProductAcceptanceBinding(request);

  expect([revision.advisoryOnly, decoded.revision.revisionDigest, digest.revisionDigest])
    .toEqual([true, revision.revisionDigest, revision.revisionDigest]);
  expect([materiality.material, projectionDigest?.optionId]).toEqual([true, "option-a"]);
  expect(gate.ok).toBe(true);
  // The published surface must refuse caller-shaped human approval, and it must
  // say WHICH layer refused: an unsatisfied gate is answered by the authority
  // kernel, a non-gate by Gate 1 itself.
  const forged = core.validateProductContractGate1(revision, {
    approvalId: "approval-product-root", approvedAtEpochMs: 1_787_516_800_000,
    contractId: revision.contractId, principalId: "human:yaron", principalKind: "HUMAN",
    revisionDigest: revision.revisionDigest, revisionId: revision.revisionId,
  } as never);
  expect(forged.ok ? "SATISFIED" : [forged.code, forged.layer])
    .toEqual(["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]);
  const unsatisfied = core.validateProductContractGate1(
    revision, core.productContractGate1Authority(revision),
  );
  expect(unsatisfied.ok ? "SATISFIED" : [unsatisfied.code, unsatisfied.layer])
    .toEqual(["APPROVAL_HUMAN_AUTHORITY_REQUIRED", "HUMAN_AUTHORITY_GATE"]);
  expect(binding).toEqual({
    acceptanceCriteriaDigest: acceptanceCreated.contract.criteriaDigest, advisoryOnly: true,
    graphBinding, ok: true, productContractRevisionDigest: revision.revisionDigest,
  });
  expect([
    core.PRODUCT_CONTRACT_VERSION, core.PRODUCT_CONTRACT_DIGEST_DOMAIN,
    core.PRODUCT_CONTRACT_PROJECTION_DIGEST_DOMAIN,
  ]).toEqual([
    "moe-product-contract-revision/1", "moe-product-contract-revision-digest/1",
    "moe-product-contract-clarification-projection/1",
  ]);
});

const v2Priority: ProductContractV2Priority = "MUST";
const v2BudgetKind: ProductContractV2BudgetKind = "TIME";
const v2Requirement = (requirementId: string): ProductContractV2Requirement => ({
  dependsOnRequirementIds: [], priority: v2Priority, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const v2Criterion = (
  criterionId: string, requirementId: string,
): ProductContractV2Criterion => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Verify ${criterionId} deterministically.`,
});

const V2_CRITERION_IDS = Object.freeze([
  "criterion-deploy", "criterion-functional", "criterion-nfr",
  "criterion-security", "criterion-tech", "criterion-ux",
]);

const productV2Draft = (): ProductContractRevisionV2Draft => {
  const objective: ProductContractV2Objective = {
    objectiveId: "objective-a", statement: "Deliver the intended user outcome.",
  };
  const userJob: ProductContractV2UserJob = {
    job: "Complete the primary workflow.", user: "Registered operator", userJobId: "job-a",
  };
  const journey: ProductContractV2Journey = {
    criterionIds: ["criterion-functional"], journeyId: "journey-a",
    statement: "The operator completes the primary workflow.", userJobId: userJob.userJobId,
  };
  const assumption: ProductContractV2Assumption = {
    assumptionId: "assumption-a", statement: "The qualified runtime is installed.",
    validationCriterionId: "criterion-tech",
  };
  const budget: ProductContractV2Budget = {
    budgetId: "budget-a", kind: v2BudgetKind, limit: 30, unit: "days",
  };
  const metric: ProductContractV2SuccessMetric = {
    measurement: "Measure consented completed workflows.", metricId: "metric-a",
    objectiveIds: [objective.objectiveId], statement: "The workflow is completed.",
    target: "At least eighty percent in a cohort of ten or more.",
  };
  const optionA: ProductContractV2DecisionOption = {
    optionId: "option-a", statement: "Use the selected qualified profile.",
  };
  const optionB: ProductContractV2DecisionOption = {
    optionId: "option-b", statement: "Qualify another profile before planning.",
  };
  const decision: ProductContractV2MaterialDecision = {
    decisionId: "decision-a", options: [optionA, optionB],
    question: "Which qualified delivery profile is required?", selectedOptionId: optionA.optionId,
  };
  const negative: ProductContractV2NegativeScope = {
    scopeId: "scope-a", statement: "No native mobile client.",
  };
  const complete: ProductContractV2ProductCompleteDefinition = {
    criterionIds: V2_CRITERION_IDS,
    statement: "Every approved criterion is independently verified.",
  };
  const lineage: ProductContractV2Lineage | null = null;
  return {
    assumptions: [assumption], authorRef: "principal-product", budgets: [budget],
    contractId: "product-contract-v2-root",
    criteria: [
      v2Criterion("criterion-deploy", "requirement-deploy"),
      v2Criterion("criterion-functional", "requirement-functional"),
      v2Criterion("criterion-nfr", "requirement-nfr"),
      v2Criterion("criterion-security", "requirement-security"),
      v2Criterion("criterion-tech", "requirement-tech"),
      v2Criterion("criterion-ux", "requirement-ux"),
    ],
    deploymentRequirements: [v2Requirement("requirement-deploy")],
    functionalRequirements: [v2Requirement("requirement-functional")],
    journeys: [journey], lineage, materialDecisions: [decision], negativeScope: [negative],
    nonFunctionalRequirements: [v2Requirement("requirement-nfr")], objectives: [objective],
    productCompleteDefinition: complete, retiredCriterionIds: [], retiredRequirementIds: [],
    revisionId: "product-revision-v2-root",
    securityPrivacyRequirements: [v2Requirement("requirement-security")],
    sourceDocumentDigests: [hex("e")], successMetrics: [metric],
    technologyRequirements: [v2Requirement("requirement-tech")], userJobs: [userJob],
    uxAccessibilityRequirements: [v2Requirement("requirement-ux")],
  };
};

it("publishes the distinct Product Contract /2 codec and every v2 type through the root", () => {
  const created: ProductContractV2CreateResult =
    core.createProductContractRevisionV2(productV2Draft());
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  const revision: ProductContractRevisionV2 = created.revision;
  const encoded: ProductContractV2EncodeResult = core.encodeProductContractRevisionV2(revision);
  if (!encoded.ok) throw new Error(`${encoded.code}@${encoded.layer}`);
  const decoded: ProductContractV2DecodeResult =
    core.decodeProductContractRevisionV2Bytes(encoded.bytes);
  if (!decoded.ok) throw new Error(`${decoded.code}@${decoded.layer}`);
  const digest: ProductContractV2DigestResult =
    core.deriveProductContractRevisionV2Digest(revision);
  if (!digest.ok) throw new Error(`${digest.code}@${digest.layer}`);
  const slotCreated: ProductContractCurrentRevisionSlotV2Result =
    core.createProductContractCurrentRevisionSlotV2("project-a", revision);
  if (!slotCreated.ok) throw new Error(`${slotCreated.code}@${slotCreated.layer}`);
  const slot: ProductContractCurrentRevisionSlotV2 = slotCreated.slot;
  const currentRef: ProductContractRevisionV2Ref = slot.currentRevision;
  const slotEncoded: ProductContractCurrentRevisionSlotV2EncodeResult =
    core.encodeProductContractCurrentRevisionSlotV2(slot);
  if (!slotEncoded.ok) throw new Error(`${slotEncoded.code}@${slotEncoded.layer}`);
  const slotDecoded: ProductContractCurrentRevisionSlotV2Result =
    core.decodeProductContractCurrentRevisionSlotV2Bytes(slotEncoded.bytes, revision);
  if (!slotDecoded.ok) throw new Error(`${slotDecoded.code}@${slotDecoded.layer}`);
  const bindingRequest = null as unknown as ProductAcceptanceBindingV2Request;
  const binding: ProductAcceptanceBindingV2Result =
    core.validateProductAcceptanceBindingV2(bindingRequest);

  expect(decoded.revision).toEqual(revision);
  expect([digest.revisionDigest, currentRef.revisionDigest, slotDecoded.slot.slotDigest])
    .toEqual([revision.revisionDigest, revision.revisionDigest, slot.slotDigest]);
  expect([
    core.PRODUCT_CONTRACT_V2_VERSION, core.PRODUCT_CONTRACT_V2_DIGEST_DOMAIN,
    core.PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
    core.PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_DIGEST_DOMAIN,
  ]).toEqual([
    "moe-product-contract-revision/2", "moe-product-contract-revision-digest/2",
    "moe-product-contract-current-revision-slot/2",
    "moe-product-contract-current-revision-slot-digest/2",
  ]);

  const unresolved = productV2Draft();
  const decision = unresolved.materialDecisions[0]!;
  const result: ProductContractV2CreateResult = core.createProductContractRevisionV2({
    ...unresolved, materialDecisions: [{ ...decision, selectedOptionId: null }],
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected unresolved material choice to refuse");
  const refusal: ProductContractV2Refusal = result;
  const code: ProductContractV2Code = "PRODUCT_CONTRACT_V2_MATERIAL_DECISION_UNRESOLVED";
  const layer: ProductContractV2Layer = "PRODUCT_CONTRACT_V2_SEMANTICS";
  expect([refusal.code, refusal.layer]).toEqual([code, layer]);
  expect(core.PRODUCT_CONTRACT_V2_CODES).toContain(code);
  expect(core.PRODUCT_CONTRACT_V2_LAYERS).toContain(layer);
  expect(core.PRODUCT_CONTRACT_V2_PRIORITIES).toContain(v2Priority);
  expect(core.PRODUCT_CONTRACT_V2_BUDGET_KINDS).toContain(v2BudgetKind);
  expect(binding).toEqual({
    code: "PRODUCT_CONTRACT_ACCEPTANCE_INVALID", layer: "ACCEPTANCE_BINDING", ok: false,
  });
  const selfAmendment: ProductContractV2AmendmentResult =
    core.validateProductContractV2Amendment(revision, revision);
  expect(selfAmendment).toEqual({
    code: "PRODUCT_CONTRACT_V2_LINEAGE_PARENT_NOT_CURRENT",
    layer: "PRODUCT_CONTRACT_V2_LINEAGE",
    ok: false,
  });
});

it("publishes amendment lineage and exact Product Contract refusals through the root", () => {
  const currentResult = core.createProductContractRevision(productDraft());
  if (!currentResult.ok) throw new Error(`unexpected refusal ${currentResult.code}`);
  const current = currentResult.revision;
  const lineage: ProductContractLineage = {
    parentRevisionDigest: current.revisionDigest, parentRevisionId: current.revisionId,
  };
  const candidateResult = core.createProductContractRevision({
    ...productDraft(),
    criteria: [productCriterion(
      "criterion-b", "requirement-b", "The build is reproducible.", "criterion-a",
    )],
    lineage,
    requirements: [productRequirement(
      "requirement-b", "The focused build is reproducible.", "requirement-a",
    )],
    retiredCriterionIds: ["criterion-a"], retiredRequirementIds: ["requirement-a"],
    revisionId: "product-revision-b",
  });
  if (!candidateResult.ok) throw new Error(`unexpected refusal ${candidateResult.code}`);
  const amendment: ProductContractAmendmentResult =
    core.validateProductContractAmendment(current, candidateResult.revision);
  expect(amendment.ok).toBe(true);

  const result: ProductContractCreateResult = core.createProductContractRevision({
    ...productDraft(), sourceDocumentDigests: [],
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ProductContractRefusal = result;
  const code: ProductContractCode = "PRODUCT_CONTRACT_PROVENANCE_VACUOUS";
  const layer: ProductContractLayer = "PROVENANCE";
  expect([refusal.code, refusal.layer]).toEqual([code, layer]);
  expect(core.PRODUCT_CONTRACT_CODES).toContain(code);
  expect(core.PRODUCT_CONTRACT_LAYERS).toContain(layer);
});

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_TIMEOUT_MS = 30_000;
const CHILD_KILL_MS = 20_000;

/**
 * cwd is the package root so the bare specifier `@moe/core` resolves through
 * this package's own `exports` map via Node's self-reference rule — the exact
 * resolution `@moe/scheduler` and `@moe/daemon` get.
 */
const probe = async (source: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    // Killed on timeout rather than left to outlive the run: vitest's own test
    // timeout fails the assertion but would not reap the child.
    { cwd: PACKAGE_ROOT, timeout: CHILD_KILL_MS },
  );
  return JSON.parse(stdout) as unknown;
};

const REPORT_ROOT_ENTRY = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/core");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    namedExportCount: keys.length,
    undefinedBindingCount: keys.filter((key) => ns[key] === undefined).length,
    prepareExpansion: typeof ns.prepareExpansion,
    approveExpansionManually: typeof ns.approveExpansionManually,
    reduceExpansionPlanningHold: typeof ns.reduceExpansionPlanningHold,
    reducePlanningRun: typeof ns.reducePlanningRun,
    preparationLayers: [...(ns.EXPANSION_PREPARATION_LAYERS ?? [])],
    approvalComponents: [...(ns.EXPANSION_APPROVAL_COMPONENTS ?? [])],
    createProjectConfigurationManifest: typeof ns.createProjectConfigurationManifest,
    encodeProjectConfigurationManifest: typeof ns.encodeProjectConfigurationManifest,
    decodeProjectConfigurationManifestBytes: typeof ns.decodeProjectConfigurationManifestBytes,
    codecCodes: [...(ns.PROJECT_CONFIGURATION_CODEC_CODES ?? [])],
    decideApprovalAuthority: typeof ns.decideApprovalAuthority,
    grantHumanAuthority: typeof ns.grantHumanAuthority,
    approvalPolicyKinds: [...(ns.APPROVAL_POLICY_KINDS ?? [])],
    approvalAuthorityLayers: [...(ns.APPROVAL_AUTHORITY_LAYERS ?? [])],
    createProductContractRevision: typeof ns.createProductContractRevision,
    encodePlanExecutionContent: typeof ns.encodePlanExecutionContent,
    decodePlanExecutionContentBytes: typeof ns.decodePlanExecutionContentBytes,
    encodeAcceptanceCriteriaContent: typeof ns.encodeAcceptanceCriteriaContent,
    decodeAcceptanceCriteriaContentBytes: typeof ns.decodeAcceptanceCriteriaContentBytes,
    createProductContractRevisionV2: typeof ns.createProductContractRevisionV2,
    encodeProductContractRevisionV2: typeof ns.encodeProductContractRevisionV2,
    decodeProductContractRevisionV2Bytes: typeof ns.decodeProductContractRevisionV2Bytes,
    deriveProductContractRevisionV2Digest: typeof ns.deriveProductContractRevisionV2Digest,
    createProductContractCurrentRevisionSlotV2: typeof ns.createProductContractCurrentRevisionSlotV2,
    advanceProductContractCurrentRevisionSlotV2: typeof ns.advanceProductContractCurrentRevisionSlotV2,
    encodeProductContractCurrentRevisionSlotV2: typeof ns.encodeProductContractCurrentRevisionSlotV2,
    decodeProductContractCurrentRevisionSlotV2Bytes: typeof ns.decodeProductContractCurrentRevisionSlotV2Bytes,
    validateProductContractV2Amendment: typeof ns.validateProductContractV2Amendment,
    productContractV2Version: ns.PRODUCT_CONTRACT_V2_VERSION,
    productContractV2Layers: [...(ns.PRODUCT_CONTRACT_V2_LAYERS ?? [])],
    productContractCurrentSlotV2Version: ns.PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
    assessClarificationMateriality: typeof ns.assessClarificationMateriality,
    assessProductContractClarificationMaterialityV2: typeof ns.assessProductContractClarificationMaterialityV2,
    deriveProductContractClarificationProjectionDigestV2: typeof ns.deriveProductContractClarificationProjectionDigestV2,
    productContractV2ClarificationMaterialityCodes: [...(ns.PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_CODES ?? [])],
    productContractV2ClarificationMaterialityLayer: ns.PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER,
    productContractV2ClarificationProjectionDigestDomain: ns.PRODUCT_CONTRACT_V2_CLARIFICATION_PROJECTION_DIGEST_DOMAIN,
    validateProductContractAmendment: typeof ns.validateProductContractAmendment,
    validateProductContractGate1: typeof ns.validateProductContractGate1,
    productContractGate1Authority: typeof ns.productContractGate1Authority,
    validateProductAcceptanceBinding: typeof ns.validateProductAcceptanceBinding,
    validateProductAcceptanceBindingV2: typeof ns.validateProductAcceptanceBindingV2,
    productContractLayers: [...(ns.PRODUCT_CONTRACT_LAYERS ?? [])],
    derivePolicySliceDigest: typeof ns.derivePolicySliceDigest,
    policySliceDigestVersion: ns.POLICY_SLICE_DIGEST_VERSION,
    policySliceDigestCodes: [...(ns.POLICY_SLICE_DIGEST_CODES ?? [])],
    policySliceDigestLayers: [...(ns.POLICY_SLICE_DIGEST_LAYERS ?? [])],
    createSourceSnapshot: typeof ns.createSourceSnapshot,
    encodeSourceSnapshot: typeof ns.encodeSourceSnapshot,
    decodeSourceSnapshotBytes: typeof ns.decodeSourceSnapshotBytes,
    deriveSourceSnapshotDigest: typeof ns.deriveSourceSnapshotDigest,
    admitSourceSnapshotRef: typeof ns.admitSourceSnapshotRef,
    sourceSnapshotVersion: ns.SOURCE_SNAPSHOT_VERSION,
    sourceSnapshotCodes: [...(ns.SOURCE_SNAPSHOT_CODES ?? [])],
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

const reportUnbridged = (specifier: string): string => `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  await import(${JSON.stringify("SPECIFIER")});
  report({ outcome: "IMPORTED", code: "NONE" });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`.replace(JSON.stringify("SPECIFIER"), JSON.stringify(specifier));

it("loads @moe/core in Node's strip-types runtime with the expansion closure importable", async () => {
  // Asserts the BINDINGS, not the exit code: a child can exit 0 having imported
  // nothing, and type-stripping erases every `export type`, so a closure
  // published only as types would arrive here with these values missing while
  // tsc stayed green. The two vocabularies are compared by LITERAL equality
  // rather than by length: a frozen array that lost a member keeps its type.
  expect(await probe(REPORT_ROOT_ENTRY)).toEqual({
    outcome: "IMPORTED",
    namedExportCount: 256,
    undefinedBindingCount: 0,
    decideApprovalAuthority: "function",
    grantHumanAuthority: "function",
    approvalPolicyKinds: ["PROCEED_WITHOUT_HUMAN", "REQUIRE_HUMAN"],
    approvalAuthorityLayers: ["HUMAN_AUTHORITY_GATE", "APPROVAL_POLICY"],
    createProductContractRevision: "function",
    encodePlanExecutionContent: "function",
    decodePlanExecutionContentBytes: "function",
    encodeAcceptanceCriteriaContent: "function",
    decodeAcceptanceCriteriaContentBytes: "function",
    createProductContractRevisionV2: "function",
    encodeProductContractRevisionV2: "function",
    decodeProductContractRevisionV2Bytes: "function",
    deriveProductContractRevisionV2Digest: "function",
    createProductContractCurrentRevisionSlotV2: "function",
    advanceProductContractCurrentRevisionSlotV2: "function",
    encodeProductContractCurrentRevisionSlotV2: "function",
    decodeProductContractCurrentRevisionSlotV2Bytes: "function",
    validateProductContractV2Amendment: "function",
    productContractV2Version: "moe-product-contract-revision/2",
    productContractV2Layers: [
      "PRODUCT_CONTRACT_V2_PROVENANCE", "PRODUCT_CONTRACT_V2_SEMANTICS",
      "PRODUCT_CONTRACT_V2_CURRENT_SLOT", "PRODUCT_CONTRACT_V2_LINEAGE",
    ],
    productContractCurrentSlotV2Version: "moe-product-contract-current-revision-slot/2",
    assessClarificationMateriality: "function",
    assessProductContractClarificationMaterialityV2: "function",
    deriveProductContractClarificationProjectionDigestV2: "function",
    productContractV2ClarificationMaterialityCodes: [
      "PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID",
      "PRODUCT_CONTRACT_V2_CLARIFICATION_VACUOUS",
      "PRODUCT_CONTRACT_V2_CLARIFICATION_IMMATERIAL",
      "PRODUCT_CONTRACT_V2_CLARIFICATION_IDENTITY_MISMATCH",
    ],
    productContractV2ClarificationMaterialityLayer:
      "PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY",
    productContractV2ClarificationProjectionDigestDomain:
      "moe-product-contract-clarification-projection/2",
    validateProductContractAmendment: "function",
    validateProductContractGate1: "function",
    productContractGate1Authority: "function",
    validateProductAcceptanceBinding: "function",
    validateProductAcceptanceBindingV2: "function",
    productContractLayers: [
      "PROVENANCE", "LINEAGE", "MATERIALITY", "GATE_1", "ACCEPTANCE_BINDING",
    ],
    derivePolicySliceDigest: "function",
    policySliceDigestVersion: "moe.policy.slice.content.v1",
    policySliceDigestCodes: ["POLICY_SLICE_INVALID"],
    policySliceDigestLayers: ["POLICY_SLICE_CODEC"],
    createSourceSnapshot: "function",
    encodeSourceSnapshot: "function",
    decodeSourceSnapshotBytes: "function",
    deriveSourceSnapshotDigest: "function",
    admitSourceSnapshotRef: "function",
    sourceSnapshotVersion: "moe-source-snapshot/1",
    sourceSnapshotCodes: [
      "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_VERSION_UNSUPPORTED",
      "SOURCE_SNAPSHOT_LIMIT_EXCEEDED", "SOURCE_SNAPSHOT_BYTES_INVALID",
      "SOURCE_SNAPSHOT_DUPLICATE_KEY", "SOURCE_SNAPSHOT_NONCANONICAL",
      "SOURCE_SNAPSHOT_DIGEST_MISMATCH",
    ],
    prepareExpansion: "function",
    approveExpansionManually: "function",
    reduceExpansionPlanningHold: "function",
    reducePlanningRun: "function",
    createProjectConfigurationManifest: "function",
    encodeProjectConfigurationManifest: "function",
    decodeProjectConfigurationManifestBytes: "function",
    codecCodes: [
      "PROJECT_CONFIGURATION_BYTES_INVALID", "PROJECT_CONFIGURATION_DUPLICATE_KEY",
      "PROJECT_CONFIGURATION_NONCANONICAL", "PROJECT_CONFIGURATION_DIGEST_MISMATCH",
    ],
    preparationLayers: [
      "BUDGET", "EVIDENCE", "FENCE", "FUNDING", "INPUT", "LIFECYCLE", "POLICY", "RESOURCE",
      "SUPERSESSION_KERNEL",
    ],
    approvalComponents: [
      "APPROVAL_COMMAND", "APPROVAL_VALIDATION", "EXPANSION_APPROVAL", "EXPANSION_PREPARATION",
      "POLICY_EVALUATION", "SUPERSESSION_ENGINE",
    ],
  });
}, CHILD_TIMEOUT_MS);

it("still refuses an unbridged test module with ERR_MODULE_NOT_FOUND", async () => {
  // Negative control, and the reason the probe above is not vacuous. It pins the
  // LITERAL reason code rather than "it threw": it proves test-tier code was kept
  // off the runtime surface AND that a broken probe would report FAILED instead
  // of quietly reporting IMPORTED for a package that never loaded.
  expect(await probe(reportUnbridged("./src/index-surface.test.js"))).toEqual({
    outcome: "FAILED",
    code: "ERR_MODULE_NOT_FOUND",
  });
}, CHILD_TIMEOUT_MS);
