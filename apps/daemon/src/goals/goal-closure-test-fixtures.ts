import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as daemon from "@moe/daemon";
import { PROJECT_CONFIGURATION_LIMIT_KEYS, RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import {
  createProjectConfigurationManifest, encodeProjectConfigurationManifest,
} from "@moe/core";
import { DEFAULT_CONTEXT_BYTE_BUDGET, selectContext } from "@moe/context";
import {
  CLAUDE_LAUNCHER_VERSION, CLAUDE_RESULT_TELEMETRY_VERSION,
  CLAUDE_TELEMETRY_HANDOFF_VERSION, buildInputManifest, buildProviderRuntimeObservation,
} from "@moe/runner";
import type {
  ClaudeBoundLaunchResult, ClaudeLaunchRequest, ClaudeLaunchResult, ClaudeTelemetryHandoff,
  DeclaredInput, ProviderRuntimeObservation,
} from "@moe/runner";
import { RECOVERY_BINDING_CODEC_VERSION } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { ACTIVATION_LEDGER_EVENT_TYPE } from "../activation/activation-ledger-contracts.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  ACTIVATION_WORLD_NODE_KEY, seedActivationWorldWithGatePolicy,
} from "../activation/activation-world-fixtures.js";
import {
  CLAUDE_PROFILE, GOAL_ID, OBSERVATION, PROJECT_ID, PROVIDER_OBSERVATION, SEALED_SUBMISSION_HASH,
  acceptancePayload, approvalPayload, approvalRecord, bootstrapSequence, closeStores, driveThrough,
  envelope, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readLatestProjectConfiguration } from "../configuration/project-configuration-selection.js";
