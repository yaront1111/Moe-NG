/**
 * @moe/scheduler — three zero-minting composition areas on one entry point.
 *
 * 1. Structural graph analysis and preview:
 *  - validateGraphSnapshot: fail-closed structural validation -> ValidatedGraph.
 *  - analyzeGraphStructure: deterministic structural facts about a ValidatedGraph.
 *  - analyzeHardEdgeCounterfactuals: review-only source-edge pressure facts.
 *  - partitionFrontier: readiness partition from caller-supplied frontier facts.
 *  - previewGraphSnapshot: zero-authority validation/frontier/analysis composition.
 *
 * 2. Caller-supplied authority fencing and resource reservation:
 *  - fenceAuthority and its parsers: the design-749 check order over a lease
 *    record and a proof the CALLER supplies; no lease, token, or epoch is minted.
 *  - reserveAll / adapterConfirm / adapterFail / grantSuccessorCapacity /
 *    reserveProviderSlot: all-or-none acquisition over a caller-supplied
 *    capacity snapshot. No slot is counted here.
 *  - activateProviderSlot: the sole RESERVED -> ACTIVE slot transition, binding
 *    exactly one caller-supplied attempt. It mints no slot and no attempt.
 *
 * 3. Caller-supplied conserved-budget admission reservation:
 *  - reserveForAdmission / cancelReservation: units move all-or-none between the
 *    AVAILABLE and RESERVED buckets of a caller-supplied account view; the
 *    caller's own view is never mutated, a shifted one is returned.
 *  - activateReservation: binds an attempt and moves NO units, because
 *    RESERVED -> COMMITTED belongs to settlement.
 *  - No policy is re-evaluated and no approval is composed — a supplied gate
 *    must already read ALLOW / APPROVE+CURRENT or the admission is refused.
 *
 * 4. Fairness contract families for the fair scheduler:
 *  - the frozen reason-code and refusing-layer vocabularies, plus total
 *    validators for the WorkItem, ring, resource, opportunity-evidence and
 *    cap-revision families. They DESCRIBE and VALIDATE only: no exported
 *    function decides rotation order, deficit accounting or aging, and a bypass
 *    claim the caller cannot prove is refused rather than admitted. The
 *    rotation algorithm and the aging policy are the consumer's, task-10cab3e5.
 *
 * 5. Graph-supersession dispositions (scheduler half). buildSupersessionDispositions
 *    is the complete, deterministic, hash-bound attempt/effect/resource/budget set
 *    for one supersession, and carryWaitProjection is the wait/blocker carry
 *    validated through admission-wait's own validateIntentionalWait. Both COMPOSE
 *    the landed drain, resource and budget authority and decide none of it; a kind
 *    with no disposition, a changed fact or an UNKNOWN fact refuses with an
 *    existing @moe/contracts code and the refusing layer, never a shorter set.
 *
 * Every area is contract-neutral and stays that way: the package reports exact
 * facts and never invents dependency, policy, lease, or execution authority. It
 * does not infer independence, delete edges, infer semantic dependency truth,
 * claim a decomposition is faster, mint authority, or create budget. See
 * ./graph-model.ts for the structural rationale.
 */

export { validateGraphSnapshot } from "./validate-graph.js";
export { analyzeGraphStructure } from "./analyze-graph.js";
export { analyzeHardEdgeCounterfactuals } from "./hard-edge-counterfactual.js";
export { GraphAnalysisError } from "./graph-analysis-error.js";
export { partitionFrontier } from "./frontier.js";
export { previewGraphSnapshot } from "./graph-preview.js";
export {
  ABSOLUTE_MAX_GRAPH_HARD_EDGES,
  ABSOLUTE_MAX_GRAPH_NODES,
  ABSOLUTE_MAX_GRAPH_TOTAL_EDGES,
  DEFAULT_GRAPH_POLICY,
  DEFAULT_MAX_HARD_EDGES,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_TOTAL_EDGES,
  MIN_GATED_DESCENDANTS_FOR_REVIEW,
  MAX_GRAPH_KEY_CODE_UNITS,
  resolveGraphPolicy,
} from "./graph-policy.js";
export { createTraversalCounter } from "./graph-model.js";

