export {
  PROJECT_COMMAND_KINDS, PROJECT_TRANSITIONS, reduceProject,
} from "./project/project-reducer.js";
/**
 * The durable ProjectState reader. `stateOf` on the daemon ledger hands back a
 * raw `JsonValue`, so a host-side authority that resolves against project state
 * must re-validate those bytes through the production validator rather than
 * cast them: corrupt ledger bytes are a refusal, never a fallback.
 */
export { snapshotProjectState } from "./project/project-validation.js";
export type {
  ProjectAcceptedResult, ProjectActivateCommand, ProjectActivationWitness,
  ProjectBindRepositoryCommand, ProjectCommand, ProjectCommandKind, ProjectEvent,
  ProjectLifecycle, ProjectReducerResult, ProjectRegisterCommand, ProjectRejectedResult,
  ProjectState, RecoveryCompleteCommand, RecoveryCompletionWitness, RepositoryObservation,
  RestoreQuiesceCommand, RestoreQuiesceWitness,
} from "./project/project-contract.js";

/**
 * The content-addressed project configuration codec. `settingsDigest` is derived
 * from a domain-separated SHA-256 over the canonical settings bytes, so every
 * consumer that decodes these bytes agrees on the same authority or refuses.
 */
export {
  PROJECT_CONFIGURATION_CODEC_CODES, PROJECT_CONFIGURATION_CODEC_LAYERS,
  PROJECT_CONFIGURATION_SETTINGS_DIGEST_DOMAIN, createProjectConfigurationManifest,
  decodeProjectConfigurationManifestBytes, encodeProjectConfigurationManifest,
} from "./configuration/project-configuration-manifest.js";
export type {
  ProjectConfigurationCodecCode, ProjectConfigurationCodecLayer,
  ProjectConfigurationCodecRefusal, ProjectConfigurationManifestCreateResult,
  ProjectConfigurationManifestDecodeResult, ProjectConfigurationManifestEncodeResult,
} from "./configuration/project-configuration-manifest.js";

export {
  GOAL_COMMAND_KINDS, GOAL_TRANSITIONS, reduceGoal,
} from "./goal/goal-reducer.js";
export type {
  AcceptanceClosureWitness, CancellationAuthorizationWitness, GoalAcceptedResult,
  GoalActivateInitialGraphCommand, GoalCancelCommand, GoalCloseCommand, GoalCommand,
  GoalCommandKind, GoalCreateCommand, GoalEvent, GoalLifecycle, GoalPauseCommand,
  GoalQualificationInvalidatedCommand, GoalRecoveryFacets, GoalReducerResult,
  GoalRejectedResult, GoalReopenAsRevisionCommand, GoalResumeCommand, GoalSchedulingControl,
  GoalState, GoalSuccessorData, InitialGraphActivationWitness, ProjectReadyWitness,
  QualificationInvalidationWitness, ReopenAuthorizationWitness, ZeroAuthorityWitness,
} from "./goal/goal-contract.js";

export {
  PLANNING_RUN_COMMAND_KINDS,
  PLANNING_RUN_TRANSITIONS,
  reducePlanningRun,
} from "./planning/planning-run-reducer.js";
export type {
  GoalCancelPlanningCommand,
  GraphApproveCommand,
  NodeSummary,
  PlanApprovalWitness,
  PlanApproveCommand,
  PlanApproved,
  PlanProposeCommand,
  PlanReviseCommand,
  PlanRevisionCreated,
  PlanRevisionHashes,
  PlanRevisionSeal,
  PlanSubmissionWitness,
  PlanningAbsenceRecoveryWitness,
  PlanningActivationWitness,
  PlanningCancelCommand,
  PlanningCancellationWitness,
  PlanningClaimCommand,
  PlanningClaimWitness,
  PlanningClaimed,
  PlanningCreateDraftCommand,
  PlanningEffectTerminalProof,
  PlanningFinalizeSubmissionCommand,
  PlanningReadinessWitness,
  PlanningReadyCommand,
  PlanningRecoverAbsentCommand,
  PlanningRecoveredAbsent,
  PlanningRefusalWitness,
  PlanningReleaseCommand,
  PlanningReleaseWitness,
  PlanningReleased,
  PlanningResumeProof,
  PlanningRunAcceptedResult,
  PlanningRunActivated,
  PlanningRunCancelled,
  PlanningRunCommand,
  PlanningRunCommandKind,
  PlanningRunCreated,
  PlanningRunEvent,
  PlanningRunFacets,
  PlanningRunKind,
  PlanningRunLifecycle,
  PlanningRunReady,
  PlanningRunReducerResult,
  PlanningRunRejected,
  PlanningRunRejectedResult,
  PlanningRunState,
  PlanningRunSuccessorData,
  PlanningSubmissionSealed,
  PlanningUnsupportedReason,
  PlanningUnsupportedResult,
  SubmissionFinalizeWitness,
} from "./planning/planning-contract.js";

