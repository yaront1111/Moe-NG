export {
  ARTIFACT_ADDRESS_PATTERN,
  MAX_ARTIFACT_ENUMERATION_ENTRIES,
  RUNNER_ARTIFACT_ERROR_CODES,
  refMatches,
  refRejection,
  type ArtifactDirectoryEntry,
  type ArtifactDirectoryEntryKind,
  type ArtifactEnumerationFailure,
  type ArtifactEnumerationLayer,
  type ArtifactEnumerationOk,
  type ArtifactEnumerationResult,
  type ArtifactFailure,
  type ArtifactFsPort,
  type ArtifactObjectObservation,
  type ArtifactRef,
  type ArtifactReferenceProof,
  type ArtifactStagingObservation,
  type ArtifactStore,
  type ArtifactStoreOptions,
  type DeleteArtifactResult,
  type RunnerArtifactErrorCode,
  type StageArtifactResult,
  type StagedArtifact,
  type VerifyArtifactResult,
} from "./artifacts/artifact-contract.js";
export { enumerateArtifactsAt } from "./artifacts/artifact-enumeration.js";
export { createNodeArtifactFs } from "./artifacts/artifact-node-fs.js";
export { createArtifactStore } from "./artifacts/artifact-store.js";

export {
  MAX_SCOPE_PATHS,
  RUNNER_SCOPE_ERROR_CODES,
  SCOPE_ATTRIBUTION_CLASSES,
  SCOPE_OBSERVATION_VERSION,
  ScopeObserverError,
  canonicalPathRejection,
  scopeObservationDigestInput,
  type GitObserver,
  type GitRefListing,
  type GitRefObservation,
  type ObserveScopeInput,
  type ObserveScopeResult,
  type RunnerScopeErrorCode,
  type ScopeAttributionClass,
  type ScopeCanonicalEntry,
  type ScopeFailure,
  type ScopeGitAttribution,
  type ScopeObservation,
  type ScopeObserverLayer,
  type ScopePathObserver,
} from "./scope/scope-contract.js";
export {
  MAX_SCOPE_OBSERVATION_BYTES,
  createNodeGitObserver,
  createNodeScopePaths,
  hermeticGitEnvironment,
} from "./scope/scope-git.js";
export { observeScope } from "./scope/scope-observation.js";
export { parseRefListing } from "./scope/scope-refs.js";

/**
 * The supervisor effect seam, curated rather than blanket re-exported: a consumer
 * can create an effect intent, apply a lifecycle command, consume and validate a
 * one-use activation grant, and mirror-fence a lease. `effect-shape`'s generic
 * hostile-input guards stay internal — they carry no supervisor domain meaning —
 * as do its raw key lists, which are unfrozen arrays the mirror parsers read on
 * every call. The test-only fixture module is never published.
 */
export {
  activateEffect,
  type ActivationCommit,
  type ActivationOutcome,
} from "./supervisor/effect-activation.js";
export {
  activationDigestInput,
  consumeActivationGrant,
  deriveGrantId,
  grantRefusal,
  initialGrantBinding,
  validateActivationCommit,
  type CommitCheck,
  type GrantOutcome,
} from "./supervisor/effect-grant.js";
export {
  ATTEMPT_SLICE_STATES,
  EFFECT_CALLER_CONTRACT,
  EFFECT_COMMANDS,
  EFFECT_STATES,
  GRANT_STATES,
  SUPERVISOR_ACTIVATION_VERSION,
  SUPERVISOR_EFFECT_PROTOCOL_VERSION,
  SUPERVISOR_ERROR_CODES,
  SUPERVISOR_LAYERS,
  SUPERVISOR_RESULT_VERSION,
  TERMINAL_EFFECT_STATES,
  isTerminalEffectState,
  supervisorFailure,
  withLeg,
  type ActivationGrant,
  type AttemptSlice,
  type AttemptSliceState,
  type DependencyWitness,
  type EffectClaim,
  type EffectCommand,
  type EffectIntent,
  type EffectResult,
  type EffectState,
  type EffectTombstone,
  type GrantState,
  type SettlementEvidence,
  type SupervisorErrorCode,
  type SupervisorFailure,
  type SupervisorFailureDetail,
  type SupervisorLayer,
  type TerminalEffectState,
  type UncertaintyEvidence,
} from "./supervisor/effect-kernel.js";
export {
  ADMITTED_EFFECT_TRANSITIONS,
  applyEffectCommand,
  applyEffectTombstone,
  type AdmittedTransition,
  type LifecycleOutcome,
} from "./supervisor/effect-lifecycle.js";
export {
  parseActivationGrant,
  parseAttemptSlice,
  parseCommandInput,
  parseDependencyWitness,
  parseEffectClaim,
  parseEffectIntent,
  parseEffectTombstone,
  parseSettlementEvidence,
  parseUncertaintyEvidence,
  type EffectCommandInput,
  type SettleCommand,
  type SimpleCommand,
} from "./supervisor/effect-parse.js";
export {
  MAX_SUPERVISOR_COUNT,
  MAX_SUPERVISOR_TEXT_CHARS,
  MIRRORED_LEASE_KINDS,
  MIRRORED_LEASE_STATES,
  parseMirroredLease,
  parseMirroredProof,
  type MirroredLeaseKind,
  type MirroredLeaseProof,
  type MirroredLeaseRecord,
  type MirroredLeaseState,
} from "./supervisor/effect-shape.js";
export { fenceMirroredLease, type MirrorVerdict } from "./supervisor/lease-mirror.js";