import { selectProjectConfiguration } from "../configuration/project-configuration-selection.js";
import { createFoundationVerificationService } from "../evidence/foundation-verification-service.js";
import { readStoredReceipt } from "../evidence/foundation-verification-store.js";
import {
  candidateTreeEntries, materializeCandidateTree,
} from "../evidence/foundation-verification-tree-fixtures.js";
import type { CandidateTree } from "../evidence/foundation-verification-tree-fixtures.js";
import { createVerificationCatalogReader } from "../evidence/verification-catalog-reader.js";
import { VERIFICATION_CATALOG_VERSION } from "../evidence/verification-catalog-contracts.js";
import { credentialSha256Of } from "../identity/session-authenticator.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { runSessionCommand } from "../identity/session-services.js";
import { readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import { resolveCurrentProviderProfile } from "../provider-profile/provider-profile-resolver.js";
import {
  RESTORE_CONTROLLER_SCHEMA_VERSION, preparedRestoreIdentity,
} from "../recovery/restore-controller-contract.js";
import { recordLandingReceipt } from "../repository/landing-ledger.js";
import { readReviewLedger } from "../review/review-ledger.js";
import { seedVerifierReceipt } from "../review/review-test-fixtures.js";
import { createFoundationAttemptServiceWithProviderRun } from "../work/foundation-attempt-service.js";
import { readFoundationAttemptRecord } from "../work/foundation-attempt-store.js";
import type { FoundationAttemptProviderRun } from "../work/foundation-attempt-provider-port.js";
import { createFoundationCaptureLifecycle } from "../work/foundation-capture-lifecycle.js";
import { createFoundationCaptureProducer } from "../work/foundation-capture-producer.js";
import { createFoundationContextSealPort } from "../work/foundation-context-record.js";
import type { FoundationContextProvenance } from "../work/foundation-context-selection.js";
import { FOUNDATION_CONTEXT_MATRIX_VERSION } from "../work/foundation-context-selection.js";
import { deriveFoundationDispatchFacts } from "../work/foundation-dispatch-derivation.js";
import { createFoundationLaunchCompletionAuthority } from
  "../work/foundation-launch-completion-wiring.js";
import {
  decodeFoundationRepositoryScopeCatalog, resolveFoundationRepositoryScope,
} from "../work/foundation-repository-scope-authority.js";
import { FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION } from
  "../work/foundation-repository-scope-contracts.js";

/**
 * Production-backed goal-closure worlds. Approval and review use shipped command handlers;
 * Foundation attempts use the shipped activation/reservation/provider/attempt service with only
 * its physical provider call injected; verification seals a real Git candidate and runs a real
 * child process through the shipped verifier service.
 *
 * Test-tier scaffolding, reached only from `*.test.ts`, so it deliberately has no `.js` bridge —
 * `review-test-fixtures.ts` has none either, and `index-surface.test.ts` keeps both names off the
 * published root.
 */

const encoder = new TextEncoder();
const OPERATOR_CREDENTIAL = "j1-operator-credential";
const OPERATOR_PRINCIPAL_ID = "j1-operator";
const GLOBAL_PAGE_LIMIT = 200;
const PRINCIPAL_ID = "principal-1";
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const DIGEST_A = "1".repeat(64), DIGEST_B = "2".repeat(64), DIGEST_C = "3".repeat(64);
const EXIT_ZERO = Object.freeze([process.execPath, "-e", "process.exit(0)"]);
const GOAL_PROVIDER_PROFILE = Object.freeze({
  ...CLAUDE_PROFILE,
  limits: Object.freeze({
    ...CLAUDE_PROFILE.limits,
    stderrBytes: CLAUDE_PROFILE.limits.stdoutBytes,
    timeoutMs: 600_000,
  }),
  profileRevisionId: CLAUDE_PROFILE.selection.profileRef,
});
const VERIFIER_IDENTITY = Object.freeze({
  capabilitySchemaDigest: DIGEST_B, verifierId: "moe-verifier", verifierVersion: "1.0.0",
});
const scratchRoots: string[] = [];
let seedOrdinal = 0;

export function cleanupGoalClosureFixtures(): void {
  const cleanupErrors: unknown[] = [];
  try {
    closeStores();
  } catch (error) {
    cleanupErrors.push(error);
  }
  storeWorlds = new WeakMap<SqliteEventStore, AttemptWorld>();
  try {
    while (scratchRoots.length > 0) {
      const root = scratchRoots.at(-1);
      if (root !== undefined) {
        rmSync(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
        scratchRoots.pop();
      }
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "goal closure fixture cleanup failed");
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
}

function nextLabel(nodeRef: string): string {
  seedOrdinal += 1;
  return `${nodeRef.replace(/[^0-9a-zA-Z-]/gu, "-")}-${process.pid}-${seedOrdinal}`;
}

function nested(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${key} parent is not a record`);
  }
  const found = (value as Record<string, unknown>)[key];
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    throw new TypeError(`${key} is not a record`);
  }
  return found as Record<string, unknown>;
}

interface AttemptWorld {
  readonly catalog: Record<string, unknown>;
  readonly label: string;
  readonly nodeRef: string;
  readonly pinRoot: string;
  readonly runtime: ProviderRuntimeObservation;
  readonly sessionId: string;
  readonly tree: CandidateTree;
}

let storeWorlds = new WeakMap<SqliteEventStore, AttemptWorld>();

function createAttemptWorld(nodeRef: string, baseWorld?: AttemptWorld): AttemptWorld {
  const label = nextLabel(nodeRef);
  if (baseWorld !== undefined) {
    if (baseWorld.nodeRef !== nodeRef) {
      throw new Error(`attempt world already binds ${baseWorld.nodeRef}, not ${nodeRef}`);
    }
    return Object.freeze({
      ...baseWorld,
      label,
      sessionId: `session-${label}`,
    });
  }
  const tree = materializeCandidateTree(label);
  scratchRoots.push(tree.root);
  const root = mkdtempSync(join(tmpdir(), `moe-goal-closure-${label}-`));
  scratchRoots.push(root);
  const worktreeParent = join(root, "worktrees"), installedRoot = join(root, "installed");
  const pinRoot = join(root, "pins"), executable = join(installedRoot, "claude.exe");
  mkdirSync(worktreeParent, { recursive: true });
  mkdirSync(installedRoot, { recursive: true });
  mkdirSync(pinRoot, { recursive: true });
  const executableBytes = Buffer.from("fixture-runtime", "utf8");
  writeFileSync(executable, executableBytes);
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: CLAUDE_PROFILE.capabilitySchemaDigest,
    clock: { observedAt: () => DECIDED_AT }, pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: "claude/2.0.0", resolvedRuntimeClosure: [{
      kind: "EXECUTABLE", path: executable,
      sha256: createHash("sha256").update(executableBytes).digest("hex"),
    }],
  });
  if (!built.ok) throw new Error(`runtime observation refused: ${built.code}`);
  return Object.freeze({
    catalog: {
      catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
      entries: [{ declaredPaths: ["pkg/src/base.ts"], projectId: PROJECT_ID,
        repositoryRef: OBSERVATION.repositoryRef, scopeRef: OBSERVATION.scopeRef,
        sourceRepositoryRoot: tree.root, worktreeParent }],
    },
    label, nodeRef, pinRoot, runtime: built.observation, sessionId: `session-${label}`, tree,
  });
}

function bootstrapGoalWorld(
  store: SqliteEventStore, nodeRef: string, world: AttemptWorld,
  approvedScope: readonly string[] = [nodeRef],
): void {
  for (const request of bootstrapSequence()) {
    if (request.kind === "approval.decide") break;
    const adjusted = request.kind === "project.bind_repository"
      ? envelope("project.bind_repository", 1, {
        observation: { ...OBSERVATION, baseRevisionHash: world.tree.head },
      })
      : request.kind === "provider.probe"
        ? envelope("provider.probe", 0, {
          observation: {
            ...PROVIDER_OBSERVATION,
            profile: GOAL_PROVIDER_PROFILE,
            runtime: world.runtime,
          },
        })
        : request;
    const outcome = send(store, adjusted);
    if (!outcome.ok) throw new Error(`goal fixture ${request.kind} refused: ${outcome.code}`);
  }
  seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
  const approved = send(store, envelope("approval.decide", 0, approvalPayload({
    record: { ...approvalRecord(SEALED_SUBMISSION_HASH), approvedNodeScope: [...approvedScope] },
  })));
  if (!approved.ok) throw new Error(`goal fixture approval refused: ${approved.code}`);
  seedConfiguration(store, world.label);
}

function configurationLimit(key: typeof PROJECT_CONFIGURATION_LIMIT_KEYS[number]): number {
  if (key === "activeProviderSessions") return GOAL_PROVIDER_PROFILE.concurrencyCeiling;
  if (key === "capturedOutputBytes") return GOAL_PROVIDER_PROFILE.limits.stdoutBytes;
  if (key === "runnerAuthorizedMsPerAttempt") return GOAL_PROVIDER_PROFILE.limits.timeoutMs;
  if (key === "uiTailBytes") return GOAL_PROVIDER_PROFILE.limits.tailBytes;
  return 1_000_000;
}

function seedConfiguration(store: SqliteEventStore, label: string): void {
  const limits = PROJECT_CONFIGURATION_LIMIT_KEYS.map((key) => ({
    key,
    value: configurationLimit(key),
  }));
  const created = createProjectConfigurationManifest(PROJECT_ID, {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" }, limits,
    network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
    orchestrationSource: { objectFormat: "sha256", sourceSha: "4".repeat(64) },
    policy: { acceptanceGate: "MANUAL_HUMAN_APPROVAL", autoApprovalOptInDigest: null,
      evaluatorVersion: "policy-evaluator-v1", expansionGate: "MANUAL_HUMAN_APPROVAL",
      planningGate: "MANUAL_HUMAN_APPROVAL", policyRevisionId: "policy-revision-1", revision: 1 },
    schemaVersions: { commandSchemaVersion: "moe-command-1", errorSchemaVersion: "moe-error-1",
      querySchemaVersion: "moe-query-1" },
    selection: CLAUDE_PROFILE.selection,
  });
  if (!created.ok) throw new Error(`configuration manifest refused: ${created.code}`);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`configuration encode refused: ${encoded.code}`);
  const selected = selectProjectConfiguration(store, {
    commandId: `cmd-config-${label}`, correlationId: `corr-config-${label}`,
    decidedAt: DECIDED_AT, expectedVersion: 0, manifestBytes: encoded.bytes,
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  });
  if (!selected.ok) throw new Error(`configuration selection refused: ${selected.code}`);
}

function openAttemptSession(
  store: SqliteEventStore, sessionId: string, label: string, installBinding: boolean,
): void {
  if (installBinding) {
    const incarnationRef = "71".repeat(32), keyEpochRef = "72".repeat(32);
    const restoreCommandId = `restore-${label}`, generationDigest = "73".repeat(32);
    const restore = {
      backupCursor: "0", generationDigest, incarnationRef, keyEpochRef,
      preparedIdentity: preparedRestoreIdentity({
        generationDigest, incarnationRef, keyEpochRef, restoreCommandId,
      }),
      restoreCommandId, schemaVersion: RESTORE_CONTROLLER_SCHEMA_VERSION,
    };
    const binding = store.installRecoveryBinding({
      bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
      incarnationRef, installedAt: DECIDED_AT, keyEpochRef,
      payload: encoder.encode(JSON.stringify(restore)), slot: "ACTIVE",
    });
    if (!binding.ok) throw new Error(`recovery binding refused: ${binding.code}`);
  }
  const request = {
    commandId: `cmd-open-${label}`, correlationId: `corr-open-${label}`,
    decidedAt: DECIDED_AT, expectedVersion: 0, kind: "session.open",
    payload: { capabilities: ["work.claim"], credentialSha256: credentialSha256Of(`cred-${label}`),
      expiresAt: "2026-09-15T00:00:00.000Z", sessionId },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, schemaVersion: SESSION_SCHEMA_VERSION,
  };
  const opened = runSessionCommand(store, encoder.encode(JSON.stringify(request)));
  if (!opened.ok) throw new Error(`session fixture refused: ${opened.code}@${opened.refusedBy}`);
}

function activationRequest(label: string, sessionId: string, graphEpoch: number): {
  readonly aggregateId: string; readonly bytes: Uint8Array; readonly claim: Record<string, unknown>;
} {
  const aggregate = `agg-${label}`, intentId = `intent-${label}`, idem = `idem-${label}`;
  const lease = { authorityHashRef: DIGEST_A, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
    leaseId: `lease-${label}`, leaseToken: `token-${label}`, monotonicObservation: 500,
    ownerSessionRef: sessionId, serverWallDeadline: 2_000_000_000, state: "ACTIVE", version: 7 };
  const proof = { authorityHashRef: DIGEST_A, epoch: 3, expectedVersion: 7,
    leaseToken: `token-${label}`, ownerSessionRef: sessionId };
  const claim = { claimId: `claim-${label}`, claimedAt: DECIDED_AT, intentId,
    lockIdentity: `lock-${label}`, wrapperIdentity: `wrapper-${label}` };
  const bytes = encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${label}`, correlationId: `corr-${label}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
    payload: { activation: { attempt: { aggregateId: aggregate, attemptId: `attempt-${label}`,
      intentId, state: "LAUNCH_REQUESTED", version: 0 }, claim, dependencyWitnesses: [],
      desiredState: "ACTIVE", leaseProof: proof, lockIdentity: `lock-${label}`,
      observedGraphEpoch: graphEpoch, observedRuntimeDigest: DIGEST_A, tombstone: null,
      wrapperIdentity: `wrapper-${label}` },
    effect: { command: { kind: "claim" }, intent: { aggregateId: aggregate,
      desiredState: "ACTIVE", expectedGraphEpoch: graphEpoch, idempotencyKey: idem,
      inputBinding: DIGEST_A, intentId, leaseBinding: lease, predecessorCursor: "cursor-1",
      protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST_A,
      state: "PENDING", version: 0 } }, lease: { proof, record: lease },
    liveClaims: [{ dimension: "default", slotRef: `held-${label}`, state: "RESERVED" }],
    slot: { dimension: "default", requestId: `req-${label}`, rows: [{ capacityUnits: 1,
      effectIntentRef: `intent-ref-${label}`, epoch: 1, external: false, fenceable: true,
      resourceId: `res-${label}`, state: "ACTIVE" }], slotRef: `slot-${label}` } },
  }));
  return Object.freeze({ aggregateId: deriveActivationAggregateId(aggregate, idem), bytes, claim });
}

function scopeResolver(store: SqliteEventStore, world: AttemptWorld) {
  const decoded = decodeFoundationRepositoryScopeCatalog(world.catalog);
  if (!decoded.ok) throw new Error(`scope catalog refused: ${decoded.code}@${decoded.layer}`);
  return () => resolveFoundationRepositoryScope(store, decoded.catalog, {
    baseRevisionHash: world.tree.head, projectId: PROJECT_ID,
    repositoryRef: OBSERVATION.repositoryRef, scopeRef: OBSERVATION.scopeRef,
  });
}

function prepareContext(
  store: SqliteEventStore, world: AttemptWorld, inputManifest: Record<string, unknown>,
) {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`active graph refused: ${active.code}@${active.layer}`);
  const configuration = readLatestProjectConfiguration(store, { projectId: PROJECT_ID });
  if (!configuration.ok) {
    throw new Error(`configuration refused: ${configuration.code}@${configuration.layer}`);
  }
  const sealedInput = buildInputManifest({
    baseIdentity: String(inputManifest["baseIdentity"]),
    entries: inputManifest["entries"] as never,
  });
  if (!sealedInput.ok) throw new Error(`input seal refused: ${sealedInput.code}`);
  const selected = selectContext({
    byteBudget: DEFAULT_CONTEXT_BYTE_BUDGET, exclusions: [],
    mandatory: [{ content: "verify the goal closure world", id: "mission-1",
      kind: "MANDATORY", section: "mission" }], optional: [],
  });
  if (selected.kind !== "ADMITTED") throw new Error(`context selection refused: ${selected.code}`);
  const provenance: FoundationContextProvenance = {
    attemptRef: `attempt-${world.label}`, configurationDigest: configuration.manifest.settingsDigest,
    contextLimitBytes: DEFAULT_CONTEXT_BYTE_BUDGET,
    graphContentHash: active.graphContentHash, graphEpoch: active.graphEpoch,
    graphRevisionId: active.revisionId, inputManifestSha256: sealedInput.manifest.sha256,
    journalDigest: null, journalHorizon: "0", matrixVersion: FOUNDATION_CONTEXT_MATRIX_VERSION,
    nodeKey: world.nodeRef, projectId: PROJECT_ID, sessionId: world.sessionId,
  };
  return Object.freeze({
    configurationDigest: configuration.manifest.settingsDigest,
    provenance,
    selection: selected.selection,
  });
}

function contextPort(
  store: SqliteEventStore, world: AttemptWorld, inputManifest: Record<string, unknown>,
) {
  const prepared = prepareContext(store, world, inputManifest);
  const capabilities = () => resolveCurrentProviderProfile(store, {
    expectedConfigurationDigest: prepared.configurationDigest, projectId: PROJECT_ID,
  });
  return createFoundationContextSealPort({
    brief: {
      catalog: createVerificationCatalogReader({ catalogSource: () => ({
        catalogVersion: VERIFICATION_CATALOG_VERSION, entries: [{
          argv: ["node", "-e", "process.exit(0)"], capability: "capability-implement",
          profileRevisionId: GOAL_PROVIDER_PROFILE.profileRevisionId, projectId: PROJECT_ID,
        }],
      }) }),
      repositoryScope: scopeResolver(store, world), store,
    },
    capabilities,
    context: { assembleFoundationContextSelection: () => Object.freeze({
      ok: true as const, provenance: prepared.provenance, selection: prepared.selection,
    }) },
    ledger: store,
    observation: () => ({
      adapterCapabilitySchemaDigest: world.runtime.adapterCapabilitySchemaDigest,
      platformIdentity: world.runtime.platformIdentity,
      reportedVersion: world.runtime.reportedVersion,
    }),
    readPort: store,
  });
}

type ObservedLaunch = Extract<ClaudeLaunchResult, { readonly kind: "OBSERVED" }>;

function launchRequestOf(value: unknown): ClaudeLaunchRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("provider launch request is not a record");
  }
  const request = value as Record<string, unknown>;
  if (typeof request["bootstrapCredentialDigest"] !== "string"
    || typeof request["contextManifestDigest"] !== "string"
    || typeof request["renderedContext"] !== "string"
    || typeof request["launchSelection"] !== "object"
    || request["launchSelection"] === null) {
    throw new TypeError("provider launch request lacks its production fields");
  }
  return value as ClaudeLaunchRequest;
}

function handoffFor(
  input: Parameters<FoundationAttemptProviderRun>[1], request: ClaudeLaunchRequest,
  observation: ObservedLaunch["observation"],
): ClaudeTelemetryHandoff {
  const knownZero = Object.freeze({ known: true as const, value: 0 });
  const knownOne = Object.freeze({ known: true as const, value: 1 });
  const unsupported = Object.freeze({ known: false as const,
    code: "TELEMETRY_ACHIEVED_CONCURRENCY_UNSUPPORTED" as const,
    layer: "TELEMETRY_SCHEMA" as const });
  const selection = request.launchSelection;
  const handoff: ClaudeTelemetryHandoff = {
    concurrency: { achieved: unsupported, declaredCeiling: {
      known: true as const, value: selection.concurrencyCeiling,
    }, fact: "DECLARED_CEILING_ONLY" },
    declared: { known: true as const, selection },
    handoffVersion: CLAUDE_TELEMETRY_HANDOFF_VERSION, infrastructure: "NONE",
    launch: { activationDigest: observation.activationDigest,
      completedAt: observation.completedAt, effectDigest: observation.effectDigest,
      exit: observation.exit, freshRuntimeDigest: observation.freshRuntimeDigest,
      kind: "OBSERVED" as const, observationDigest: observation.observationDigest,
      pinnedClosureDigest: observation.pinnedClosureDigest,
      quotedRuntimeDigest: observation.quotedRuntimeDigest, reasonCode: null, reasonLayer: null,
      runtimeBindingDigest: observation.runtimeBindingDigest, startedAt: observation.startedAt,
      truthClass: "PROVEN" },
    observedModel: { modelId: { known: true as const, value: selection.selectedModelId },
      snapshotEvidence: { known: true as const, value: selection.modelSnapshotEvidence },
      snapshotKind: selection.modelSnapshotKind },
    parserVersion: CLAUDE_RESULT_TELEMETRY_VERSION, providerRunRef: input.providerRun,
    sequence: knownOne,
    stderrReceiptDigest: { known: true as const, value: observation.stderr.sha256 },
    stdoutReceiptDigest: { known: true as const, value: observation.stdout.sha256 },
    steps: { coverage: "COMPLETE", turns: knownOne }, telemetryRefusal: null,
    terminal: "COMPLETED",
    tokens: { cacheCreationInputTokens: knownZero, cacheReadInputTokens: knownZero,
      coverage: "COMPLETE", inputTokens: knownZero, outputTokens: knownZero },
  };
  return Object.freeze(handoff);
}

function providerRunFor(
  store: SqliteEventStore, aggregateId: string, claim: Record<string, unknown>,
  label: string, calls: { value: number },
): FoundationAttemptProviderRun {
  return async (authority, input): Promise<ClaudeBoundLaunchResult> => {
    calls.value += 1;
    const request = launchRequestOf(input.request);
    const history = readFoundationActivationHistory(
      aggregateId, store.readEvents(aggregateId), PROJECT_ID);
    if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
    const { record } = history.history;
    const consumed = authority.consumeGrantDurably(record.grant, record.grant.wrapperIdentity);
    const grant = nested(consumed, "grant") as unknown as ObservedLaunch["consumedGrant"];
    const registration = Object.freeze({
      bootstrapCredentialDigest: request.bootstrapCredentialDigest,
      lockIdentity: String(claim["lockIdentity"]), processIdentity: `windows:${process.pid}:${label}`,
      registeredAt: "2026-08-15T00:00:01.000Z",
      wrapperIdentity: String(claim["wrapperIdentity"]),
    });
    const preflight = { ...registration,
      processIdentity: `pending:${String(claim["wrapperIdentity"])}`,
      registeredAt: "2026-08-15T00:00:00.500Z" };
    nested(authority.commitProcessRegistration({
      claim, phase: "PREFLIGHT", prior: null, registration: preflight,
    }), "registration");
    nested(authority.commitProcessRegistration({
      claim, phase: "STARTED", prior: null, registration,
    }), "registration");
    const stream: ObservedLaunch["observation"]["stdout"] = Object.freeze({
      byteLength: 0, capturedBase64: "", complete: true,
      sha256: createHash("sha256").update("").digest("hex"), tailBase64: "", truncated: false });
    const observation: ObservedLaunch["observation"] = {
      activationDigest: record.activationDigest, completedAt: "2026-08-15T00:00:02.000Z",
      consumedGrantDigest: DIGEST_A, contextManifestDigest: request.contextManifestDigest,
      deliveredByteLength: encoder.encode(request.renderedContext).byteLength,
      effectDigest: DIGEST_B, exit: { code: 0, kind: "EXITED" }, freshRuntimeDigest: DIGEST_C,
      grantId: record.grant.grantId, launcherVersion: CLAUDE_LAUNCHER_VERSION,
      lockIdentity: registration.lockIdentity, observationDigest: DIGEST_A,
      pinnedClosureDigest: DIGEST_B, processIdentity: registration.processIdentity,
      quotedRuntimeDigest: DIGEST_A, reasonCode: null, reasonLayer: null,
      registrationDigest: DIGEST_C, runtimeBindingDigest: DIGEST_A,
      startedAt: "2026-08-15T00:00:01.000Z", stderr: stream, stdout: stream,
      truthClass: "PROVEN", wrapperIdentity: registration.wrapperIdentity,
    };
    const result: ObservedLaunch = Object.freeze({ code: null, consumedGrant: grant,
      kind: "OBSERVED", layer: null, observation, ok: true, registration, truthClass: "PROVEN" });
    return Object.freeze({ handoff: handoffFor(input, request, observation), ok: true, result });
  };
}

interface SeededAttemptInternal {
  readonly attemptAggregateId: string;
  readonly attemptRef: string;
  readonly candidateRoot: string;
  readonly nodeRef: string;
  readonly providerRunCalls: number;
  readonly recordDigest: string;
  readonly runtime: ProviderRuntimeObservation;
  readonly tree: CandidateTree;
}

export type SeededAttempt = Omit<SeededAttemptInternal, "runtime" | "tree">;

/**
 * One PROVEN attempt through the real service body. The injected port is only the physical
 * provider answer; activation, reservation, provider telemetry and attempt settlement remain
 * owned by production.
 */
export async function seedProvenAttempt(
  store: SqliteEventStore, nodeRef = ACTIVATION_WORLD_NODE_KEY,
  approvedScope: readonly string[] = [nodeRef],
): Promise<SeededAttemptInternal> {
  const baseWorld = storeWorlds.get(store);
  const world = createAttemptWorld(nodeRef, baseWorld);
  if (baseWorld === undefined) {
    bootstrapGoalWorld(store, nodeRef, world, approvedScope);
    storeWorlds.set(store, world);
  }
  openAttemptSession(store, world.sessionId, world.label, baseWorld === undefined);
  const facts = deriveFoundationDispatchFacts({
    catalogSource: () => world.catalog, projectId: PROJECT_ID, store,
  });
  if (!facts.ok) throw new Error(`dispatch facts refused: ${facts.code}@${facts.refusedBy}`);
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`active graph refused: ${active.code}@${active.layer}`);
  const activation = activationRequest(world.label, world.sessionId, active.graphEpoch);
  const calls = { value: 0 };
  const service = createFoundationAttemptServiceWithProviderRun({
    captureResult: createFoundationCaptureProducer({ store }),
    completion: createFoundationLaunchCompletionAuthority({ pinRoot: world.pinRoot, store }),
    context: contextPort(store, world, facts.inputManifest as unknown as Record<string, unknown>),
    lifecycle: createFoundationCaptureLifecycle({
      catalogSource: () => world.catalog, clock: () => DECIDED_AT, store,
    }),
    store,
  }, providerRunFor(store, activation.aggregateId, activation.claim, world.label, calls));
  const outcome = await service.dispatch({
    activationRequestBytes: activation.bytes,
    binding: { attemptAggregateId: activation.aggregateId, nodeKey: nodeRef,
      sessionId: world.sessionId },
    graphSnapshot: facts.graphSnapshot,
    inputManifest: facts.inputManifest,
  });
  if (!outcome.ok) {
    throw new Error(`attempt fixture refused: ${outcome.code}@${outcome.refusedBy}`);
  }
  const stored = readFoundationAttemptRecord(store, activation.aggregateId);
  if (!stored.ok) throw new Error(`attempt readback refused: ${stored.code}@${stored.refusedBy}`);
  if (stored.record["truthClass"] !== "PROVEN" || stored.record["resultManifest"] === null) {
    throw new Error("attempt readback was not PROVEN with a result manifest");
  }
  return Object.freeze({
    attemptAggregateId: activation.aggregateId, attemptRef: `attempt-${world.label}`,
    candidateRoot: world.tree.root, nodeRef, providerRunCalls: calls.value,
    recordDigest: stored.digest, runtime: world.runtime, tree: world.tree,
  });
}

function declaredInputs(tree: CandidateTree): readonly DeclaredInput[] {
  return candidateTreeEntries(tree).map((entry) => ({
    path: String(entry["path"]),
    ref: { byteLength: Number(entry["byteLength"]), sha256: String(entry["sha256"]) },
  }));
}

export interface SeededVerification extends SeededAttempt {
  readonly effectIdentity: string;
  readonly leaseIdentity: string;
  readonly receiptSha256: string;
  readonly row: Record<string, unknown>;
  readonly verificationId: string;
}

/** One canonical PASSED receipt over the exact candidate bytes the attempt sealed. */
export async function seedVerifiedNode(
  store: SqliteEventStore, nodeRef = ACTIVATION_WORLD_NODE_KEY,
  approvedScope: readonly string[] = [nodeRef],
): Promise<SeededVerification> {
  const internal = await seedProvenAttempt(store, nodeRef, approvedScope);
  const recipeAggregateId = `recipe-${internal.attemptRef}`;
  const verificationId = `verify-${internal.attemptRef}`;
  const service = createFoundationVerificationService({
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, store,
  });
  const sealed = service.sealRecipe({
    argv: EXIT_ZERO, declaredInputs: declaredInputs(internal.tree), declaredOutputPaths: [],
    recipeAggregateId, runtimeObservation: internal.runtime, verifierIdentity: VERIFIER_IDENTITY,
  });
  if (!sealed.ok) throw new Error(`recipe fixture refused: ${sealed.code}@${sealed.layer}`);
  const outcome = await service.verify({
    attemptAggregateId: internal.attemptAggregateId, candidateRoot: internal.candidateRoot,
    expectedRecordDigest: internal.recordDigest, recipeAggregateId, verificationId,
  });
  if (!outcome.ok) throw new Error(`verification fixture refused: ${outcome.code}@${outcome.layer}`);
  const stored = readStoredReceipt(store, verificationId);
  if (!stored.ok) throw new Error(`receipt readback refused: ${stored.code}@${stored.layer}`);
  if (stored.row["verdict"] !== "PASSED") {
    throw new Error(`verification fixture answered ${String(stored.row["verdict"])}, not PASSED`);
  }
  const receipt = nested(stored.row, "receipt");
  if (receipt["graphIdentity"] !== nodeRef) {
    throw new Error(`receipt names ${String(receipt["graphIdentity"])}, not ${nodeRef}`);
  }
  return Object.freeze({
    attemptAggregateId: internal.attemptAggregateId, attemptRef: internal.attemptRef,
    candidateRoot: internal.candidateRoot, effectIdentity: String(receipt["effectIdentity"]),
    leaseIdentity: String(receipt["leaseIdentity"]), nodeRef,
    providerRunCalls: internal.providerRunCalls,
    receiptSha256: String(stored.row["receiptSha256"]), recordDigest: internal.recordDigest,
    row: stored.row, verificationId,
  });
}

export interface GlobalEventScan {
  /** Rows of `ACTIVATION_LEDGER_EVENT_TYPE` anywhere in the store. */
  readonly activationRows: number;
  /** False if the walk stopped on a non-advancing cursor rather than on `hasMore`. */
  readonly exhausted: boolean;
  readonly total: number;
}

/**
 * The whole store's event stream, walked to exhaustion.
 *
 * STORE-WIDE AND NOT PER-AGGREGATE, deliberately. A consumer asserting "this world holds no
 * committed activation" by reading one guessed aggregate would miss a row committed anywhere
 * else, and the sibling row that landed this technique (task-bff22559, commit d96797f) flagged
 * exactly that trap. `total` is returned so the caller can assert a NONZERO denominator: an empty
 * store also has zero activation rows, and a scan that measured nothing would pass vacuously.
 */
export function scanGlobalEvents(store: SqliteEventStore): GlobalEventScan {
  let activationRows = 0, total = 0, cursor = 0n;
  for (;;) {
    const page = store.readEventsAfter(cursor, GLOBAL_PAGE_LIMIT);
    total += page.items.length;
    activationRows += page.items
      .filter((event) => event.eventType === ACTIVATION_LEDGER_EVENT_TYPE).length;
    if (!page.hasMore || page.nextCursor === null) {
      return Object.freeze({ activationRows, exhausted: true, total });
    }
    if (page.nextCursor <= cursor) return Object.freeze({ activationRows, exhausted: false, total });
    cursor = page.nextCursor;
  }
}

/**
 * The approval whose durable `approvedNodeScope` is the closure's node set.
 *
 * THE WORLD IS SEEDED FIRST (task-1de7b81a), and the order is now load-bearing rather than
 * incidental. The witnessless HUMAN_APPROVAL world stands in for the grant this repository cannot yet
 * express: it authorizes a FUNDED budget root, and a root is once-only. Approving first would
 * mint the zero-amount genesis root instead, and every later `effect.activate` in this lineage
 * would refuse BUDGET_LEDGER_TRANSITION_REFUSED against a root that can never be topped up —
 * `openBudgetRoot` is the only unit-creating reducer in `@moe/scheduler`. The call is idempotent,
 * so the world these fixtures measure is unchanged; only the moment it comes into existence
 * moved earlier. It seeds a GRAPH and a BUDGET ROOT and commits no activation ledger row.
 */
export function approveNodes(store: SqliteEventStore, nodeRefs: readonly string[]): void {
  driveThrough(store, "approval.decide");
  seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
  const outcome = send(store, envelope("approval.decide", 0, approvalPayload({
    // The SEALED hash: `driveThrough` proposed through the shipped journey, whose propose
    // terminal carries the authority member, so the run's submission hash is the sealed
    // plan body's own `planHash` and an approval naming the legacy constant is refused
    // BOOTSTRAP_REVISION_HASH_MISMATCH (task-074e6d2e).
    record: { ...approvalRecord(SEALED_SUBMISSION_HASH), approvedNodeScope: [...nodeRefs] },
  })));
  if (!outcome.ok) throw new Error(`approval setup failed: ${outcome.code}`);
}

/**
 * The daemon-side review acceptance required before the third human action, driven through the
 * PUBLISHED, authenticated package-root command path. The verifier receipt is the daemon's own
 * internal producer, so the fixture seeds that durable fact and nothing else.
 *
 * A `VerifierReceiptRecorded` row is NOT a Foundation verification receipt: the closure composer
 * reads it only after an in-scope node already has one, which is why every consumer of this
 * helper still refuses at the receipt fence.
 */
export function seedReviewAcceptance(store: SqliteEventStore, nodeRef = "node-1"): void {
  const receipt = seedVerifierReceipt(store, nodeRef, PROJECT_ID);
  // This fixture emulates the node verifier's in-process integration-acceptance dispatch.
  const outcome = dispatchAsOperator(store, {
    commandId: `cmd-j1-review-accept-${nodeRef}`,
    commandKind: "integration.accept_output",
    correlationId: "corr-j1-review",
    expectedVersion: receipt.currentVersion,
    payload: { receiptId: receipt.receiptId, subjectRef: nodeRef },
    targetAggregateId: nodeRef,
  }, "NODE_VERIFIER");
  if (!outcome.ok) throw new Error(`authenticated review setup failed for ${nodeRef}`);
}

interface OperatorDispatch {
  readonly commandId: string;
  readonly commandKind: string;
  readonly correlationId: string;
  readonly expectedVersion: number;
  readonly payload: Record<string, unknown>;
  readonly targetAggregateId: string;
}

/**
 * The PUBLISHED, authenticated package-root command path under the configured operator
 * principal — the seat `goal.close` and `integration.accept_output` both require
 * (`OPERATOR_PRINCIPAL_KINDS`). Extracted so a fixture that closes a goal and one that accepts
 * a node's output reach the daemon through the SAME shipped entry point rather than through two
 * hand-copied envelopes that could drift apart.
 */
function dispatchAsOperator(
  store: SqliteEventStore, request: OperatorDispatch, transport: "HTTP_LISTENER" | "NODE_VERIFIER",
): ReturnType<typeof daemon.handleCommandRequest> {
  const ports = daemon.createDaemonCommandPorts({
    clock: () => "2026-08-16T00:00:00.000Z",
    operatorPrincipalId: OPERATOR_PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
  });
  return daemon.handleCommandRequest({
    authenticator: {
      authenticate: (credential) => credential === OPERATOR_CREDENTIAL
        ? {
          principal: {
            capabilities: daemon.OPERATOR_CAPABILITIES,
            principalId: OPERATOR_PRINCIPAL_ID,
            projectId: PROJECT_ID,
          },
          verdict: "AUTHENTICATED" as const,
        }
        : { verdict: "UNAUTHENTICATED" as const },
    },
    ...ports,
  }, {
    body: encoder.encode(JSON.stringify({
      ...request,
      requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: OPERATOR_CREDENTIAL,
    })),
    credential: OPERATOR_CREDENTIAL,
    protocolVersion: daemon.WIRE_PROTOCOL_VERSION,
  }, transport);
}

/**
 * `goal.close` through the shipped, authenticated operator wire — the same entry the control
 * room's third human action reaches. Nothing about the closure is presented: the payload's two
 * witnesses are the inert fixture literals `qualifyGoalClosure` replaces with derived ones.
 */
export function closeGoalThroughCommandPath(
  store: SqliteEventStore, expectedVersion: number, commandId = "cmd-j1-goal-close",
): ReturnType<typeof daemon.handleCommandRequest> {
  return dispatchAsOperator(store, {
    commandId,
    commandKind: "goal.close",
    correlationId: "corr-j1-close",
    expectedVersion,
    payload: acceptancePayload(),
    targetAggregateId: GOAL_ID,
  }, "HTTP_LISTENER");
}

/** The landing outcome a fixture asks the lander's ledger to record for a node. */
export type SeededLanding = "COMMITTED" | Readonly<{ readonly refusalCode: string }>;

const LANDING_SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * One durable landing receipt for a node, written through the lander's OWN ledger writer
 * (`recordLandingReceipt`) rather than planted: the bytes a closure reads back are the exact
 * bytes production commits.
 *
 * `verifierReceiptId` defaults to the one this node's review acceptance names, because that is
 * the only pairing production can produce; an override exists solely for the STALE-landing arm,
 * where a landing attests a verifier receipt the acceptance does not.
 */
export function seedLandingReceipt(
  store: SqliteEventStore, nodeRef: string, outcome: SeededLanding, verifierReceiptId?: string,
): string {
  const accepted = readReviewLedger(store, PROJECT_ID, nodeRef).accepted;
  const receiptId = verifierReceiptId ?? accepted?.verifierReceiptId;
  if (receiptId === undefined) {
    throw new Error(`no review acceptance names ${nodeRef}, so no landing can attest one`);
  }
  const committed = outcome === "COMMITTED";
  const recorded = recordLandingReceipt(store, {
    commit: committed
      ? {
        branch: "main", files: ["src/landed.ts"], message: `Land ${nodeRef}\n`,
        parentSha: null, sha: LANDING_SHA,
      }
      : null,
    decidedAt: "2026-08-16T01:00:00.000Z",
    projectId: PROJECT_ID,
    refusal: committed ? null : { code: outcome.refusalCode, detail: "fixture landing refusal" },
    subjectRef: nodeRef,
    verifierReceiptId: receiptId,
    workspace: "D:/fixture-workspace",
  });
  if (!recorded.ok) throw new Error(`landing receipt fixture refused: ${recorded.code}`);
  return recorded.receipt.receiptId;
}