export {
  ACCEPTANCE_CONTRACT_CODES, ACCEPTANCE_CONTRACT_LAYERS, ACCEPTANCE_CONTRACT_VERSION,
} from "./planning/acceptance-contract.js";
export type {
  AcceptanceContract, AcceptanceContractApplicability, AcceptanceContractCode,
  AcceptanceContractDraft, AcceptanceContractLayer, AcceptanceContractRefusal,
  AcceptanceCriterionObligation, AcceptanceEvidenceRequirement,
} from "./planning/acceptance-contract.js";
export {
  ACCEPTANCE_CONTRACT_DIGEST_DOMAIN, ACCEPTANCE_CRITERION_CONTENT_DOMAIN,
  createAcceptanceContract, decodeAcceptanceContractBytes, deriveAcceptanceContractDigest,
  deriveAcceptanceCriterionContent, encodeAcceptanceContract,
} from "./planning/acceptance-contract-codec.js";
export type {
  AcceptanceContractCreateResult, AcceptanceContractDecodeResult,
  AcceptanceContractDigestResult, AcceptanceContractEncodeResult, AcceptanceCriterionContent,
  AcceptanceCriterionContentResult,
} from "./planning/acceptance-contract-codec.js";

/** Immutable advisory product truth; runtime writers and compiler authority live outside core. */
export {
  PRODUCT_CONTRACT_CODES, PRODUCT_CONTRACT_DIGEST_DOMAIN, PRODUCT_CONTRACT_LAYERS,
  PRODUCT_CONTRACT_VERSION, createProductContractRevision, decodeProductContractRevisionBytes,
  deriveProductContractRevisionDigest, encodeProductContractRevision,
} from "./product-contract/product-contract-codec.js";
export type {
  ProductContractCode, ProductContractCriterion, ProductContractLayer, ProductContractLineage,
  ProductContractRefusal, ProductContractRequirement, ProductContractRevision,
  ProductContractRevisionDraft,
} from "./product-contract/product-contract-codec.js";
export type {
  ProductContractCreateResult, ProductContractDecodeResult, ProductContractDigestResult,
  ProductContractEncodeResult,
} from "./product-contract/product-contract-codec.js";

/**
 * The v2 contract is a distinct wire family. It is intentionally exported beside
 * `/1`, never through an alias or decoder fallback that could silently grant old
 * bytes the richer `/2` meaning.
 */