export {
  activateProviderSlot,
  adapterConfirm,
  adapterFail,
  grantSuccessorCapacity,
  reserveAll,
  reserveProviderSlot,
} from "./authority/lease-resource.js";
export {
  fenceAuthority,
  parseClock,
  parseLeaseRecord,
  parseProof,
} from "./authority/lease-fencing.js";
export { SLOT_STATES } from "./authority/resource-model.js";
export {
  ADMISSION_PURPOSES,
  ADMISSION_PURPOSE_RESERVE_CONTRACT,
  BUDGET_RESERVATION_ISSUE_CODES,
  PROTECTED_ADMISSION_PURPOSES,
  RESERVATION_STATES,
  activateReservation,
  cancelReservation,
  deriveReservationId,
  reserveForAdmission,
} from "./budget/budget-reservation.js";
export {
  FAIRNESS_CONTRACT_ISSUE_CODES,
  FAIRNESS_CONTRACT_LAYERS,
  FAIRNESS_DISPATCHABILITY_STATES,
  FAIRNESS_PRIORITY_CLASSES,
  isFairnessIdentity,
} from "./fairness/fairness-contract.js";
export { validateWorkItem, validateWorkItemSet } from "./fairness/fairness-work-item.js";
export { validateRing, validateRingResource } from "./fairness/fairness-ring.js";
export { validateBypassClaim } from "./fairness/fairness-evidence.js";
export { validateCapRevision } from "./fairness/fairness-cap-revision.js";
export {
  FAIRNESS_DIMENSION_CEILING,
  FAIRNESS_ROTATION_DISPOSITIONS,
  FAIRNESS_SERVICE_COST,
  resourceRotationOrder,
  rotateOnce,
  validateResourceCapacity,
  validateRotationRequest,
} from "./fairness/fairness-rotation.js";
export {
  FAIRNESS_BYPASSES_PER_LEVEL,
  FAIRNESS_FORCED_BYPASS_BOUND,
  FAIRNESS_PRIORITY_LADDER,
  ageWorkItem,
  bypassesToForced,
} from "./fairness/fairness-aging.js";
export {
  SUPERSESSION_BOUND_DISPOSITION_FIELDS, SUPERSESSION_DISPOSITION_FAMILIES,
  SUPERSESSION_DISPOSITION_LAYERS, SUPERSESSION_REFUSAL_CODES,
} from "./supersession/supersession-disposition-contract.js";

/**
 * The scheduler half of the expansion admission protocol: derive evidence from a
 * sealed receipt, then admit ONE proposal all-or-none.
 *
 * CURATED, NOT COMPLETE. expansion-preparation.ts and expansion-receipt.ts export
 * their parsers and refusal constructors (parseExpansionRequest, prepare, digestOf,
 * own, issue, refuse, checkKeys, RECEIPT_KEYS, HEX_64 and the rest) so the two
 * composers can share them; none is published. admitExpansion IS the entry point,
 * and a consumer that could call `prepare` directly would skip every pure check
 * that makes the composition all-or-none.
 *
 * FORBIDDEN_VERDICT_KEYS is published because it is a declared CASE LIST, not
 * plumbing: a refusal matrix must sweep it from the production constant, or the
 * sweep silently shrinks when the vocabulary grows.
 */
export { admitExpansion } from "./expansion/expansion-admission.js";
export { deriveExpansionEvidence } from "./expansion/expansion-evidence.js";
export {
  EXPANSION_ADMISSION_ISSUE_CODES, EXPANSION_ADMISSION_ORIGINS,
} from "./expansion/expansion-preparation.js";
/**
 * The admission-to-preparation bridge. `bindExpansionAdmission` is the ONLY way
 * an admitted expansion becomes core's `ExpansionAdmittedFacts` and its
 * `PlanningExpansionHoldBinding`, so no consumer has to hand-map the two shapes
 * and none can invent an opportunity ref or a DAEMON_VERIFIED marker on the way.
 * `validateOpportunityAttestation` is published beside it because the daemon
 * must be able to validate the evidence it is about to pass in.
 */
export { validateOpportunityAttestation } from "./fairness/fairness-evidence.js";
export {
  EXPANSION_BINDING_ISSUE_CODES, EXPANSION_BINDING_LAYERS, EXPANSION_BINDING_ORIGINS,
  bindExpansionAdmission,
} from "./expansion/expansion-binding.js";
export {
  EXPANSION_EVIDENCE_ISSUE_CODES, EXPANSION_EVIDENCE_LAYERS, FORBIDDEN_VERDICT_KEYS,
} from "./expansion/expansion-receipt.js";
export { buildSupersessionDispositions, carryWaitProjection }
  from "./supersession/supersession-dispositions.js";

export type {
  BlockedNode,
  BlockedReason,
  BlockedReasonCode,
  CriticalPathEdge,
  FrontierCursor,
  FrontierError,
  FrontierOk,
  FrontierPartition,
  FrontierResult,
  GraphEdge,
  GraphEdgeKind,
  GraphIssue,
  GraphIssueCode,
  GraphKey,
  GraphNode,
  GraphPolicy,
  GraphSnapshot,
  GraphStructuralAnalysis,
  GraphValidationError,
  GraphValidationOk,
  GraphValidationResult,
  HardEdgeFact,
  HardEdgeSatisfaction,
  NodeAvailabilityFact,
  NodeStructuralFacts,
  RedundancyCandidate,
  StructuralDiagnostic,
  TraversalCounter,
  ValidatedGraph,
} from "./graph-model.js";
export type {
  GraphPreviewAdvisoryEnvelope,
  GraphPreviewAnalyzed,
  GraphPreviewFrontierInvalid,
  GraphPreviewGraphInvalid,
  GraphPreviewOptions,
  GraphPreviewOptionsInvalid,
  GraphPreviewPolicyInvalid,
  GraphPreviewResult,
} from "./graph-preview-model.js";
export type { GraphAnalysisErrorCode } from "./graph-analysis-error.js";
export type {
  HardEdgeCounterfactual,
  HardEdgeCounterfactualAnalysis,
} from "./hard-edge-counterfactual-model.js";

