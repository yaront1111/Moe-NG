/**
 * The Claude observation seam, curated rather than blanket re-exported.
 *
 * A consumer holding only these names can build and re-verify a provider runtime
 * observation, decide whether its pinning is authoritative enough to launch, read
 * the capability profile vocabulary, and reconcile an observed run into exactly
 * one member of the closed outcome set.
 *
 * `buildProviderRuntimeObservation` is MANDATORY here rather than convenience:
 * `ProviderRuntimeObservation` carries a digest over its own field set, and
 * `observedExecutionRejection` refuses one whose digest does not recompute, so a
 * hand-built observation can never reach an evidence receipt. Publishing the
 * type without its builder would publish an unusable type.
 *
 * The stream names are the type closure of reconciliation — `ClaudeStreamRecord`
 * is the input and the disposition/anomaly vocabularies are what the verdict
 * carries. `recordClaudeStream` itself is deliberately withheld: a stream record
 * is plain data a consumer can assemble from these types, so reconciliation is
 * reachable without opening the stream-recording subtree on this seam.
 *
 * The probe port, the capability assessment helpers, and `claudeFailure` stay
 * internal.
 */
export {
  CLAUDE_RECONCILED_OUTCOMES,
  CLAUDE_RECONCILIATION_VERSION,
  reconcileClaudeRun,
  type ClaudeProcessExit,
  type ClaudeReconciledOutcome,
  type ClaudeReconciliation,
  type ReconcileClaudeRunInput,
} from "../providers/claude/claude-cancel-reconcile.js";
export {
  CLAUDE_CAPABILITIES,
  CLAUDE_CAPABILITY_PROFILE_VERSION,
  CLAUDE_CAPABILITY_STATUSES,
  CLAUDE_CONTEXT_POLICIES,
  CLAUDE_PROOF_METHODS,
  type ClaudeCapability,
  type ClaudeCapabilityProfile,
  type ClaudeCapabilityRecord,
  type ClaudeCapabilityStatus,
  type ClaudeContextLimit,
  type ClaudeContextPolicy,
  type ClaudeProofMethod,
} from "../providers/claude/claude-capabilities.js";
export {
  CLAUDE_OBSERVATION_ERROR_CODES,
  CLAUDE_RUNTIME_OBSERVATION_VERSION,
  OBSERVATION_TRUTH_CLASSES,
  RUNTIME_CLOSURE_KINDS,
  RUNTIME_PINNING_METHODS,
  buildProviderRuntimeObservation,
  observationDigestInput,
  runtimePinningIsAuthoritative,
  type BuildObservationInput,
  type BuildObservationOk,
  type BuildObservationResult,
  type ClaudeFailure,
  type ClaudeObservationErrorCode,
  type ObservationClock,
  type ObservationFreshness,
  type ObservationTruthClass,
  type PlatformIdentity,
  type ProviderRuntimeObservation,
  type RuntimeClosureEntry,
  type RuntimeClosureKind,
  type RuntimePinningMethod,
} from "../providers/claude/claude-observation.js";
export {
  CLAUDE_STREAM_ANOMALIES,
  CLAUDE_STREAM_DISPOSITIONS,
  CLAUDE_STREAM_RECORD_VERSION,
  type ClaudeRawRetention,
  type ClaudeStreamAnomaly,
  type ClaudeStreamDisposition,
  type ClaudeStreamEvent,
  type ClaudeStreamRecord,
  type MoeEffectIdentity,
} from "../providers/claude/claude-stream.js";