export {
  PRODUCT_CONTRACT_V2_BUDGET_KINDS, PRODUCT_CONTRACT_V2_CODES,
  PRODUCT_CONTRACT_V2_DIGEST_DOMAIN, PRODUCT_CONTRACT_V2_LAYERS,
  PRODUCT_CONTRACT_V2_LIMITS,
  PRODUCT_CONTRACT_V2_PRIORITIES, PRODUCT_CONTRACT_V2_VERSION,
  createProductContractRevisionV2, decodeProductContractRevisionV2Bytes,
  deriveProductContractRevisionV2Digest, encodeProductContractRevisionV2,
} from "./product-contract/product-contract-v2-codec.js";
export type {
  ProductContractRevisionV2, ProductContractRevisionV2Draft,
  ProductContractV2Assumption, ProductContractV2Budget, ProductContractV2BudgetKind,
  ProductContractV2Code, ProductContractV2CreateResult, ProductContractV2Criterion,
  ProductContractV2DecisionOption, ProductContractV2DecodeResult,
  ProductContractV2DigestResult, ProductContractV2EncodeResult,
  ProductContractV2Journey, ProductContractV2Layer,
  ProductContractV2Lineage, ProductContractV2MaterialDecision,
  ProductContractV2NegativeScope, ProductContractV2Objective, ProductContractV2Priority,
  ProductContractV2ProductCompleteDefinition, ProductContractV2Refusal,
  ProductContractV2Requirement, ProductContractV2SuccessMetric, ProductContractV2UserJob,
} from "./product-contract/product-contract-v2-codec.js";
export {
  PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_DIGEST_DOMAIN,
  PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
  advanceProductContractCurrentRevisionSlotV2,
  createProductContractCurrentRevisionSlotV2,
  decodeProductContractCurrentRevisionSlotV2Bytes,
  encodeProductContractCurrentRevisionSlotV2,
} from "./product-contract/product-contract-v2-current-slot.js";
export { validateProductContractV2Amendment }
  from "./product-contract/product-contract-v2-lineage.js";
export type { ProductContractV2AmendmentResult }
  from "./product-contract/product-contract-v2-lineage.js";
export type {
  ProductContractCurrentRevisionSlotV2,
  ProductContractCurrentRevisionSlotV2EncodeResult,
  ProductContractCurrentRevisionSlotV2Result,
  ProductContractRevisionV2Ref,
} from "./product-contract/product-contract-v2-current-slot.js";
export { validateProductContractGate1V2 }
  from "./product-contract/product-contract-v2-gate-1.js";
export type { ProductContractV2Gate1Result }
  from "./product-contract/product-contract-v2-gate-1.js";
export {
  PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_CODES,
  PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER,
  PRODUCT_CONTRACT_V2_CLARIFICATION_PROJECTION_DIGEST_DOMAIN,
  assessProductContractClarificationMaterialityV2,
  deriveProductContractClarificationProjectionDigestV2,
} from "./product-contract/product-contract-v2-materiality.js";
export type {
  ProductContractClarificationV2,
  ProductContractClarificationV2MaterialityRefusal,
  ProductContractClarificationV2MaterialityResult,
  ProductContractClarificationV2Option,
  ProductContractClarificationV2OptionDigest,
  ProductContractClarificationV2SharedIdentity,
  ProductContractV2ClarificationMaterialityCode,
} from "./product-contract/product-contract-v2-materiality.js";

/** Content-addressed delivery, isolation, and fresh-verifier authority for `/2`. */
export * from "./delivery-profile/delivery-profile-codec.js";
export {
  BUILT_IN_DELIVERY_PROFILE_QUALIFICATIONS,
  BUILT_IN_DELIVERY_PROFILE_REVISIONS,
} from "./delivery-profile/delivery-profile-builtins.js";
export { resolveQualifiedDeliveryProfile }
  from "./delivery-profile/delivery-profile-qualification.js";
export type { QualifiedDeliveryProfileResolution }
  from "./delivery-profile/delivery-profile-qualification.js";
export * from "./capability-catalog/capability-catalog-codec.js";
export * from "./capability-catalog/capability-catalog-resolution.js";
export * from "./execution-profile/execution-isolation-profile-codec.js";
export * from "./execution-profile/verification-recipe-codec.js";
/**
 * The bounded identity triple a Gate 1 grant binds to. Only the REF admission is
 * published: `admitProductContractRevision` stays unexported so the full-revision
 * seam remains `createProductContractRevision` and `validateProductContractGate1`.
 */
export { admitProductContractRevisionRef } from "./product-contract/product-contract-admission.js";
export { PRODUCT_CONTRACT_REVISION_REF_KEYS } from "./product-contract/product-contract-contract.js";
export type { ProductContractRevisionRef,
  ProductContractRevisionRefAdmission } from "./product-contract/product-contract-contract.js";
