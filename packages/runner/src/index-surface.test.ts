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
import { dirname } from "node:path";
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
/** The recovery, evidence and Claude observation seams, through the same root. */
import type {
  ArtifactFsPort, ArtifactRef, ArtifactStore, BuildEvidenceReceiptInput, BuildEvidenceReceiptResult,
  BuildObservationInput, BuildObservationResult, BuildVerificationRecipeResult, CandidateTreeEntry,
  CandidateTreePort, ClaudeProcessExit, ClaudeRawRetention, ClaudeReconciledOutcome,
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
/** The platform boundary seam, through the same root. */
import type {
  LinuxBoundaryFacts, LinuxClassificationContext, LinuxPathFact, ObserveLinuxPlatformInput,
  PlatformBoundary, PlatformBoundaryVerdict, PlatformFactEnvelope, PlatformFailure,
  PlatformHostIdentity, PlatformLayer, PlatformObservation, PlatformTruthClass,
} from "@moe/runner";
/** The Git ref and artifact object enumeration seam, through the same root. */
import type {
  ArtifactDirectoryEntry, ArtifactDirectoryEntryKind, ArtifactEnumerationFailure,
  ArtifactEnumerationLayer, ArtifactEnumerationOk, ArtifactEnumerationResult,
  ArtifactObjectObservation, ArtifactStagingObservation, GitRefListing, GitRefObservation,
  ScopeObserverLayer,
} from "@moe/runner";

it("resolves the self-referencing package root specifier @moe/runner", () => {
  expect(typeof runner.observeScope).toBe("function");
});

type ExportKind = "array" | "function" | "number" | "regexp" | "string";
/**
 * Hand-transcribed: 29 runner scope/artifact/workspace values, 40 supervisor values, 50
 * recovery / evidence / Claude observation values, the 8 values the verifier
 * process wrapper publishes, and the 11 values the platform boundary seam
 * publishes. Read off the module sources, never off the namespace under test —
 * a list derived from what it checks asserts only that the namespace equals
 * itself.
 */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["ADMITTED_EFFECT_TRANSITIONS", "array"], ["ARTIFACT_ADDRESS_PATTERN", "regexp"],
  ["ATTEMPT_SLICE_STATES", "array"], ["EFFECT_CALLER_CONTRACT", "array"],
  ["EFFECT_COMMANDS", "array"], ["EFFECT_STATES", "array"],
  ["GRANT_STATES", "array"], ["MAX_ARTIFACT_ENUMERATION_ENTRIES", "number"],
  ["MAX_SCOPE_OBSERVATION_BYTES", "number"], ["MAX_SCOPE_PATHS", "number"],
  ["MAX_SUPERVISOR_COUNT", "number"], ["MAX_SUPERVISOR_TEXT_CHARS", "number"],
  ["MAX_WORKSPACE_ENTRIES", "number"],
  ["MIRRORED_LEASE_KINDS", "array"], ["MIRRORED_LEASE_STATES", "array"],
  ["RUNNER_ARTIFACT_ERROR_CODES", "array"], ["RUNNER_SCOPE_ERROR_CODES", "array"],
  ["RUNNER_WORKSPACE_ERROR_CODES", "array"], ["SCOPE_ATTRIBUTION_CLASSES", "array"],
  ["SCOPE_OBSERVATION_VERSION", "string"], ["SUPERVISOR_ACTIVATION_VERSION", "string"],
  ["SUPERVISOR_EFFECT_PROTOCOL_VERSION", "string"], ["SUPERVISOR_ERROR_CODES", "array"],
  ["SUPERVISOR_LAYERS", "array"], ["SUPERVISOR_RESULT_VERSION", "string"],
  ["ScopeObserverError", "function"], ["TERMINAL_EFFECT_STATES", "array"],
  ["WORKSPACE_INPUT_MANIFEST_VERSION", "string"], ["WORKSPACE_RESULT_MANIFEST_VERSION", "string"],
  ["activateEffect", "function"], ["activationDigestInput", "function"],
  ["applyEffectCommand", "function"], ["applyEffectTombstone", "function"],
  ["buildInputManifest", "function"], ["buildResultManifest", "function"],
  ["canonicalPathRejection", "function"], ["consumeActivationGrant", "function"],
  ["createArtifactStore", "function"], ["createNodeArtifactFs", "function"],
  ["createNodeGitObserver", "function"], ["createNodeScopePaths", "function"],
  ["deriveGrantId", "function"], ["enumerateArtifactsAt", "function"],
  ["fenceMirroredLease", "function"],
  ["grantRefusal", "function"], ["hermeticGitEnvironment", "function"],
  ["initialGrantBinding", "function"], ["inputManifestDigestInput", "function"],
  ["isTerminalEffectState", "function"], ["observeScope", "function"],
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
  // providers/claude/: reconciliation, capability profile, runtime observation, stream vocabulary.
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
  // platform/: the OS-neutral boundary vocabulary and the Linux classifier.
  ["LINUX_SUPPORTED_ARCHITECTURES", "array"], ["PLATFORM_BOUNDARIES", "array"],
  ["PLATFORM_ERROR_CODES", "array"], ["PLATFORM_LAYERS", "array"],
  ["PLATFORM_LINUX_LAYER", "string"], ["PLATFORM_OBSERVATION_VERSION", "string"],
  ["PLATFORM_TRUTH_CLASSES", "array"], ["classifyLinuxBoundary", "function"],
  ["isPlatformFailure", "function"], ["observeLinuxPlatform", "function"],
  ["platformFailure", "function"],
  // recovery-inventory/: the coverage vocabulary plus the port-composing aggregate.
  ["MAX_RECOVERY_INVENTORY_ITEMS", "number"], ["RECOVERY_INVENTORY_CLASSES", "array"],
  ["RECOVERY_INVENTORY_ERROR_CODES", "array"], ["RECOVERY_INVENTORY_LAYERS", "array"],
  ["RECOVERY_INVENTORY_REF_KINDS", "array"], ["RECOVERY_INVENTORY_TRUTH_CLASSES", "array"],
  ["RECOVERY_INVENTORY_UNKNOWN_REASONS", "array"], ["RECOVERY_INVENTORY_VERSION", "string"],
  ["collectRecoveryInventory", "function"], ["createRecoveryInventoryRegistry", "function"],
  ["isRecoveryInventoryFailure", "function"], ["recoveryInventoryFailure", "function"],
];
const surface: Readonly<Record<string, unknown>> = runner;

it("generates one expectation per published root export", () => {
  expect(EXPECTED_EXPORTS.length).toBe(150);
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

function commitFixture(): ActivationCommit {
  const activated: ActivationOutcome = runner.activateEffect(activationRequest());
  if (activated.kind !== "ACTIVATED") throw new Error(codeOf(refusalOf(activated)));
  return activated.commit;
}

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
