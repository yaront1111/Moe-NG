/**
 * Package-ROOT reachability contract for the committed supervisor effect surface.
 *
 * Every specifier in this file is the bare package root `@moe/runner`. The
 * package `exports` map is exclusive (`{".": "./src/index.ts"}`), so a deep
 * subpath such as `@moe/runner/supervisor/effect-lifecycle.js` does not resolve
 * for a real consumer at all — testing one would prove nothing about the seam
 * this task publishes, and a relative import would prove even less.
 *
 * The expected namespace below is hand-transcribed from the module sources, never
 * derived from the namespace under test, so a removed export AND an unreviewed
 * addition both go red.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import * as runner from "@moe/runner";
import type {
  ActivationCommit, ActivationGrant, ActivationOutcome, AdmittedTransition, AttemptSlice,
  AttemptSliceState, CommitCheck, DependencyWitness, EffectClaim, EffectCommand,
  EffectCommandInput, EffectIntent, EffectResult, EffectState, EffectTombstone, GrantOutcome,
  GrantState, LifecycleOutcome, MirrorVerdict, MirroredLeaseKind, MirroredLeaseProof,
  MirroredLeaseRecord, MirroredLeaseState, SettleCommand, SettlementEvidence, SimpleCommand,
  SupervisorErrorCode, SupervisorFailure, SupervisorFailureDetail, SupervisorLayer,
  TerminalEffectState, UncertaintyEvidence,
} from "@moe/runner";
/** The recovery-inventory seam's type closure, named through the same root. */
import type {
  RecoveryInventoryClass, RecoveryInventoryCoverageProof, RecoveryInventoryEnumerationContext,
  RecoveryInventoryOpaqueRef, RecoveryInventoryRegistration, RecoveryInventoryReport,
  RecoveryInventoryResult, RecoveryInventoryWindow,
} from "@moe/runner";
/**
 * The construction closure of the four registration factories, named through the
 * same root. A daemon that can see `providerLockInventoryRegistration` but cannot
 * name the shape of its argument cannot compose it, so an under-published closure
 * has to fail here rather than in the consumer's own repository. `ObservationClock`,
 * `PlatformIdentity`, `RuntimeClosureEntry` and `RuntimePinningMethod` are NOT
 * repeated here: the Claude seam already roots them, and Codex's own structurally
 * identical declarations must not be re-exported under the same names. The Codex
 * seam publishes its copies under `Codex`-prefixed ALIASES instead, imported in
 * their own block below; the ten `Codex*` names in THIS block stay owned by the
 * recovery-inventory seam and are deliberately not republished by it.
 */
import type {
  ArtifactObjectInventoryInput, ArtifactObjectInventoryReading, ClaudeCancelObservation,
  ClaudeProbePort, ClaudeProbeReport, ClaudeProcessTreeObservation,
  ClaudeRunEnumerationObservation, ClaudeStructuredSample, ClaudeTokenizerObservation,
  CodexCancelObservation, CodexContextLimit, CodexCwdObservation, CodexProbePort,
  CodexProbeReport, CodexProcessTreeObservation, CodexRunEnumerationObservation,
  CodexStructuredSample, CodexTokenizerObservation, GitIntegrationInventoryInput,
  GitIntegrationInventoryReading, GitIntegrationRefusal, ProbeClaudeRuntimeInput,
  ProbeCodexRuntimeInput, ProviderLockInventoryInput, ProviderLockInventoryPort,
  ProviderProcessRecord, WorkspaceInventoryInput, WorkspaceInventoryListing,
  WorkspaceInventoryPort, WorkspaceInventoryResultAspect, WorkspaceInventorySource,
} from "@moe/runner";
/**
 * The Codex provider seam's type closure, through the same root. Nine of these
 * are aliases over provider-neutral names Codex redeclares — `CodexObservationClock`,
 * `CodexPlatformIdentity`, `CodexRuntimeClosureEntry`, `CodexRuntimeClosureKind`,
 * `CodexRuntimePinningMethod`, `CodexObservationTruthClass`, `CodexBuildObservationInput`,
 * `CodexBuildObservationResult` and `CodexEffectIdentity` — so naming them here is
 * what proves the alias reached the root rather than being dropped as an
 * ambiguous star export, which produces no compile error of its own.
 */
import type {
  CodexBuildObservationInput, CodexBuildObservationResult, CodexCapability,
  CodexCapabilityProfile, CodexCapabilityRecord, CodexCapabilityStatus, CodexContextPolicy,
  CodexEffectIdentity, CodexFailure, CodexMirroredSkillEntry, CodexMirroredSkillFile,
  CodexMirroredSkillRendererInput, CodexObservationClock, CodexObservationErrorCode,
  CodexObservationTruthClass, CodexPlatformIdentity, CodexProcessExit, CodexProofMethod,
  CodexProviderRuntimeObservation, CodexRawRetention, CodexReconciledOutcome,
  CodexReconciliation, CodexRenderErrorCode, CodexRenderLayer, CodexRenderLayerEntry,
  CodexRenderedContext, CodexRuntimeClosureEntry, CodexRuntimeClosureKind,
  CodexRuntimePinningMethod, CodexStreamAnomaly, CodexStreamDisposition, CodexStreamErrorCode,
  CodexStreamEvent, CodexStreamRecord, CodexTokenizerPort, ProbeCodexRuntimeOk,
  ProbeCodexRuntimeResult, ReconcileCodexRunInput, RecordCodexStreamInput,
  RecordCodexStreamResult, RenderCodexContextInput, RenderCodexContextResult,
} from "@moe/runner";
/**
 * The provider-telemetry seam's type closure, through the same root. A type-only
 * export is INVISIBLE to the namespace count above — `Object.keys` cannot see
 * it — so naming each one here through the bare specifier is the only thing that
 * proves it reached the root rather than being dropped as an ambiguous star
 * export, which produces no compile error of its own.
 */
import type {
  ClaudeDeclaredSelection, ClaudeObservedModel, ClaudeResultTelemetry,
  ClaudeResultTelemetryVerdict, ClaudeStepObservations, ClaudeTelemetryConcurrency,
  ClaudeTelemetryHandoff, ClaudeTelemetryLaunchFacts, ClaudeTelemetryLaunchInput,
  ClaudeTelemetryLaunchResult, ClaudeTokenObservations, ParseClaudeResultTelemetryInput,
  ProviderConcurrencyFact, ProviderCountCoverage, ProviderFactUnknown,
  ProviderInfrastructureOutcome, ProviderQuantity, ProviderRunRef, ProviderTelemetryCode,
  ProviderTelemetryLayer, ProviderTelemetryRefusal, ProviderTerminalOutcome, ProviderText,
} from "@moe/runner";
/**
 * The provider-RUN RECORD closure, through the same root and for the same
 * reason: a consumer that receives a record but cannot NAME its parts cannot
 * store, narrow or re-verify one.
 */
import type {
  ProviderCostBasis, ProviderDecisionDigests, ProviderModelSelection, ProviderModelSnapshotKind,
  ProviderObservedModel, ProviderRunConcurrency, ProviderRunIdentity, ProviderRunRecord,
  ProviderRuntimeEvidence, ProviderStepCounts, ProviderTokenCounts, ProviderUnpricedReason,
  ProviderUsageCode, ProviderUsageContext, ProviderUsageCostBasis, ProviderUsageLayer,
  ProviderUsageMeasurement, ProviderUsageNormalized, ProviderUsageRefusal, ProviderUsageResult,
} from "@moe/runner";
/** The recovery, evidence and Claude observation seams, through the same root. */
import type {
  ArtifactFsPort, ArtifactRef, ArtifactStore, BuildEvidenceReceiptInput, BuildEvidenceReceiptResult,
  BuildObservationInput, BuildObservationResult, BuildVerificationRecipeResult, CandidateTreeEntry,
  CandidateTreePort, ClaudeLaunchErrorCode, ClaudeLaunchFailure, ClaudeLaunchLayer,
  ClaudeLaunchLimits, ClaudeLaunchLockLease, ClaudeLaunchLockResult, ClaudeLaunchObservation,
  ClaudeLaunchOptions, ClaudeLaunchRegistrationPhase, ClaudeLaunchRequest,
  ClaudeLaunchResult, ClaudeLaunchSelection, ClaudeLaunchTruthClass, ClaudeLauncherAuthority,
  ClaudeLauncherDependencies, ClaudeModelEvidenceKind, ClaudeProcessExit,
  ClaudeRawRetention, ClaudeReasoningEffort, ClaudeReconciledOutcome, ClaudeRegistrationCommit,
  ClaudeReconciliation, ClaudeStreamAnomaly, ClaudeStreamDisposition, ClaudeStreamEvent,
  ClaudeStreamRecord, CrashClassification, DeclaredInput, DischargedObligation, DrainAdvance,
  DrainDisposition, DrainReason, DrainTerminalTarget, EvidenceFailure, EvidenceObligationKind,
  EvidenceReceipt, EvidenceRefusalLayer, ExecutionDisposition, GitObserver, MoeEffectIdentity,
  ObligationContext, ObligationSupport, ObservationClock, ObservationTruthClass, ObservedOutput,
  ObservedVerifierExecution, OverlapVerdict, PlatformIdentity, PredecessorRelease,
  ProviderRuntimeObservation, ReceiptTimestamps, ReconcileClaudeRunInput, RecoveryEffectStatus,
  RecoveryErrorCode, RecoveryFailure, RecoveryLayer, RecoveryOutcomeKind,
  RematerializeCandidateInput, RematerializeCandidateResult, RestartPostState, ResumeVerdict,
  RunnerEvidenceErrorCode, RuntimeClosureEntry, RuntimeClosureKind, RuntimePinningMethod,
  ScopeObservation, VerificationRecipe, VerifierIdentity, WorkspaceInputManifest,
  WorkspaceResultManifest,
} from "@moe/runner";
/**
 * The runtime pin-REQUEST seam's type closure, through the same root. A consumer
 * that can call the hydrator but cannot NAME its input, its result union or the
 * refusal it may return cannot compose it at all, so an under-published closure
 * has to fail here rather than in the consumer's own repository.
 */
import type {
  ClaudeRuntimePinErrorCode, ClaudeRuntimePinFailure, ClaudeRuntimePinRequest,
  ClaudeRuntimePinRequestInput, ClaudeRuntimePinRequestResult,
} from "@moe/runner";
/**
 * The launch-LIMIT admission seam's type closure, through the same root. Type
 * exports are invisible to the runtime export count below, so the only proof
 * that this closure is published is that each name is USED in an annotation —
 * which the limit cases further down do. `ClaudeLaunchLimits` itself is already
 * named by the launcher block above and is not re-imported here.
 */
import type {
  ClaudeLaunchLimitField, ClaudeLaunchLimitIssue, ClaudeLaunchLimitIssueCode,
  ClaudeLaunchLimitLayer, ClaudeLaunchLimitsResult,
} from "@moe/runner";
/**
 * The DISCOVERY seam's type closure, through the same root. `WindowsProcessUnknown`
 * is one of the four arms its result can carry — a consumer that cannot name it
 * cannot branch on the layer that refused, which is precisely the fact DoD 3
 * requires to survive.
 */
import type {
  DiscoverInstalledClaudeRuntimeResult, DiscoveredClaudeRuntime, WindowsProcessUnknown,
} from "@moe/runner";
/** The platform boundary seam, through the same root. */
import type {
  LinuxBoundaryFacts, LinuxClassificationContext, LinuxPathFact, ObserveLinuxPlatformInput,
  PlatformBoundary, PlatformBoundaryVerdict, PlatformFactEnvelope, PlatformFailure,
  PlatformHostIdentity, PlatformLayer, PlatformObservation, PlatformTruthClass,
} from "@moe/runner";
/**
 * The macOS half of that seam, through the same root and in its own block. A
 * darwin consumer must be able to compose a whole observation without naming a
 * single `Linux*` type — if it could not, the two adapters would not really be
 * independent and macOS would be reachable only by borrowing Linux's closure.
 */
import type {
  MacosBoundaryFacts, MacosClassificationContext, MacosPathFact, MacosWorkspaceFact,
  ObserveMacosPlatformInput,
} from "@moe/runner";
/** The Git ref and artifact object enumeration seam, through the same root. */
import type {
  ArtifactDirectoryEntry, ArtifactDirectoryEntryKind, ArtifactEnumerationFailure,
  ArtifactEnumerationLayer, ArtifactEnumerationOk, ArtifactEnumerationResult,
  ArtifactObjectObservation, ArtifactStagingObservation, GitRefListing, GitRefObservation,
  ScopeObserverLayer, SourceSnapshotGitCode, SourceSnapshotGitLayer,
  SourceSnapshotGitObservation, SourceSnapshotGitObserved, SourceSnapshotGitObserver,
  SourceSnapshotGitRefusal, SourceSnapshotGitResult,
} from "@moe/runner";
/**
 * The provider-run settlement seam's type closure, through the same root. A
 * consumer that can call `settleEffectFromProviderObservation` but cannot name
 * the observation it must build, or the refusal it must branch on, cannot
 * compose the seam at all — so an under-published closure fails here rather than
 * in the consuming repository.
 */
import type {
  ProviderRunObservation, ProviderSettlementCode, ProviderSettlementDisposition,
  ProviderSettlementOutcome, ProviderSettlementRefusal, ProviderSettlementRow,
  RunnerWorktreeLayer, WorktreeFailure, WorktreeMaterializationRequest,
  WorktreeMaterializationResult, WorktreeMaterializer, WorktreeReleaseDisposition,
  WorktreeReleaseIntent,
} from "@moe/runner";
/** The Foundation capture seam's construction closure, named through the same root. */
import type {
  FoundationCaptureCode, FoundationCaptureDirent, FoundationCaptureFailure,
  FoundationCaptureFsPort, FoundationCaptureInput, FoundationCaptureLayer,
  FoundationCaptureLimits, FoundationCaptureResult, FoundationCaptureStat,
  FoundationPrelaunchInput, FoundationPrelaunchResult,
} from "@moe/runner";

it("resolves the self-referencing package root specifier @moe/runner", () => {
  expect(typeof runner.observeScope).toBe("function");
});