export { validateProductContractAmendment } from "./product-contract/product-contract-lineage.js";
export type {
  ProductContractAmendmentResult,
} from "./product-contract/product-contract-lineage.js";
export {
  PRODUCT_CONTRACT_PROJECTION_DIGEST_DOMAIN, assessClarificationMateriality,
} from "./product-contract/product-contract-materiality.js";
export type {
  ProductContractClarification, ProductContractClarificationOption,
  ProductContractMaterialityResult, ProductContractProjection, ProductContractProjectionDigest,
} from "./product-contract/product-contract-materiality.js";
/**
 * `productContractGate1Authority` publishes the UNSATISFIED gate for a revision,
 * not a verdict: it mints nothing, and only `grantHumanAuthority` fed an
 * authenticated principal can satisfy what it returns. It is published so a
 * consumer never hand-builds the work reference Gate 1 binds to.
 */
export {
  productContractGate1Authority, validateProductAcceptanceBinding, validateProductContractGate1,
} from "./product-contract/product-contract-acceptance-binding.js";
export type {
  ProductAcceptanceBindingRequest, ProductAcceptanceBindingResult,
  ProductContractGate1Result, ProductContractGraphBinding,
} from "./product-contract/product-contract-acceptance-binding.js";

export {
  PLAN_REVISION_CODES, PLAN_REVISION_LAYERS, PLAN_REVISION_VERSION,
} from "./planning/plan-revision-contract.js";
export type {
  PlanRevision, PlanRevisionCode, PlanRevisionDraft, PlanRevisionGraphBinding,
  PlanRevisionLayer, PlanRevisionRefusal, PlanRevisionStep,
} from "./planning/plan-revision-contract.js";
export {
  PLAN_EXECUTION_CONTENT_DOMAIN, PLAN_REVISION_DIGEST_DOMAIN, createPlanRevision,
  decodePlanRevisionBytes, derivePlanExecutionContent, derivePlanRevisionDigest,
  encodePlanRevision,
} from "./planning/plan-revision-codec.js";
export type {
  PlanExecutionContentResult, PlanRevisionCreateResult, PlanRevisionDecodeResult,
  PlanRevisionDigestResult, PlanRevisionEncodeResult,
} from "./planning/plan-revision-codec.js";
export {
  GRAPH_REVISION_COMMAND_KINDS,
  GRAPH_REVISION_TRANSITIONS,
  reduceGraphRevision,
} from "./planning/graph-revision-reducer.js";
export {
  CORE_GRAPH_REVISION_REPLAY,
  GRAPH_REVISION_EVENT_KINDS,
  GRAPH_REVISION_REPLAY_CODES,
  replayGraphRevisionEvents,
} from "./planning/graph-revision-replay.js";
export type {
  GraphRevisionEventKind,
  GraphRevisionReplayAcceptedResult,
  GraphRevisionReplayCode,
  GraphRevisionReplayRefusal,
  GraphRevisionReplayResult,
} from "./planning/graph-revision-replay.js";
export type {
  GraphActivationBinding,
  GraphRevisionAcceptedResult,
  GraphRevisionActivated,
  GraphRevisionActivationWitness,
  GraphRevisionApprovalWitness,
  GraphRevisionApproveCommand,
  GraphRevisionApproved,
  GraphRevisionCommand,
  GraphRevisionCommandKind,
  GraphRevisionCreateCommand,
  GraphRevisionCreated,
  GraphRevisionEvent,
  GraphRevisionLifecycle,
  GraphRevisionReducerResult,
  GraphRevisionRefusalWitness,
  GraphRevisionRejectCommand,
  GraphRevisionRejected,
  GraphRevisionRejectedResult,
  GraphRevisionState,
  GraphRevisionSubmitCommand,
  GraphRevisionSubmitted,
  GraphRevisionSupersedeCommand,
  GraphSubmissionWitness,
} from "./planning/graph-revision-contract.js";

