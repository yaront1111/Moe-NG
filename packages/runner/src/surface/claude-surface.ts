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
/**
 * The durable-authority seam. The FACTORY is published while the default port
 * set behind it is not, and that asymmetry is the point: a daemon needs the
 * launcher's grant consumption and launch registration to be durable
 * compare-and-sets, but it must not be able to take the shipped defaults one at
 * a time — a consumer able to do that could replace the Windows physical
 * boundary alone and keep every other guarantee's appearance. `createClaudeLauncher`
 * is the only way to reach those two slots, and it replaces exactly those two.
 * `CLAUDE_LAUNCHER_DEFAULTS`, `classifyRegistrationPhase` and
 * `durableRegistrationPort` stay internal.
 */
export { createClaudeLauncher } from "../providers/claude/claude-launcher-authority.js";
/**
 * The launch-selection closure travels with the launcher because
 * `ClaudeLaunchRequest` names `ClaudeLaunchSelection`: a consumer able to declare
 * the request but unable to construct that field could not launch at all. The
 * vocabularies come with it for the same reason — a closed union whose members
 * cannot be read is a field nobody can fill — and the flag spellings come because
 * the launcher refuses argv that does not name the selection in exactly those
 * spellings, which a consumer must be able to produce rather than guess.
 *
 * `snapshotLaunchSelection` and `verifyLaunchSelection` are deliberately WITHHELD.
 * The launcher applies both itself, before it prepares a runtime or touches a
 * grant; publishing them would let a consumer pre-validate one selection and then
 * hand `launchClaude` a different one, which is exactly the disagreement between
 * the claimed selection and the launched one that this seam exists to prevent.
 */
export {
  CLAUDE_LAUNCHER_VERSION,
  CLAUDE_LAUNCH_ERROR_CODES,
  CLAUDE_LAUNCH_LAYERS,
  CLAUDE_LAUNCH_REGISTRATION_PHASES,
  CLAUDE_LAUNCH_SELECTION_FLAGS,
  CLAUDE_LAUNCH_TRUTH_CLASSES,
  CLAUDE_MODEL_EVIDENCE_KINDS,
  CLAUDE_REASONING_EFFORTS,
  launchClaude,
  type ClaudeLaunchDuplicate,
  type ClaudeLaunchErrorCode,
  type ClaudeLaunchExit,
  type ClaudeLaunchFailure,
  type ClaudeLaunchLayer,
  type ClaudeLaunchLockLease,
  type ClaudeLaunchLockResult,
  type ClaudeLaunchLimits,
  type ClaudeLaunchObservation,
  type ClaudeLaunchObserved,
  type ClaudeLaunchOptions,
  type ClaudeLaunchRegistrationPhase,
  type ClaudeLaunchRequest,
  type ClaudeLaunchResult,
  type ClaudeLaunchSelection,
  type ClaudeLaunchTruthClass,
  type ClaudeLauncherAuthority,
  type ClaudeLauncherDependencies,
  type ClaudeModelEvidenceKind,
  type ClaudeReasoningEffort,
  type ClaudeRegistrationCommit,
  type ClaudeStreamEvidence,
} from "../providers/claude/claude-launcher.js";
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