type ExportKind = "array" | "function" | "number" | "object" | "regexp" | "string";
/**
 * Hand-transcribed: 43 runner scope/artifact/workspace/source-snapshot values plus the 12 the
 * Foundation workspace capture seam publishes, 40 supervisor values, 50
 * recovery / evidence / Claude observation values, the 8 values the verifier
 * process wrapper publishes, the 15 values the platform boundary seam publishes
 * (11 neutral-plus-Linux and 4 macOS),
 * the 4 registration factories the recovery-inventory seam publishes, and the 3
 * launch-selection values the launcher seam publishes so a consumer can fill
 * `ClaudeLaunchRequest.launchSelection` and spell the argv it is checked against,
 * and the 30 values the Codex provider seam publishes.
 * Read off the module sources, never off the namespace under test —
 * a list derived from what it checks asserts only that the namespace equals
 * itself.
 */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["CRITERION_CHECK_EXECUTOR_VERSION", "string"], ["createCriterionCheckExecutor", "function"],
  ["ADMITTED_EFFECT_TRANSITIONS", "array"], ["ARTIFACT_ADDRESS_PATTERN", "regexp"],
  ["ATTEMPT_SLICE_STATES", "array"], ["EFFECT_CALLER_CONTRACT", "array"],
  ["EFFECT_COMMANDS", "array"], ["EFFECT_STATES", "array"],
  ["GRANT_STATES", "array"], ["MAX_ARTIFACT_ENUMERATION_ENTRIES", "number"],
  ["MAX_SCOPE_OBSERVATION_BYTES", "number"], ["MAX_SCOPE_PATHS", "number"],
  ["MAX_SOURCE_SNAPSHOT_GIT_OUTPUT_BYTES", "number"],
  ["MAX_SUPERVISOR_COUNT", "number"], ["MAX_SUPERVISOR_TEXT_CHARS", "number"],
  ["MAX_WORKSPACE_ENTRIES", "number"], ["MAX_WORKTREE_COMMAND_BYTES", "number"],
  ["MIRRORED_LEASE_KINDS", "array"], ["MIRRORED_LEASE_STATES", "array"],
  ["RUNNER_ARTIFACT_ERROR_CODES", "array"], ["RUNNER_SCOPE_ERROR_CODES", "array"],
  ["RUNNER_SOURCE_SNAPSHOT_GIT_CODES", "array"],
  ["RUNNER_SOURCE_SNAPSHOT_GIT_LAYER", "string"],
  ["RUNNER_WORKSPACE_ERROR_CODES", "array"], ["RUNNER_WORKTREE_LAYERS", "array"],
  ["SCOPE_ATTRIBUTION_CLASSES", "array"],
  ["SCOPE_OBSERVATION_VERSION", "string"], ["SUPERVISOR_ACTIVATION_VERSION", "string"],
  ["SUPERVISOR_EFFECT_PROTOCOL_VERSION", "string"], ["SUPERVISOR_ERROR_CODES", "array"],
  ["SUPERVISOR_LAYERS", "array"], ["SUPERVISOR_RESULT_VERSION", "string"],
  ["ScopeObserverError", "function"], ["TERMINAL_EFFECT_STATES", "array"],
  ["WORKSPACE_INPUT_MANIFEST_VERSION", "string"], ["WORKSPACE_RESULT_MANIFEST_VERSION", "string"],
  // workspace/worktree-materializer-*: the physical allocator seam.
  ["WORKTREE_ASSIGNMENT_VERSION", "string"], ["WORKTREE_GIT_TIMEOUT_MS", "number"],
  ["SOURCE_SNAPSHOT_GIT_TIMEOUT_MS", "number"],
  ["WORKTREE_RELEASE_DISPOSITIONS", "array"], ["WORKTREE_RELEASE_INTENTS", "array"],
  ["activateEffect", "function"], ["activationDigestInput", "function"],
  ["applyEffectCommand", "function"], ["applyEffectTombstone", "function"],
  ["buildInputManifest", "function"], ["buildResultManifest", "function"],
  ["canonicalPathRejection", "function"], ["consumeActivationGrant", "function"],
  ["createArtifactStore", "function"], ["createNodeArtifactFs", "function"],
  ["createNodeGitObserver", "function"], ["createNodeScopePaths", "function"],
  ["createNodeSourceSnapshotGitObserver", "function"],
  ["createNodeWorktreeMaterializer", "function"], ["deriveWorktreeTarget", "function"],
  ["deriveGrantId", "function"], ["enumerateArtifactsAt", "function"],
  ["fenceMirroredLease", "function"],
  ["grantRefusal", "function"], ["hermeticGitEnvironment", "function"],
  ["initialGrantBinding", "function"], ["inputManifestDigestInput", "function"],
  ["isTerminalEffectState", "function"], ["isWorktreeFailure", "function"],
  ["observeScope", "function"],
  ["parseActivationGrant", "function"], ["parseAttemptSlice", "function"],
  ["parseCommandInput", "function"], ["parseDependencyWitness", "function"],
  ["parseEffectClaim", "function"], ["parseEffectIntent", "function"],
  ["parseEffectTombstone", "function"], ["parseMirroredLease", "function"],
  ["parseMirroredProof", "function"], ["parseRefListing", "function"],
  ["parseSettlementEvidence", "function"], ["parseUncertaintyEvidence", "function"],
  ["refMatches", "function"],
  ["refRejection", "function"], ["resultManifestDigestInput", "function"],
  ["scopeObservationDigestInput", "function"], ["supervisorFailure", "function"],
  ["validateActivationCommit", "function"], ["withLeg", "function"],
  // recovery/: recovery-contract, crash-classification, safe-boundary, plus the
  // supervisor vocabularies that CrashClassification and DrainAdvance carry.
  ["DRAIN_REASONS", "array"], ["DRAIN_TERMINAL_TARGETS", "array"],
  ["PREDECESSOR_RELEASES", "array"], ["RECOVERY_CONTRACT_VERSION", "string"],
  ["RECOVERY_EFFECT_STATUSES", "array"], ["RECOVERY_ERROR_CODES", "array"],
  ["RECOVERY_LAYERS", "array"], ["RECOVERY_OUTCOME_KINDS", "array"],
  ["RESTART_POST_STATES", "array"], ["admitResume", "function"],
  ["admitSuccessorOverlap", "function"], ["advanceRecoveryDrain", "function"],
  ["classifyCrash", "function"],
  // The disposition VALIDATOR half of that seam. A daemon that must record a
  // drain disposition durably has to be able to refuse an incoherent one; with
  // only the vocabulary published it could name the reasons but never check
  // them, and would end up retyping the check — the exact drift this seam
  // exists to prevent. `drainRank`, `drainTargetOf` and `DRAIN_TABLE_ROWS` stay
  // internal: `isMonotonicDisposition` performs the target comparison itself.
  ["isMonotonicDisposition", "function"], ["parseDrainDisposition", "function"],
  // evidence/: contract vocabulary, recipe, receipt, rematerialization, obligations, execution.
  ["EVIDENCE_OBLIGATION_KINDS", "array"], ["EVIDENCE_RECEIPT_VERSION", "string"],
  ["EVIDENCE_REFUSAL_LAYERS", "array"], ["EXECUTION_DISPOSITIONS", "array"],
  ["MAX_EVIDENCE_ARGV_ENTRIES", "number"], ["MAX_EVIDENCE_DECLARED_ENTRIES", "number"],
  ["MAX_EVIDENCE_OBLIGATIONS", "number"], ["MAX_EVIDENCE_TEXT_CHARS", "number"],
  ["RUNNER_EVIDENCE_ERROR_CODES", "array"], ["VERIFICATION_RECIPE_VERSION", "string"],
  ["buildEvidenceReceipt", "function"], ["buildVerificationRecipe", "function"],
  ["canonicalObligations", "function"], ["isEvidenceFailure", "function"],
  ["observedExecutionRejection", "function"], ["receiptDigestInput", "function"],
  ["recipeSealMatches", "function"], ["rematerializeCandidate", "function"],
  // evidence/: the verifier process wrapper — the one seam here that spawns.
  ["MAX_VERIFIER_OUTPUT_BYTES", "number"], ["MAX_VERIFIER_RUN_MS", "number"],
  ["VERIFIER_PROCESS_ERROR_CODES", "array"], ["VERIFIER_PROCESS_LAYERS", "array"],
  ["VERIFIER_REAP_GRACE_MS", "number"], ["createNodeProcessLauncher", "function"],
  ["hermeticVerifierEnvironment", "function"], ["runVerifierProcess", "function"],
  // providers/claude/: reconciliation, capability profile, runtime observation, stream and launcher.
  ["CLAUDE_CAPABILITIES", "array"], ["CLAUDE_CAPABILITY_PROFILE_VERSION", "string"],
  ["CLAUDE_CAPABILITY_STATUSES", "array"], ["CLAUDE_CONTEXT_POLICIES", "array"],
  ["CLAUDE_OBSERVATION_ERROR_CODES", "array"], ["CLAUDE_PROOF_METHODS", "array"],
  ["CLAUDE_RECONCILED_OUTCOMES", "array"], ["CLAUDE_RECONCILIATION_VERSION", "string"],
  ["CLAUDE_RUNTIME_OBSERVATION_VERSION", "string"], ["CLAUDE_STREAM_ANOMALIES", "array"],
  ["CLAUDE_STREAM_DISPOSITIONS", "array"], ["CLAUDE_STREAM_RECORD_VERSION", "string"],
  ["OBSERVATION_TRUTH_CLASSES", "array"], ["RUNTIME_CLOSURE_KINDS", "array"],
  ["RUNTIME_PINNING_METHODS", "array"], ["buildProviderRuntimeObservation", "function"],
  ["observationDigestInput", "function"], ["reconcileClaudeRun", "function"],
  ["runtimePinningIsAuthoritative", "function"],
  ["CLAUDE_LAUNCHER_VERSION", "string"], ["CLAUDE_LAUNCH_ERROR_CODES", "array"],
  ["CLAUDE_LAUNCH_LAYERS", "array"], ["CLAUDE_LAUNCH_TRUTH_CLASSES", "array"],
  ["MAX_CLAUDE_RENDERED_CONTEXT_BYTES", "number"],
  ["launchClaude", "function"],
  // The launch-selection closure. The two selection FUNCTIONS stay internal —
  // see the withheld-name control below — because the launcher applies them
  // itself before it prepares a runtime or consumes a grant.
  ["CLAUDE_LAUNCH_SELECTION_ENV", "object"], ["CLAUDE_LAUNCH_SELECTION_FLAGS", "object"],
  ["CLAUDE_MODEL_EVIDENCE_KINDS", "array"], ["CLAUDE_REASONING_EFFORTS", "array"],
  // The launch-LIMIT admission vocabulary, published from the module that
  // ENFORCES it, plus the resume roster the real selection verifier consumes.
  // The request SNAPSHOT that applies the validator stays internal — see the
  // withheld-name control below.
  ["CLAUDE_LAUNCH_LIMIT_CEILINGS", "object"], ["CLAUDE_LAUNCH_LIMIT_FIELDS", "array"],
  ["CLAUDE_LAUNCH_LIMIT_ISSUE_CODES", "array"], ["CLAUDE_LAUNCH_RESUME_FLAGS", "array"],
  ["validateClaudeLaunchLimits", "function"],
  // The durable-authority overlay. The FACTORY is published; the shipped default
  // port set behind it is not, so the two authority slots are the only ones a
  // consumer can reach. See the withheld-name control below.
  ["CLAUDE_LAUNCH_REGISTRATION_PHASES", "array"], ["createClaudeLauncher", "function"],
  // The runtime pin-REQUEST seam: the hydrator plus the refusal vocabulary a
  // consumer needs to branch on it. The filesystem, the host facts observer and
  // the clock it mints are NOT here — see the withheld-name control below.
  ["CLAUDE_RUNTIME_PIN_ERROR_CODES", "array"], ["CLAUDE_RUNTIME_PIN_LAYER", "string"],
  ["createClaudeRuntimePinRequest", "function"],
  // The other half of that seam: the only published thing that can PRODUCE a
  // quote the factory accepts. It takes no argument, so a consumer obtains an
  // observation of THE installed runtime without choosing WHICH one is observed.
  ["discoverInstalledClaudeRuntime", "function"],
  // platform/: the OS-neutral boundary vocabulary and the Linux classifier.
  ["LINUX_SUPPORTED_ARCHITECTURES", "array"], ["PLATFORM_BOUNDARIES", "array"],
  ["PLATFORM_ERROR_CODES", "array"], ["PLATFORM_LAYERS", "array"],
  ["PLATFORM_LINUX_LAYER", "string"], ["PLATFORM_OBSERVATION_VERSION", "string"],
  ["PLATFORM_TRUTH_CLASSES", "array"], ["classifyLinuxBoundary", "function"],
  ["isPlatformFailure", "function"], ["observeLinuxPlatform", "function"],
  ["platformFailure", "function"],
  // platform/macos/: the darwin classifier, published beside Linux rather than
  // through it. Four values only — the neutral vocabulary above is shared, and
  // the nine reason codes are reused under a macOS LAYER instead of duplicated.
  ["MACOS_SUPPORTED_ARCHITECTURES", "array"], ["PLATFORM_MACOS_LAYER", "string"],
  ["classifyMacosBoundary", "function"], ["observeMacosPlatform", "function"],
  // recovery-inventory/: the coverage vocabulary plus the port-composing aggregate.
  ["MAX_RECOVERY_INVENTORY_ITEMS", "number"], ["RECOVERY_INVENTORY_CLASSES", "array"],
  ["RECOVERY_INVENTORY_ERROR_CODES", "array"], ["RECOVERY_INVENTORY_LAYERS", "array"],
  ["RECOVERY_INVENTORY_REF_KINDS", "array"], ["RECOVERY_INVENTORY_TRUTH_CLASSES", "array"],
  ["RECOVERY_INVENTORY_UNKNOWN_REASONS", "array"], ["RECOVERY_INVENTORY_VERSION", "string"],
  ["collectRecoveryInventory", "function"], ["createRecoveryInventoryRegistry", "function"],
  ["isRecoveryInventoryFailure", "function"], ["recoveryInventoryFailure", "function"],
  // The four registration factories a daemon composes into that aggregate. The
  // per-class `enumerate*` readers and `*_INVENTORY_VERSION` constants stay
  // internal: a consumer registers a port, it never calls an enumerator itself.
  ["artifactObjectInventoryRegistration", "function"],
  ["gitIntegrationInventoryRegistration", "function"],
  ["providerLockInventoryRegistration", "function"],
  ["workspaceInventoryRegistration", "function"],
  // The 30 values the Codex provider seam publishes: 6 schema-version strings,
  // 15 frozen vocabularies, and 9 entry points spanning observation, probe,
  // stream recording, render and reconciliation. Six of them are ALIASES over
  // provider-neutral names Codex redeclares and claude-surface already roots —
  // CODEX_OBSERVATION_TRUTH_CLASSES, CODEX_RUNTIME_CLOSURE_KINDS,
  // CODEX_RUNTIME_PINNING_METHODS, buildCodexRuntimeObservation,
  // codexObservationDigestInput, codexRuntimePinningIsAuthoritative — plus
  // CODEX_MIRRORED_SKILL_RENDERER_INPUT_VERSION, codexRendererEnvelopeIdentity
  // and renderCodexAdvisorySkills, aliased under the same rule. An alias that
  // was missed does not fail to compile: ESM drops a name supplied by two star
  // paths, so it lands here as a MISSING key in the equality below.
  ["CODEX_ACCEPTED_SCHEMA_VERSIONS", "array"], ["CODEX_CAPABILITIES", "array"],
  ["CODEX_CAPABILITY_PROFILE_VERSION", "string"], ["CODEX_CAPABILITY_STATUSES", "array"],
  ["CODEX_CONTEXT_POLICIES", "array"],
  ["CODEX_MIRRORED_SKILL_RENDERER_INPUT_VERSION", "string"],
  ["CODEX_OBSERVATION_ERROR_CODES", "array"], ["CODEX_OBSERVATION_TRUTH_CLASSES", "array"],
  ["CODEX_PROOF_METHODS", "array"], ["CODEX_RECONCILED_OUTCOMES", "array"],
  ["CODEX_RECONCILIATION_VERSION", "string"], ["CODEX_RENDERER_ENVELOPE_VERSION", "string"],
  ["CODEX_RENDER_ERROR_CODES", "array"], ["CODEX_RENDER_LAYERS", "array"],
  ["CODEX_RUNTIME_CLOSURE_KINDS", "array"], ["CODEX_RUNTIME_OBSERVATION_VERSION", "string"],
  ["CODEX_RUNTIME_PINNING_METHODS", "array"], ["CODEX_STREAM_ANOMALIES", "array"],
  ["CODEX_STREAM_DISPOSITIONS", "array"], ["CODEX_STREAM_ERROR_CODES", "array"],
  ["CODEX_STREAM_RECORD_VERSION", "string"], ["buildCodexRuntimeObservation", "function"],
  ["codexObservationDigestInput", "function"], ["codexRendererEnvelopeIdentity", "function"],
  ["codexRuntimePinningIsAuthoritative", "function"], ["probeCodexRuntime", "function"],
  ["reconcileCodexRun", "function"], ["recordCodexStream", "function"],
  ["renderCodexAdvisorySkills", "function"], ["renderCodexContext", "function"],
  // The 18 values the provider-telemetry seam publishes: 5 supported-fact
  // tables, 1 anomaly-refusal table, 6 closed vocabularies, 3 pinned versions
  // and the 3 entry points. Counted by hand from claude-surface.ts, never from
  // the namespace under test.
  ["CLAUDE_MODEL_EVIDENCE_PATTERNS", "object"], ["CLAUDE_RESULT_SUBTYPES", "object"],
  ["CLAUDE_RESULT_TELEMETRY_VERSION", "string"], ["CLAUDE_STEP_FIELD", "string"],
  ["CLAUDE_TELEMETRY_ANOMALY_REFUSALS", "array"], ["CLAUDE_TELEMETRY_HANDOFF_VERSION", "string"],
  ["CLAUDE_TELEMETRY_RECORDS", "object"], ["CLAUDE_TOKEN_FIELDS", "object"],
  ["PROVIDER_CONCURRENCY_FACTS", "array"], ["PROVIDER_COUNT_COVERAGE_CLASSES", "array"],
  ["PROVIDER_INFRASTRUCTURE_OUTCOMES", "array"], ["PROVIDER_TELEMETRY_CODES", "array"],
  ["PROVIDER_TELEMETRY_CONTRACT_VERSION", "string"], ["PROVIDER_TELEMETRY_LAYERS", "array"],
  ["PROVIDER_TERMINAL_OUTCOMES", "array"], ["createTelemetryBoundClaudeLauncher", "function"],
  ["launchClaudeWithTelemetry", "function"], ["parseClaudeResultTelemetry", "function"],
  // The 10 values the provider-RUN RECORD seam publishes: 4 closed vocabularies,
  // 1 meter table, 2 pinned versions, 1 pinned parser revision and the 2 entry
  // points. Counted by hand from claude-surface.ts, never from the namespace.
  ["PROVIDER_COST_BASES", "array"], ["PROVIDER_RUN_RECORD_VERSION", "string"],
  ["PROVIDER_UNPRICED_REASONS", "array"], ["PROVIDER_USAGE_CODES", "array"],
  ["PROVIDER_USAGE_CONTRACT_VERSION", "string"], ["PROVIDER_USAGE_LAYERS", "array"],
  ["PROVIDER_USAGE_METERS", "object"], ["PROVIDER_USAGE_SOURCE_PARSER_VERSION", "number"],
  ["buildProviderRunRecord", "function"], ["normalizeProviderUsage", "function"],
  // The 6 values the provider-run SETTLEMENT seam publishes: 2 pinned strings
  // (its own version and its own refusal layer), 3 frozen tables (the closed
  // refusal vocabulary, the exact admitted input key set, and the settlement
  // mapping declared as data) and the single entry point. Its message table and
  // its admission reader stay internal — see the withheld-name control below.
  ["PROVIDER_EFFECT_SETTLEMENT_LAYER", "string"], ["PROVIDER_EFFECT_SETTLEMENT_VERSION", "string"],
  ["PROVIDER_RUN_OBSERVATION_KEYS", "array"], ["PROVIDER_SETTLEMENT_ADMITTED_ROWS", "array"],
  ["PROVIDER_SETTLEMENT_CODES", "array"], ["settleEffectFromProviderObservation", "function"],
  // workspace/: the Foundation CAPTURE seam. 12 values — the two entry points,
  // the shipped Node filesystem port, the closed refusal vocabulary, the three
  // boundaries that can decide a refusal, the scanner's own two budgets plus the
  // caller-narrowable default, its schema version, and the narrower plus the two
  // digest functions a verifier needs to recompute a prelaunch proof. The proof
  // MINTER and the failure constructor stay internal — see the withheld-name
  // control below — as do the pure decision rules and the raw enumerator.
  ["DEFAULT_FOUNDATION_CAPTURE_LIMITS", "object"], ["FOUNDATION_CAPTURE_CODES", "array"],
  ["FOUNDATION_CAPTURE_LAYER_NAMES", "array"], ["FOUNDATION_CAPTURE_VERSION", "string"],
  ["MAX_FOUNDATION_CAPTURE_BYTES", "number"], ["MAX_FOUNDATION_CAPTURE_ENTRIES", "number"],
  ["captureFoundationWorkspaceDelta", "function"], ["createNodeFoundationCaptureFs", "function"],
  ["isFoundationCaptureFailure", "function"], ["prelaunchProofDigestInput", "function"],
  ["prelaunchProofSealMatches", "function"], ["proveFoundationPrelaunchTree", "function"],
  // Only the fixed Windows project-stack entry and its audited environment
  // roster are published; the generic argv-capable boundary stays withheld.
  ["PROJECT_STACK_ENVIRONMENT_KEYS", "array"],
  ["PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS", "array"],
  ["openWindowsProjectStackBoundary", "function"],
];
const surface: Readonly<Record<string, unknown>> = runner;

it("generates one expectation per published root export", () => {
  expect(EXPECTED_EXPORTS.length).toBe(276);
});

it("publishes exactly the reviewed root namespace, with no loss and no addition", () => {
  // Both sides sorted: the hand-written list is grouped by the seam it documents,
  // and transcription order is not a fact about the published surface.
  expect(Object.keys(runner).sort()).toEqual(EXPECTED_EXPORTS.map(([name]) => name).sort());
});

it.each(EXPECTED_EXPORTS)("publishes %s on the package root as a %s", (name, kind) => {
  const value = surface[name];
  if (kind === "array") expect(Array.isArray(value)).toBe(true);
  else if (kind === "regexp") expect(value instanceof RegExp).toBe(true);
  else expect(typeof value).toBe(kind);
});

it("publishes the SourceSnapshot Git observer's complete result closure", () => {
  const observer: SourceSnapshotGitObserver = runner.createNodeSourceSnapshotGitObserver(
    join(dirname(fileURLToPath(import.meta.url)), "absent-source-snapshot-repository"),
    process.env,
  );
  const result: SourceSnapshotGitResult = observer.observe("a".repeat(64));
  if (result.ok) {
    const accepted: SourceSnapshotGitObserved = result;
    const observation: SourceSnapshotGitObservation = accepted.observation;
    expect(observation.repositoryBaseTree).toMatch(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u);
    return;
  }
  const refusal: SourceSnapshotGitRefusal = result;
  const code: SourceSnapshotGitCode = refusal.code;
  const layer: SourceSnapshotGitLayer = refusal.layer;
  expect({ code, layer }).toEqual({
    code: "RUNNER_SOURCE_SNAPSHOT_ROOT_UNRESOLVABLE",
    layer: "RUNNER_SOURCE_SNAPSHOT_GIT",
  });
});

/**
 * Hand-transcribed from supervisor/effect-test-fixtures.ts and
 * recovery/recovery-test-fixtures.ts, neither of which may ever reach the seam.
 * evidence/ and providers/claude/ have no fixture module at all — their test data
 * is inline — so there is nothing further to exclude there.
 */
const FIXTURE_NAMES: readonly string[] = [
  "AT", "LATER", "DIGEST", "makeLease", "makeProof", "makeIntent", "makeAttempt", "makeClaim",
  "makeTombstone", "makeGrant", "makeSettlement", "makeUncertainty", "makeWitness",
  "makeActivationRequest", "withGetter", "withExtraKey",
  "HELD_EPOCH", "HELD_TOKEN", "RECONCILED", "REGISTRATION", "COMMIT", "ADVANCED", "SETTLED",
  "disposition", "records", "observation", "situation",
];

it("keeps the test-only fixture module off the published surface", () => {
  expect(FIXTURE_NAMES.filter((name) => name in surface)).toEqual([]);
});

/**
 * Every record below is hand-written from the module sources rather than read off
 * an export under test, so a vocabulary that silently changed value would fail
 * these assertions instead of quietly redefining them.
 */
const DIGEST = "b".repeat(64);
const AT = "2026-08-08T00:00:00.000Z";
const WRAPPER = "wrapper:1";
const LOCK = "lock:1";
const LEASE: MirroredLeaseRecord = {
  leaseId: "lease:1", kind: "ASSIGNMENT" satisfies MirroredLeaseKind, ownerSessionRef: "session:1",
  leaseToken: "token:1", epoch: 3, state: "ACTIVE" satisfies MirroredLeaseState,
  serverWallDeadline: 90, bootId: "boot:1", monotonicObservation: 12, authorityHashRef: DIGEST,
  version: 7,
};
const PROOF: MirroredLeaseProof = {
  leaseToken: "token:1", epoch: 3, authorityHashRef: DIGEST, ownerSessionRef: "session:1",
  expectedVersion: 7,
};
const ATTEMPT: AttemptSlice = {
  attemptId: "attempt:1", aggregateId: "aggregate:1", intentId: "intent:1",
  state: "LAUNCH_REQUESTED" satisfies AttemptSliceState, version: 2,
};
const CLAIM_RECORD: EffectClaim = {
  claimId: "claim:1", intentId: "intent:1", wrapperIdentity: WRAPPER, lockIdentity: LOCK,
  claimedAt: AT,
};
const WITNESS: DependencyWitness =
  { witnessId: "witness:1", expectedDigest: DIGEST, observedDigest: DIGEST };
const SETTLEMENT: SettlementEvidence =
  { reconciliationVersion: "recon/1", reconciliationDigest: DIGEST, outcomeClass: "COMPLETED" };
const UNCERTAINTY: UncertaintyEvidence =
  { uncertaintyReason: "unreadable", uncertaintyDigest: DIGEST };

function intentIn(state: EffectState): EffectIntent {
  return {
    protocolVersion: "moe-effect-intent/1", intentId: "intent:1", aggregateId: "aggregate:1",
    expectedGraphEpoch: 3, leaseBinding: LEASE, inputBinding: DIGEST,
    predecessorCursor: "cursor:1", desiredState: "RUNNING", idempotencyKey: "idem:1",
    runtimeObservationDigest: DIGEST, state, version: 7,
  };
}
function activationRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    intent: intentIn("ARMED"), attempt: ATTEMPT, claim: CLAIM_RECORD, tombstone: null,
    leaseProof: PROOF, wrapperIdentity: WRAPPER, lockIdentity: LOCK, observedGraphEpoch: 3,
    desiredState: "RUNNING", dependencyWitnesses: [WITNESS], observedRuntimeDigest: DIGEST,
    ...overrides,
  };
}

/** Names each arm without any deep import, and pins REFUSED's exact key set. */
function refusalOf(outcome: LifecycleOutcome | GrantOutcome | ActivationOutcome | CommitCheck |
  MirrorVerdict): SupervisorFailure {
  if (outcome.kind !== "REFUSED") throw new Error(`expected REFUSED, got ${outcome.kind}`);
  expect(Object.keys(outcome).sort()).toEqual(["failure", "kind"]);
  const failure: SupervisorFailure = outcome.failure;
  const layer: SupervisorLayer = failure.layer;
  const detail: SupervisorFailureDetail = failure.detail;
  expect(runner.SUPERVISOR_LAYERS).toContain(layer);
  expect(detail).not.toHaveProperty("leaseToken");
  return failure;
}
function codeOf(failure: SupervisorFailure): SupervisorErrorCode {
  expect(runner.SUPERVISOR_ERROR_CODES).toContain(failure.code);
  return failure.code;
}