/**
 * WHEN a submitted plan may proceed without a human, and the per-unit-of-work
 * gate that certain work cannot proceed without one regardless of that setting.
 *
 * CURATED, NOT COMPLETE. `checkHumanAuthority` and `refuseApprovalAuthority`
 * stay unpublished on purpose. A consumer that could mint a refusal could forge
 * the verdicts these modules exist to hold, and the gate check is reachable only
 * through `decideApprovalAuthority`, which consults it FIRST by construction —
 * publishing the check on its own would invite a consumer to call it and then
 * decide for itself whether to honour the answer.
 */
export {
  APPROVAL_AUTHORITY_CODES, APPROVAL_AUTHORITY_LAYERS, grantHumanAuthority,
} from "./planning/approval-authority.js";
export type {
  ApprovalAuthorityCode, ApprovalAuthorityLayer, ApprovalAuthorityRefusal,
  HumanAuthorityGate, HumanAuthorityGrant, HumanAuthorityGrantResult,
} from "./planning/approval-authority.js";
export {
  APPROVAL_POLICY_KINDS, decideApprovalAuthority,
} from "./planning/approval-policy.js";
export type {
  ApprovalAuthorityDecision, ApprovalAuthorityRequest, ApprovalAuthorityResult,
  ApprovalPolicy, ApprovalPolicyKind,
} from "./planning/approval-policy.js";

/**
 * The curated policy surface now lives in `./policy/policy-public.ts`, which publishes exactly
 * the names this block did (task-77af2cd3). Extracted to bring this barrel under the 400-line
 * split threshold; the root export set is unchanged and `index-surface.test.ts` still pins it.
 */
export * from "./policy/policy-public.js";

export {
  EXPANSION_HOLD_CAUSES, EXPANSION_HOLD_COMMAND_KINDS,
  EXPANSION_HOLD_ERROR_CODES, EXPANSION_HOLD_LAYERS, reduceExpansionPlanningHold,
} from "./expansion/expansion-planning-hold.js";
export type {
  CreateExpansionHoldCommand, ExpansionHandoffBinding, ExpansionHoldCause,
  ExpansionHoldErrorCode, ExpansionHoldLayer, ExpansionHoldLifecycle,
  ExpansionPlanningHoldCommand, ExpansionPlanningHoldEvent, ExpansionPlanningHoldResult,
  ExpansionPlanningHoldState, ExpansionReleaseEvidence, ExpansionTerminalProof,
  TransitionExpansionHoldCommand,
} from "./expansion/expansion-planning-hold.js";

/**
 * The core half of the expansion admission protocol: bind one scheduler-admitted
 * expansion to an approval identity, then approve it manually.
 *
 * CURATED, NOT COMPLETE. `canonicalBytes`, `expansionIdentityOf` and
 * `refuseExpansionPreparation` are exported from their modules so the approval
 * module can re-derive and refuse, and they stay unpublished on purpose: a
 * consumer that could recompute the canonical identity itself would be able to
 * fork the identity authority these two modules exist to hold, and a consumer
 * never needs to construct a refusal it is supposed to receive.
 */
export {
  EXPANSION_PREPARATION_CODES, EXPANSION_PREPARATION_COMPONENTS, EXPANSION_PREPARATION_LAYERS,
  prepareExpansion,
} from "./expansion/expansion-preparation.js";
export type {
  ExpansionAdmittedFacts, ExpansionApprovalCriteria, ExpansionBudgetReservationFacts,
  ExpansionFairnessFacts, ExpansionFenceFacts, ExpansionFundingFacts, ExpansionPolicyFacts,
  ExpansionPreparation, ExpansionPreparationCode, ExpansionPreparationComponent,
  ExpansionPreparationInput, ExpansionPreparationLayer, ExpansionPreparationRefusal,
  ExpansionPreparationResult, ExpansionPreparationSources, ExpansionPreparedFacts,
  ExpansionResourceReservationFacts,
} from "./expansion/expansion-preparation.js";

