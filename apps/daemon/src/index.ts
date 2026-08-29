/**
 * The @moe/daemon package root.
 *
 * A pure barrel: it decides nothing and defines nothing. Name lists are PACKED
 * rather than one-per-line — the same convention the recovery blocks below
 * already carried — because this file has a hard per-file line budget and the
 * reviewed surface for each area lives in that area's own module.
 */
export {
  BOOTSTRAP_COMMAND_KINDS, BOOTSTRAP_REFUSAL_CODES, BOOTSTRAP_REQUEST_KEYS,
  BOOTSTRAP_SCHEMA_VERSION, decodeBootstrapRequestBytes,
  type BootstrapCommandKind, type BootstrapDecodeRefusal, type BootstrapDecodeResult,
  type BootstrapInputRejected, type BootstrapRefusalCode, type BootstrapRefusedBy,
  type BootstrapRequest, type BootstrapRequestAccepted, type BootstrapRequestRefused,
} from "./bootstrap/bootstrap-contracts.js";
export {
  PREREQUISITE_REFUSAL_CODES, SERVICE_REFUSED_BY,
  type CommandHandler, type DurableAggregate, type DurableLedger, type HandlerContext,
  type HandlerTable, type PrerequisiteRefusalCode, type ServiceAccepted, type ServiceOutcome,
  type ServiceRefused, type ServiceRefusedBy,
} from "./bootstrap/bootstrap-ledger.js";
export { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "./bootstrap/bootstrap-services.js";
export { GOAL_HANDLERS } from "./goals/goal-services.js";
export { PLANNING_HANDLERS } from "./planning/planning-services.js";
/** Server-derived expansion release selection (task-671cdd10). No exported seam takes an
 *  `attemptRef`: the reader derives it, and the internal locator scan stays unexported. */
export {
  EXPANSION_RELEASE_SELECTOR_CODES, EXPANSION_RELEASE_SELECTOR_LAYER_ROSTER,
  EXPANSION_RELEASE_SELECTOR_QUERY_KEYS,
  type ExpansionReleaseSelectorBound, type ExpansionReleaseSelectorCode,
  type ExpansionReleaseSelectorLayer, type ExpansionReleaseSelectorOutcome,
  type ExpansionReleaseSelectorQuery, type ExpansionReleaseSelectorQueryKey,
  type ExpansionReleaseSelectorRefused,
} from "./planning/expansion-release-selector-contracts.js";
export {
  createExpansionReleaseAuthorityReader, readExpansionReleaseSelection,
} from "./planning/expansion-release-selector.js";
export {
  CLAIM_LEGS, SLOT_CEILING_LEG, WORK_AUTHORITY_LABELS, WORK_COMMANDS, WORK_ERROR_CODES,
  WORK_LAYERS, WORK_LEGS, WORK_SCHEMA_VERSION,
  type ClaimLeg, type ClaimSuccessors, type WorkApplied, type WorkAuthorityLabel,
  type WorkCommand, type WorkContextView, type WorkErrorCode, type WorkFailure,
  type WorkGranted, type WorkInputRejected, type WorkLayer, type WorkLeg,
  type WorkRefused, type WorkResult,
} from "./work/work-kernel.js";
export {
  parseWorkRequest, type WorkRequestEnvelope, type WorkRequestParse,
} from "./work/work-ingress.js";
export { claimWork } from "./work/work-claim.js";
/**
 * The advisory legacy-import shadow read (design §21.8). READ-ONLY: its port declares two
 * readers and no writer, and every result carries `advisoryOnly` with `authority: "NONE"`.
 * The consumer edge is task-22cfca91c5134b24aaf3e5734444fb93, which calls
 * `compareImportShadow`.
 */
export {
  IMPORT_SHADOW_READ_LAYER, IMPORT_SHADOW_REFUSAL_CODES,
  type ImportShadowAccepted, type ImportShadowCompared, type ImportShadowComparison,
  type ImportShadowRead, type ImportShadowReadLayer, type ImportShadowRefusalCode,
  type ImportShadowRefused, type ImportShadowRequest, type ImportShadowStorePort,
} from "./projections/import-shadow-contracts.js";
export {
  compareImportShadow, readImportShadowProjection,
} from "./projections/import-shadow-reader.js";
export {
  EVENT_STREAM_CLOCKS, EVENT_STREAM_LAYER, EVENT_STREAM_OBSERVERS,
  EVENT_STREAM_REFUSAL_CODES, EVENT_STREAM_UNKNOWN_CODES, MAX_EVENT_PAGE_SIZE,
  type EventGapFrame,
  type EventAcknowledgeFrame, type EventAcknowledgeRequest, type EventAcknowledgedFrame,
  type EventPageFrame, type EventReadFrame, type EventReadRequest, type EventRefusedFrame,
  type EventReseatedFrame, type EventResumeFrame, type EventResumeRequest,
  type EventStreamClock, type EventStreamObserver, type EventStreamRefusalCode,
  type EventStreamUnknownCode, type SeamObserver, type StreamCursor,
  type StreamAcknowledgeRequest, type StreamAcknowledgeResult, type StreamAcknowledged,
  type StreamEvent, type StreamGap, type StreamPage, type StreamPageRequest,
  type StreamReadResult, type StreamRefused, type StreamReseatRequest,
  type StreamSeatResult, type StreamSeated, type StreamSnapshot, type SubscriptionPort,
  type WireCursor, type WireEvent, type WireEventIdentity, type WireKnownValue,
  type WireObservation, type WireSnapshot, type WireUnknownValue, type WireValue,
} from "./http/event-stream-contract.js";
export { acknowledgeEventPage, readEventPage, resumeFromSnapshot } from "./http/event-stream.js";
export {
  CONTROL_ROOM_LISTENER_LAYER, DAEMON_ENTRY_LAYER, DAEMON_ENTRY_REFUSAL_CODES,
  LISTENER_REFUSAL_CODES, isDependencyProvider, refuseEntry, startControlRoomListener,
  startDaemon,
  type BootReconciliationPort, type BootReconciliationRefused, type ControlRoomListener,
  type DaemonDependencyProvider, type DaemonEntryRefusalCode, type DaemonEntryRefused,
  type DaemonPairingApprovalResult,
  type DaemonStartOptions, type DaemonStartResult, type ListenerRefusalCode,
  type ListenerRefused, type ShutdownResult, type StartedDaemon, type StartListenerOptions,
  type StartListenerResult,
} from "./daemon-entry.js";
export {
  HTTP_BOUNDARY_ERROR_CODES, HTTP_INPUT_BOUNDS, HTTP_REFUSAL_STAGES,
  MAX_COMMAND_PAYLOAD_FIELDS, WIRE_PROTOCOL_VERSION, buildCommandRegistry,
  type AuthenticatedPrincipal, type AuthenticationResult, type Authenticator,
  type AuthVerdict, type BoundaryCodesAreRuntimeCodes, type CommandAdapterDeps,
  type CommandDecisionPort, type CommandHandler as HttpCommandHandler,
  type CommandHandlerInput, type CommandRegistry, type CommandRegistryEntry,
  type DecisionKey, type DecisionPortResult, type DurableDecision, type HttpAccepted,
  type HttpBoundaryErrorCode, type HttpCommandRequest, type HttpCommandResult,
  type HttpPortRefused, type HttpRefusalStage, type HttpRefused, type PortRefusal,
  type WireProtocolVersion,
} from "./http/http-contract.js";
export { handleCommandRequest } from "./http/http-adapter.js";
export {
  OPERATOR_CAPABILITIES, createDaemonCommandPorts,
  type DaemonCommandPortOptions, type DaemonCommandPorts,
} from "./daemon-command-registry.js";
export {
  DOCTOR_COMMAND_KINDS, DOCTOR_ERROR_CODES, DOCTOR_RECOVERY_SCHEMA_VERSION,
  evaluateDoctorCommandBytes,
  type DoctorAuthorityStale, type DoctorCommandKind, type DoctorCommandResult,
  type DoctorErrorCode, type DoctorInputRejected, type DoctorProposed, type DoctorReported,
  type DoctorRequestInvalid, type DoctorVersionReportAbsent,
} from "./recovery/doctor-commands.js";
export { collectDoctorVersionReport } from "./recovery/doctor-version.node.js";
export type { DoctorVersionReport, DoctorVersionsReported } from "./recovery/doctor-version-contract.js";
export { REVIEW_HANDLERS } from "./review/review-services.js";
export type {
  DeltaClassification, DeltaNodeClassification, ReviewCommandKind, ReviewDecodeRefusal,
  ReviewDecodeResult, ReviewIngressRefusalCode, ReviewInputRejected,
  ReviewPrerequisiteRefusalCode, ReviewRefusedBy, ReviewRequest, ReviewRequestAccepted,
  ReviewRequestRefused,
} from "./review/review-contracts.js";
export type {
  CommandHandler as ReviewCommandHandler, HandlerContext as ReviewHandlerContext,
  HandlerTable as ReviewHandlerTable, ReviewAccepted, ReviewDaemonLayer,
  ReviewDaemonRefusalCode, ReviewLedger, ReviewOutcome, ReviewRefused, ReviewRoundRecord,
} from "./review/review-ledger.js";
export {
  RECOVERY_INCARNATION_ERROR_CODES, RECOVERY_INCARNATION_SCHEMA_VERSION,
  createNodeRecoveryCryptoPort, createRecoveryIncarnationService,
  type GenesisIncarnationBinding, type RecoveryIncarnationBinding,
  type RecoveryIncarnationBindingCommon, type RecoveryIncarnationCryptoPort,
  type RecoveryIncarnationErrorCode, type RecoveryIncarnationKeyHandle,
  type RecoveryIncarnationKeyPair, type RecoveryIncarnationMinted,
  type RecoveryIncarnationOrigin, type RecoveryIncarnationProof,
  type RecoveryIncarnationRefused, type RecoveryIncarnationRequest,
  type RecoveryIncarnationResult, type RecoveryIncarnationService,
  type RestoreIncarnationBinding,
} from "./recovery/recovery-incarnation.js";
// The durable half of the same identity. `anchorIncarnation` is published
// alongside the succession service because an ORIGIN incarnation has to be
// anchored by whoever mints it: without it a root consumer could never place
// the first link, and every chain walk would refuse NOT_FOUND forever.
export {
  anchorIncarnation, readAnchoredIncarnation,
} from "./recovery/recovery-incarnation-anchor.js";
export {
  RECOVERY_SUCCESSION_ERROR_CODES, RECOVERY_SUCCESSION_LAYER,
  RECOVERY_SUCCESSION_SCHEMA_VERSION, createRecoverySuccessionService, readSuccessionChain,
  type RecoverySuccessionChain, type RecoverySuccessionChainResult,
  type RecoverySuccessionErrorCode, type RecoverySuccessionRecord,
  type RecoverySuccessionRecorded, type RecoverySuccessionRefused,
  type RecoverySuccessionRequest, type RecoverySuccessionResult,
  type RecoverySuccessionService,
} from "./recovery/recovery-succession.js";
// R3 disaster-recovery completion, plus the reconciliation ledger it consumes.
// The ledger pair is published HERE rather than left where it was written: it
// had zero root exports and zero production consumers, so nothing could compose
// it and a runtime-loadability gate proving the module LOADS proved nothing
// about anything IMPORTING it.
export {
  RECOVERY_COMPLETION_APPROVAL_DOMAIN, RECOVERY_COMPLETION_HUMAN_GATE_ID,
  recoveryCompletionApprovalDigest, type RecoveryCompletionApprovalSubject,
} from "./recovery/recovery-completion-authority.js";
export {
  RECOVERY_COMPLETE_PAYLOAD_KEYS, RECOVERY_COMPLETION_CODES, RECOVERY_COMPLETION_COMMAND_KIND,
  RECOVERY_COMPLETION_LAYER, RECOVERY_COMPLETION_SCHEMA_VERSION, RECOVERY_STEP_UP_REF_PREFIX,
  RECOVERY_STEP_UP_WINDOW_SECONDS, recoveryCompletionDigest, recoveryCoverageProofDigest,
  type RecoveryCompletionCode, type RecoveryCompletionEvidence,
  type RecoveryCompletionItemEvidence, type RecoveryCompletionProofEvidence,
  type RecoveryCompletionRefused, type RecoveryCompletionUpstream,
} from "./recovery/recovery-completion-digest.js";
export {
  readRecoveryCompletionEvidence, runRecoveryCompleteCommand, type RecoveryCompleteRequest,
  type RecoveryCompletionAccepted, type RecoveryCompletionEvidenceFound,
  type RecoveryCompletionEvidenceResult, type RecoveryCompletionOutcome,
} from "./recovery/recovery-completion.js";
export {
  readRecoveryReconciliation, recordRecoveryReconciliation,
  type RecoveryDurableReconcileRequest, type RecoveryReconciliationExternalFacts,
  type RecoveryReconciliationFound, type RecoveryReconciliationReadResult,
  type RecoveryReconciliationRecorded, type RecoveryReconciliationWriteResult,
} from "./recovery/recovery-inventory-ledger.js";
export type {
  RecoveryInventoryRefusal, RecoveryReconciliationItem, RecoveryReconciliationProof,
  RecoveryReconciliationRecord,
} from "./recovery/recovery-inventory-contract.js";
export {
  PROJECT_CONFIGURATION_SELECTION_CODES, PROJECT_CONFIGURATION_SELECTION_LAYER,
  readCurrentProjectConfiguration, readLatestProjectConfiguration, selectProjectConfiguration,
  type CurrentProjectConfiguration, type ProjectConfigurationSelectionCode,
  type ProjectConfigurationSelectionUnknown, type ProjectConfigurationSelectionUpstream,
  type ProjectConfigurationStore, type ReadCurrentProjectConfigurationResult,
  type SelectedProjectConfiguration, type SelectProjectConfigurationResult,
} from "./configuration/project-configuration-selection.js";
// The current-profile READER only. `admitProviderProfile` and the codec byte surface stay
// unpublished: `provider.probe` is the single admission seam, and a second published entry
// point would let a caller mint durable authority around it. Two codec TYPES travel because
// a ProviderCapabilities consumer cannot name its closure without them.
export {
  PROVIDER_PROFILE_READER_CODES, resolveCurrentProviderProfile,
  type ProviderCapabilities, type ProviderProfileReaderLayer,
} from "./provider-profile/provider-profile-resolver.js";
export { type ProviderProfileIssue, type ProviderProfileRevision }
  from "./provider-profile/provider-profile-codec.js";
// Relocated out of this barrel, re-exported under the original names so no
// consumer's import path changed. See graph-preview-request.ts for why.
export {
  evaluateGraphPreviewRequestBytes,
  type GraphPreviewInputRejected, type GraphPreviewRequestError,
  type GraphPreviewRequestEvaluated, type GraphPreviewRequestInvalid,
  type GraphPreviewRequestResult,
} from "./graph-preview-request.js";
// The Foundation ingress surface: six committed families published by explicit
// name from ONE curated area module, so an external canary or MCP host can drive
// production authority without a deep import. Never `export *` — see
// foundation/foundation-surface.ts for why a star here would be unsound.
export {
  CONTINUATION_COMMAND_KIND, CONTINUATION_PAYLOAD_KEYS, DAEMON_FOUNDATION_ATTEMPT,
  DELTA_CLASSIFICATIONS, FOUNDATION_ATTEMPT_CODES, FOUNDATION_ATTEMPT_RECORD_VERSION,
  FOUNDATION_ATTEMPT_REQUEST_KEYS, FOUNDATION_ATTEMPT_SCHEMA_VERSION,
  FOUNDATION_DISPATCH_COMMAND_KIND, FOUNDATION_RESERVATION_VERSION,
  FOUNDATION_VERIFICATION_CODES, FOUNDATION_VERIFICATION_COMMAND_KIND,
  FOUNDATION_VERIFICATION_LAYERS, FOUNDATION_VERIFICATION_RECEIPT_VERSION,
  FOUNDATION_VERIFICATION_RECIPE_VERSION, FOUNDATION_VERIFICATION_REFUSAL_SOURCES,
  FOUNDATION_VERIFICATION_REQUEST_KEYS, FOUNDATION_VERIFICATION_SCHEMA_VERSION,
  FOUNDATION_VERIFICATION_VERDICTS, GOAL_CLOSURE_WITNESS_VERSION, GOAL_PREREQUISITE_LAYER,
  GOAL_PREREQUISITE_REFUSAL_CODES, RESTART_RECONCILIATION_COMMAND_KIND,
  RESTART_RECONCILIATION_SCHEMA_VERSION, RESTART_RECORD_CLASSIFICATIONS,
  REVIEW_COMMAND_KINDS, REVIEW_INGRESS_REFUSAL_CODES, REVIEW_PREREQUISITE_REFUSAL_CODES,
  REVIEW_REFUSED_BY, REVIEW_REQUEST_KEYS, REVIEW_SCHEMA_VERSION, RUNNER_WORKSPACE_LAYER,
  SCHEDULER_GRAPH_LAYER, coordinationPresentationDigest, createCoordinationAdapter,
  createFoundationAttemptService, createFoundationVerificationService,
  decodeReviewRequestBytes, deriveRecipeAggregateId, deriveVerificationAggregateId,
  qualifyGoalClosure, readFoundationAttemptRecord, readReconciliationRecords,
  readReviewLedger, reconcileOnRestart, runContinuationCommand, runReviewCommand,
  type AcceptanceRecord, type ContinuationCommandInput, type ContinuationCommandOutcome,
  type CoordinationAdapter, type CoordinationAdapterOptions, type CoordinationAuthRefused,
  type CoordinationPresentationFields, type DeltaRecord, type FoundationAttemptBinding,
  type FoundationAttemptCode, type FoundationAttemptDeps,
  type FoundationAttemptDispatchRequest, type FoundationAttemptLaunchTemplate,
  type FoundationAttemptOutcome, type FoundationAttemptRecordAnswer,
  type FoundationAttemptRefused, type FoundationRecipeOutcome,
  type FoundationRecipeRegistration, type FoundationVerificationAnswer,
  type FoundationVerificationCode, type FoundationVerificationDeps,
  type FoundationVerificationLayer, type FoundationVerificationOutcome,
  type FoundationVerificationRefusalSource, type FoundationVerificationRefused,
  type FoundationVerificationRequest, type FoundationVerificationVerdict,
  type GoalClosureQualification, type GoalClosureQualified, type GoalClosureRefused,
  type GoalPrerequisiteRefusalCode, type InFlightAttempt, type ReconciliationRecord,
  type RestartReconciliationRequest, type RestartReconciliationResult,
  type RestartRecordClassification, type RestartTruthClass,
} from "./foundation/foundation-surface.js";
export {
  admitCutoverActivateApproval,
  type AdmitCutoverActivateApprovalInput, type CutoverActivateApprovalAccepted,
  type CutoverActivateApprovalResult, type CutoverAttemptReadRefusal,
} from "./cutover/cutover-attempt-commit.js";