it("pins the published protocol vocabularies by value", () => {
  expect(runner.SUPERVISOR_EFFECT_PROTOCOL_VERSION).toBe("moe-effect-intent/1");
  expect(runner.SUPERVISOR_ACTIVATION_VERSION).toBe("moe-effect-activation/1");
  expect(runner.SUPERVISOR_RESULT_VERSION).toBe("moe-effect-result/1");
  expect([...runner.EFFECT_COMMANDS]).toContain("requestCancel");
  expect([...runner.EFFECT_STATES]).toContain("CANCEL_REQUESTED");
  expect([...runner.MIRRORED_LEASE_STATES]).toContain("REVOKED");
  expect([...runner.TERMINAL_EFFECT_STATES]).toEqual(["SUCCEEDED", "FAILED", "UNKNOWN", "CANCELLED"]);
  expect(runner.isTerminalEffectState("ACTIVE")).toBe(false);
  expect([...runner.MIRRORED_LEASE_KINDS, ...runner.GRANT_STATES, ...runner.ATTEMPT_SLICE_STATES])
    .toEqual(["ASSIGNMENT", "WORKSPACE", "RESOURCE", "UNUSED", "CONSUMED", "LAUNCH_REQUESTED",
      "RUNNING"]);
  expect([...runner.EFFECT_CALLER_CONTRACT]).toHaveLength(4);
  expect([runner.MAX_SUPERVISOR_COUNT, runner.MAX_SUPERVISOR_TEXT_CHARS])
    .toEqual([Number.MAX_SAFE_INTEGER - 1_000_000, 400]);
  const arcs: readonly AdmittedTransition[] = runner.ADMITTED_EFFECT_TRANSITIONS;
  const claimArc = arcs.find((arc) => arc.from === "PENDING" && arc.command === "claim");
  expect(claimArc?.to).toEqual(["CLAIMED"]);
});

it("parses each supervisor record from the root and refuses hostile input with null", () => {
  const intent: EffectIntent | null = runner.parseEffectIntent(intentIn("PENDING"));
  const tombstone: EffectTombstone | null =
    runner.parseEffectTombstone({ intentId: "intent:1", reason: "cancelled", terminalizedAt: AT });
  expect([intent?.state, tombstone?.reason, runner.parseMirroredLease(LEASE)?.epoch]).toEqual(
    ["PENDING", "cancelled", 3],
  );
  // Stronger than republishing the raw key lists: the exact-own-key contract itself.
  expect([runner.parseMirroredLease({ ...LEASE, extra: 1 }), runner.parseMirroredProof(PROOF)?.epoch])
    .toEqual([null, 3]);
  expect([
    runner.parseAttemptSlice(null), runner.parseEffectClaim(null), runner.parseActivationGrant(null),
    runner.parseSettlementEvidence(null), runner.parseUncertaintyEvidence(null),
    runner.parseDependencyWitness(null), runner.parseCommandInput(null),
    runner.parseMirroredProof(null),
  ]).toEqual([null, null, null, null, null, null, null, null]);
});

it("discriminates TRANSITIONED through the published applyEffectCommand", () => {
  const command: SimpleCommand = { kind: "claim" satisfies EffectCommand };
  const outcome: LifecycleOutcome = runner.applyEffectCommand(intentIn("PENDING"), command);
  if (outcome.kind !== "TRANSITIONED") throw new Error(codeOf(refusalOf(outcome)));
  expect(Object.keys(outcome).sort()).toEqual(["intent", "kind", "ok", "result", "versionDelta"]);
  expect([outcome.ok, outcome.intent.state, outcome.intent.version, outcome.versionDelta]).toEqual(
    [true, "CLAIMED", 8, 1],
  );
  expect(outcome.result).toBeNull();
});

it("keeps MUST_DRAIN an instruction to drain, carrying no ok field at all", () => {
  const command: SimpleCommand = { kind: "requestCancel" };
  const outcome: LifecycleOutcome = runner.applyEffectCommand(intentIn("ACTIVE"), command);
  if (outcome.kind !== "MUST_DRAIN") throw new Error(`expected MUST_DRAIN, got ${outcome.kind}`);
  expect(Object.keys(outcome).sort()).toEqual(["drainRequired", "intent", "kind", "versionDelta"]);
  expect("ok" in outcome).toBe(false);
  expect([outcome.drainRequired, outcome.versionDelta, outcome.intent.version]).toEqual([true, 0, 7]);
});

it("discriminates REFUSED by its own reason code, with exactly the keys kind and failure", () => {
  const outcome: LifecycleOutcome = runner.applyEffectCommand(intentIn("PENDING"), { kind: "arm" });
  const failure = refusalOf(outcome);
  expect(codeOf(failure)).toBe("EFFECT_TRANSITION_NOT_ADMITTED");
  expect([failure.layer, failure.ok, failure.detail.state]).toEqual(["LIFECYCLE", false, "PENDING"]);
});

it("adopts a settlement result and cancels a pre-activation intent by tombstone", () => {
  const settle: SettleCommand = {
    kind: "settle", target: "SUCCEEDED", settlement: SETTLEMENT, uncertainty: null, adoptedAt: AT,
  };
  const settled: LifecycleOutcome = runner.applyEffectCommand(intentIn("ACTIVE"), settle);
  if (settled.kind !== "TRANSITIONED") throw new Error(codeOf(refusalOf(settled)));
  const result: EffectResult | null = settled.result;
  const terminal: TerminalEffectState | undefined = result?.terminalState;
  expect([terminal, result?.outcomeClass, result?.resultVersion]).toEqual(
    ["SUCCEEDED", "COMPLETED", "moe-effect-result/1"],
  );
  const unproven: EffectCommandInput = { ...settle, target: "UNKNOWN", uncertainty: null };
  expect(codeOf(refusalOf(runner.applyEffectCommand(intentIn("ACTIVE"), unproven))))
    .toBe("EFFECT_UNCERTAINTY_EVIDENCE_REQUIRED");
  const proven: EffectCommandInput = { ...settle, target: "UNKNOWN", uncertainty: UNCERTAINTY };
  expect(runner.applyEffectCommand(intentIn("ACTIVE"), proven).kind).toBe("TRANSITIONED");
  const tombstone: EffectTombstone =
    { intentId: "intent:1", reason: "cancelled", terminalizedAt: AT };
  const dominated: LifecycleOutcome =
    runner.applyEffectTombstone(intentIn("ARMED"), tombstone);
  expect(dominated.kind === "TRANSITIONED" && dominated.intent.state).toBe("CANCELLED");
  expect(codeOf(refusalOf(runner.applyEffectTombstone(intentIn("ACTIVE"), tombstone))))
    .toBe("EFFECT_TOMBSTONE_DOES_NOT_DOMINATE");
});

it("activates, consumes the one-use grant, and re-validates the commit from the root", () => {
  const activated: ActivationOutcome = runner.activateEffect(activationRequest());
  if (activated.kind !== "ACTIVATED") throw new Error(codeOf(refusalOf(activated)));
  const commit: ActivationCommit = activated.commit;
  const grant: ActivationGrant = commit.grant;
  expect([commit.intent.state, commit.attempt.state, grant.state]).toEqual(
    ["ACTIVE", "RUNNING", "UNUSED" satisfies GrantState],
  );
  expect(grant.grantId).toBe(runner.deriveGrantId("intent:1", commit.activationDigest));
  expect(runner.activationDigestInput(commit.intent, commit.attempt,
    runner.initialGrantBinding("intent:1", WRAPPER))).toHaveProperty("grant.state", "UNUSED");

  const consumed: GrantOutcome = runner.consumeActivationGrant(grant, WRAPPER);
  if (consumed.kind !== "CONSUMED") throw new Error(codeOf(refusalOf(consumed)));
  expect([consumed.grant.state, consumed.grant.version, consumed.versionDelta]).toEqual(
    ["CONSUMED", 1, 1],
  );
  expect(codeOf(refusalOf(runner.consumeActivationGrant(consumed.grant, WRAPPER))))
    .toBe("GRANT_ALREADY_CONSUMED");
  expect(codeOf(refusalOf(runner.consumeActivationGrant(grant, "wrapper:2"))))
    .toBe("GRANT_WRAPPER_MISMATCH");

  const check: CommitCheck = runner.validateActivationCommit(commit.intent, commit.attempt, grant);
  if (check.kind !== "COHERENT") throw new Error(codeOf(refusalOf(check)));
  expect([check.ok, check.activationDigest]).toEqual([true, commit.activationDigest]);
  expect(codeOf(refusalOf(runner.validateActivationCommit(intentIn("ARMED"), ATTEMPT, grant))))
    .toBe("ACTIVATION_COMMIT_INCOHERENT");
});

it("refuses an unarmed activation and a stale lease by their own reason codes", () => {
  const unarmed = refusalOf(runner.activateEffect(activationRequest({ intent: intentIn("ACTIVE") })));
  expect([codeOf(unarmed), unarmed.layer, unarmed.detail.leg]).toEqual(
    ["ACTIVATION_INTENT_NOT_ARMED", "ACTIVATION", "intentState"],
  );
  const legal: readonly MirroredLeaseState[] = ["ACTIVE"];
  const fenced: MirrorVerdict = runner.fenceMirroredLease(LEASE, PROOF, "effect.activate", legal);
  if (fenced.kind !== "FENCED") throw new Error(codeOf(refusalOf(fenced)));
  expect([fenced.ok, fenced.lease.leaseId, fenced.proof.expectedVersion]).toEqual([true, "lease:1", 7]);
  const stale = refusalOf(
    runner.fenceMirroredLease(LEASE, { ...PROOF, epoch: 2 }, "effect.activate", legal),
  );
  expect([codeOf(stale), stale.layer]).toEqual(["LEASE_MIRROR_STALE_EPOCH", "LEASE_MIRROR"]);
  expect(codeOf(refusalOf(runner.fenceMirroredLease(null, PROOF, "effect.activate", legal))))
    .toBe("LEASE_MIRROR_MALFORMED");
  const bounded = runner.supervisorFailure("EFFECT_COUNTER_EXHAUSTED", "KERNEL", "bound", {});
  expect([codeOf(bounded), runner.withLeg(bounded, "counters").detail.leg]).toEqual(
    ["EFFECT_COUNTER_EXHAUSTED", "counters"],
  );
});

/* ------------------------------------------------------------------ *
 * Recovery, evidence and Claude observation: DoD 4.
 *
 * Every value below is obtained by CALLING a published function through the
 * root. Nothing here constructs a union literal to stand in for one: a literal
 * typechecks against a locally re-declared shape whether or not the real type
 * was ever published, so it would pass on a seam that publishes nothing.
 * ------------------------------------------------------------------ */

type Overrides = Readonly<Record<string, unknown>>;

/** Hand-written from launch-lock.ts's LaunchLockRegistration, not read from a fixture module. */
const REGISTRATION: Overrides = {
  lockIdentity: LOCK, wrapperIdentity: WRAPPER, processIdentity: "process-77",
  bootstrapCredentialDigest: DIGEST, registeredAt: AT,
};
/**
 * A reconciliation REFERENCE, which the restart records accept only when it is
 * pinned to the adapter version and outcome vocabulary this same root publishes.
 * The supervisor's own SETTLEMENT fixture above is deliberately not reused: it
 * carries a generic version string, which is exactly what this record refuses.
 */
const RECONCILED: Overrides = {
  reconciliationVersion: runner.CLAUDE_RECONCILIATION_VERSION,
  reconciliationDigest: DIGEST,
  outcomeClass: "PROVEN_RESULT" satisfies ClaudeReconciledOutcome,
};
/** Monotonic by construction: WORK_CANCEL is its own strongest reason, CANCELLED its target. */
const HELD_DISPOSITION: Overrides = {
  reasons: ["WORK_CANCEL"], strongestReason: "WORK_CANCEL", terminalTarget: "CANCELLED",
};

function commitFixture(overrides: Readonly<Record<string, unknown>> = {}): ActivationCommit {
  const activated: ActivationOutcome = runner.activateEffect(activationRequest(overrides));
  if (activated.kind !== "ACTIVATED") throw new Error(codeOf(refusalOf(activated)));
  return activated.commit;
}

/**
 * What a launch claims it is launching, built from published names only. The
 * launcher re-verifies this against argv BEFORE it prepares a runtime, consumes
 * a grant, takes a lock or opens a boundary, so a request that carries the
 * selection without the matching argv — or the argv without the selection —
 * never reaches any leg downstream of that gate.
 *
 * `modelSnapshotEvidence` is a DATED value rather than a version or a profile
 * revision: neither of those is evidence of WHICH MODEL was asked for.
 */
const SELECTED_MODEL = "claude-opus-5-20260514";
const SELECTED_EFFORT = "high";
const SELECTION: ClaudeLaunchSelection = {
  provider: "claude", selectedModelId: SELECTED_MODEL,
  modelSnapshotKind: "DATED_SNAPSHOT", modelSnapshotEvidence: "2026-05-14",
  reasoningEffort: SELECTED_EFFORT, profileRevisionId: "profile-rev-1",
  configurationDigest: DIGEST, policyDigest: DIGEST, orchestrationDigest: DIGEST,
  concurrencyCeiling: 4,
};
const SELECTION_ARGV: readonly string[] = [
  runner.CLAUDE_LAUNCH_SELECTION_FLAGS.model, SELECTED_MODEL,
  runner.CLAUDE_LAUNCH_SELECTION_FLAGS.effort, SELECTED_EFFORT,
];

/**
 * Publication/composition contract only. Durable grant CAS belongs to daemon dispatch task
 * task-6cbff01023b14b26a78fc5e3eb1dd8a9; canary task-97554aa4293e40eab56c0b642e18513a
 * eventually certifies that composed edge.
 */
it("lets a root-only consumer construct and narrow the Claude launcher", async () => {
  expect(runner.CLAUDE_LAUNCH_ERROR_CODES).toContain("CLAUDE_LAUNCH_DEPENDENCY_THROWN");
  const observation = observationFixture("CONTENT_ADDRESSED_COPY");
  // The launcher binds the prepared runtime to the committed activation before
  // it reaches the grant, so this commit has to name the runtime `prepareRuntime`
  // reports below; otherwise that binding guard answers and the GRANT leg this
  // test is about would never run.
  const commit = commitFixture({
    intent: { ...intentIn("ARMED"), runtimeObservationDigest: observation.observationDigest },
    observedRuntimeDigest: observation.observationDigest,
  });
  const lease: ClaudeLaunchLockLease = { release: async () => undefined };
  const lock: ClaudeLaunchLockResult = { ok: true, lease };
  const deps: ClaudeLauncherDependencies = {
    prepareRuntime: async () => ({ ok: true, preparationVersion: "moe-claude-runtime-pin/1",
      quotedObservationDigest: observation.observationDigest,
      freshObservationDigest: observation.observationDigest, pinnedClosureDigest: DIGEST,
      pinnedRoot: "C:\\pins", pinRootIdentity: DIGEST, executablePath: "C:\\pins\\claude.exe",
      observation, bindingDigest: DIGEST }),
    resolveDuplicate: () => { throw new Error("duplicate port must not run"); },
    validateCommit: runner.validateActivationCommit,
    consumeGrant: runner.consumeActivationGrant,
    acquireLock: async () => lock,
    openBoundary: () => { throw new Error("boundary must not open"); },
    registerLock: () => { throw new Error("registration must not run"); },
    observeProcess: () => { throw new Error("observation must not run"); },
    now: () => AT, delay: async () => await new Promise(() => undefined),
  };
  const limits: ClaudeLaunchLimits = { stdoutBytes: 8, stderrBytes: 8, tailBytes: 4, timeoutMs: 10 };
  const request = { runtime: { quotedObservation: observation, installedRoot: "C:\\installed",
    pinRoot: "C:\\pins", fs: {}, facts: {}, clock: {} }, duplicateDelivery: null, effect: commit.intent,
    attempt: commit.attempt, grant: commit.grant, claim: CLAIM_RECORD,
    wrapperIdentity: "wrapper:other", bootstrapCredentialDigest: DIGEST,
    priorRegistration: null, renderedContext: "sealed context\n", contextManifestDigest: DIGEST,
    argv: [...SELECTION_ARGV], cwd: "C:\\work", environment: {},
    reconciliation: null, limits, launchSelection: SELECTION
  } satisfies Record<keyof ClaudeLaunchRequest, unknown>;
  const options: ClaudeLaunchOptions = { platform: "win32", deps };
  const result: ClaudeLaunchResult = await runner.launchClaude(request, options);
  if (result.kind !== "REFUSED") throw new Error(`expected refusal, received ${result.kind}`);
  const failure: ClaudeLaunchFailure = result;
  const code: ClaudeLaunchErrorCode = failure.code;
  const layer: ClaudeLaunchLayer = failure.layer;
  const truth: ClaudeLaunchTruthClass = failure.truthClass;
  expect({ code, layer, truth }).toEqual({
    code: "GRANT_WRAPPER_MISMATCH", layer: "GRANT", truth: "UNKNOWN",
  });
  expect({} as ClaudeLaunchObservation).toBeDefined();
});

/**
 * Type-only exports are invisible to the `Object.keys` guard above, so each new
 * type has to ANNOTATE a real value here or an unpublished one would go
 * unnoticed until a consumer's own repository failed to compile. The launch is
 * refused on platform, so this constructs the seam without spawning anything.
 */
it("gives a root-only consumer the durable launcher authority type closure", async () => {
  const phases: readonly ClaudeLaunchRegistrationPhase[] =
    runner.CLAUDE_LAUNCH_REGISTRATION_PHASES;
  const commits: ClaudeRegistrationCommit[] = [];
  const authority: ClaudeLauncherAuthority = {
    consumeGrantDurably: (grant, wrapperIdentity) =>
      runner.consumeActivationGrant(grant, wrapperIdentity),
    commitProcessRegistration: (commit) => {
      commits.push(commit);
      const phase: ClaudeLaunchRegistrationPhase = commit.phase;
      return { kind: "REGISTERED", ok: true, registration: commit.registration, phase };
    },
  };
  // The launch-selection closure, annotated so a type that stopped being
  // published fails here rather than in a consumer's own repository. Both
  // vocabularies must keep their explicit UNKNOWN member: unavailable snapshot
  // evidence stays UNKNOWN instead of being back-filled from something else.
  const kinds: readonly ClaudeModelEvidenceKind[] = runner.CLAUDE_MODEL_EVIDENCE_KINDS;
  const efforts: readonly ClaudeReasoningEffort[] = runner.CLAUDE_REASONING_EFFORTS;
  const selection: ClaudeLaunchSelection = SELECTION;
  expect(kinds).toContain("UNKNOWN");
  expect(efforts).toContain("UNKNOWN");
  expect(kinds).toContain(selection.modelSnapshotKind);
  expect(efforts).toContain(selection.reasoningEffort);
  expect(runner.CLAUDE_LAUNCH_LAYERS).toContain("TELEMETRY_CONFIGURATION");
  const launch = runner.createClaudeLauncher(authority);
  const result: ClaudeLaunchResult = await launch({}, { platform: "linux" });
  expect(phases).toEqual(["PREFLIGHT", "STARTED"]);
  expect(result).toMatchObject({
    kind: "REFUSED", code: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", layer: "LAUNCHER",
  });
  expect(commits).toEqual([]);
});

/**
 * Negative control for the seam's WIDTH. The factory is published precisely so
 * the eight non-authority ports do not have to be: a consumer able to take them
 * one at a time could replace the Windows physical boundary alone and keep every
 * other guarantee's appearance. If any of these ever appears on the root, the
 * factory has stopped being the only way in.
 */
it("withholds the launcher's default ports and internals from the root", () => {
  const withheld = [
    "CLAUDE_LAUNCHER_DEFAULTS", "classifyRegistrationPhase", "durableRegistrationPort",
    "acquireWindowsLaunchLock", "openWindowsProcessBoundary", "prepareClaudeRuntimePin",
    "registerLaunchLock", "resolveDuplicateDelivery", "intakeProcessObservation",
  ];
  expect(withheld.length).toBe(9);
  expect(withheld.filter((name) => name in surface)).toEqual([]);
});

it("publishes only the curated Windows project-stack boundary", () => {
  expect(typeof surface["openWindowsProjectStackBoundary"]).toBe("function");
  expect(Array.isArray(surface["PROJECT_STACK_ENVIRONMENT_KEYS"])).toBe(true);
  expect(Array.isArray(surface["PROJECT_STACK_PROVIDER_CREDENTIAL_KEYS"])).toBe(true);
  expect("openWindowsProcessBoundary" in surface).toBe(false);
});

/**
 * Negative control for the launch-selection seam specifically. The launcher
 * applies both of these itself, before it prepares a runtime or consumes a
 * grant. Publishing either would let a consumer snapshot or verify ONE selection
 * and then hand `launchClaude` a different one — the claimed selection and the
 * launched selection would be free to disagree, which is the whole failure this
 * seam exists to make impossible.
 *
 * `snapshotClaudeLaunchRequest` is withheld for the same reason: the launcher is
 * the only thing entitled to apply it to the actual request. Its LIMIT decision
 * is published separately, as `validateClaudeLaunchLimits` — a producer may ask
 * whether four bounds are admissible without being handed the seam that decides
 * what request the launcher will run.
 */