export type {
  AuthorityErrorCode,
  AuthorityIssue,
  AuthorityOutcome,
  AuthorityProof,
  AuthorityRejection,
  ClockObservation,
  LeaseKind,
  LeaseRecord,
  LeaseState,
  RejectionSecurityRecord,
} from "./authority/authority-kernel.js";
export type { Fenced } from "./authority/lease-fencing.js";
export type {
  AcquisitionFailure,
  AcquisitionSet,
  AcquisitionState,
  DeclaredResource,
  ProviderSlotActivateCommand,
  ProviderSlotReservation,
  ReserveAllRequest,
  ReserveAllResult,
  ResourceRow,
  ResourceWaitRequest,
  SlotState,
} from "./authority/resource-model.js";
export type {
  AdmissionAmount,
  AdmissionGate,
  AdmissionHumanApproval,
  AdmissionPolicyAllowance,
  AdmissionPurpose,
  AdmissionRequest,
  BudgetAvailableView,
  BudgetReservationIssue,
  BudgetReservationIssueCode,
  BudgetReservationResult,
  ReservationActivateCommand,
  ReservationCancelCommand,
  ReservationLine,
  ReservationRecord,
  ReservationState,
} from "./budget/budget-reservation.js";
export type {
  BudgetAccountState,
  BudgetMeterBuckets,
  BudgetPolicyOutcome,
  BudgetReservePurpose,
} from "./budget/budget-contract.js";

export type {
  FairnessContractIssue,
  FairnessContractIssueCode,
  FairnessContractLayer,
  FairnessContractRefusal,
  FairnessContractResult,
  FairnessDispatchabilityState,
  FairnessPriorityClass,
} from "./fairness/fairness-contract.js";
export type {
  FairnessDispatchabilityFact,
  FairnessWorkItem,
} from "./fairness/fairness-work-item.js";
export type {
  FairnessRing,
  FairnessRingQueueEntry,
  FairnessRingResource,
} from "./fairness/fairness-ring.js";
export type {
  FairnessBypassClaim,
  FairnessOpportunityAttestation,
  FairnessProvenBypasses,
} from "./fairness/fairness-evidence.js";
export type {
  FairnessCapMigration,
  FairnessCapRevision,
} from "./fairness/fairness-cap-revision.js";
export type {
  FairnessResourceCapacity,
  FairnessRotationDisposition,
  FairnessRotationInputs,
  FairnessRotationOutcome,
  FairnessRotationSelection,
} from "./fairness/fairness-rotation.js";
export type { FairnessAgedStanding } from "./fairness/fairness-aging.js";

export type {
  ExpansionAdmissionIssue, ExpansionAdmissionIssueCode, ExpansionAdmissionOrigin,
  ExpansionAdmissionRefusal, ExpansionAdmissionRequest, ExpansionAdmissionResult,
  ExpansionAdmissionUnwind, ExpansionBoundFacts, ExpansionBudgetFacts, ExpansionCapacityFact,
  ExpansionFairnessFacts, ExpansionLineageFacts, ExpansionPreparation, ExpansionResourceFacts,
  ExpansionRestoredMeter,
} from "./expansion/expansion-preparation.js";
export type {
  DerivedExpansionEvidence, ExpansionChildFacts, ExpansionEvidenceIssue,
  ExpansionEvidenceIssueCode, ExpansionEvidenceLayer, ExpansionEvidenceRefusal,
  ExpansionEvidenceResult, ExpansionInputFact,
} from "./expansion/expansion-receipt.js";
export type {
  ExpansionAdmissionBinding, ExpansionBindingIssue, ExpansionBindingIssueCode,
  ExpansionBindingLayer, ExpansionBindingOrigin, ExpansionBindingRefusal, ExpansionBindingRequest,
  ExpansionBindingResult, ExpansionCurrentAuthority,
} from "./expansion/expansion-binding.js";

export type {
  SupersessionBoundDispositionField,
  SupersessionBudgetFacts,
  SupersessionCarryRefusal,
  SupersessionDispositionFamily,
  SupersessionDispositionLayer,
  SupersessionDispositionResult,
  SupersessionDispositionSet,
  SupersessionFamilyDisposition,
  SupersessionNodeFacts,
  SupersessionRefusalCode,
  SupersessionResourceFacts,
} from "./supersession/supersession-disposition-contract.js";