export {
  EXPANSION_APPROVAL_CODES, EXPANSION_APPROVAL_COMPONENTS, EXPANSION_APPROVAL_LAYERS,
  approveExpansionManually,
} from "./expansion/expansion-approval.js";
export type {
  ExpansionApprovalBinding, ExpansionApprovalClaim, ExpansionApprovalCode,
  ExpansionApprovalComponent, ExpansionApprovalLayer, ExpansionApprovalRefusal,
  ExpansionApprovalRequest, ExpansionApprovalResult,
} from "./expansion/expansion-approval.js";

export {
  PLANNING_EXPANSION_ERROR_CODES, PLANNING_EXPANSION_LAYERS, PLANNING_EXPANSION_TARGETS,
  inspectPlanningExpansionContract, snapshotPlanningRunContractState, validExpansionCreateCommand,
  validExpansionCreatedEvent, validExpansionHoldBinding, validExpansionProposalIdentity,
  validExpansionProposeCommand, validExpansionSealedEvent, validPlanningRunContractState,
} from "./planning/planning-expansion-validation.js";
export type { PlanningExpansionErrorCode, PlanningExpansionInspection,
  PlanningExpansionLayer, PlanningExpansionTarget } from "./planning/planning-expansion-validation.js";
export type { PlanningExpansionHoldBinding, PlanningExpansionProposalIdentity } from "./planning/planning-command-contract.js";
export type { PlanningRunContractState } from "./planning/planning-event-contract.js";

export { SUPERSESSION_DISPOSITION_KINDS, SUPERSESSION_KERNEL_LAYER, decideSupersession } from "./supersession/supersession-engine.js";
export type { SupersessionAcceptedResult, SupersessionDecision, SupersessionDisposition, SupersessionDispositionKind,
  SupersessionInput, SupersessionPredecessorBinding, SupersessionRefusal, SupersessionResult, SupersessionSafeCarry,
  SupersessionSuccessorBinding } from "./supersession/supersession-engine.js";

/** Packed rather than one-name-per-line: this barrel is already over the 400-line cap. */
export { CUTOVER_COMMAND_KINDS, CUTOVER_TRANSITIONS, reduceCutover } from "./cutover/cutover-reducer.js";
export {
  LIVE_QUIESCE_EVIDENCE_LAYER,
  LIVE_QUIESCE_EVIDENCE_REFUSAL_CODES,
  deriveLiveQuiesceEvidenceDigest,
  serializeLiveQuiesceEvidenceCanonical,
  type LiveQuiesceEvidence,
  type LiveQuiesceEvidenceCanonicalResult,
  type LiveQuiesceEvidenceDigestResult,
  type LiveQuiesceEvidenceRefusal,
  type LiveQuiesceEvidenceRefusalCode,
  type LiveQuiesceInventory,
  type LiveQuiesceItem,
  type LiveQuiesceItemKind,
  type LiveQuiesceItemResult,
} from "./cutover/cutover-quiesce-evidence.js";
export type { CutoverAbortCommand, CutoverAbortWitness, CutoverAcceptedResult, CutoverAdmitActivateApprovalCommand,
  CutoverAdmitQuiesceApprovalCommand, CutoverApprovalWitness, CutoverAttemptEvent, CutoverAttemptState,
  CutoverBeginQuiesceCommand, CutoverCommand, CutoverCommandKind, CutoverCompleteQuiesceCommand,
  CutoverImportVerificationWitness, CutoverPreviewCommand, CutoverQuiesceProofWitness, CutoverReducerResult,
  CutoverRejectedResult, CutoverSourceInventoryWitness, CutoverState,
  CutoverVerifyImportCommand } from "./cutover/cutover-contract.js";

/**
 * Identity is re-exported through its own curated area seam rather than as per-module blocks:
 * `./identity/index.ts` already curates the three identity modules, so duplicating its surface
 * here would create a second place to keep in sync. Nothing else in this file collides with it.
 */
export * from "./identity/index.js";