it("withholds the selection snapshot, the verifier and the request snapshot", () => {
  const withheld = ["snapshotLaunchSelection", "verifyLaunchSelection", "isHostileObject",
    "refuseSelection", "snapshotClaudeLaunchRequest"];
  expect(withheld.length).toBe(5);
  expect(withheld.filter((name) => name in surface)).toEqual([]);
  // Positive control: the same membership test finds the names this seam DOES
  // publish, so the assertion above cannot be passing because `in` is broken.
  expect(["CLAUDE_LAUNCH_SELECTION_FLAGS", "CLAUDE_REASONING_EFFORTS"]
    .filter((name) => name in surface)).toEqual(
    ["CLAUDE_LAUNCH_SELECTION_FLAGS", "CLAUDE_REASONING_EFFORTS"]);
});

/**
 * The resume roster, re-exported from the binding the real selection verifier
 * consumes rather than copied. A daemon that builds a launch template has to
 * know which argv tokens make a `--model` claim unprovable, and it may not
 * discover that set by reimplementing it.
 */
it("publishes the exact six-member resume roster the verifier applies", () => {
  expect([...runner.CLAUDE_LAUNCH_RESUME_FLAGS]).toEqual(
    ["--resume", "-r", "--continue", "-c", "--from-pr", "--cloud"]);
  expect(runner.CLAUDE_LAUNCH_RESUME_FLAGS.length).toBe(6);
  expect(Object.isFrozen(runner.CLAUDE_LAUNCH_RESUME_FLAGS)).toBe(true);
});

/**
 * The launch-limit admission surface, exercised through the BARE namespace: the
 * validator, its ceiling table and both closed vocabularies have to be reachable
 * by a consumer that only holds `@moe/runner`. The accepted arm is kept beside
 * the refusal — a refusal-only smoke cannot see a ceiling that silently moved
 * the wrong way. Consumer: task-9a1eb61d566e47838c9f79c030da1f70.
 */
it("admits and refuses launch limits through the package root", () => {
  const fields: readonly ClaudeLaunchLimitField[] = [...runner.CLAUDE_LAUNCH_LIMIT_FIELDS];
  expect(fields).toEqual(["stdoutBytes", "stderrBytes", "tailBytes", "timeoutMs"]);
  const codes: readonly ClaudeLaunchLimitIssueCode[] = [...runner.CLAUDE_LAUNCH_LIMIT_ISSUE_CODES];
  expect(codes).toEqual(["CLAUDE_LAUNCH_LIMITS_MALFORMED", "CLAUDE_LAUNCH_LIMIT_INVALID",
    "CLAUDE_LAUNCH_LIMIT_EXCEEDED"]);
  expect(runner.CLAUDE_LAUNCH_LIMIT_CEILINGS).toEqual(
    { stdoutBytes: 1_048_576, stderrBytes: 1_048_576, tailBytes: 65_536, timeoutMs: 600_000 });
  const admitted: ClaudeLaunchLimitsResult = runner.validateClaudeLaunchLimits(
    { stdoutBytes: 1_048_576, stderrBytes: 1_048_576, tailBytes: 65_536, timeoutMs: 600_000 });
  expect(admitted.ok).toBe(true);
  if (!admitted.ok) throw new Error("expected admission");
  const limits: ClaudeLaunchLimits = admitted.limits;
  expect(limits.tailBytes).toBe(65_536);
  const refused: ClaudeLaunchLimitsResult = runner.validateClaudeLaunchLimits(
    { stdoutBytes: 1_048_576, stderrBytes: 1_048_576, tailBytes: 65_537, timeoutMs: 600_000 });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("expected a refusal");
  const layer: ClaudeLaunchLimitLayer = "LAUNCH_LIMITS";
  const issue: ClaudeLaunchLimitIssue = refused.issue;
  expect(issue).toEqual(
    { code: "CLAUDE_LAUNCH_LIMIT_EXCEEDED", layer, field: "tailBytes" });
});

/**
 * The runtime pin-REQUEST seam. `ClaudeRuntimePinRequest` names six fields and
 * only three of them are data; a root-only consumer supplies those three and
 * receives the other three already minted. Production consumer:
 * task-6cbff01023b14b26a78fc5e3eb1dd8a9.
 */
it("hydrates a runtime pin request from plain data through the package root", () => {
  const quotedObservation: ProviderRuntimeObservation =
    observationFixture("CONTENT_ADDRESSED_COPY");
  const input: ClaudeRuntimePinRequestInput = {
    quotedObservation, installedRoot: "C:\\installed", pinRoot: "C:\\pins",
  };
  const result: ClaudeRuntimePinRequestResult = runner.createClaudeRuntimePinRequest(input);
  if ("ok" in result) throw new Error(`hydration refused with ${result.code}`);
  const request: ClaudeRuntimePinRequest = result;
  expect(Object.keys(request).sort()).toEqual(
    ["clock", "facts", "fs", "installedRoot", "pinRoot", "quotedObservation"],
  );
  expect(Object.isFrozen(request)).toBe(true);
  expect(request.quotedObservation.observationDigest).toBe(quotedObservation.observationDigest);
  // The three a caller may not supply are minted here, and are really callable.
  expect(typeof request.fs.hostPlatform()).toBe("string");
  expect(typeof request.clock.observedAt()).toBe("string");
  expect(typeof request.facts.observe).toBe("function");
});

it("refuses a caller-supplied capability with the runtime layer's own reason code", () => {
  const smuggled = {
    quotedObservation: observationFixture("CONTENT_ADDRESSED_COPY"),
    installedRoot: "C:\\installed", pinRoot: "C:\\pins", fs: {},
  };
  const result: ClaudeRuntimePinRequestResult = runner.createClaudeRuntimePinRequest(smuggled);
  if (!("ok" in result)) throw new Error("a smuggled capability was accepted");
  const failure: ClaudeRuntimePinFailure = result;
  const code: ClaudeRuntimePinErrorCode = failure.code;
  expect(runner.CLAUDE_RUNTIME_PIN_ERROR_CODES).toContain(code);
  expect(runner.CLAUDE_RUNTIME_PIN_LAYER).toBe("RUNTIME");
  expect({ code, layer: failure.layer, truth: failure.truthClass }).toEqual({
    code: "CLAUDE_RUNTIME_OBSERVATION_INVALID",
    layer: runner.CLAUDE_RUNTIME_PIN_LAYER,
    truth: "UNKNOWN",
  });
});

/**
 * Negative control for the pin-request seam's WIDTH, and the real deliverable of
 * publishing the factory: a positive export list cannot prove an ABSENCE.
 * `observeInstalledClaudeRuntime` matters most — it takes an `executablePath`, so
 * a consumer holding it could point the host observer at a binary no quote ever
 * committed to, which is exactly the authority the factory withholds by deriving
 * that path from the quoted closure instead.
 */
it("withholds every runtime capability the pin-request factory mints", () => {
  const withheld = [
    "createNodeClaudeRuntimeFs", "RUNTIME_PIN_CHUNK_BYTES", "observeInstalledClaudeRuntime",
    "probeClaudeRuntime", "ClaudeRuntimeObservationRefused", "prepareClaudeRuntimePin",
    "CLAUDE_LAUNCHER_DEFAULTS", "discoverSources", "resolveSources", "readQuote",
    "inspectSources", "snapshotSourceCandidates", "aggregateClosureDigest", "authorityDigest",
  ];
  expect(withheld.length).toBe(14);
  // Read off the imported NAMESPACE, never the barrel's text: the root re-exports
  // with `export *`, which a grep cannot see through.
  expect(withheld.filter((name) => name in surface)).toEqual([]);
  // Positive control: the same membership test finds what this seam DOES publish,
  // including the discovery capability that closes the other half of the gap.
  expect(["createClaudeRuntimePinRequest", "CLAUDE_RUNTIME_PIN_ERROR_CODES",
    "discoverInstalledClaudeRuntime"].filter((name) => name in surface))
    .toEqual(["createClaudeRuntimePinRequest", "CLAUDE_RUNTIME_PIN_ERROR_CODES",
      "discoverInstalledClaudeRuntime"]);
});

/**
 * The unsteerability is a TYPE-level fact rather than a runtime rejection, which
 * would be one refactor away from being relaxed. An added parameter — required,
 * optional or defaulted — stops `Parameters<>` being the empty tuple.
 */
type DiscoveryTakesNoArgument =
  Parameters<typeof runner.discoverInstalledClaudeRuntime> extends readonly [] ? true : false;
/** The fourth refusal arm is nameable through the root, so its layer is branchable. */
type WindowsArmIsNameable =
  WindowsProcessUnknown extends DiscoverInstalledClaudeRuntimeResult ? true : false;

/**
 * The other half of the pin-request seam, and the only published route to a quote
 * `createClaudeRuntimePinRequest` accepts. The result is obtained by CALLING the
 * published function: a constructed literal typechecks against a locally
 * re-declared shape whether or not the real type was ever published.
 */
it("gives a root-only consumer an observation of an installed runtime it cannot choose", async () => {
  const takesNoArgument: DiscoveryTakesNoArgument = true;
  const windowsArmNameable: WindowsArmIsNameable = true;
  expect([takesNoArgument, windowsArmNameable, runner.discoverInstalledClaudeRuntime.length])
    .toEqual([true, true, 0]);
  const result: DiscoverInstalledClaudeRuntimeResult =
    await runner.discoverInstalledClaudeRuntime();
  if (!("ok" in result && result.ok === true)) {
    // Refusals keep the code of whichever authority answered, never a discovery code.
    expect(typeof (result as { readonly code: string }).code).toBe("string");
    return;
  }
  const discovered: DiscoveredClaudeRuntime = result;
  expect(discovered.observation.truthClass).toBe("PROVEN");
  expect(runner.RUNTIME_PINNING_METHODS).toContain(discovered.observation.pinningMethod);
  // Quotable AS IS. The factory refuses a self-assembled quote with
  // CLAUDE_RUNTIME_OBSERVATION_CHANGED; that it accepts this one is the deliverable.
  const input: ClaudeRuntimePinRequestInput = {
    quotedObservation: discovered.observation, installedRoot: discovered.installedRoot,
    pinRoot: "C:\\pins",
  };
  const hydrated: ClaudeRuntimePinRequestResult = runner.createClaudeRuntimePinRequest(input);
  if ("ok" in hydrated) throw new Error(`hydration refused with ${hydrated.code}`);
  expect(hydrated.quotedObservation.observationDigest)
    .toBe(discovered.observation.observationDigest);
}, 120_000);

function recordsOf(overrides: Overrides = {}): Overrides {
  const commit = commitFixture();
  return {
    intent: commit.intent, attempt: commit.attempt, attemptState: "RUNNING", claim: CLAIM_RECORD,
    grant: commit.grant, tombstone: null, registration: REGISTRATION, lockState: "HELD",
    observation: null, reconciliation: null, resourceFact: "ACTIVE",
    disposition: HELD_DISPOSITION, safeHandoff: null, ...overrides,
  };
}

function observationOf(overrides: Overrides = {}): Overrides {
  return {
    effectRef: "intent-1", processExit: { kind: "UNOBSERVED" }, effectStatus: "PROVEN_ACTIVE",
    observedEpoch: LEASE.epoch, presenceLooksLive: false, journalDigest: null,
    reviewPackageDigest: null, ...overrides,
  };
}

function classify(
  records: Overrides = {}, observation: Overrides = {}, claimedAuthority: unknown = null,
): CrashClassification {
  return runner.classifyCrash({
    records: recordsOf(records), observation: observationOf(observation), claimedAuthority,
  });
}

/** Names each refusing arm without any deep import, and pins the refusal key set. */
function recoveryRefusal(
  verdict: CrashClassification | DrainAdvance | OverlapVerdict | ResumeVerdict,
): RecoveryFailure {
  if (verdict.kind !== "REFUSED" && verdict.kind !== "BLOCKED") {
    throw new Error(`expected a refusal, got ${verdict.kind}`);
  }
  expect(Object.keys(verdict).sort()).toEqual(["failure", "kind"]);
  const failure: RecoveryFailure = verdict.failure;
  expect(failure.ok).toBe(false);
  return failure;
}

/** A recovery code, or a supervisor code carried through with its own layer intact. */
function recoveryCode(failure: RecoveryFailure): RecoveryErrorCode | SupervisorErrorCode {
  const layer: RecoveryLayer | SupervisorLayer = failure.layer;
  expect([...runner.RECOVERY_LAYERS, ...runner.SUPERVISOR_LAYERS]).toContain(layer);
  return failure.code;
}

it("pins the published recovery vocabularies by value", () => {
  const kinds: readonly RecoveryOutcomeKind[] = runner.RECOVERY_OUTCOME_KINDS;
  expect([...kinds]).toEqual(
    ["ADOPTED", "ABSENT", "SUSPECT", "QUARANTINED", "RECONCILIATION_COMMAND"],
  );
  const releases: readonly PredecessorRelease[] = runner.PREDECESSOR_RELEASES;
  const statuses: readonly RecoveryEffectStatus[] = runner.RECOVERY_EFFECT_STATUSES;
  expect([[...releases], [...statuses], [...runner.RECOVERY_LAYERS]]).toEqual([
    ["PROVEN_RELEASED", "ACTIVE", "UNKNOWN"],
    ["PROVEN_ABSENT", "PROVEN_ACTIVE", "UNESTABLISHED"],
    ["SAFE_BOUNDARY", "CLASSIFICATION"],
  ]);
  expect(runner.RECOVERY_CONTRACT_VERSION).toBe("moe-crash-recovery/1");
  expect([...runner.RECOVERY_ERROR_CODES]).toContain("RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN");
  const reasons: readonly DrainReason[] = runner.DRAIN_REASONS;
  const targets: readonly DrainTerminalTarget[] = runner.DRAIN_TERMINAL_TARGETS;
  const posts: readonly RestartPostState[] = runner.RESTART_POST_STATES;
  expect([reasons[0], targets[0], posts[0]]).toEqual(
    ["URGENT_REVOKE", "CANCELLED", "ACTIVE_ADOPTED"],
  );
});

it("discriminates every CrashClassification arm through the published classifyCrash", () => {
  const advanced = { ...PROOF, epoch: LEASE.epoch + 1, leaseToken: "token:2" };
  const adopted = classify({}, {}, advanced);
  if (adopted.kind !== "ADOPTED") throw new Error(recoveryCode(recoveryRefusal(adopted)));
  const postState: RestartPostState = adopted.postState;
  expect([adopted.ok, adopted.effectRef, postState]).toEqual([true, "intent-1", "ACTIVE_ADOPTED"]);

  const suspect = classify({}, { effectStatus: "UNESTABLISHED" }, advanced);
  if (suspect.kind !== "SUSPECT") throw new Error(recoveryCode(recoveryRefusal(suspect)));
  expect([suspect.ok, suspect.postState]).toEqual([true, "ACTIVE_ADOPTED"]);

  const quarantined = classify({ registration: null, lockState: "RELEASED" });
  if (quarantined.kind !== "QUARANTINED") {
    throw new Error(recoveryCode(recoveryRefusal(quarantined)));
  }
  expect([...quarantined.held]).toEqual(["resource:ACTIVE", "effect:intent-1"]);

  const absent = classify(
    {
      intent: intentIn("SUCCEEDED"), attempt: null, attemptState: "TERMINAL", claim: null,
      grant: null, registration: null, lockState: "RELEASED", reconciliation: RECONCILED,
      resourceFact: "PROVEN_RELEASED",
    },
    { effectStatus: "PROVEN_ABSENT", processExit: { kind: "EXITED", code: 0 } },
  );
  if (absent.kind !== "ABSENT") throw new Error(recoveryCode(recoveryRefusal(absent)));
  expect([absent.ok, absent.effectRef, "postState" in absent]).toEqual([true, "intent-1", false]);

  const commanded = classify({ attemptState: "LEASED" });
  if (commanded.kind !== "RECONCILIATION_COMMAND") {
    throw new Error(recoveryCode(recoveryRefusal(commanded)));
  }
  expect([commanded.ok, commanded.command]).toEqual([true, "recovery.inspect_external"]);
  expect(commanded.detail.length).toBeGreaterThan(0);
});

it("refuses adoption, malformed input and a stale observation by three distinct codes", () => {
  expect(recoveryCode(recoveryRefusal(classify()))).toBe("RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN");
  const malformed = recoveryRefusal(runner.classifyCrash(null));
  expect([recoveryCode(malformed), malformed.layer]).toEqual(
    ["RECOVERY_OBSERVATION_MALFORMED", "CLASSIFICATION"],
  );
  const stale = recoveryRefusal(classify({}, { observedEpoch: LEASE.epoch - 1 }));
  expect([recoveryCode(stale), stale.layer]).toEqual(
    ["RECOVERY_STALE_OBSERVATION_REFUSED", "CLASSIFICATION"],
  );
});

it("discriminates both OverlapVerdict arms and separates the two blocking codes", () => {
  const overlap = (predecessorRelease: PredecessorRelease): OverlapVerdict =>
    runner.admitSuccessorOverlap({
      predecessorRef: "pred-1", successorRef: "succ-1", predecessorRelease,
      classification: "ABSENT",
    });
  const admitted = overlap("PROVEN_RELEASED");
  if (admitted.kind !== "ADMITTED") throw new Error(recoveryCode(recoveryRefusal(admitted)));
  expect([admitted.ok, admitted.successorRef]).toEqual([true, "succ-1"]);
  expect([
    recoveryCode(recoveryRefusal(overlap("ACTIVE"))),
    recoveryCode(recoveryRefusal(overlap("UNKNOWN"))),
    recoveryCode(recoveryRefusal(runner.admitSuccessorOverlap(null))),
  ]).toEqual([
    "RECOVERY_PREDECESSOR_ACTIVE", "RECOVERY_PREDECESSOR_RELEASE_UNKNOWN",
    "RECOVERY_BOUNDARY_MALFORMED",
  ]);
});

/**
 * The public root requires the durable classification, and only ABSENT resumes.
 * This replaces an assertion that admitted PROVEN_RELEASED with no classification
 * at all: that shape let SUSPECT and QUARANTINED gain successor authority from a
 * caller-supplied release fact. Omitting the classification now fails closed.
 */
it("requires a durable classification at the root and resumes only ABSENT", () => {
  const overlap = (classification: unknown): OverlapVerdict =>
    runner.admitSuccessorOverlap({
      predecessorRef: "pred-1", successorRef: "succ-1",
      predecessorRelease: "PROVEN_RELEASED", classification,
    });
  const suspect = recoveryRefusal(overlap("SUSPECT"));
  const quarantined = recoveryRefusal(overlap("QUARANTINED"));
  expect([recoveryCode(suspect), suspect.layer]).toEqual(
    ["RECOVERY_CLASSIFICATION_NOT_RESUMABLE", "SAFE_BOUNDARY"],
  );
  expect([recoveryCode(quarantined), quarantined.layer]).toEqual(
    ["RECOVERY_CLASSIFICATION_NOT_RESUMABLE", "SAFE_BOUNDARY"],
  );
  const missing = recoveryRefusal(
    runner.admitSuccessorOverlap({
      predecessorRef: "pred-1", successorRef: "succ-1",
      predecessorRelease: "PROVEN_RELEASED",
    }),
  );
  expect([recoveryCode(missing), missing.layer]).toEqual(
    ["RECOVERY_BOUNDARY_MALFORMED", "SAFE_BOUNDARY"],
  );
});

it("discriminates both ResumeVerdict arms and refuses a proven release with no handoff", () => {
  const admitted: ResumeVerdict = runner.admitResume({
    resumeRef: "resume-1", predecessorRelease: "PROVEN_RELEASED", safeHandoff: "handoff-1",
    classification: "ABSENT",
  });
  if (admitted.kind !== "ADMITTED") throw new Error(recoveryCode(recoveryRefusal(admitted)));
  expect([admitted.ok, admitted.resumeRef, admitted.safeHandoff]).toEqual(
    [true, "resume-1", "handoff-1"],
  );
  const unproven = recoveryRefusal(
    runner.admitResume({
      resumeRef: "resume-1", predecessorRelease: "PROVEN_RELEASED", safeHandoff: null,
      classification: "ABSENT",
    }),
  );
  expect([recoveryCode(unproven), unproven.layer]).toEqual(
    ["RECOVERY_RESUME_BOUNDARY_UNPROVEN", "SAFE_BOUNDARY"],
  );
  expect(recoveryCode(recoveryRefusal(runner.admitResume(null))))
    .toBe("RECOVERY_BOUNDARY_MALFORMED");
});

it("refuses a resume for every non-resumable classification at the root", () => {
  const resume = (classification: unknown): ResumeVerdict =>
    runner.admitResume({
      resumeRef: "resume-1", predecessorRelease: "PROVEN_RELEASED",
      safeHandoff: "handoff-1", classification,
    });
  const kinds = ["ADOPTED", "SUSPECT", "QUARANTINED", "RECONCILIATION_COMMAND"] as const;
  const refusals = kinds.map((kind) => recoveryRefusal(resume(kind)));
  expect(refusals).toHaveLength(4);
  expect(refusals.map((refusal) => [recoveryCode(refusal), refusal.layer])).toEqual(
    kinds.map(() => ["RECOVERY_CLASSIFICATION_NOT_RESUMABLE", "SAFE_BOUNDARY"]),
  );
  const missing = recoveryRefusal(
    runner.admitResume({
      resumeRef: "resume-1", predecessorRelease: "PROVEN_RELEASED", safeHandoff: "handoff-1",
    }),
  );
  expect(recoveryCode(missing)).toBe("RECOVERY_BOUNDARY_MALFORMED");
});