/**
 * The recovery, recovery-inventory, evidence, Claude observation and Codex
 * provider seams reach the root through five per-area surface modules rather
 * than five more inline blocks. Each of those modules is itself an explicit
 * named list — `export *` here republishes exactly what a reviewer curated one
 * file down and cannot grow on its own, so the seam stays a reviewed decision
 * while this entry point stays readable.
 */
export * from "./surface/claude-surface.js";
export * from "./surface/codex-surface.js";
export * from "./surface/evidence-surface.js";
export * from "./surface/provider-record-surface.js";
export * from "./surface/recovery-inventory-surface.js";
export * from "./surface/recovery-surface.js";

/**
 * The platform boundary seam. `PLATFORM_BOUNDARIES` and `PLATFORM_ERROR_CODES`
 * are the frozen vocabulary an OS conformance task schedules faults against.
 * `PLATFORM_LAYERS` beside `PLATFORM_LINUX_LAYER` and `PLATFORM_MACOS_LAYER` is
 * what lets a consumer tell the OS-neutral shape gate's refusal from a
 * particular OS classifier's — the whole reason the modules are separate, and
 * what stops a darwin verdict from being an inherited Linux one. The nine
 * reason codes are shared; the LAYER is what distinguishes them.
 * `platformFailure` and `isPlatformFailure` narrow a refusal without
 * redeclaring its shape, and `observe*Platform` / `classify*Boundary` are the
 * whole-observation and single-boundary entry points per OS. Named explicitly
 * rather than `export *`: this seam is a reviewed decision and must not grow on
 * its own.
 *
 * Both classifiers judge CALLER-SUPPLIED observations against a host the caller
 * names. A PROVEN result means the supplied observation is coherent; it never
 * means the process running this code is on that host.
 */
export {
  PLATFORM_BOUNDARIES,
  PLATFORM_ERROR_CODES,
  PLATFORM_LAYERS,
  PLATFORM_OBSERVATION_VERSION,
  PLATFORM_TRUTH_CLASSES,
  isPlatformFailure,
  platformFailure,
  type PlatformBoundary,
  type PlatformBoundaryVerdict,
  type PlatformErrorCode,
  type PlatformFactEnvelope,
  type PlatformFailure,
  type PlatformHostIdentity,
  type PlatformLayer,
  type PlatformObservation,
  type PlatformTruthClass,
} from "./platform/platform-contract.js";
export {
  LINUX_SUPPORTED_ARCHITECTURES,
  PLATFORM_LINUX_LAYER,
  classifyLinuxBoundary,
  observeLinuxPlatform,
  type LinuxBoundaryFacts,
  type LinuxClassificationContext,
  type LinuxPathFact,
  type LinuxWorkspaceFact,
  type ObserveLinuxPlatformInput,
} from "./platform/linux-observation.js";
export {
  MACOS_SUPPORTED_ARCHITECTURES,
  PLATFORM_MACOS_LAYER,
  classifyMacosBoundary,
  observeMacosPlatform,
  type MacosBoundaryFacts,
  type MacosClassificationContext,
  type MacosPathFact,
  type MacosWorkspaceFact,
  type ObserveMacosPlatformInput,
} from "./platform/macos/macos-observation.js";

export {
  MAX_WORKSPACE_ENTRIES,
  RUNNER_WORKSPACE_ERROR_CODES,
  WORKSPACE_INPUT_MANIFEST_VERSION,
  WORKSPACE_RESULT_MANIFEST_VERSION,
  inputManifestDigestInput,
  resultManifestDigestInput,
  type BuildInputManifestInput,
  type BuildInputManifestResult,
  type BuildResultManifestInput,
  type BuildResultManifestResult,
  type ResultEntryKind,
  type ResultEntryOrigin,
  type ResultTreeEntry,
  type RunnerWorkspaceErrorCode,
  type WorkspaceFailure,
  type WorkspaceInputEntry,
  type WorkspaceInputManifest,
  type WorkspaceProducer,
  type WorkspaceResultManifest,
  type WorkspaceTreeEntry,
} from "./workspace/workspace-contract.js";
export { buildInputManifest, buildResultManifest } from "./workspace/workspace-manifest.js";
