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
 * The provider-run settlement seam, published beside the reducer it delegates to
 * because it is the same subtree, not a new provider surface. The entry point is
 * the only thing here that decides anything; the three tables beside it are what
 * let a consumer branch on the decision it made — the exact input key set, the
 * closed refusal vocabulary, and the settlement mapping as data.
 *
 * WITHHELD: `admitProviderRunObservation`, `PROVIDER_SETTLEMENT_MESSAGES` and
 * `PROVIDER_SETTLEMENT_OUTCOME_CLASSES`. The first MINTS an admitted observation
 * and the other two are what a fabricated refusal or a hand-picked outcome class
 * would need to look real — the same asymmetry the telemetry seam publishes
 * under: consumers READ settlements, only this package mints them.
 */
export {
  settleEffectFromProviderObservation,
  type ProviderSettlementOutcome,
} from "./supervisor/provider-effect-settlement.js";
export {
  PROVIDER_EFFECT_SETTLEMENT_LAYER,
  PROVIDER_EFFECT_SETTLEMENT_VERSION,
  PROVIDER_RUN_OBSERVATION_KEYS,
  PROVIDER_SETTLEMENT_ADMITTED_ROWS,
  PROVIDER_SETTLEMENT_CODES,
  type ProviderRunObservation,
  type ProviderSettlementCode,
  type ProviderSettlementDisposition,
  type ProviderSettlementRefusal,
  type ProviderSettlementRow,
} from "./supervisor/provider-settlement-contracts.js";

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

/**
 * The physical workspace allocator. A consumer gets the request shape, the
 * derivation, the frozen assignment, the release vocabulary and the Node
 * adapter — enough to allocate, replay and release one attempt's tree. The
 * failure CONSTRUCTOR and the state fence stay internal: publishing either
 * would let a caller hand this package a fabricated refusal or a hand-built
 * "verified" inspection, which is exactly the authority this seam withholds.
 */
export {
  RUNNER_WORKTREE_LAYERS,
  WORKTREE_ASSIGNMENT_VERSION,
  WORKTREE_RELEASE_DISPOSITIONS,
  WORKTREE_RELEASE_INTENTS,
  deriveWorktreeTarget,
  isWorktreeFailure,
  type DeriveWorktreeTargetResult,
  type RunnerWorktreeLayer,
  type WorktreeAssignment,
  type WorktreeFailure,
  type WorktreeMaterializationRequest,
  type WorktreeMaterializationResult,
  type WorktreeMaterializer,
  type WorktreeReleaseDisposition,
  type WorktreeReleaseIntent,
  type WorktreeReleaseRequest,
  type WorktreeReleaseResult,
  type WorktreeTarget,
} from "./workspace/worktree-materializer-contract.js";
export {
  MAX_WORKTREE_COMMAND_BYTES,
  WORKTREE_GIT_TIMEOUT_MS,
  createNodeWorktreeMaterializer,
} from "./workspace/worktree-materializer-node.js";

/**
 * The Foundation workspace CAPTURE seam: the pair that proves an assigned tree
 * is its sealed input before a provider runs, and derives the advisory attempt
 * core after it exits. Published are the two entry points, the shipped Node
 * filesystem port, the closed refusal vocabulary, the three boundaries that can
 * decide a refusal, the scanner's own budgets, and the two functions a verifier
 * needs to recompute a prelaunch proof's digest.
 *
 * WITHHELD, on the same asymmetry the settlement seam publishes under:
 * `sealPrelaunchProof` MINTS the proof, and `captureFailure` mints a refusal.
 * A consumer able to call either could hand this package a fabricated
 * "the tree was proven" or a fabricated reason — exactly the authority the
 * prelaunch proof exists to establish. The pure decision rules and the raw
 * enumerator stay internal too: the entry points apply them, a consumer never
 * calls one itself.
 */
export {
  DEFAULT_FOUNDATION_CAPTURE_LIMITS,
  FOUNDATION_CAPTURE_CODES,
  FOUNDATION_CAPTURE_LAYER_NAMES,
  FOUNDATION_CAPTURE_VERSION,
  MAX_FOUNDATION_CAPTURE_BYTES,
  MAX_FOUNDATION_CAPTURE_ENTRIES,
  isFoundationCaptureFailure,
  prelaunchProofDigestInput,
  prelaunchProofSealMatches,
  type FoundationCaptureCode,
  type FoundationCaptureCore,
  type FoundationCaptureDirent,
  type FoundationCaptureFailure,
  type FoundationCaptureFsPort,
  type FoundationCaptureInput,
  type FoundationCaptureLayer,
  type FoundationCaptureLimits,
  type FoundationCaptureResult,
  type FoundationCaptureStat,
  type FoundationPrelaunchInput,
  type FoundationPrelaunchProof,
  type FoundationPrelaunchResult,
} from "./workspace/foundation-workspace-capture-contract.js";
export { createNodeFoundationCaptureFs } from "./workspace/foundation-workspace-capture-node.js";
export {
  captureFoundationWorkspaceDelta,
  proveFoundationPrelaunchTree,
} from "./workspace/foundation-workspace-capture.js";