it("advances a drain, and names which of the two layers refused each way", () => {
  const advanced: DrainAdvance = runner.advanceRecoveryDrain(HELD_DISPOSITION, {
    reasons: ["WORK_CANCEL", "URGENT_REVOKE"], strongestReason: "URGENT_REVOKE",
    terminalTarget: "CANCELLED",
  });
  if (advanced.kind !== "ADVANCED") throw new Error(recoveryCode(recoveryRefusal(advanced)));
  const disposition: DrainDisposition = advanced.disposition;
  expect([advanced.ok, disposition.strongestReason, disposition.terminalTarget]).toEqual(
    [true, "URGENT_REVOKE", "CANCELLED"],
  );
  const dropped = recoveryRefusal(
    runner.advanceRecoveryDrain(HELD_DISPOSITION, {
      reasons: ["URGENT_REVOKE"], strongestReason: "URGENT_REVOKE", terminalTarget: "CANCELLED",
    }),
  );
  expect([recoveryCode(dropped), dropped.layer]).toEqual(
    ["RECOVERY_DRAIN_REASON_DROPPED", "SAFE_BOUNDARY"],
  );
  const downgraded = recoveryRefusal(
    runner.advanceRecoveryDrain(HELD_DISPOSITION, {
      reasons: ["WORK_CANCEL", "SUBMISSION_FINALIZE"], strongestReason: "SUBMISSION_FINALIZE",
      terminalTarget: "SUCCEEDED",
    }),
  );
  expect([recoveryCode(downgraded), downgraded.layer]).toEqual(
    ["RECOVERY_DRAIN_DOWNGRADE_REFUSED", "SAFE_BOUNDARY"],
  );
  // Carried verbatim from the supervisor, which owns drain monotonicity. The
  // recovery layer must NOT restamp it, or a reader cannot tell who refused.
  const carried = recoveryRefusal(
    runner.advanceRecoveryDrain(
      {
        reasons: ["URGENT_REVOKE", "WORK_CANCEL"], strongestReason: "WORK_CANCEL",
        terminalTarget: "CANCELLED",
      },
      HELD_DISPOSITION,
    ),
  );
  expect([recoveryCode(carried), carried.layer]).toEqual(
    ["DRAIN_DISPOSITION_NOT_MONOTONIC", "DRAIN"],
  );
});

/* ---- evidence: recipe, rematerialization, execution, receipt ---- */

const HEAD_OID = "0".repeat(40);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "c".repeat(64);
const SCHEMA_DIGEST = "d".repeat(64);
const STARTED_AT = "2026-08-08T10:00:00Z";
const COMPLETED_AT = "2026-08-08T10:00:09Z";
const INPUT_PATH = "pkg/src/base.ts";
const AUTHORED_PATH = "pkg/src/authored.ts";
const OUTPUT_PATH = "out/report.json";
const OUTPUT_REF: ArtifactRef = { sha256: DIGEST_B, byteLength: 7 };
const VERIFIER: VerifierIdentity = {
  verifierId: "moe-verifier", verifierVersion: "1.0.0", capabilitySchemaDigest: SCHEMA_DIGEST,
};
const DECLARED: DeclaredInput = { path: INPUT_PATH, ref: { sha256: DIGEST_A, byteLength: 10 } };

function evidenceFailureOf(result: { readonly ok: boolean }): EvidenceFailure {
  if (result.ok) throw new Error("expected an evidence refusal, got a success");
  const failure = result as EvidenceFailure;
  const layer: EvidenceRefusalLayer = failure.layer;
  const code: RunnerEvidenceErrorCode = failure.code;
  expect(runner.EVIDENCE_REFUSAL_LAYERS).toContain(layer);
  expect(runner.RUNNER_EVIDENCE_ERROR_CODES).toContain(code);
  return failure;
}

function recipeOf(inputs: readonly DeclaredInput[], outputs: readonly string[]): VerificationRecipe {
  const result: BuildVerificationRecipeResult = runner.buildVerificationRecipe({
    argv: ["node", "verify.mjs"], declaredInputs: inputs, declaredOutputPaths: outputs,
    verifierIdentity: VERIFIER,
  });
  if (!result.ok) throw new Error(evidenceFailureOf(result).code);
  return result.recipe;
}

function scopeFixture(): ScopeObservation {
  const git: GitObserver = {
    headCommit: () => HEAD_OID,
    statusPorcelainV2: () => new TextEncoder().encode(`# branch.oid ${HEAD_OID}\0`),
    lsFilesTracked: () => [], lsFilesIgnored: () => [], submodulePaths: () => [],
  };
  const result = runner.observeScope({
    worktreeRoot: "fixture-root", baseIdentity: HEAD_OID, declaredScopePaths: ["pkg/src"],
    gitObserver: git, pathObserver: { realpath: (path) => path, exists: () => false },
    observedAt: STARTED_AT, observerVersion: "moe-runner-scope-observer/1",
  });
  if (!result.ok) throw new Error(`${result.code} ${result.message}`);
  return result.observation;
}

function inputManifestFixture(): WorkspaceInputManifest {
  const result = runner.buildInputManifest({
    baseIdentity: HEAD_OID,
    entries: [{ path: INPUT_PATH, sha256: DIGEST_A, byteLength: 10, producer: { kind: "BASE" } }],
  });
  if (!result.ok) throw new Error(`${result.code} ${result.message}`);
  return result.manifest;
}

function resultManifestFixture(inputManifest: WorkspaceInputManifest): WorkspaceResultManifest {
  const result = runner.buildResultManifest({
    inputManifest, scopeObservation: scopeFixture(), authoredPaths: [AUTHORED_PATH],
    resultTreeEntries: [
      { path: INPUT_PATH, sha256: DIGEST_A, byteLength: 10, origin: "INHERITED", kind: "REGULAR" },
      { path: AUTHORED_PATH, sha256: DIGEST_B, byteLength: 4, origin: "AUTHORED", kind: "REGULAR" },
    ],
    declaredArtifactRefs: [OUTPUT_REF],
  });
  if (!result.ok) throw new Error(`${result.code} ${result.message}`);
  return result.manifest;
}

function observationFixture(pinningMethod: RuntimePinningMethod): ProviderRuntimeObservation {
  const closure: readonly RuntimeClosureEntry[] = [
    { kind: "EXECUTABLE" satisfies RuntimeClosureKind, path: "bin/node", sha256: DIGEST_A },
  ];
  const platform: PlatformIdentity = { os: "win32", arch: "x64", osVersion: "10.0.26200" };
  const clock: ObservationClock = { observedAt: () => STARTED_AT };
  const input: BuildObservationInput = {
    resolvedRuntimeClosure: closure, reportedVersion: "1.2.3",
    adapterCapabilitySchemaDigest: SCHEMA_DIGEST, pinningMethod, platformIdentity: platform, clock,
  };
  const result: BuildObservationResult = runner.buildProviderRuntimeObservation(input);
  if (!result.ok) throw new Error(result.code);
  return result.observation;
}

function executionFixture(recipe: VerificationRecipe): ObservedVerifierExecution {
  const outputs: readonly ObservedOutput[] = [{ path: OUTPUT_PATH, ref: OUTPUT_REF }];
  return {
    argv: [...recipe.argv], disposition: "COMPLETED" satisfies ExecutionDisposition, exitCode: 0,
    outputs, runtimeObservation: observationFixture("CONTENT_ADDRESSED_COPY"),
    startedAt: STARTED_AT, completedAt: COMPLETED_AT,
  };
}

it("builds and seal-verifies a verification recipe, and refuses an empty argv by code", () => {
  const recipe = recipeOf([DECLARED], [OUTPUT_PATH]);
  expect([recipe.recipeVersion, runner.recipeSealMatches(recipe)]).toEqual(
    [runner.VERIFICATION_RECIPE_VERSION, true],
  );
  expect(runner.recipeSealMatches({ ...recipe, sha256: DIGEST_A })).toBe(false);
  const refused = evidenceFailureOf(
    runner.buildVerificationRecipe({
      argv: [], declaredInputs: [], declaredOutputPaths: [], verifierIdentity: VERIFIER,
    }),
  );
  expect([refused.code, refused.layer, refused.ok]).toEqual(
    ["RUNNER_EVIDENCE_ARGV_INVALID", "RECIPE_SHAPE", false],
  );
  expect([runner.MAX_EVIDENCE_ARGV_ENTRIES, runner.MAX_EVIDENCE_TEXT_CHARS]).toEqual([128, 400]);
  expect([runner.MAX_EVIDENCE_DECLARED_ENTRIES, runner.MAX_EVIDENCE_OBLIGATIONS]).toEqual(
    [1024, 64],
  );
});

it("discriminates both RematerializeCandidateResult arms through the root", () => {
  const unreachable = (name: string) => (): never => {
    throw new Error(`${name} must not be called for an empty declared closure`);
  };
  const artifacts = {
    stageArtifact: unreachable("stageArtifact"), verifyArtifact: unreachable("verifyArtifact"),
    deleteArtifact: unreachable("deleteArtifact"),
  } as unknown as ArtifactStore;
  const artifactFs = {
    openWrite: unreachable("openWrite"), write: unreachable("write"), fsync: unreachable("fsync"),
    close: unreachable("close"), exists: unreachable("exists"), rename: unreachable("rename"),
    persistAfterRename: unreachable("persistAfterRename"), readAll: unreachable("readAll"),
    unlink: unreachable("unlink"),
  } as unknown as ArtifactFsPort;
  const listed: readonly CandidateTreeEntry[] = [];
  const candidate: CandidateTreePort = {
    list: () => listed, write: unreachable("candidate.write"), remove: unreachable("remove"),
  };
  const input: RematerializeCandidateInput = {
    recipe: recipeOf([], []), baseIdentity: HEAD_OID, producer: { kind: "BASE" }, artifacts,
    artifactFs, artifactRoot: "store-root", candidate,
  };
  const rematerialized: RematerializeCandidateResult = runner.rematerializeCandidate(input);
  if (!rematerialized.ok) throw new Error(evidenceFailureOf(rematerialized).code);
  expect([[...rematerialized.materializedPaths], rematerialized.inputManifest.baseIdentity]).toEqual(
    [[], HEAD_OID],
  );
  // Same CODE as the receipt path below, a DIFFERENT layer: which gate answered
  // is the fact a consumer needs, and it survives publication.
  const tampered = evidenceFailureOf(
    runner.rematerializeCandidate({ ...input, recipe: { ...input.recipe, sha256: DIGEST_A } }),
  );
  expect([tampered.code, tampered.layer]).toEqual(
    ["RUNNER_EVIDENCE_RECIPE_DIGEST_MISMATCH", "REMATERIALIZATION"],
  );
});

it("discriminates both BuildEvidenceReceiptResult arms and re-derives the receipt seal", () => {
  const recipe = recipeOf([DECLARED], [OUTPUT_PATH]);
  const inputManifest = inputManifestFixture();
  const resultManifest = resultManifestFixture(inputManifest);
  const support: ObligationSupport = { kind: "ARTIFACT", ref: OUTPUT_REF };
  const obligations: readonly DischargedObligation[] = [
    { kind: "OUTPUT_PRESENT" satisfies EvidenceObligationKind, support },
    {
      kind: "RESULT_TREE_SEALED",
      support: { kind: "RESULT_TREE", manifestSha256: resultManifest.sha256 },
    },
  ];
  const input: BuildEvidenceReceiptInput = {
    recipe, execution: executionFixture(recipe), inputManifest, resultManifest,
    graphIdentity: "graph-node-17", leaseIdentity: "lease-42", effectIdentity: "effect-9",
    obligations,
  };
  const built: BuildEvidenceReceiptResult = runner.buildEvidenceReceipt(input);
  if (!built.ok) throw new Error(evidenceFailureOf(built).code);
  const receipt: EvidenceReceipt = built.receipt;
  const timestamps: ReceiptTimestamps = receipt.timestamps;
  expect([receipt.receiptVersion, receipt.recipeSha256, timestamps.startedAt]).toEqual(
    [runner.EVIDENCE_RECEIPT_VERSION, recipe.sha256, STARTED_AT],
  );
  expect(receipt.obligations.map((entry) => entry.kind)).toEqual(
    ["OUTPUT_PRESENT", "RESULT_TREE_SEALED"],
  );
  // The published digest input is what makes a stored receipt re-verifiable.
  expect(Object.keys(runner.receiptDigestInput(receipt))).toContain("recipeSha256");
  const tampered = evidenceFailureOf(
    runner.buildEvidenceReceipt({ ...input, recipe: { ...recipe, sha256: DIGEST_A } }),
  );
  expect([tampered.code, tampered.layer]).toEqual(
    ["RUNNER_EVIDENCE_RECIPE_DIGEST_MISMATCH", "RECEIPT_BINDING"],
  );
});

it("judges an observed execution and an obligation set against the published surface", () => {
  const recipe = recipeOf([DECLARED], [OUTPUT_PATH]);
  expect(runner.observedExecutionRejection(executionFixture(recipe), recipe)).toBeNull();
  const unknown = runner.observedExecutionRejection(
    { ...executionFixture(recipe), disposition: "UNKNOWN" }, recipe,
  );
  expect([unknown?.code, unknown?.layer]).toEqual(["RUNNER_EVIDENCE_EXECUTION_UNKNOWN", "EXECUTION"]);
  expect([...runner.EXECUTION_DISPOSITIONS]).toEqual(["COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"]);

  const context: ObligationContext = {
    outputRefs: [OUTPUT_REF], resultTreeSha256: DIGEST_A, runtimeObservationSha256: DIGEST_B,
  };
  const agentReported: readonly DischargedObligation[] = [
    { kind: "COMMAND_EXIT", support: { kind: "AGENT_REPORT", reportedBy: "agent", reportSha256: DIGEST_A } },
  ];
  const refused = runner.canonicalObligations(agentReported, context);
  // An array has no `ok` to narrow on, which is exactly why isEvidenceFailure is published.
  if (!runner.isEvidenceFailure(refused)) throw new Error("agent-reported text must not discharge");
  expect([refused.code, refused.layer]).toEqual(
    ["RUNNER_EVIDENCE_AGENT_TEXT_UNSUPPORTED", "OBLIGATION"],
  );
  const bound = runner.canonicalObligations(
    [{ kind: "OUTPUT_PRESENT", support: { kind: "ARTIFACT", ref: OUTPUT_REF } }], context,
  );
  expect(runner.isEvidenceFailure(bound)).toBe(false);
});

/* ---- Claude observation and reconciliation ---- */

const STREAM_EFFECT: MoeEffectIdentity = {
  effectIntentId: "intent-1", attemptRef: "attempt-1", epoch: 1,
};
const STREAM_EVENT: ClaudeStreamEvent = {
  ordinal: 0, effectIntentId: "intent-1", attemptRef: "attempt-1", epoch: 1, declaredSequence: 1,
  type: "assistant", schemaVersion: "claude-stream-json/1", byteLength: 4, lineSha256: DIGEST_A,
  lineBase64: null,
};
const STREAM_RAW: ClaudeRawRetention = {
  kind: "INLINE", byteLength: 4, sha256: DIGEST_A, rawBase64: "AAAA", tailBase64: "AAAA",
};

function streamOf(
  disposition: ClaudeStreamDisposition, anomalies: readonly ClaudeStreamAnomaly[] = [],
): ClaudeStreamRecord {
  return {
    recordVersion: runner.CLAUDE_STREAM_RECORD_VERSION, effect: STREAM_EFFECT, disposition,
    anomalies, events: [STREAM_EVENT], raw: STREAM_RAW, recordDigest: DIGEST_B,
  };
}

function reconcile(
  disposition: ClaudeStreamDisposition, cancelRequested: boolean, processExit: ClaudeProcessExit,
  anomalies: readonly ClaudeStreamAnomaly[] = [],
): ClaudeReconciliation {
  const input: ReconcileClaudeRunInput = {
    stream: streamOf(disposition, anomalies), cancelRequested, processExit,
  };
  return runner.reconcileClaudeRun(input);
}

it("reconciles an observed Claude run into each published outcome, from the root", () => {
  const exited0: ClaudeProcessExit = { kind: "EXITED", code: 0 };
  const signalled: ClaudeProcessExit = { kind: "SIGNALLED", signal: "SIGKILL" };
  const outcomes: readonly ClaudeReconciledOutcome[] = [
    reconcile("COMPLETED", false, exited0).outcome,
    reconcile("COMPLETED", true, exited0).outcome,
    reconcile("CANCELLED", true, exited0).outcome,
    reconcile("INCOMPLETE", true, exited0).outcome,
    reconcile("INCOMPLETE", true, { kind: "EXITED", code: 1 }).outcome,
    reconcile("INCOMPLETE", false, signalled).outcome,
    reconcile("UNKNOWN", false, signalled).outcome,
    reconcile("UNKNOWN", false, signalled, ["TRUNCATION"]).outcome,
  ];
  expect([...outcomes]).toEqual([
    "PROVEN_RESULT", "COMPLETED_BEFORE_CANCEL", "CANCELLED_CLEAN", "HONEST_UNKNOWN",
    "CANCELLED_UNKNOWN_TAIL", "CRASHED", "HONEST_UNKNOWN", "CRASHED",
  ]);
  for (const outcome of outcomes) expect(runner.CLAUDE_RECONCILED_OUTCOMES).toContain(outcome);

  const reconciliation = reconcile("COMPLETED", false, exited0);
  expect([reconciliation.reconciliationVersion, reconciliation.disposition]).toEqual(
    [runner.CLAUDE_RECONCILIATION_VERSION, "COMPLETED"],
  );
  // ClaudeProcessExit narrows by kind through the root: only EXITED carries a code.
  const exit: ClaudeProcessExit = reconciliation.processExit;
  expect(exit.kind === "EXITED" ? exit.code : "no code").toBe(0);
  const unobserved: ClaudeProcessExit = reconcile("UNKNOWN", false, { kind: "UNOBSERVED" })
    .processExit;
  expect([unobserved.kind, "code" in unobserved, "signal" in unobserved]).toEqual(
    ["UNOBSERVED", false, false],
  );
  expect(reconciliation.reconciliationDigest).not.toBe(
    reconcile("COMPLETED", true, exited0).reconciliationDigest,
  );
});

it("builds a runtime observation, re-derives its digest, and refuses an unknown pin method", () => {
  const observation = observationFixture("CONTENT_ADDRESSED_COPY");
  const truthClass: ObservationTruthClass = observation.truthClass;
  expect([observation.observationVersion, truthClass, observation.providerId]).toEqual(
    [runner.CLAUDE_RUNTIME_OBSERVATION_VERSION, "PROVEN", "claude"],
  );
  expect(runner.OBSERVATION_TRUTH_CLASSES).toContain(truthClass);
  expect(Object.keys(runner.observationDigestInput(observation))).toContain("pinningMethod");
  expect([
    runner.runtimePinningIsAuthoritative(observation),
    runner.runtimePinningIsAuthoritative(observationFixture("UNSUPPORTED")),
  ]).toEqual([true, false]);
  const refused: BuildObservationResult = runner.buildProviderRuntimeObservation({
    resolvedRuntimeClosure: [], reportedVersion: null,
    adapterCapabilitySchemaDigest: SCHEMA_DIGEST,
    pinningMethod: "NOT_A_METHOD" as RuntimePinningMethod,
    platformIdentity: { os: "win32", arch: "x64", osVersion: "10.0.26200" },
    clock: { observedAt: () => STARTED_AT },
  });
  if (refused.ok) throw new Error("an unknown pinning method must refuse");
  expect([refused.code, refused.ok]).toEqual(["CLAUDE_OBSERVATION_PINNING_METHOD_INVALID", false]);
  expect(runner.CLAUDE_OBSERVATION_ERROR_CODES).toContain(refused.code);
});

it("pins the published Claude capability and stream vocabularies by value", () => {
  expect(runner.CLAUDE_CAPABILITY_PROFILE_VERSION).toBe("moe-claude-capability-profile/1");
  expect([...runner.CLAUDE_CAPABILITY_STATUSES]).toEqual(["SUPPORTED", "UNSUPPORTED"]);
  expect([...runner.CLAUDE_CONTEXT_POLICIES]).toEqual(["ADMISSIBLE", "HOLD_UNKNOWN"]);
  expect([...runner.CLAUDE_CAPABILITIES]).toContain("RUN_ENUMERATION_NEGATIVE_PROOF");
  expect([...runner.CLAUDE_PROOF_METHODS]).toContain("NONE");
  expect([...runner.RUNTIME_CLOSURE_KINDS]).toEqual(["EXECUTABLE", "LAUNCHER", "PACKAGE"]);
  expect([...runner.RUNTIME_PINNING_METHODS]).toContain("PLATFORM_IMMUTABLE_HANDLE");
  expect([...runner.CLAUDE_STREAM_DISPOSITIONS]).toContain("INCOMPLETE");
  expect([...runner.CLAUDE_STREAM_ANOMALIES]).toContain("TRUNCATION");
  expect(runner.CLAUDE_STREAM_RECORD_VERSION).toBe("moe-claude-stream-record/1");
});

