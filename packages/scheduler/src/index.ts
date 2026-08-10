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
 *    capacity snapshot. No slot is counted or activated here.
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
  SUPERSESSION_BOUND_DISPOSITION_FIELDS, SUPERSESSION_DISPOSITION_FAMILIES,
  SUPERSESSION_DISPOSITION_LAYERS, SUPERSESSION_REFUSAL_CODES,
} from "./supersession/supersession-disposition-contract.js";
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
