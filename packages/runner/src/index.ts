export {
  ARTIFACT_ADDRESS_PATTERN,
  RUNNER_ARTIFACT_ERROR_CODES,
  refMatches,
  refRejection,
  type ArtifactFailure,
  type ArtifactFsPort,
  type ArtifactRef,
  type ArtifactReferenceProof,
  type ArtifactStore,
  type ArtifactStoreOptions,
  type DeleteArtifactResult,
  type RunnerArtifactErrorCode,
  type StageArtifactResult,
  type StagedArtifact,
  type VerifyArtifactResult,
} from "./artifacts/artifact-contract.js";
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
  type ObserveScopeInput,
  type ObserveScopeResult,
  type RunnerScopeErrorCode,
  type ScopeAttributionClass,
  type ScopeCanonicalEntry,
  type ScopeFailure,
  type ScopeGitAttribution,
  type ScopeObservation,
  type ScopePathObserver,
} from "./scope/scope-contract.js";
export {
  MAX_SCOPE_OBSERVATION_BYTES,
  createNodeGitObserver,
  createNodeScopePaths,
  hermeticGitEnvironment,
} from "./scope/scope-git.js";
export { observeScope } from "./scope/scope-observation.js";

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