/**
 * The platform seam is DRIVEN here, not merely resolved. Reaching a symbol
 * proves a name is published; building an input, getting a verdict back and
 * narrowing a refusal proves the published type closure is actually sufficient
 * to compose against — which is the thing an OS conformance task needs and the
 * thing a cardinality check cannot tell you.
 */
it("lets a consumer drive the Linux platform seam using root exports alone", () => {
  const host: PlatformHostIdentity = { os: "linux", arch: "x64", osVersion: "6.8.0-41-generic" };
  const context: LinuxClassificationContext = {
    host,
    asOf: "2026-08-09T12:00:00.000Z",
    maxFactAgeMs: 60_000,
  };
  const facts: LinuxBoundaryFacts = {
    PROVIDER_LAUNCH: null, GIT_WORKSPACE: null, PATH_SYMLINK: null, LOCK: null,
    SIGNAL_CANCELLATION: null, RUNTIME_CLOSURE: null, CRASH_RECOVERY: null,
  };
  const input: ObserveLinuxPlatformInput = { ...context, facts };

  const observation: PlatformObservation = runner.observeLinuxPlatform(input);
  const aggregate: PlatformTruthClass = observation.truthClass;
  expect(aggregate).toBe("UNKNOWN");
  expect(observation.verdicts.map((verdict: PlatformBoundaryVerdict) => verdict.boundary))
    .toEqual([...runner.PLATFORM_BOUNDARIES]);

  const absent: PlatformFailure | null = observation.verdicts[0]?.failure ?? null;
  expect(absent?.code).toBe("PLATFORM_FACT_ABSENT");
  const layer: PlatformLayer | undefined = absent?.layer;
  expect(layer).toBe(runner.PLATFORM_LINUX_LAYER);

  // A coherent on-host fact proves through the root, so PROVEN is reachable and
  // the UNKNOWN above is a judgement rather than the only answer available.
  const boundary: PlatformBoundary = "PATH_SYMLINK";
  const fact: LinuxPathFact = {
    path: "/srv/moe/work", symlinkTarget: null, resolvedPath: "/srv/moe/work",
  };
  const envelope: PlatformFactEnvelope<LinuxPathFact> = {
    host, observedAt: "2026-08-09T11:59:59.000Z", truthClass: "PROVEN", fact,
  };
  const verdict = runner.classifyLinuxBoundary(boundary, envelope, context);
  if (runner.isPlatformFailure(verdict)) throw new Error("a known boundary must return a verdict");
  expect([verdict.boundary, verdict.truthClass, verdict.failure]).toEqual([
    "PATH_SYMLINK", "PROVEN", null,
  ]);

  // The other layer is reachable from the root too: an unusable boundary NAME is
  // the OS-neutral contract's refusal, not Linux's.
  const refused = runner.classifyLinuxBoundary("NETWORK", envelope, context);
  if (!runner.isPlatformFailure(refused)) throw new Error("an unknown boundary must refuse");
  expect([refused.code, refused.layer, refused.boundary]).toEqual([
    "PLATFORM_BOUNDARY_UNKNOWN", "PLATFORM_CONTRACT", null,
  ]);
  expect(runner.PLATFORM_ERROR_CODES).toContain(refused.code);
});

/**
 * The same drive, on darwin, deliberately naming NO `Linux*` symbol. Reaching
 * both UNKNOWN and PROVEN through the root proves the macOS closure is
 * self-sufficient; asserting `PLATFORM_MACOS_LAYER` rather than merely "some
 * refusal happened" proves the verdict is not Linux's wearing a new name.
 *
 * The facts below are supplied by this test, not observed from a machine. This
 * asserts deterministic darwin classification; it is not macOS conformance.
 */
it("lets a consumer drive the macOS platform seam using root exports alone", () => {
  const host: PlatformHostIdentity = { os: "darwin", arch: "arm64", osVersion: "24.6.0" };
  const context: MacosClassificationContext = {
    host,
    asOf: "2026-08-09T12:00:00.000Z",
    maxFactAgeMs: 60_000,
  };
  const facts: MacosBoundaryFacts = {
    PROVIDER_LAUNCH: null, GIT_WORKSPACE: null, PATH_SYMLINK: null, LOCK: null,
    SIGNAL_CANCELLATION: null, RUNTIME_CLOSURE: null, CRASH_RECOVERY: null,
  };
  const input: ObserveMacosPlatformInput = { ...context, facts };

  const observation: PlatformObservation = runner.observeMacosPlatform(input);
  expect(observation.truthClass).toBe("UNKNOWN");
  expect(observation.verdicts.map((verdict: PlatformBoundaryVerdict) => verdict.boundary))
    .toEqual([...runner.PLATFORM_BOUNDARIES]);

  const absent: PlatformFailure | null = observation.verdicts[0]?.failure ?? null;
  expect(absent?.code).toBe("PLATFORM_FACT_ABSENT");
  const layer: PlatformLayer | undefined = absent?.layer;
  expect(layer).toBe(runner.PLATFORM_MACOS_LAYER);
  expect(layer).not.toBe(runner.PLATFORM_LINUX_LAYER);

  const boundary: PlatformBoundary = "PATH_SYMLINK";
  const fact: MacosPathFact = {
    path: "/Users/moe/work", symlinkTarget: null, resolvedPath: "/Users/moe/work",
  };
  const envelope: PlatformFactEnvelope<MacosPathFact> = {
    host, observedAt: "2026-08-09T11:59:59.000Z", truthClass: "PROVEN", fact,
  };
  const verdict = runner.classifyMacosBoundary(boundary, envelope, context);
  if (runner.isPlatformFailure(verdict)) throw new Error("a known boundary must return a verdict");
  expect([verdict.boundary, verdict.truthClass, verdict.failure]).toEqual([
    "PATH_SYMLINK", "PROVEN", null,
  ]);

  // The workspace pair type is part of the published closure too: a consumer
  // that cannot spell it cannot supply the GIT_WORKSPACE boundary at all.
  const workspaceFactShape: (value: MacosWorkspaceFact) => readonly string[] =
    (value) => Object.keys(value).sort();
  expect(runner.MACOS_SUPPORTED_ARCHITECTURES).toContain(host.arch);
  expect(typeof workspaceFactShape).toBe("function");

  const refusedBoundary = runner.classifyMacosBoundary("APFS", envelope, context);
  if (!runner.isPlatformFailure(refusedBoundary)) throw new Error("an unknown boundary must refuse");
  expect([refusedBoundary.code, refusedBoundary.layer, refusedBoundary.boundary]).toEqual([
    "PLATFORM_BOUNDARY_UNKNOWN", "PLATFORM_CONTRACT", null,
  ]);
});

it("composes the recovery-inventory seam through the root, naming every closure type", async () => {
  // Every annotation below is a root-exported type. If the seam published a
  // function whose signature reaches a type it did not publish, this file stops
  // compiling — which is the only way a "type closure" claim can be checked.
  const backup: RecoveryInventoryOpaqueRef = {
    kind: "BACKUP_CURSOR_GENERATION", ref: "gen-1", digest: "a".repeat(64),
  };
  const incarnation: RecoveryInventoryOpaqueRef = {
    kind: "RECOVERY_INCARNATION", ref: "inc-1", digest: "b".repeat(64),
  };
  const window: RecoveryInventoryWindow = {
    startInclusive: "2026-08-01T00:00:00Z", endInclusive: "2026-08-09T23:59:59Z",
  };
  const configured: readonly RecoveryInventoryClass[] = ["WORKSPACE", "GIT_INTEGRATION_ON_DISK"];

  const seen: RecoveryInventoryEnumerationContext[] = [];
  const registration: RecoveryInventoryRegistration = {
    class: "WORKSPACE",
    enumerate: (context: RecoveryInventoryEnumerationContext) => {
      seen.push(context);
      return Promise.resolve({
        status: "ENUMERATED", items: [], complete: true, negativeProofDigest: "c".repeat(64),
      });
    },
  };

  const result: RecoveryInventoryResult = await runner.collectRecoveryInventory(
    { projectTag: "moe-next", backup, incarnation, window, configuredClasses: configured },
    runner.createRecoveryInventoryRegistry([registration]),
  );
  if (runner.isRecoveryInventoryFailure(result)) {
    throw new Error(`a well-formed request must report, got ${result.code}`);
  }
  const report: RecoveryInventoryReport = result;

  // The registered class proves COMPLETE off a negative proof; the CONFIGURED
  // class nobody registered still gets a proof, and it is UNKNOWN rather than
  // absent. That pair is the coverage protocol in one assertion.
  const proofs: readonly RecoveryInventoryCoverageProof[] = report.proofs;
  expect(proofs.map((proof) => [proof.class, proof.truth, proof.reason])).toEqual([
    ["WORKSPACE", "COMPLETE", null],
    ["GIT_INTEGRATION_ON_DISK", "UNKNOWN", "ENUMERATOR_UNREGISTERED"],
  ]);
  expect(report.coverage).toBe("UNKNOWN");
  expect(seen.map((context) => context.class)).toEqual(["WORKSPACE"]);
  expect(runner.RECOVERY_INVENTORY_ERROR_CODES).toContain("RECOVERY_INVENTORY_COVERAGE_UNKNOWN");
});

/* ------------------------------------------------------------------ *
 * The Git ref and artifact object enumeration seam.
 *
 * Both capabilities are reached by CALLING through the root, never by naming a
 * literal that would typecheck against a locally re-declared shape. Both
 * refusals pin the exact code AND the layer that answered: a caller that cannot
 * tell the port's I/O fault from the store's layout verdict has lost the whole
 * reason the two-layer vocabulary exists.
 * ------------------------------------------------------------------ */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

it("parses a ref listing at the root and names the layer refusing a truncated one", () => {
  const record = `refs/heads/main\0${HEAD_OID}\0commit\0\n`;
  const listing: GitRefListing = runner.parseRefListing(
    new TextEncoder().encode(record),
    "for-each-ref",
  );
  const observed: readonly GitRefObservation[] = listing.refs;
  expect([observed.map((ref) => ref.refName), observed.map((ref) => ref.targetCommit)]).toEqual([
    ["refs/heads/main"], [HEAD_OID],
  ]);
  // The digest is carried even by an empty observation, so "observed, nothing
  // there" never degrades into bare proof of absence.
  expect(listing.refCount).toBe(1);
  expect(listing.observationDigest).toMatch(/^[0-9a-f]{64}$/u);

  let refused: unknown;
  try {
    // A COMPLETE record whose LF terminator was replaced by another byte, so the
    // LF guard is the only thing that can reject it: drop that guard and the
    // stray byte is chopped instead, four valid fields survive, and this returns.
    // A record simply cut short would be answered by the field-count guard with
    // the same code and the same layer, leaving the claim below untested.
    const unterminated = `refs/heads/main\0${HEAD_OID}\0commit\0X`;
    runner.parseRefListing(new TextEncoder().encode(unterminated), "for-each-ref");
  } catch (error) {
    refused = error;
  }
  if (!(refused instanceof runner.ScopeObserverError)) {
    throw new Error("a record with no LF terminator must refuse, not return");
  }
  const layer: ScopeObserverLayer | undefined = refused.layer;
  expect([refused.code, layer]).toEqual(["RUNNER_SCOPE_STATUS_MALFORMED", "GIT_OBSERVER"]);
});

it("enumerates artifacts at the root and separates the two refusing layers", () => {
  const unavailable: ArtifactEnumerationResult = runner.enumerateArtifactsAt(
    { exists: () => true } as unknown as ArtifactFsPort,
    "store-root/objects",
  );
  if (unavailable.ok) throw new Error("a port with no listDirectory must refuse");
  const failure: ArtifactEnumerationFailure = unavailable;
  const failureLayer: ArtifactEnumerationLayer = failure.layer;
  // The STORE refuses, not the port: nothing was read, so "empty" is not a
  // claim this call is entitled to make.
  expect([failure.code, failureLayer]).toEqual(
    ["RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE", "ARTIFACT_STORE"],
  );

  const emptyPort = { exists: () => true, listDirectory: () => [] } as unknown as ArtifactFsPort;
  const empty: ArtifactEnumerationResult = runner.enumerateArtifactsAt(emptyPort, "root/objects");
  if (!empty.ok) throw new Error(`a readable empty directory must succeed, got ${empty.code}`);
  const observation: ArtifactEnumerationOk = empty;
  const objects: readonly ArtifactObjectObservation[] = observation.objects;
  const staging: readonly ArtifactStagingObservation[] = observation.staging;
  expect([objects.length, staging.length, observation.entryCount]).toEqual([0, 0, 0]);
  expect(observation.observationDigest).toMatch(/^[0-9a-f]{64}$/u);
  expect(runner.MAX_ARTIFACT_ENUMERATION_ENTRIES).toBe(100_000);
});

it("lists a real directory through the published node artifact port", () => {
  const port: ArtifactFsPort = runner.createNodeArtifactFs();
  const listDirectory = port.listDirectory;
  if (listDirectory === undefined) throw new Error("the shipped port must supply listDirectory");
  const entries: readonly ArtifactDirectoryEntry[] = listDirectory.call(port, SRC_DIR);
  const kinds: readonly ArtifactDirectoryEntryKind[] = entries.map((entry) => entry.kind);
  // Non-vacuous by assertion, and anchored: a scan root that silently narrowed
  // to an empty or wrong directory would still satisfy a bare length check.
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.find((entry) => entry.name === "index.ts")?.kind).toBe("FILE");
  expect(entries.find((entry) => entry.name === "scope")?.kind).toBe("DIRECTORY");
  expect(kinds.filter((kind) => !["FILE", "DIRECTORY", "OTHER"].includes(kind))).toEqual([]);
});

/**
 * The recovery-inventory registration seam, composed ONLY through the root.
 *
 * Every annotation below is a published type doing real work: if the surface
 * under-publishes one leaf of a factory's argument, this file stops compiling,
 * which is the failure a downstream daemon would otherwise hit in its own repo.
 * The enumeration behaviour of each adapter is proven against real ports in
 * `recovery-inventory/inventory-registration.test.ts`; what is proven here is
 * that a consumer holding nothing but `@moe/runner` can BUILD all four.
 */
const INVENTORY_CLOCK: ObservationClock = { observedAt: () => "2026-08-08T00:00:00.000Z" };
const INVENTORY_PLATFORM: PlatformIdentity = { os: "windows", arch: "x64", osVersion: "10.0" };

const CLAUDE_REPORT: ClaudeProbeReport = {
  resolvedRuntimeClosure: [] as readonly RuntimeClosureEntry[],
  reportedVersion: "v1",
  schemaVersion: null,
  pinningMethod: "UNSUPPORTED" satisfies RuntimePinningMethod,
  structuredSample: null satisfies ClaudeStructuredSample | null,
  rawSampleBase64: null,
  cancelObservation: null satisfies ClaudeCancelObservation | null,
  processTreeObservation: { childrenBefore: 2, childrenAfter: 0 } satisfies
    ClaudeProcessTreeObservation,
  runEnumeration: { enumeratedRunIds: ["run-a"], provenAbsentRunId: "run-z" } satisfies
    ClaudeRunEnumerationObservation,
  tokenizer: null satisfies ClaudeTokenizerObservation | null,
  declaredContextLimit: null,
  helpText: null,
  resumeClaim: null,
};

const CODEX_REPORT: CodexProbeReport = {
  resolvedRuntimeClosure: [],
  reportedVersion: "v1",
  schemaVersion: null,
  pinningMethod: "UNSUPPORTED",
  structuredSample: null satisfies CodexStructuredSample | null,
  rawSampleBase64: null,
  cancelObservation: null satisfies CodexCancelObservation | null,
  cwdObservation: null satisfies CodexCwdObservation | null,
  processTreeObservation: { childrenBefore: 2, childrenAfter: 0 } satisfies
    CodexProcessTreeObservation,
  runEnumeration: { enumeratedRunIds: ["run-a"], provenAbsentRunId: "run-z" } satisfies
    CodexRunEnumerationObservation,
  tokenizer: null satisfies CodexTokenizerObservation | null,
  declaredContextLimit: null satisfies CodexContextLimit | null,
  helpText: null,
  resumeClaim: null,
};

function rootProviderInput(): ProviderLockInventoryInput {
  const claudePort: ClaudeProbePort = { report: () => CLAUDE_REPORT };
  const codexPort: CodexProbePort = { report: () => CODEX_REPORT };
  const claude: ProbeClaudeRuntimeInput =
    { port: claudePort, clock: INVENTORY_CLOCK, platformIdentity: INVENTORY_PLATFORM };
  const codex: ProbeCodexRuntimeInput =
    { port: codexPort, clock: INVENTORY_CLOCK, platformIdentity: INVENTORY_PLATFORM };
  const processRecords: readonly ProviderProcessRecord[] =
    [{ processIdentity: "pid-1", exit: { kind: "EXITED", code: 0 }, reconciliation: null }];
  const port: ProviderLockInventoryPort = {
    governingClaim: () => CLAIM_RECORD,
    launchLockRecords: () => [],
    processRecords: () => processRecords,
  };
  return { port, claude, codex, clock: INVENTORY_CLOCK };
}

function rootWorkspaceInput(): WorkspaceInventoryInput {
  const result: WorkspaceInventoryResultAspect | null = null;
  const source: WorkspaceInventorySource = {
    workspaceRef: "ws/alpha", baseIdentity: "1".repeat(40), rootPath: SRC_DIR,
    producer: { kind: "BASE" }, result,
  };
  const listing: WorkspaceInventoryListing = { workspaces: [source], listingComplete: true };
  const port: WorkspaceInventoryPort = { list: () => listing };
  return { port, clock: INVENTORY_CLOCK };
}

it("publishes the whole construction closure of the four registration factories", () => {
  const git: GitIntegrationInventoryInput = {
    observer: {} as unknown as GitObserver, clock: INVENTORY_CLOCK,
  };
  const artifact: ArtifactObjectInventoryInput = {
    store: {} as unknown as ArtifactStore, clock: INVENTORY_CLOCK,
  };
  const registrations: readonly RecoveryInventoryRegistration[] = [
    runner.providerLockInventoryRegistration(rootProviderInput()),
    runner.workspaceInventoryRegistration(rootWorkspaceInput()),
    runner.gitIntegrationInventoryRegistration(git),
    runner.artifactObjectInventoryRegistration(artifact),
  ];

  // Exact classes in exact vocabulary order, four of them, all distinct: a
  // surface that aliased one factory to another would produce a duplicate here
  // rather than merely resolving four symbols.
  const classes = registrations.map((registration) => registration.class);
  expect(classes).toEqual([...runner.RECOVERY_INVENTORY_CLASSES]);
  expect(new Set(classes).size).toBe(4);
  expect(registrations.every((registration) => Object.isFrozen(registration))).toBe(true);

  // The two refusal shapes a consumer reads back are nameable through the root
  // too, so a caller can branch on the code its adapter reported.
  const gitRefusal: GitIntegrationRefusal =
    { code: "RUNNER_SCOPE_OBSERVATION_FAILED", layer: "GIT_OBSERVER" };
  const gitReading: GitIntegrationInventoryReading =
    { reading: { status: "UNAVAILABLE" }, refusal: gitRefusal };
  const artifactReading: ArtifactObjectInventoryReading =
    { reading: { status: "UNAVAILABLE" }, refusal: null };
  expect([gitReading.refusal?.code, gitReading.refusal?.layer, artifactReading.refusal])
    .toEqual(["RUNNER_SCOPE_OBSERVATION_FAILED", "GIT_OBSERVER", null]);
});

/** Negative control: the per-class readers and versions stay off the surface. */
it("keeps the recovery-inventory enumerators and version constants unpublished", () => {
  const withheld = [
    "enumerateProviderLockInventory", "enumerateWorkspaceInventory",
    "enumerateGitIntegrationInventory", "enumerateArtifactObjectInventory",
    "PROVIDER_LOCK_INVENTORY_VERSION", "WORKSPACE_INVENTORY_VERSION",
    "GIT_INTEGRATION_INVENTORY_VERSION", "ARTIFACT_OBJECT_INVENTORY_VERSION",
  ];
  expect(withheld.filter((name) => name in surface)).toEqual([]);
});

/**
 * The Codex provider seam's type closure. Type-only exports are invisible to
 * every runtime guard in this file — the `Object.keys` equality and the count
 * literal both see values only — so an absent or misspelled `export type` line
 * moves nothing and would surface first in a consumer's own repository.
 *
 * Every annotation below is applied to a REAL value obtained through the bare
 * `@moe/runner` specifier, never to a bare literal. `const x: T = { ... }`
 * typechecks against a locally re-declared shape whether or not `T` was ever
 * published, so a literal would assert nothing about the seam.
 */
const CODEX_DIGEST_A = "a".repeat(64);
const CODEX_DIGEST_B = "b".repeat(64);
const codexClock: CodexObservationClock = { observedAt: () => "2026-08-14T10:00:00.000Z" };
const codexPlatform: CodexPlatformIdentity = { os: "linux", arch: "x64", osVersion: "6.8" };
const codexClosure: readonly CodexRuntimeClosureEntry[] = [
  { kind: "PACKAGE", path: "z/package", sha256: CODEX_DIGEST_B },
  { kind: "EXECUTABLE", path: "a/codex", sha256: CODEX_DIGEST_A },
];
const codexEffect: CodexEffectIdentity =
  { effectIntentId: "effect-1", attemptRef: "attempt-1", epoch: 7 };

