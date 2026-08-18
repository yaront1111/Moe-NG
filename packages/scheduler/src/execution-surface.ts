/**
 * Execution-facing half of the package root: the authority, resource, budget and
 * fairness families, curated exactly as the root curated them inline.
 *
 * This module publishes NOTHING the root did not already publish, and withholds
 * everything the root already withheld. It exists so that neither this file nor
 * the root sits past the per-file size rule, and so a later consumer can add an
 * execution export without editing an oversized source. The root forwards this
 * module wholesale, so the reviewed namespace is byte-for-byte the same set.
 *
 * The curation lives in the export specifiers below, never in the file boundary:
 * each family's reviewed rationale travels WITH its block, because that prose is
 * the argument for what the family publishes and what it deliberately does not.
 */
export {
  activateProviderSlot,
  adapterConfirm,
  adapterFail,
  grantSuccessorCapacity,
  releaseProviderSlot,
  reserveAll,
  reserveProviderSlot,
} from "./authority/lease-resource.js";
/**
 * The design-427 release command shape travels WITH `releaseProviderSlot` above, because a
 * consumer that can name the transition but not the record it takes cannot call it from the
 * bare specifier alone. Published through the same slot-family re-export block, so the whole
 * RESERVED -> ACTIVE -> RELEASED path is reachable from one import.
 */
export type { ProviderSlotReleaseCommand } from "./authority/lease-resource.js";
export {
  fenceAuthority,
  parseClock,
  parseLeaseRecord,
  parseProof,
} from "./authority/lease-fencing.js";
export { SLOT_STATES } from "./authority/resource-model.js";
/**
 * The design-765 release authority, SOLE composer of a lease's RELEASED /
 * DRAINING / NO_OP transition: one place for a durable consumer to get
 * `leaseState`, and no reason to derive `resumable`, a terminal target or a drain
 * rank a second time. CURATED — `applyDrainReason` and `parseDisposition` stay
 * withheld, because `releaseWork` runs both internally over an ALREADY-FENCED
 * record and a consumer holding either could compose a disposition, and so a
 * `resumable`, for a lease the fence never admitted.
 */
export { releaseWork } from "./authority/lease-drain.js";
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
  BUDGET_ISSUE_CODES,
  BUDGET_MEASUREMENT_COVERAGES,
  BUDGET_MEASUREMENT_SOURCES,
} from "./budget/budget-contract.js";
/**
 * The measurement authority, not its parts. `normalizeUsageMeasurement` composes
 * `validateUsageMeasurement` and then adds the source/coverage matrix, the pricebook binding
 * check and the identity/sequence checks, so publishing the bare validator would hand a
 * consumer a gate that accepts records the authority refuses. `projectBudgetFact`,
 * `PolicyFactInputCompatible` and `MEASUREMENT_FACT_TIER` stay withheld for the same reason
 * in the other direction: budget-policy projection is a different seam.
 */
export {
  MEASUREMENT_ISSUE_CODES,
  MEASUREMENT_ISSUE_LAYERS,
  SUPPORTED_SOURCE_PARSER_VERSIONS,
  normalizeUsageMeasurement,
} from "./budget/budget-measurement.js";
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
/** The four shapes `releaseWork` reads and answers in, so a consumer completes the
 *  type closure from the bare specifier alone; `DrainTerminalTarget` and
 *  `DrainReason` are reachable as field types of `DrainDisposition`. */
export type { DrainDisposition, ReleaseHandoff, ReleaseRequest, ReleaseResult }
  from "./authority/lease-drain.js";
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
  BudgetIssueCode,
  BudgetMeasurementCoverage,
  BudgetMeasurementSource,
  BudgetMeterBuckets,
  BudgetPolicyOutcome,
  BudgetReservePurpose,
  ObservedIntervalRefs,
  UsageMeasurementRecord,
} from "./budget/budget-contract.js";
/** `ObservedIntervalRefs` above is closure, not decoration: it is the field type of
 * `UsageMeasurementRecord.observedInterval`, so without it a consumer can name the record but
 * never construct one. */
export type {
  LayeredIssue,
  MeasurementIssueCode,
  MeasurementIssueLayer,
  MeasurementResult,
  NormalizedMeasurement,
  PricebookBinding,
} from "./budget/budget-measurement.js";

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