function codexObservationInput(
  overrides: Partial<CodexBuildObservationInput> = {},
): CodexBuildObservationInput {
  return {
    resolvedRuntimeClosure: codexClosure,
    reportedVersion: "codex-cli 1.0",
    adapterCapabilitySchemaDigest: CODEX_DIGEST_A,
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: codexPlatform,
    clock: codexClock,
    ...overrides,
  };
}

it("gives a root-only consumer the Codex observation type closure, both arms", () => {
  const kinds: readonly CodexRuntimeClosureKind[] = runner.CODEX_RUNTIME_CLOSURE_KINDS;
  const methods: readonly CodexRuntimePinningMethod[] = runner.CODEX_RUNTIME_PINNING_METHODS;
  const truths: readonly CodexObservationTruthClass[] = runner.CODEX_OBSERVATION_TRUTH_CLASSES;
  const codes: readonly CodexObservationErrorCode[] = runner.CODEX_OBSERVATION_ERROR_CODES;
  expect([kinds.length, methods.length, truths.length, codes.length]).toEqual([3, 3, 2, 8]);

  const built: CodexBuildObservationResult =
    runner.buildCodexRuntimeObservation(codexObservationInput());
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error("valid Codex observation input was refused");
  // OK arm reached: annotate the observation itself, then re-derive its digest
  // input through the published helper rather than trusting the builder's own.
  const observation: CodexProviderRuntimeObservation = built.observation;
  const truth: CodexObservationTruthClass = observation.truthClass;
  expect(observation.observationVersion).toBe(runner.CODEX_RUNTIME_OBSERVATION_VERSION);
  expect(observation.providerId).toBe("codex");
  expect(truths).toContain(truth);
  expect(methods).toContain(observation.pinningMethod);
  expect(typeof runner.codexRuntimePinningIsAuthoritative(observation)).toBe("boolean");
  // The digest INPUT, not the digest: it must reproduce the observation's own
  // identity fields and must not carry the digest it is used to compute.
  const digestInput = runner.codexObservationDigestInput(observation);
  expect(digestInput["providerId"]).toBe("codex");
  expect(digestInput["observationVersion"]).toBe(observation.observationVersion);
  expect(digestInput["truthClass"]).toBe(truth);
  expect("observationDigest" in digestInput).toBe(false);

  // REFUSED arm reached, and the exact reason code pinned rather than "not ok":
  // a closure entry whose sha256 is a well-typed string but not a 64-hex digest.
  const refused: CodexBuildObservationResult = runner.buildCodexRuntimeObservation(
    codexObservationInput({
      resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "a/codex", sha256: "not-a-digest" }],
    }),
  );
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("a malformed closure digest was accepted");
  const failure: CodexFailure<CodexObservationErrorCode> = refused;
  expect(failure.code).toBe("CODEX_OBSERVATION_CLOSURE_INVALID");
  expect(codes).toContain(failure.code);
});

it("gives a root-only consumer the Codex probe and capability type closure", () => {
  const capabilities: readonly CodexCapability[] = runner.CODEX_CAPABILITIES;
  const statuses: readonly CodexCapabilityStatus[] = runner.CODEX_CAPABILITY_STATUSES;
  const proofs: readonly CodexProofMethod[] = runner.CODEX_PROOF_METHODS;
  const policies: readonly CodexContextPolicy[] = runner.CODEX_CONTEXT_POLICIES;
  expect([capabilities.length, statuses.length, proofs.length, policies.length])
    .toEqual([12, 2, 12, 2]);

  // Family B: these names already reach the root from the recovery-inventory
  // seam and are deliberately NOT republished by the Codex seam. Building the
  // probe input out of them is what proves this task left them reachable rather
  // than shadowing them with a second owner.
  const sample: CodexStructuredSample = { jsonLines: ["{}"] };
  const cancel: CodexCancelObservation = { requestedAtSequence: 1, terminatedAtSequence: 2 };
  const cwd: CodexCwdObservation = { requestedCwd: "/w", observedCwd: "/w" };
  const tree: CodexProcessTreeObservation = { childrenBefore: 1, childrenAfter: 0 };
  const runs: CodexRunEnumerationObservation =
    { enumeratedRunIds: ["run-1"], provenAbsentRunId: "run-2" };
  const tokenizerFacts: CodexTokenizerObservation =
    { tokenizerId: "o200k", sampleText: "hello", sampleTokenCount: 1 };
  const limit: CodexContextLimit = { kind: "EXACT_TOKENS", tokens: 200_000 };
  const report: CodexProbeReport = {
    resolvedRuntimeClosure: codexClosure,
    reportedVersion: "codex-cli 1.0",
    schemaVersion: "codex-stream-json/1",
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    structuredSample: sample,
    rawSampleBase64: null,
    cancelObservation: cancel,
    cwdObservation: cwd,
    processTreeObservation: tree,
    runEnumeration: runs,
    tokenizer: tokenizerFacts,
    declaredContextLimit: limit,
    helpText: "codex --help",
    resumeClaim: null,
  };
  const port: CodexProbePort = { report: () => report };
  const probeInput: ProbeCodexRuntimeInput =
    { port, clock: codexClock, platformIdentity: codexPlatform };

  const probed: ProbeCodexRuntimeResult = runner.probeCodexRuntime(probeInput);
  expect(probed.ok).toBe(true);
  if (!probed.ok) throw new Error("a complete Codex probe report was refused");
  const ok: ProbeCodexRuntimeOk = probed;
  const profile: CodexCapabilityProfile = ok.profile;
  const observed: CodexProviderRuntimeObservation = ok.observation;
  expect(profile.profileVersion).toBe(runner.CODEX_CAPABILITY_PROFILE_VERSION);
  expect(policies).toContain(profile.contextPolicy);
  expect(observed.providerId).toBe("codex");

  // Every record in the profile is a member of all three published vocabularies.
  const records: readonly CodexCapabilityRecord[] = profile.capabilities;
  expect(records.length).toBe(capabilities.length);
  for (const entry of records) {
    expect(capabilities).toContain(entry.capability);
    expect(statuses).toContain(entry.status);
    expect(proofs).toContain(entry.proofMethod);
  }
});

it("gives a root-only consumer the Codex stream and reconciliation type closure", () => {
  const anomalies: readonly CodexStreamAnomaly[] = runner.CODEX_STREAM_ANOMALIES;
  const dispositions: readonly CodexStreamDisposition[] = runner.CODEX_STREAM_DISPOSITIONS;
  const streamCodes: readonly CodexStreamErrorCode[] = runner.CODEX_STREAM_ERROR_CODES;
  const outcomes: readonly CodexReconciledOutcome[] = runner.CODEX_RECONCILED_OUTCOMES;

  const line = JSON.stringify({ schemaVersion: "codex-stream-json/1", seq: 1, type: "assistant" });
  const streamInput: RecordCodexStreamInput = {
    rawBytes: new TextEncoder().encode(`${line}\n`),
    effect: codexEffect,
    acceptedSchemaVersions: runner.CODEX_ACCEPTED_SCHEMA_VERSIONS,
  };
  const recorded: RecordCodexStreamResult = runner.recordCodexStream(streamInput);
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error("a well-formed Codex stream line was refused");
  const streamRecord: CodexStreamRecord = recorded.record;
  const events: readonly CodexStreamEvent[] = streamRecord.events;
  const raw: CodexRawRetention = streamRecord.raw;
  expect(streamRecord.recordVersion).toBe(runner.CODEX_STREAM_RECORD_VERSION);
  expect(dispositions).toContain(streamRecord.disposition);
  expect(streamRecord.anomalies.every((anomaly) => anomalies.includes(anomaly))).toBe(true);
  expect(events.length).toBe(1);
  expect(events[0]?.effectIntentId).toBe(codexEffect.effectIntentId);
  expect(raw.kind).toBe("INLINE");

  // REFUSED arm, exact code: an empty allowlist can never admit a schema, so the
  // recorder refuses rather than silently accepting every version.
  const empty: RecordCodexStreamResult =
    runner.recordCodexStream({ ...streamInput, acceptedSchemaVersions: [] });
  expect(empty.ok).toBe(false);
  if (empty.ok) throw new Error("an empty schema allowlist was accepted");
  const streamFailure: CodexFailure<CodexStreamErrorCode> = empty;
  expect(streamFailure.code).toBe("CODEX_STREAM_SCHEMA_ALLOWLIST_EMPTY");
  expect(streamCodes).toContain(streamFailure.code);

  // Reconciliation composes on the record above, which is why both are
  // published: a consumer can carry one seam's output straight into the next.
  const exit: CodexProcessExit = { kind: "EXITED", code: 0 };
  const reconcileInput: ReconcileCodexRunInput =
    { stream: streamRecord, cancelRequested: false, processExit: exit };
  const reconciliation: CodexReconciliation = runner.reconcileCodexRun(reconcileInput);
  const outcome: CodexReconciledOutcome = reconciliation.outcome;
  expect(reconciliation.reconciliationVersion).toBe(runner.CODEX_RECONCILIATION_VERSION);
  expect(outcomes).toContain(outcome);
  expect(reconciliation.streamDigest).toBe(streamRecord.recordDigest);
});

it("gives a root-only consumer the Codex render type closure, both arms", () => {
  const layers: readonly CodexRenderLayer[] = runner.CODEX_RENDER_LAYERS;
  const renderCodes: readonly CodexRenderErrorCode[] = runner.CODEX_RENDER_ERROR_CODES;
  const encoder = new TextEncoder();
  const file: CodexMirroredSkillFile = {
    path: "SKILL.md", byteLength: 2, contentBase64: "aGk=",
    // The real sha256 of the decoded bytes ("hi"); the renderer re-hashes the
    // content and refuses a file whose digest does not recompute.
    sha256: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
  };
  const skill: CodexMirroredSkillEntry = {
    skillId: "skill-1", version: "1", origin: "local", bundleDigest: CODEX_DIGEST_B, files: [file],
  };
  const snapshot: CodexMirroredSkillRendererInput = {
    rendererInputVersion: runner.CODEX_MIRRORED_SKILL_RENDERER_INPUT_VERSION,
    authority: "NONE",
    advisoryOnly: true,
    skills: [skill],
  };
  const tokenizerPort: CodexTokenizerPort = { countTokens: (bytes) => bytes.byteLength };
  const renderInput: RenderCodexContextInput = {
    agentsContractBytes: encoder.encode("# AGENTS\n"),
    taskContext: { taskRef: "task-1", bodyBytes: encoder.encode("do the thing") },
    skillSnapshot: snapshot,
    contextLimit: { kind: "EXACT_TOKENS", tokens: 200_000 },
    tokenizer: tokenizerPort,
  };

  const rendered: RenderCodexContextResult = runner.renderCodexContext(renderInput);
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error("a valid Codex render input was refused");
  const context: CodexRenderedContext = rendered.rendered;
  const manifest: readonly CodexRenderLayerEntry[] = context.layerManifest;
  expect(context.rendererEnvelopeVersion).toBe(runner.CODEX_RENDERER_ENVELOPE_VERSION);
  expect(context.authority).toBe("NONE");
  expect(manifest.map((entry) => entry.layer)).toEqual([...layers]);
  expect(typeof runner.codexRendererEnvelopeIdentity(context)).toBe("string");

  // REFUSED arm, exact code: an UNKNOWN context limit cannot bound a render, so
  // the renderer refuses instead of guessing a budget.
  const unbounded: RenderCodexContextResult =
    runner.renderCodexContext({ ...renderInput, contextLimit: { kind: "UNKNOWN" } });
  expect(unbounded.ok).toBe(false);
  if (unbounded.ok) throw new Error("an UNKNOWN context limit was accepted as a bound");
  const renderFailure: CodexFailure<CodexRenderErrorCode> = unbounded;
  expect(renderFailure.code).toBe("CODEX_RENDER_CONTEXT_LIMIT_UNKNOWN");
  expect(renderCodes).toContain(renderFailure.code);

  // The advisory skill renderer is published separately: bytes, or a refusal
  // carrying its own code from the same closed vocabulary.
  const bytes = runner.renderCodexAdvisorySkills(snapshot);
  expect(bytes instanceof Uint8Array).toBe(true);

  // WHICH LAYER REFUSED, pinned in both directions, because the two published
  // entry points do NOT share a gate. `rendererInputVersion` is checked by
  // `renderCodexContext` alone; `renderCodexAdvisorySkills` never looks at it
  // and renders a bad-version snapshot happily. Asserting only "it refused"
  // would let either gate answer for the other and stay green.
  const badVersion: CodexMirroredSkillRendererInput =
    { ...snapshot, rendererInputVersion: "x/9" };
  expect(runner.renderCodexAdvisorySkills(badVersion) instanceof Uint8Array).toBe(true);
  const versionRefused: RenderCodexContextResult =
    runner.renderCodexContext({ ...renderInput, skillSnapshot: badVersion });
  expect(versionRefused.ok).toBe(false);
  if (versionRefused.ok) throw new Error("an unsupported renderer input version was accepted");
  expect(versionRefused.code).toBe("CODEX_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED");

  // The skills renderer's OWN gate: a file digest that does not recompute over
  // the decoded content. This one refuses at the skills layer, not the context
  // layer, and carries a different code.
  const badDigest: CodexMirroredSkillRendererInput = {
    ...snapshot,
    skills: [{ ...skill, files: [{ ...file, sha256: CODEX_DIGEST_A }] }],
  };
  const digestRefused = runner.renderCodexAdvisorySkills(badDigest);
  expect(digestRefused instanceof Uint8Array).toBe(false);
  const skillFailure = digestRefused as CodexFailure<CodexRenderErrorCode>;
  expect(skillFailure.code).toBe("CODEX_RENDER_SKILL_SNAPSHOT_INVALID");
  expect(renderCodes).toContain(skillFailure.code);
});

/**
 * Negative control for the Codex seam's WIDTH. Each withheld name is an internal
 * that would let a consumer take a step the seam applies for it: `codexFailure`
 * and `capabilityStatus` mint a refusal and a status rather than reading one;
 * `assessCapabilities` and `capabilitySchemaDigestOf` are what the probe applies
 * itself, so a consumer holding them could assess one report and present another;
 * `isBoundedLabel` and `resolveContextLimit` are internal validators;
 * `UNPROVEN_PROBE_REPORT` is a fixture-shaped constant that must never stand in
 * for a real observation; `frameStream` and `analyzeStream` are the two halves
 * `recordCodexStream` composes and bounds.
 */
it("withholds the Codex internals, fixtures and stream framing halves from the root", () => {
  const withheld = [
    "codexFailure", "capabilityStatus", "assessCapabilities", "capabilitySchemaDigestOf",
    "isBoundedLabel", "resolveContextLimit", "UNPROVEN_PROBE_REPORT", "frameStream",
    "analyzeStream",
  ];
  expect(withheld.length).toBe(9);
  expect(withheld.filter((name) => name in surface)).toEqual([]);
  // Positive control: the identical membership test over two names this seam DOES
  // publish must find both, so the assertion above cannot be passing because `in`
  // is broken or `surface` is the wrong object.
  expect(["CODEX_CAPABILITIES", "recordCodexStream"].filter((name) => name in surface))
    .toEqual(["CODEX_CAPABILITIES", "recordCodexStream"]);
  // The seam's bounds stay internal too: every MAX_* the Codex modules declare.
  const bounds = [
    "MAX_RUNTIME_CLOSURE_ENTRIES", "MAX_RUNTIME_TEXT_CHARS", "MAX_MIRRORED_SKILLS",
    "MAX_MIRRORED_SKILL_FILES", "MAX_FRAMED_LINES", "MAX_INLINE_STREAM_BYTES",
    "MAX_INSPECTABLE_TAIL_BYTES",
  ];
  expect(bounds.length).toBe(7);
  expect(bounds.filter((name) => name in surface)).toEqual([]);
});

/**
 * Family B ownership: ten `Codex*` types that `recovery-inventory-surface.ts`
 * already publishes from the same Codex modules. Re-exporting them from the new
 * Codex seam would be legal ESM — one binding reached two ways — but it would
 * give one published name two owning seams, and that file is not this task's to
 * own. This asserts each is exported by EXACTLY ONE surface module, and names
 * which one, so a later "tidy-up" that republishes them fails here.
 *
 * The surface directory is enumerated rather than hand-listed, so a sixth surface
 * module is covered the day it lands instead of silently escaping the check.
 */
const SURFACE_SOURCES: ReadonlyMap<string, string> = new Map(
  readdirSync(join(SRC_DIR, "surface"))
    .filter((entry) => entry.endsWith("-surface.ts"))
    .map((entry) => [entry, readFileSync(join(SRC_DIR, "surface", entry), "utf8")]),
);

/**
 * Comments must be stripped before matching. This very task's `codex-surface.ts`
 * lists all ten Family B names in its doc comment explaining why it does NOT
 * republish them — matched raw, that prose would read as a second owner and turn
 * the assertion below into a false failure. The reverse mistake is worse: a
 * stripper that removes too much would find no owners at all and pass silently,
 * which is why both directions are controlled below.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function owningSurfaces(name: string): readonly string[] {
  const word = new RegExp(`\\b${name}\\b`);
  return [...SURFACE_SOURCES]
    .filter(([, source]) => word.test(withoutComments(source)))
    .map(([file]) => file)
    .sort();
}

it("leaves the ten Family B Codex types owned by exactly one surface module", () => {
  // Guard the case list itself: an empty enumeration would pass every assertion
  // below while measuring nothing.
  expect(SURFACE_SOURCES.size).toBe(7);
  expect([...SURFACE_SOURCES.keys()].sort()).toEqual([
    "claude-discovery-surface.ts", "claude-surface.ts", "codex-surface.ts",
    "evidence-surface.ts", "provider-record-surface.ts", "recovery-inventory-surface.ts",
    "recovery-surface.ts",
  ]);

  // Positive control for the stripper, both directions. `CodexCancelObservation`
  // appears in codex-surface.ts's prose and nowhere in its exports, so the raw
  // source must contain it and the stripped source must not; `probeCodexRuntime`
  // is genuinely exported there and must survive stripping.
  const codexSource = SURFACE_SOURCES.get("codex-surface.ts") ?? "";
  expect(codexSource).toContain("CodexCancelObservation");
  expect(withoutComments(codexSource)).not.toContain("CodexCancelObservation");
  expect(withoutComments(codexSource)).toContain("probeCodexRuntime");

  const familyB = [
    "CodexCancelObservation", "CodexContextLimit", "CodexCwdObservation", "CodexProbePort",
    "CodexProbeReport", "CodexProcessTreeObservation", "CodexRunEnumerationObservation",
    "CodexStructuredSample", "CodexTokenizerObservation", "ProbeCodexRuntimeInput",
  ];
  expect(familyB.length).toBe(10);
  expect(familyB.map((name) => owningSurfaces(name).join(","))).toEqual(
    familyB.map(() => "recovery-inventory-surface.ts"),
  );

  // Family A is the opposite case: Codex redeclares these, claude-surface roots
  // the Claude copy, and the Codex seam publishes its own under an ALIAS. The
  // unaliased spellings must therefore never appear in codex-surface.ts exports.
  const familyAUnaliased = [
    "OBSERVATION_TRUTH_CLASSES", "RUNTIME_CLOSURE_KINDS", "RUNTIME_PINNING_METHODS",
    "ObservationClock", "PlatformIdentity", "ProviderRuntimeObservation",
  ];
  expect(familyAUnaliased.length).toBe(6);
  expect(familyAUnaliased.filter((name) => name in surface))
    .toEqual(["OBSERVATION_TRUTH_CLASSES", "RUNTIME_CLOSURE_KINDS", "RUNTIME_PINNING_METHODS"]);
  expect(familyAUnaliased.map((name) => owningSurfaces(name))).toEqual(
    familyAUnaliased.map(() => ["claude-surface.ts", "codex-surface.ts"]),
  );
});

/**
 * The provider-telemetry seam, exercised THROUGH THE PACKAGE ROOT. Every name
 * below is either read off `runner` or annotated with a type imported from
 * `@moe/runner`, so a type dropped by an ambiguous star export fails to compile
 * here — the namespace-count test above cannot see a type-only export at all.
 */
const TELEMETRY_RUN_REF: ProviderRunRef = {
  provider: "claude", runRef: "run:surface:1", effectIntentId: "intent:1",
  attemptRef: "attempt:1", epoch: 2,
};

function telemetryEvidence(text: string): ParseClaudeResultTelemetryInput["stdout"] {
  const bytes = Buffer.from(text, "utf8");
  return {
    capturedBase64: bytes.toString("base64"), tailBase64: bytes.toString("base64"),
    byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    truncated: false, complete: true,
  };
}

it("parses a Claude structured result through the root and names its type closure", () => {
  const input: ParseClaudeResultTelemetryInput = {
    providerRunRef: TELEMETRY_RUN_REF,
    stdout: telemetryEvidence(
      `${JSON.stringify({ schemaVersion: "claude-stream-json/1", seq: 1, type: "system",
        subtype: "init", model: "claude-opus-5-20260514" })}\n` +
      `${JSON.stringify({ schemaVersion: "claude-stream-json/1", seq: 2, type: "result",
        subtype: "success", num_turns: 4,
        usage: { input_tokens: 9, output_tokens: 3, cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0 } })}\n`,
    ),
  };
  const verdict: ClaudeResultTelemetryVerdict = runner.parseClaudeResultTelemetry(input);
  if (!verdict.ok) throw new Error(`root parse refused: ${verdict.code}/${verdict.layer}`);
  const telemetry: ClaudeResultTelemetry = verdict.telemetry;
  const model: ClaudeObservedModel = telemetry.observedModel;
  const tokens: ClaudeTokenObservations = telemetry.tokens;
  const steps: ClaudeStepObservations = telemetry.steps;
  const coverage: ProviderCountCoverage = tokens.coverage;
  const terminal: ProviderTerminalOutcome = telemetry.terminal;
  const infrastructure: ProviderInfrastructureOutcome = telemetry.infrastructure;
  const sequence: ProviderQuantity = telemetry.sequence;
  const modelId: ProviderText = model.modelId;

  expect(telemetry.parserVersion).toBe(runner.CLAUDE_RESULT_TELEMETRY_VERSION);
  expect(runner.PROVIDER_COUNT_COVERAGE_CLASSES).toContain(coverage);
  expect(runner.PROVIDER_TERMINAL_OUTCOMES).toContain(terminal);
  expect(runner.PROVIDER_INFRASTRUCTURE_OUTCOMES).toContain(infrastructure);
  expect([coverage, terminal, infrastructure]).toEqual(["COMPLETE", "COMPLETED", "NONE"]);
  expect(sequence).toEqual({ known: true, value: 2 });
  expect(modelId).toEqual({ known: true, value: "claude-opus-5-20260514" });
  expect(steps.turns).toEqual({ known: true, value: 4 });
  expect(model.snapshotKind).toBe("DATED_SNAPSHOT");
  expect(Object.keys(runner.CLAUDE_TOKEN_FIELDS).length).toBe(4);
  expect(runner.CLAUDE_STEP_FIELD).toBe("num_turns");
  expect(Object.keys(runner.CLAUDE_TELEMETRY_RECORDS).sort())
    .toEqual(["initSubtype", "initType", "result"]);
  expect(runner.CLAUDE_TELEMETRY_ANOMALY_REFUSALS.length).toBe(8);
  expect(Object.keys(runner.CLAUDE_RESULT_SUBTYPES).length).toBe(4);
});

it("launches with telemetry through the root and names the handoff type closure", async () => {
  // `request: null` is refused by the launcher itself, so this reaches the real
  // production path without any injected port — and it lands on the arm whose
  // facts must be UNKNOWN rather than zero-filled.
  const input: ClaudeTelemetryLaunchInput =
    { providerRunRef: TELEMETRY_RUN_REF, request: null };
  const result: ClaudeTelemetryLaunchResult = await runner.launchClaudeWithTelemetry(input);
  if (!result.ok) throw new Error(`root telemetry launch refused: ${result.code}/${result.layer}`);
  const handoff: ClaudeTelemetryHandoff = result.handoff;
  const launch: ClaudeTelemetryLaunchFacts = handoff.launch;
  const declared: ClaudeDeclaredSelection = handoff.declared;
  const concurrency: ClaudeTelemetryConcurrency = handoff.concurrency;
  const refusal: ProviderTelemetryRefusal | null = handoff.telemetryRefusal;
  const blind: ProviderFactUnknown | ProviderQuantity = handoff.tokens.inputTokens;

  expect(handoff.handoffVersion).toBe(runner.CLAUDE_TELEMETRY_HANDOFF_VERSION);
  expect(handoff.providerRunRef).toEqual(TELEMETRY_RUN_REF);
  expect(launch.kind).toBe("REFUSED");
  expect(launch.observationDigest).toBeNull();
  expect(declared.known).toBe(false);
  const concurrencyFact: ProviderConcurrencyFact = concurrency.fact;
  expect(concurrencyFact).toBe("NO_CONCURRENCY_FACTS");
  expect(runner.PROVIDER_CONCURRENCY_FACTS).toContain(concurrencyFact);
  expect(blind).toEqual(
    { known: false, code: "TELEMETRY_LAUNCH_REFUSED", layer: "TELEMETRY_LAUNCH" },
  );
  const code: ProviderTelemetryCode = refusal?.code ?? "TELEMETRY_RESULT_ABSENT";
  const layer: ProviderTelemetryLayer = refusal?.layer ?? "TELEMETRY_RESULT";
  expect([code, layer]).toEqual(["TELEMETRY_LAUNCH_REFUSED", "TELEMETRY_LAUNCH"]);
  expect(runner.PROVIDER_TELEMETRY_CODES).toContain(code);
  expect(runner.PROVIDER_TELEMETRY_LAYERS).toContain(layer);
  expect(runner.PROVIDER_TELEMETRY_CONTRACT_VERSION).toBe("moe-provider-telemetry/1");
});

/**
 * Negative control for the telemetry seam's WIDTH. Every withheld name MINTS a
 * fact — a known quantity, an UNKNOWN carrying a reason code, a coverage class,
 * a refusal record, or the message table behind one. A consumer able to call any
 * of them could hand a downstream normalizer a "provider-observed" measurement
 * no provider ever emitted, which is the exact invention this seam exists to
 * make impossible.
 */
it("withholds every fact-minting telemetry helper from the root", () => {
  const withheld = [
    "knownCount", "readCount", "readText", "countCoverage", "unknownFact",
    "telemetryRefusal", "snapshotRunRef", "PROVIDER_TELEMETRY_MESSAGES",
    // The usage seam's own two minters: a fabricated REFUSAL is as dangerous as
    // a fabricated measurement, because a consumer able to make one could report
    // "normalization refused" over a run this package normalized perfectly well.
    "providerUsageRefusal", "PROVIDER_USAGE_MESSAGES",
  ];
  expect(withheld.length).toBe(10);
  expect(withheld.filter((name) => name in surface)).toEqual([]);
  // Positive control: the IDENTICAL membership check over names this seam does
  // publish, so the assertion above cannot be passing because `in` is broken.
  const published = [
    "launchClaudeWithTelemetry", "parseClaudeResultTelemetry",
    "PROVIDER_TELEMETRY_CODES", "PROVIDER_TERMINAL_OUTCOMES",
    "buildProviderRunRecord", "normalizeProviderUsage", "PROVIDER_USAGE_METERS",
  ];
  expect(published.length).toBe(7);
  expect(published.filter((name) => name in surface)).toEqual(published);
});

/**
 * The provider-RUN RECORD seam, composed THROUGH THE PACKAGE ROOT: the record is
 * built from a handoff the root's own launcher produced, so this proves the
 * consumer edge the benchmark will use rather than a relative import that proves
 * nothing. `request: null` is refused by the launcher itself, which lands on the
 * arm whose facts must be UNKNOWN carrying an exact code and layer.
 */
it("builds a provider-run record through the root and names its type closure", async () => {
  const launched: ClaudeTelemetryLaunchResult = await runner.launchClaudeWithTelemetry(
    { providerRunRef: TELEMETRY_RUN_REF, request: null });
  if (!launched.ok) throw new Error(`root telemetry launch refused: ${launched.code}`);
  const record: ProviderRunRecord = runner.buildProviderRunRecord(launched.handoff);
  const identity: ProviderRunIdentity = record.identity;
  const model: ProviderModelSelection = record.model;
  const observed: ProviderObservedModel = record.observedModel;
  const decision: ProviderDecisionDigests = record.decisionDigests;
  const runtimeEvidence: ProviderRuntimeEvidence = record.runtimeEvidence;
  const tokens: ProviderTokenCounts = record.tokens;
  const steps: ProviderStepCounts = record.steps;
  const concurrency: ProviderRunConcurrency = record.concurrency;
  const snapshotKind: ProviderModelSnapshotKind = model.snapshotKind;

  expect(record.recordVersion).toBe(runner.PROVIDER_RUN_RECORD_VERSION);
  expect(record.provider).toBe("claude");
  expect(identity.providerRunRef).toEqual(TELEMETRY_RUN_REF);
  expect(runner.PROVIDER_TERMINAL_OUTCOMES).toContain(record.terminal);
  expect(runner.PROVIDER_INFRASTRUCTURE_OUTCOMES).toContain(record.infrastructure);
  expect(runner.PROVIDER_CONCURRENCY_FACTS).toContain(concurrency.fact);
  expect([snapshotKind, observed.snapshotKind]).toEqual(["UNKNOWN", "UNKNOWN"]);
  // Every unmeasured fact carries a reason, and WHICH layer answered depends on
  // the family: launch facts inherit the launcher's refusal, while the declared
  // digests inherit the selection reader's — the two are not interchangeable.
  const blind = { known: false, code: "TELEMETRY_LAUNCH_REFUSED", layer: "TELEMETRY_LAUNCH" };
  const undeclared = { known: false, code: "TELEMETRY_DECLARED_SELECTION_UNREADABLE",
    layer: "TELEMETRY_INPUT" };
  expect([identity.effectDigest, runtimeEvidence.observationDigest, tokens.inputTokens,
    steps.count]).toEqual([blind, blind, blind, blind]);
  expect([decision.policyDigest, model.selectedModelId, runtimeEvidence.profileRevisionId])
    .toEqual([undeclared, undeclared, undeclared]);
});

it("normalizes provider usage through the root and refuses an unobserved interval", async () => {
  const launched: ClaudeTelemetryLaunchResult = await runner.launchClaudeWithTelemetry(
    { providerRunRef: TELEMETRY_RUN_REF, request: null });
  if (!launched.ok) throw new Error(`root telemetry launch refused: ${launched.code}`);
  const context: ProviderUsageContext = { priors: [] };
  const usage: ProviderUsageResult = runner.normalizeProviderUsage(launched.handoff, context);
  if (usage.ok) throw new Error("an unlaunched run was measured through the root");
  const refusal: ProviderUsageRefusal = usage;
  const layer: ProviderUsageLayer = refusal.layer;
  const code: ProviderUsageCode = refusal.code;

  expect(runner.PROVIDER_USAGE_LAYERS).toContain(layer);
  expect(runner.PROVIDER_USAGE_CODES).toContain(code);
  expect([layer, code]).toEqual(["USAGE_INPUT", "PROVIDER_USAGE_INTERVAL_UNOBSERVED"]);
  expect(runner.PROVIDER_USAGE_CONTRACT_VERSION).toBe("moe-provider-usage/1");
  expect(runner.PROVIDER_USAGE_SOURCE_PARSER_VERSION).toBe(1);
  // The normalized arm's own closure, named in a compiled position so a type
  // dropped from the root fails to compile rather than silently vanishing.
  const normalizedNames: readonly string[] = [
    "measurements", "coverage", "source", "costBasis",
  ] satisfies readonly (keyof ProviderUsageNormalized & string)[];
  expect(normalizedNames.length).toBe(4);
  // `spendMicros` is typed `null`, not `number | null`: the cost basis has no
  // arm to put a spend figure in, and this line stops compiling if that widens.
  const spend: ProviderUsageCostBasis["spendMicros"] = null;
  const meter: ProviderUsageMeasurement["measurement"]["meter"] =
    runner.PROVIDER_USAGE_METERS.inputTokens;
  expect([spend, meter]).toEqual([null, "provider.input_tokens"]);
  const basisClasses: readonly ProviderCostBasis[] = [...runner.PROVIDER_COST_BASES];
  const reasons: readonly ProviderUnpricedReason[] = [...runner.PROVIDER_UNPRICED_REASONS];
  expect([basisClasses.length, reasons.length]).toEqual([2, 3]);
});

/* ---- provider-run settlement, composed THROUGH THE PACKAGE ROOT ---- */

/**
 * The exact admitted observation, hand-written from the contract rather than
 * read off the published key list, so a key that silently changed name would
 * fail here instead of quietly redefining the seam.
 */
function runObservation(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    sourceVersion: runner.PROVIDER_TELEMETRY_CONTRACT_VERSION,
    sourceDigest: DIGEST,
    runRef: {
      provider: "claude", runRef: "run:1", effectIntentId: "intent:1",
      attemptRef: "attempt:1", epoch: 3,
    },
    terminal: "COMPLETED", infrastructure: "NONE", upstreamRefusal: null,
    completedAt: { known: true, value: AT },
    ...overrides,
  };
}

it("settles an effect from a provider observation through the root, deriving the target", () => {
  const observation: ProviderRunObservation =
    runObservation() as unknown as ProviderRunObservation;
  const outcome: ProviderSettlementOutcome = runner.settleEffectFromProviderObservation(
    intentIn("ACTIVE"), observation,
  );
  if (outcome.kind !== "TRANSITIONED") throw new Error(`expected TRANSITIONED, got ${outcome.kind}`);
  const result: EffectResult | null = outcome.result;
  expect([outcome.intent.state, result?.terminalState, result?.outcomeClass]).toEqual(
    ["SUCCEEDED", "SUCCEEDED", "PROVEN_RESULT"],
  );
  // The published table and key set, named in compiled positions.
  const rows: readonly ProviderSettlementRow[] = runner.PROVIDER_SETTLEMENT_ADMITTED_ROWS;
  const dispositions: readonly ProviderSettlementDisposition[] =
    rows.map((row) => row.disposition);
  expect([rows.length, runner.PROVIDER_RUN_OBSERVATION_KEYS.length]).toEqual([4, 7]);
  expect(dispositions).toEqual(["SUCCEEDED", "FAILED", "DRAIN", "CANCELLED"]);
  expect(runner.PROVIDER_EFFECT_SETTLEMENT_VERSION).toBe("moe-provider-effect-settlement/1");
});

it("refuses a foreign run reference through the root with its own code and layer", () => {
  const outcome: ProviderSettlementOutcome = runner.settleEffectFromProviderObservation(
    intentIn("ACTIVE"),
    runObservation({
      runRef: {
        provider: "claude", runRef: "run:1", effectIntentId: "intent:999",
        attemptRef: "attempt:1", epoch: 3,
      },
    }),
  );
  if (outcome.kind !== "PROVIDER_SETTLEMENT_REFUSED") {
    throw new Error(`expected a settlement refusal, got ${outcome.kind}`);
  }
  const failure: ProviderSettlementRefusal = outcome.failure;
  const code: ProviderSettlementCode = failure.code;
  expect([code, failure.layer, failure.ok]).toEqual(
    ["PROVIDER_SETTLEMENT_EFFECT_BINDING_MISMATCH", runner.PROVIDER_EFFECT_SETTLEMENT_LAYER, false],
  );
  expect(runner.PROVIDER_SETTLEMENT_CODES).toContain(code);
});

/**
 * Negative control for the settlement seam's WIDTH, on the same rule as the
 * telemetry one above: a consumer able to call the ADMISSION could hand this
 * package a hand-built "admitted observation", and the message table is what a
 * fabricated refusal would need to look real. Both stay internal.
 */
it("withholds the settlement seam's admission reader and message table from the root", () => {
  const withheld = [
    "admitProviderRunObservation", "PROVIDER_SETTLEMENT_MESSAGES",
    "PROVIDER_SETTLEMENT_OUTCOME_CLASSES",
  ];
  expect(withheld.length).toBe(3);
  expect(withheld.filter((name) => name in surface)).toEqual([]);
  // Positive control: the identical membership check over names it does publish.
  const published = [
    "settleEffectFromProviderObservation", "PROVIDER_SETTLEMENT_CODES",
    "PROVIDER_SETTLEMENT_ADMITTED_ROWS", "PROVIDER_RUN_OBSERVATION_KEYS",
  ];
  expect(published.filter((name) => name in surface)).toEqual(published);
});

/**
 * Negative control for the WIDTH of the workspace allocator seam, on the same
 * rule as the settlement one above: a consumer able to construct a refusal, or
 * to run the state fence over a hand-built inspection, could hand this package
 * a "verified" tree it never measured. The derivation's internal half stays
 * internal too — `deriveWorktreeTarget` is the published form.
 */
it("withholds the worktree allocator's failure constructor and state fence", () => {
  const withheld = [
    "worktreeFailure", "worktreeStateRejection", "deriveWorktreeLeaf", "isContainedByPath",
  ];
  expect(withheld.length).toBe(4);
  expect(withheld.filter((name) => name in surface)).toEqual([]);
  // Positive control: the identical membership check over names it does publish.
  const published = [
    "createNodeWorktreeMaterializer", "deriveWorktreeTarget", "isWorktreeFailure",
    "RUNNER_WORKTREE_LAYERS", "WORKTREE_RELEASE_INTENTS", "WORKTREE_RELEASE_DISPOSITIONS",
  ];
  expect(published.filter((name) => name in surface)).toEqual(published);
});

/**
 * The allocator's seam, named in compiled positions: a consumer that can call
 * `createNodeWorktreeMaterializer` but cannot spell the request it must build,
 * the assignment it gets back, or the refusal it must branch on cannot compose
 * this seam at all.
 */
it("composes the worktree allocator seam through the root in compiled positions", () => {
  const materializer: WorktreeMaterializer = runner.createNodeWorktreeMaterializer(process.env);
  const request: WorktreeMaterializationRequest = {
    sourceRepositoryRoot: "relative/not/absolute",
    worktreeParent: "/srv/parent",
    projectId: "proj-1",
    attemptId: "attempt:1",
    baseIdentity: "0".repeat(40),
  };
  const result: WorktreeMaterializationResult = materializer.materialize(request);
  if (result.ok) throw new Error("expected a refusal for a relative source root");
  const failure: WorktreeFailure = result;
  const layer: RunnerWorktreeLayer = failure.layer;
  expect([failure.code, layer, failure.ok]).toEqual([
    "RUNNER_WORKSPACE_WORKTREE_SOURCE_INVALID", "WORKTREE_CONTRACT", false,
  ]);
  expect(runner.RUNNER_WORKSPACE_ERROR_CODES).toContain(failure.code);
  expect(runner.RUNNER_WORKTREE_LAYERS).toContain(layer);
  // The release vocabulary a caller has to spell to end an attempt cleanly.
  const intent: WorktreeReleaseIntent = "ATTEMPT_TERMINAL";
  const dispositions: readonly WorktreeReleaseDisposition[] = runner.WORKTREE_RELEASE_DISPOSITIONS;
  expect([runner.WORKTREE_RELEASE_INTENTS.includes(intent), dispositions.length]).toEqual([true, 2]);
});

/**
 * Negative control for the WIDTH of the Foundation capture seam, on the same
 * rule as the settlement one above. `sealPrelaunchProof` MINTS the proof that
 * an assigned tree was measured and found equal to its sealed input, and
 * `captureFailure` mints a refusal — a consumer able to call either could hand
 * this package a "the tree was proven" it never measured, or a reason no rule
 * produced. The pure decision rules and the raw enumerator are internal for a
 * different reason: the two entry points apply them in a fixed order, and a
 * consumer that could run one alone would get a verdict with no bracket, no
 * budget and no equality proof behind it.
 */
it("withholds the capture seam's proof minter, failure constructor and raw rules", () => {
  const withheld = [
    "sealPrelaunchProof", "captureFailure", "scanDeclaredTrees", "scannedTreeRejection",
    "outOfScopeRejection", "gitStateRejection", "deriveCapture", "declarationRejection",
    "limitsRejection", "isInside",
  ];
  expect(withheld.length).toBe(10);
  expect(withheld.filter((name) => name in surface)).toEqual([]);
  // Positive control: the identical membership check over names it does publish.
  const published = [
    "proveFoundationPrelaunchTree", "captureFoundationWorkspaceDelta",
    "createNodeFoundationCaptureFs", "FOUNDATION_CAPTURE_CODES",
    "FOUNDATION_CAPTURE_LAYER_NAMES", "prelaunchProofSealMatches",
  ];
  expect(published.filter((name) => name in surface)).toEqual(published);
});

/**
 * The capture seam's TYPE closure, named through the same root. A daemon that
 * can see the entry points but cannot spell their input or output shapes cannot
 * compose them, so an under-published closure has to fail here rather than in
 * the consumer's own repository.
 */
it("roots the capture seam's input and output types through the package root", () => {
  const limits: FoundationCaptureLimits = runner.DEFAULT_FOUNDATION_CAPTURE_LIMITS;
  const code: FoundationCaptureCode = "RUNNER_FOUNDATION_CAPTURE_OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN";
  const layer: FoundationCaptureLayer = "RUNNER_WORKSPACE_CAPTURE";
  const kind: FoundationCaptureDirent = { name: "alpha.txt", kind: "REGULAR" };
  const stat: FoundationCaptureStat = { kind: "REGULAR", byteLength: 0, identity: "0:0" };
  const proveInput: (value: FoundationPrelaunchInput) => FoundationPrelaunchResult =
    runner.proveFoundationPrelaunchTree;
  const captureInput: (value: FoundationCaptureInput) => FoundationCaptureResult =
    runner.captureFoundationWorkspaceDelta;
  const fs: () => FoundationCaptureFsPort = runner.createNodeFoundationCaptureFs;
  const narrow: (value: object) => value is FoundationCaptureFailure = runner.isFoundationCaptureFailure;
  expect([limits.maxEntries > 0, runner.FOUNDATION_CAPTURE_CODES.includes(code)]).toEqual([true, true]);
  expect(runner.FOUNDATION_CAPTURE_LAYER_NAMES).toContain(layer);
  expect([kind.kind, stat.identity]).toEqual(["REGULAR", "0:0"]);
  expect([proveInput, captureInput, fs, narrow].every((value) => typeof value === "function")).toBe(true);
});
