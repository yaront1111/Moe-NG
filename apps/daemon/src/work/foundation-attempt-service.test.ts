import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_LAUNCHER_VERSION, buildInputManifest, buildProviderRuntimeObservation,
  buildResultManifest, createNodeFoundationCaptureFs, createNodeWorktreeMaterializer,
  deriveWorktreeTarget, hermeticGitEnvironment, observeScope,
} from "@moe/runner";
import type {
  GitObserver, ProviderRuntimeObservation, ScopeObservation, WorktreeMaterializationRequest,
  WorktreeMaterializationResult, WorktreeMaterializer, WorktreeReleaseRequest,
  WorktreeReleaseResult,
} from "@moe/runner";
import {
  createAcceptanceContract, createPlanRevision, reduceGraphRevision,
} from "@moe/core";
import {
  ADMISSION_PURPOSES,
  createNodeDefinition,
  deriveNodeAuthoritySet,
  encodeGraphContent,
  validateGraphSnapshot,
} from "@moe/scheduler";
import type {
  GraphRevisionContent, GraphSnapshot, NodeAuthoritySection, NodeDefinition,
} from "@moe/scheduler";
import type { CommitExpectedVersionDecisionInput, SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { ActivationRunCommitInput } from "../activation/activation-run-commit.js";
import type { ActivationTelemetryLaunchInput } from "../activation/activation-telemetry-launch.js";

const providerBoundaryProbe = vi.hoisted(() => ({
  commits: [] as Array<{
    readonly input: ActivationRunCommitInput; readonly result: unknown;
  }>,
  launches: [] as Array<{ readonly input: ActivationTelemetryLaunchInput; readonly result: unknown }>,
  /** One sequence for every boundary crossing, so ORDER is asserted as order
   *  rather than as two counters that could both be right and still be inverted. */
  order: [] as string[],
  /**
   * A SCRIPTED PROVIDER, null everywhere except the durable-readback arms.
   *
   * The physical launch is the one boundary a non-Windows case cannot cross:
   * `@moe/runner` withholds runtime discovery, which is exactly why every
   * capture assertion in this file reads `toHaveLength(0)`. A script is handed
   * `runReal` and is expected to CALL it — the runner's own telemetry handoff is
   * what the provider-run ledger composes its record from, and a hand-written
   * one would be this suite inventing a contract it does not own. The script
   * only writes the bytes a provider process would have written and raises the
   * launch observation to the PROVEN class the real runtime discovery cannot
   * reach here. Everything else — lifecycle, ledger, producer, scanner, sealer,
   * store — stays the shipped code.
   */
  scripted: null as null | ((
    input: ActivationTelemetryLaunchInput, runReal: () => Promise<unknown>,
  ) => Promise<unknown>),
}));

vi.mock("../activation/activation-telemetry-launch.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../activation/activation-telemetry-launch.js")
  >();
  return {
    ...actual,
    launchActivationProviderRun: async (
      ...args: Parameters<typeof actual.launchActivationProviderRun>
    ) => {
      providerBoundaryProbe.order.push("launch");
      const { scripted } = providerBoundaryProbe;
      const runReal = async (): Promise<unknown> => actual.launchActivationProviderRun(...args);
      const result = scripted === null ? await runReal() : await scripted(args[1], runReal);
      providerBoundaryProbe.launches.push({ input: args[1], result });
      return result as Awaited<ReturnType<typeof actual.launchActivationProviderRun>>;
    },
  };
});

vi.mock("../activation/activation-run-commit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../activation/activation-run-commit.js")>();
  return {
    ...actual,
    commitActivationProviderRun: (
      ...args: Parameters<typeof actual.commitActivationProviderRun>
    ) => {
      const result = actual.commitActivationProviderRun(...args);
      providerBoundaryProbe.commits.push({ input: args[1], result });
      return result;
    },
  };
});

import { readAttemptRelease } from "./attempt-release-disposition.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  graphRevisionAggregateId, readCurrentActiveGraph,
} from "../planning/active-graph-projection.js";
import { putGraphBody } from "../planning/graph-body-record.js";
import {
  ACTIVATION_WITNESS, PROVIDER_OBSERVATION, envelope as bootstrapEnvelope,
  send as sendBootstrap,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore,
} from "../recovery/restore-test-harness.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import {
  ACTIVATION_WORLD_NODE_KEY, seedActivationWorld,
} from "../activation/activation-world-fixtures.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { createFoundationLauncherAuthority } from "../activation/foundation-launch-authority.js";
import {
  PROVIDER_RUN_COMMAND_KIND, PROVIDER_RUN_EVENT_TYPE,
} from "../telemetry/provider-run-contracts.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import {
  DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_DISPATCH_COMMAND_KIND, FOUNDATION_DISPATCH_EVENT_TYPES,
  FOUNDATION_RESERVATION_VERSION,
  RUNNER_WORKSPACE_LAYER, decodeFoundationAttemptRequest, decodeFoundationPayload,
  deriveDispatchAggregateId, encodeFoundationPayload, identifyFoundationDispatch, sameBytes,
} from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { FOUNDATION_DISPATCH_BYTES_KEY } from "../daemon-foundation-command.js";
import { createFoundationCaptureLifecycle } from "./foundation-capture-lifecycle.js";
import { createFoundationCaptureProducer } from "./foundation-capture-producer.js";
import type { FoundationCaptureLifecycle, PrepareCaptureInput, PrepareCaptureResult } from "./foundation-capture-lifecycle.js";
import { deriveFoundationCaptureRef, readFoundationCaptureContext } from "./foundation-capture-context-ledger.js";
import { DAEMON_FOUNDATION_CAPTURE } from "./foundation-capture-context-contract.js";
import { FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION } from "./foundation-repository-scope-contracts.js";
import { createFoundationAttemptService, readFoundationAttemptRecord } from "./foundation-attempt-service.js";
import { unconfiguredFoundationContextSealPort } from "./foundation-context-record.js";
import type {
  FoundationContextSealCode, FoundationContextSealPort,
} from "./foundation-context-record.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-service.js";
import {
  commitFoundationPhase, readDurableFoundationObservation, recordProvenFoundationAttempt,
} from "./foundation-attempt-store.js";

/**
 * Foundation attempt dispatch over a REAL SqliteEventStore and the REAL
 * activation ingress, scheduler validator and workspace manifest builders.
 *
 * The physical Claude launch is NEVER replaced here. Cross-platform cases use
 * the real launcher's explicit non-Windows refusal; the separate Windows suite
 * exercises the shipped broker. Only post-launch workspace observation is a
 * service dependency. Every authority/store decision below is production code.
 *
 * NOTHING HERE HAND-FORGES A GRANT. `parseActivationGrant` demands a hex64
 * grantId derived from the whole successor intent and `canonicalDigest` is not
 * exported, so a coherent activation can only come out of the production chain
 * (mem:gotcha-coherent-activation-fixture-needs-activateeffect). The activation
 * fixture below is therefore the ingress's own, driven end to end.
 */

/**
 * Every dispatch that reaches the insertion point now materializes a REAL
 * detached Git worktree before it may launch, and `git worktree add` on Windows
 * costs seconds rather than milliseconds. The default 5s budget was written for
 * a suite that touched no filesystem; raising it here keeps a slow real
 * operation from reading as a hang.
 */
vi.setConfig({ testTimeout: 30_000 });

const encoder = new TextEncoder();
const scratchRoots: string[] = [];

afterEach(() => {
  providerBoundaryProbe.commits.length = 0;
  providerBoundaryProbe.launches.length = 0;
  providerBoundaryProbe.order.length = 0;
  // Cleared here rather than in the arms that set it: a leaked script would
  // silently replace the real launcher for every later case in the file.
  providerBoundaryProbe.scripted = null;
  cleanupRestoreHarnesses();
});
afterAll(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    // 20x250ms: these roots now hold real Git repositories and worktrees, and a
    // trailing handle under fleet load turns 5x100ms into a leaked directory.
    if (root !== undefined) {
      rmSync(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
    }
  }
});

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root, encoding: "utf8", env: hermeticGitEnvironment(process.env),
    shell: false, windowsHide: true,
  }).trim();
}

/**
 * ONE real repository for the whole suite, with SHA-256 objects so its head is
 * 64 hex: the durable observation validator demands that width, and the
 * workspace lifecycle now resolves the launch root from the durable observation
 * rather than from the caller. A 40-hex sha1 head could not be bound at all.
 */
const REPOSITORY = (() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-dispatch-repo-")));
  scratchRoots.push(root);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "moe-dispatch-trees-")));
  scratchRoots.push(parent);
  const paths = ["scope/alpha.txt", "scope/beta.txt"] as const;
  mkdirSync(join(root, "scope"));
  writeFileSync(join(root, paths[0]), Buffer.from("alpha\n", "utf8"));
  writeFileSync(join(root, paths[1]), Buffer.from("beta\n", "utf8"));
  runGit(root, ["init", "--object-format=sha256", "--initial-branch=main", "--quiet"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  runGit(root, ["add", "--", ...paths]);
  runGit(root, [
    "-c", "user.name=Moe Foundation", "-c", "user.email=foundation@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m", "foundation base",
  ]);
  return { head: runGit(root, ["rev-parse", "HEAD"]), parent, paths, root };
})();

/** Opened inside a case, never in a describe body: a held handle kills the worker. */
function readyStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-dispatch-${label}-`));
  scratchRoots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  // The SAME four bootstrap commands `seedReadyProject` drives, with ONE change:
  // the bound observation carries the fixture repository's real head. It cannot
  // be appended afterwards — the project reducer answers ILLEGAL_TRANSITION for a
  // bind after activation — so the ready sequence is driven here instead.
  for (const [kind, version, payload] of [
    ["project.register", 0, { owner: "owner-1" }],
    ["project.bind_repository", 1, {
      observation: {
        baseRevisionHash: REPOSITORY.head, repositoryRef: "repo-1", scopeRef: "scope-1",
        truthClass: "DAEMON_VERIFIED",
      },
    }],
    ["provider.probe", 0, { observation: PROVIDER_OBSERVATION }],
    ["project.activate", 2, { witness: ACTIVATION_WITNESS }],
  ] as readonly (readonly [string, number, Record<string, unknown>])[]) {
    const outcome = sendBootstrap(
      store, bootstrapEnvelope(kind, version, payload, `cmd-${kind}-${label}`));
    if (!outcome.ok) throw new Error(`fixture ${kind} refused: ${outcome.code}`);
  }
  // The rest of what `seedReadyProject` drives. This file re-runs the four bootstrap commands
  // itself only to carry the fixture repository's real head, so it owes the same durable ACTIVE
  // graph and authorized budget root every other world here gets — `effect.activate` now derives
  // its budget from those facts instead of from the caller's payload section. Idempotent by
  // construction: it enriches a world, it never rebuilds one.
  seedActivationWorld(store);
  return store;
}

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const HEAD = REPOSITORY.head;
const DIGEST_A = "2".repeat(64), DIGEST_B = "3".repeat(64), DIGEST_C = "4".repeat(64);
const NODE_KEY = ACTIVATION_WORLD_NODE_KEY;
const SESSION_ID = "session-1";

const LEASE_RECORD = {
  authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT", leaseId: "lease-1",
  leaseToken: "token-1", monotonicObservation: 500, ownerSessionRef: SESSION_ID,
  serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;
const LEASE_PROOF = {
  authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: "token-1",
  ownerSessionRef: SESSION_ID,
} as const;
const RESOURCE_ROW = {
  capacityUnits: 1, effectIntentRef: "intent-ref-1", epoch: 1, external: false, fenceable: true,
  resourceId: "res-1", state: "ACTIVE",
} as const;
const EFFECT_INTENT = {
  aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4, idempotencyKey: "idem-1",
  inputBinding: DIGEST, intentId: "intent-1", leaseBinding: LEASE_RECORD,
  predecessorCursor: "cursor-1", protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST, state: "PENDING", version: 0,
} as const;
const CLAIM = {
  claimId: "claim-1", claimedAt: DECIDED_AT, intentId: "intent-1", lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
} as const;
const ACTIVATION_SECTION = {
  attempt: { aggregateId: "agg-1", attemptId: "attempt-1", intentId: "intent-1", state: "LAUNCH_REQUESTED", version: 0 },
  claim: CLAIM, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DIGEST, tombstone: null,
  wrapperIdentity: "wrapper-1",
} as const;

const ACTIVATION_AGGREGATE = deriveActivationAggregateId(
  EFFECT_INTENT.aggregateId, EFFECT_INTENT.idempotencyKey);
const DISPATCH_AGGREGATE = deriveDispatchAggregateId(ACTIVATION_AGGREGATE);

function activationBytes(commandId = "cmd-dispatch-1"): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId, correlationId: "corr-dispatch", decidedAt: DECIDED_AT, expectedVersion: 0,
    kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: ACTIVATION_SECTION,
      effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

const SINGLE_NODE_GRAPH = Object.freeze({
  completionNodeKey: NODE_KEY, edges: [], nodes: [{ executionBearing: true, nodeKey: NODE_KEY }],
});
/** Two execution-bearing nodes, HARD-closed onto the completion node so the
 *  scheduler ADMITS it — the refusal must be this daemon's, not a graph fault. */
const MULTI_NODE_GRAPH = Object.freeze({
  completionNodeKey: NODE_KEY,
  edges: [{ consumerNodeKey: NODE_KEY, edgeKey: "dev-e1", kind: "HARD", producerNodeKey: "dev-a" }],
  nodes: [{ executionBearing: true, nodeKey: "dev-a" }, { executionBearing: true, nodeKey: NODE_KEY }],
});

const INSTALLED_ROOT = "C:\\installed", PIN_ROOT = "C:\\pins";
const EXECUTABLE_PATH = "C:\\installed\\claude.exe";

/**
 * A REAL digest-bound quote from the runner's own observation builder. The three
 * fields below are the only runtime data a caller may ever propose: the
 * filesystem, host observer and clock behind them are minted inside @moe/runner
 * by `createClaudeRuntimePinRequest`, never composed here and never in deps.
 */
function runtimeQuote(
  closure: readonly Record<string, unknown>[] = [
    { kind: "EXECUTABLE", path: EXECUTABLE_PATH, sha256: DIGEST_A },
  ],
): ProviderRuntimeObservation {
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: DIGEST_B, clock: { observedAt: () => DECIDED_AT },
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: "claude/2.0.0", resolvedRuntimeClosure: closure as never,
  });
  if (!built.ok) throw new Error(`runtime quote fixture refused: ${built.code}`);
  return built.observation;
}

/**
 * The worktree the daemon WILL derive for this attempt. A caller can compute it
 * — the derivation is published and pure — but computing it is not choosing it:
 * the launch root comes from the materializer's assignment either way, and a
 * proposal that disagrees refuses instead of winning.
 */
const DERIVED_WORKTREE = (() => {
  const derived = deriveWorktreeTarget({
    attemptId: "attempt-1", baseIdentity: HEAD, projectId: PROJECT_ID,
    sourceRepositoryRoot: REPOSITORY.root, worktreeParent: REPOSITORY.parent,
  });
  if (!derived.ok) throw new Error(`worktree fixture refused: ${derived.code}`);
  return derived.target.worktreePath;
})();

const LAUNCH_TEMPLATE = Object.freeze({
  argv: ["--print", "hello", "--model", "claude-opus-5", "--effort", "high"],
  bootstrapCredentialDigest: DIGEST_B, cwd: DERIVED_WORKTREE, environment: {},
  launchSelection: {
    concurrencyCeiling: 4, configurationDigest: "1c".repeat(32),
    modelSnapshotEvidence: "claude-opus-5/build-2026-05-14",
    modelSnapshotKind: "DATED_SNAPSHOT", orchestrationDigest: "3e".repeat(32),
    policyDigest: "2d".repeat(32), profileRevisionId: "profile-revision-19",
    provider: "claude", reasoningEffort: "high", selectedModelId: "claude-opus-5",
  },
  limits: { stderrBytes: 1_024, stdoutBytes: 1_024, tailBytes: 256, timeoutMs: 1_000 },
  runtime: {
    installedRoot: INSTALLED_ROOT, pinRoot: PIN_ROOT, quotedObservation: runtimeQuote(),
  },
});
/** A proposal that AGREES with the fixture repository's real bytes. It is still
 *  only a proposal: the launch root and the sealed input come from the durable
 *  authority, and this entry can do nothing but match or refuse. */
const REAL_ENTRY = Object.freeze({
  byteLength: readFileSync(join(REPOSITORY.root, REPOSITORY.paths[0])).byteLength,
  path: REPOSITORY.paths[0], producer: { kind: "BASE" },
  sha256: createHash("sha256")
    .update(readFileSync(join(REPOSITORY.root, REPOSITORY.paths[0]))).digest("hex"),
});
const INPUT_MANIFEST = Object.freeze({
  baseIdentity: HEAD,
  entries: [{ ...REAL_ENTRY }],
});

interface RequestOverrides {
  readonly binding?: Record<string, unknown>;
  readonly bytes?: Uint8Array;
  readonly graphSnapshot?: unknown;
  readonly launchTemplate?: Record<string, unknown>;
}

function dispatchRequest(overrides: RequestOverrides = {}): Record<string, unknown> {
  return {
    activationRequestBytes: overrides.bytes ?? activationBytes(),
    binding: overrides.binding
      ?? { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY, sessionId: SESSION_ID },
    graphSnapshot: overrides.graphSnapshot ?? structuredClone(SINGLE_NODE_GRAPH),
    inputManifest: structuredClone(INPUT_MANIFEST),
    launchTemplate: overrides.launchTemplate ?? structuredClone(LAUNCH_TEMPLATE),
  };
}

/**
 * A SECOND durable identity, distinct in EVERY field the captureRef and the
 * worktree derive from: the intent's idempotency key (so the activation
 * aggregate differs), the attemptId, and the session that owns the lease. Two
 * dispatches that share any one of them are collapsed by the reservation into a
 * duplicate delivery, and a deduplicated pair cannot tell "isolated" apart from
 * "crossed onto one" — both produce a single ref.
 */
const SECOND_SESSION_ID = "session-2";
const SECOND_ATTEMPT_ID = "attempt-2";
const SECOND_LEASE_RECORD = {
  ...LEASE_RECORD, leaseId: "lease-2", leaseToken: "token-2", ownerSessionRef: SECOND_SESSION_ID,
} as const;
const SECOND_LEASE_PROOF = {
  ...LEASE_PROOF, leaseToken: "token-2", ownerSessionRef: SECOND_SESSION_ID,
} as const;
/** `leaseBinding` travels INSIDE the intent, so it has to be the second lease
 *  too: an intent still binding the first lease refuses at the runner's lease
 *  mirror (LEASE_MIRROR_STALE) long before any workspace is prepared. */
const SECOND_INTENT = {
  ...EFFECT_INTENT, idempotencyKey: "idem-2", intentId: "intent-2",
  leaseBinding: SECOND_LEASE_RECORD,
} as const;
const SECOND_AGGREGATE = deriveActivationAggregateId(
  SECOND_INTENT.aggregateId, SECOND_INTENT.idempotencyKey);
const SECOND_DERIVED_WORKTREE = (() => {
  const derived = deriveWorktreeTarget({
    attemptId: SECOND_ATTEMPT_ID, baseIdentity: HEAD, projectId: PROJECT_ID,
    sourceRepositoryRoot: REPOSITORY.root, worktreeParent: REPOSITORY.parent,
  });
  if (!derived.ok) throw new Error(`second worktree fixture refused: ${derived.code}`);
  return derived.target.worktreePath;
})();

function secondActivationBytes(): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: "cmd-dispatch-2", correlationId: "corr-dispatch-2", decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: {
        ...ACTIVATION_SECTION,
        attempt: {
          ...ACTIVATION_SECTION.attempt,
          attemptId: SECOND_ATTEMPT_ID, intentId: SECOND_INTENT.intentId,
        },
        claim: {
          ...CLAIM, claimId: "claim-2", intentId: SECOND_INTENT.intentId,
          lockIdentity: "lock-2", wrapperIdentity: "wrapper-2",
        },
        leaseProof: SECOND_LEASE_PROOF, lockIdentity: "lock-2", wrapperIdentity: "wrapper-2",
      },
      effect: { command: { kind: "claim" }, intent: SECOND_INTENT },
      lease: { proof: SECOND_LEASE_PROOF, record: SECOND_LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-1", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-2", rows: [RESOURCE_ROW], slotRef: "slot-2" },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/** The second identity's request. Its `cwd` proposal names the worktree THIS
 *  attempt derives; proposing the first attempt's tree would refuse as a
 *  mismatch and never reach the comparison the isolation case is about. */
function secondDispatchRequest(): Record<string, unknown> {
  return {
    activationRequestBytes: secondActivationBytes(),
    binding: {
      attemptAggregateId: SECOND_AGGREGATE, nodeKey: NODE_KEY, sessionId: SECOND_SESSION_ID,
    },
    graphSnapshot: structuredClone(SINGLE_NODE_GRAPH),
    inputManifest: structuredClone(INPUT_MANIFEST),
    launchTemplate: { ...structuredClone(LAUNCH_TEMPLATE), cwd: SECOND_DERIVED_WORKTREE },
  };
}

const OBSERVATION = Object.freeze({
  activationDigest: DIGEST, completedAt: "2026-08-15T00:00:02.000Z",
  consumedGrantDigest: DIGEST_A, effectDigest: DIGEST_B, exit: { code: 0, kind: "EXITED" },
  freshRuntimeDigest: DIGEST_C, grantId: "grant-x", launcherVersion: "moe-claude-launcher/1",
  lockIdentity: "lock-1", observationDigest: DIGEST_A, pinnedClosureDigest: DIGEST_B,
  processIdentity: "windows:4242:99", quotedRuntimeDigest: DIGEST, reasonCode: null,
  reasonLayer: null, registrationDigest: DIGEST_C, runtimeBindingDigest: DIGEST,
  startedAt: "2026-08-15T00:00:01.000Z", stderr: { sha256: DIGEST_B }, stdout: { sha256: DIGEST_A },
  truthClass: "PROVEN", wrapperIdentity: "wrapper-1",
});
const REGISTRATION = Object.freeze({
  bootstrapCredentialDigest: DIGEST_B, lockIdentity: "lock-1", processIdentity: "windows:4242:99",
  registeredAt: "2026-08-15T00:00:01.000Z", wrapperIdentity: "wrapper-1",
});
const OBSERVED_RESULT = Object.freeze({
  code: null, kind: "OBSERVED", layer: null, observation: OBSERVATION, ok: true,
  registration: REGISTRATION, truthClass: "PROVEN",
});

function fakeGit(): GitObserver {
  return {
    headCommit: () => HEAD, lsFilesIgnored: () => [], lsFilesTracked: () => [],
    statusPorcelainV2: () => encoder.encode(`# branch.oid ${HEAD}\0`), submodulePaths: () => [],
  };
}

/** A genuinely digest-bound observation from the runner's own observer, so the
 *  result manifest is never sealed over a hand-written digest. */
function scopeObservation(): ScopeObservation {
  const observed = observeScope({
    baseIdentity: HEAD, declaredScopePaths: ["pkg/src"], gitObserver: fakeGit(),
    observedAt: "2026-08-15T00:00:02Z", observerVersion: "moe-runner-scope-observer/1",
    pathObserver: { exists: () => false, realpath: (path: string) => path },
    worktreeRoot: "fixture-root",
  });
  if (!observed.ok) throw new Error(`scope fixture failed: ${observed.code}`);
  return observed.observation;
}

function captureAnswer(): Record<string, unknown> {
  return {
    // `declaredArtifactRefs` EMPTY, matching the runner's production pin at
    // `foundation-workspace-capture.ts:221`; the Foundation artifact seal
    // refuses a caller-supplied roster (task-4a318d03 condition 2).
    authoredPaths: ["pkg/src/authored.ts"], declaredArtifactRefs: [],
    resultTreeEntries: [
      { byteLength: 10, kind: "REGULAR", origin: "INHERITED", path: "pkg/src/base.ts", sha256: DIGEST_A },
      { byteLength: 4, kind: "REGULAR", origin: "AUTHORED", path: "pkg/src/authored.ts", sha256: DIGEST_B },
    ],
    scopeObservation: scopeObservation(),
  };
}

interface Harness {
  readonly captureCalls: Record<string, unknown>[];
  readonly lifecycle: FoundationCaptureLifecycle;
  /** Every crossing of a boundary, in the order it happened. */
  readonly order: string[];
  readonly prepared: PrepareCaptureResult[];
  readonly releases: WorktreeReleaseRequest[];
  readonly service: { dispatch(input: unknown): Promise<FoundationAttemptOutcome> };
}

interface HarnessOptions {
  /** Omitted models an operator who configured no workspace catalog at all. */
  readonly catalog?: unknown;
  /** Omitted binds the sealing stand-in; the context arms inject their own port. */
  readonly contextSeal?: FoundationContextSealPort;
  readonly platform?: string;
}

/**
 * The durable ACTIVE graph revision the dispatch entry now DERIVES instead of receiving.
 * Driven through the real revision reducer, committed as the events it emitted, and the
 * body stored under the hash the revision names — the whole path, not a shaped literal.
 */
// --- v3 node-authority fixtures (task-8c7e6ce4) ------------------------------

/**
 * `GraphRevisionContent` v3 (task-6ba1ff89) makes `nodeAuthority` MANDATORY, and
 * `encodeGraphContent` RE-DERIVES the set it is handed rather than adopting it
 * (`graph-content.ts:120-141`), so a hand-built section can never pass. Everything below
 * COMPOSES the published producers — `createPlanRevision` / `createAcceptanceContract`
 * (@moe/core), then `createNodeDefinition` and `deriveNodeAuthoritySet` (@moe/scheduler) —
 * and judges nothing: each helper hands back what production returned, or throws carrying
 * production's own code, so a fixture that stopped building is never mistaken for a
 * boundary that stopped refusing.
 */
const AUTHORITY_HEX = (digit: string): string => digit.repeat(64);

const planDraftFor = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  affectedCriterionIds: ["criterion-a"],
  affectedNodeIds: [...nodeKeys],
  approvalState: "APPROVED",
  authorRef: "principal-a",
  graphBinding: { graphContentHash: AUTHORITY_HEX("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null,
  rejectionRef: null,
  revisionId: "plan-revision-a",
  steps: [{ description: "Land the node.", kind: "IMPLEMENTATION", stepId: "step-a" }],
  verificationRecipeRefs: ["recipe-a"],
});

const acceptanceDraftFor = (nodeKeys: readonly string[]): Record<string, unknown> => ({
  applicability: {
    graphContentHash: AUTHORITY_HEX("a"), graphRevisionRef: "graph-revision-a",
    nodeIds: [...nodeKeys], nodeKind: "LEAF",
  },
  authorRef: "principal-a",
  contractId: "acceptance-contract-a",
  obligations: [{
    criterionId: "criterion-a",
    evidenceRequirements: [
      { evidenceRef: "artifact-a", kind: "ARTIFACT", requirementId: "requirement-a" },
    ],
    statement: "The node ships its focused verification.",
    verificationRecipeRefs: ["recipe-a"],
  }],
});

/** Admitted by PRODUCTION or not built at all: a body the codec refuses could never reach
 *  the encode this fixture exists to feed. */
function nodeDefinitionFor(nodeKey: string, snapshot: GraphSnapshot): NodeDefinition {
  const nodeKeys = snapshot.nodes.map((node) => node.nodeKey);
  const plan = createPlanRevision(planDraftFor(nodeKeys));
  if (!plan.ok) throw new Error(`plan revision fixture refused: ${plan.code}`);
  const acceptance = createAcceptanceContract(acceptanceDraftFor(nodeKeys));
  if (!acceptance.ok) throw new Error(`acceptance fixture refused: ${acceptance.code}`);
  const completes = nodeKey === snapshot.completionNodeKey;
  const built = createNodeDefinition({
    acceptanceContract: acceptance.contract,
    draft: {
      admissionAmounts: [...ADMISSION_PURPOSES].sort().map((purpose, index) => ({
        meter: "runner.authorized_ms", purpose, quantity: index + 1,
      })),
      admissionGatePolicy: "POLICY_ALLOWANCE",
      capability: "capability-implement",
      completionLinkage: completes ? nodeKey : null,
      constraints: ["constraint-a"],
      directHardDependencies: [],
      joinRole: completes ? "COMPLETION" : "NONE",
      nodeKey,
      objective: `Land ${nodeKey}.`,
      policySliceHash: AUTHORITY_HEX("3"),
      readScopes: ["services/api/src"],
      repositoryBaseTree: AUTHORITY_HEX("4"),
      resources: ["resource-a"],
      verificationRecipeRevisions: ["recipe-a"],
      writeScopes: ["services/api/src/node"],
    },
    planRevision: plan.revision,
    predicateRegistry: [],
  });
  if (!built.ok) {
    throw new Error(built.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return built.value.definition;
}

/**
 * The authenticated half of a v3 record. `definitions` is sorted by `nodeKey` because
 * `readAuthoritySection` requires the two arrays index-aligned and STRICTLY ASCENDING
 * (`graph-content-fields.ts:121-147`), and `deriveNodeAuthoritySet` already returns its
 * entries in that order. `authorities` is the PRODUCER'S own value, never a rebuilt one:
 * `bindAuthority` re-derives and refuses GRAPH_CONTENT_AUTHORITY_DISAGREEMENT on any
 * stated set that is not the derived one.
 */
function authoritySectionFor(snapshot: GraphSnapshot): NodeAuthoritySection {
  const validated = validateGraphSnapshot(snapshot);
  if (!validated.ok) {
    throw new Error(`graph fixture refused: ${validated.issues[0]?.code ?? "?"}`);
  }
  const definitions = snapshot.nodes
    .map((node) => node.nodeKey)
    .slice()
    .sort()
    .map((nodeKey) => nodeDefinitionFor(nodeKey, snapshot));
  const derived = deriveNodeAuthoritySet(snapshot, definitions);
  if (!derived.ok) {
    throw new Error(derived.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return { authorities: derived.value, definitions };
}

/**
 * A PRECONDITION, not a rebuild — the same discipline `ensureActiveGraph` uses in
 * `activation-world-fixtures.ts`. `readyStore` now drives the shared activation world, whose
 * revision is ALSO `graph-revision-1`; committing this one on top of it reuses the command id
 * `seed-graph-revision-1` with different bytes and throws COMMAND_ID_CONFLICT, and forcing a
 * second revision id instead would publish a second ACTIVE revision and read as SPLIT_BRAIN.
 */
function seedActiveGraphRevision(store: SqliteEventStore): void {
  if (readCurrentActiveGraph(store, PROJECT_ID).ok) return;
  const snapshot: GraphSnapshot = {
    completionNodeKey: NODE_KEY, edges: [],
    nodes: [{ executionBearing: true, nodeKey: NODE_KEY }],
  };
  const content: GraphRevisionContent = {
    author: "human:architect-primary", completionNode: NODE_KEY, decompositionBudget: 24,
    nodeAuthority: authoritySectionFor(snapshot),
    parentRevision: "rev-000000000000", policyRevision: "pol-000000000001",
    repositoryBaseTree: "4".repeat(40), snapshot,
  };
  const encodedGraph = encodeGraphContent(content);
  if (!encodedGraph.ok) throw new Error("graph fixture failed to encode");
  const seed = (value: string): string => value.repeat(64).slice(0, 64);
  const binding = {
    budgetHash: seed("55"), expectedGoalVersion: 3,
    graphHash: encodedGraph.value.graphContentHash, policyHash: seed("66"),
    qualityHash: seed("33"),
  } as const;
  const revisionId = "graph-revision-1";
  let current: never | undefined;
  const events: { kind: string }[] = [];
  for (const command of [
    { commandId: "cmd-create", expectedVersion: 0, goalRef: "goal-1",
      graphContentHash: binding.graphHash, kind: "graph_revision.create",
      planHash: seed("11"), revisionId },
    { commandId: "cmd-submit", expectedVersion: 1, kind: "graph_revision.submit",
      witness: { submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED" } },
    { activation: { ...binding, activationRef: "activation-1", graphEpoch: 1,
      truthClass: "HUMAN_APPROVED" },
      approval: { ...binding, approvalRef: "approval-1", truthClass: "HUMAN_APPROVED" },
      commandId: "cmd-approve", expectedVersion: 2, kind: "graph.approve" },
  ] as never[]) {
    const reduced = reduceGraphRevision(current, command);
    if (!reduced.ok) throw new Error(`graph fixture rejected: ${reduced.error.code}`);
    current = reduced.state as never;
    events.push(...(reduced.events as readonly { kind: string }[]));
  }
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, revisionId);
  store.commit({
    aggregateId, commandBytes: new TextEncoder().encode(`seed-${revisionId}`),
    commandId: `seed-${revisionId}`, committedAt: DECIDED_AT,
    events: events.map((event, index) => ({
      eventId: `seed-${revisionId}-${index}`, eventType: event.kind,
      payload: new TextEncoder().encode(JSON.stringify(event)),
    })),
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
  const stored = putGraphBody(store, PROJECT_ID, encodedGraph.value);
  if (!stored.ok) throw new Error(`graph body fixture refused: ${stored.code}`);
}

const CATALOG = Object.freeze({
  catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
  entries: [{
    declaredPaths: [...REPOSITORY.paths], projectId: PROJECT_ID, repositoryRef: "repo-1",
    scopeRef: "scope-1", sourceRepositoryRoot: REPOSITORY.root,
    worktreeParent: REPOSITORY.parent,
  }],
});

/**
 * The launch boundary is recorded through the SAME order array the lifecycle
 * writes to, so "prepare happened before launch" is one sequence rather than two
 * counters that could both be satisfied in the wrong order.
 */
function recordingMaterializer(order: string[], releases: WorktreeReleaseRequest[]): WorktreeMaterializer {
  const real = createNodeWorktreeMaterializer(process.env);
  return Object.freeze({
    materialize: (request: WorktreeMaterializationRequest): WorktreeMaterializationResult => {
      order.push("materialize");
      return real.materialize(request);
    },
    release: (request: WorktreeReleaseRequest): WorktreeReleaseResult => {
      order.push("release");
      releases.push(request);
      return real.release(request);
    },
  });
}

/** The REAL lifecycle over the fixture repository, for the deps-fencing cases
 *  that construct the service directly instead of through `harness`. */
function lifecycleFor(store: SqliteEventStore): FoundationCaptureLifecycle {
  return createFoundationCaptureLifecycle({
    captureFs: createNodeFoundationCaptureFs(),
    catalogSource: (): unknown => CATALOG,
    clock: () => DECIDED_AT,
    materializer: createNodeWorktreeMaterializer(process.env),
    store,
  });
}

/** Post-launch workspace observation and the prepare-before-launch lifecycle are
 *  the ONLY dependencies. No runtime capability is composed here — the service
 *  mints its own through @moe/runner, and the lifecycle below is the REAL one. */
function harness(store: SqliteEventStore, options: HarnessOptions = {}): Harness {
  const captureCalls: Record<string, unknown>[] = [];
  const order = providerBoundaryProbe.order;
  const prepared: PrepareCaptureResult[] = [];
  const releases: WorktreeReleaseRequest[] = [];
  const real = createFoundationCaptureLifecycle({
    captureFs: createNodeFoundationCaptureFs(),
    catalogSource: (): unknown => ("catalog" in options ? options.catalog : CATALOG),
    clock: () => DECIDED_AT,
    materializer: recordingMaterializer(order, releases),
    store,
  });
  const lifecycle: FoundationCaptureLifecycle = Object.freeze({
    prepareCapture: async (input: PrepareCaptureInput): Promise<PrepareCaptureResult> => {
      order.push("prepare");
      const answer = await real.prepareCapture(input);
      prepared.push(answer);
      return answer;
    },
    releaseWorktree: (request: WorktreeReleaseRequest): WorktreeReleaseResult =>
      real.releaseWorktree(request),
  });
  const service = createFoundationAttemptService({
    context: options.contextSeal ?? sealingContextPort(order),
    captureResult: (input) => {
      order.push("capture");
      captureCalls.push(input);
      return captureAnswer();
    },
    launchOptions: { platform: options.platform ?? "linux" }, lifecycle, store,
  });
  return { captureCalls, lifecycle, order, prepared, releases, service };
}

function eventTypes(store: SqliteEventStore, aggregateId: string): readonly string[] {
  return store.readEvents(aggregateId).map((event) => event.eventType);
}

function expectRefusal(outcome: FoundationAttemptOutcome, code: string, refusedBy: string): void {
  expect(outcome).toMatchObject({ advisoryOnly: true, authority: "NONE", code, ok: false, refusedBy });
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    throw new TypeError(`${key} is not a record`);
  }
  return found as Record<string, unknown>;
}

function durableObservedFixture(label: string): {
  readonly bound: FoundationAttemptBound; readonly record: ActivationLedgerRecord;
  readonly store: SqliteEventStore; readonly value: Record<string, unknown>;
} {
  const store = readyStore(label);
  const activated = runEffectActivateCommand(store, activationBytes());
  if (!activated.ok) throw new Error(`activation refused: ${activated.code}`);
  const initial = readFoundationActivationHistory(
    ACTIVATION_AGGREGATE, store.readEvents(ACTIVATION_AGGREGATE), PROJECT_ID);
  if (!initial.ok) throw new Error(`activation unreadable: ${initial.result.status}`);
  const { record } = initial.history;
  const authority = createFoundationLauncherAuthority({
    aggregateId: ACTIVATION_AGGREGATE, correlationId: "corr-tail",
    key: { commandId: "cmd-tail", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    projectId: PROJECT_ID, store,
  });
  const consumed = authority.consumeGrantDurably(record.grant, record.grant.wrapperIdentity);
  const grant = nested(consumed as Record<string, unknown>, "grant");
  const preflight = {
    ...REGISTRATION, processIdentity: `pending:${record.grant.wrapperIdentity}`,
    registeredAt: "2026-08-15T00:00:00.500Z",
  };
  const reserved = authority.commitProcessRegistration({
    claim: CLAIM, phase: "PREFLIGHT", prior: null, registration: preflight,
  });
  const observed = authority.commitProcessRegistration({
    claim: CLAIM, phase: "STARTED", prior: null, registration: REGISTRATION,
  });
  if (nested(reserved as Record<string, unknown>, "registration")["processIdentity"]
      !== preflight.processIdentity
    || nested(observed as Record<string, unknown>, "registration")["processIdentity"]
      !== REGISTRATION.processIdentity) {
    throw new Error("production registration authority refused the fixture");
  }
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: ACTIVATION_AGGREGATE, claim: CLAIM, commandId: "cmd-dispatch-1",
    correlationId: "corr-dispatch", nodeKey: NODE_KEY, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId: SESSION_ID, target: DISPATCH_AGGREGATE,
  });
  const observation = {
    ...OBSERVATION, activationDigest: record.activationDigest, grantId: record.grant.grantId,
    launcherVersion: CLAUDE_LAUNCHER_VERSION, lockIdentity: REGISTRATION.lockIdentity,
    processIdentity: REGISTRATION.processIdentity, reasonCode: null, reasonLayer: null,
    truthClass: "PROVEN", wrapperIdentity: REGISTRATION.wrapperIdentity,
  };
  return { bound, record, store, value: {
    code: null, consumedGrant: grant, kind: "OBSERVED", layer: null,
    observation, ok: true, registration: { ...REGISTRATION }, truthClass: "PROVEN",
  } };
}

/**
 * The pre-launch context seal these arms are NOT about. Dispatch now refuses before any
 * provider effect unless a context manifest is durably sealed (task-203a5ca7), and the real
 * seal needs the whole 11-item context matrix world. These arms grade launch, settlement and
 * release, so they bind a stand-in that seals; the PRODUCTION seal composition is driven over a
 * real store in `foundation-context-record.test.ts`.
 */
function sealingContextPort(order: string[] = []): FoundationContextSealPort {
  return {
    sealFoundationContext: () => {
      order.push("seal");
      return Object.freeze({
        bytes: Object.freeze([123, 125]), contextManifestDigest: "d".repeat(64),
        ok: true as const,
      });
    },
  };
}

/** A port that refuses under an EXACT code and layer, and records that it was asked. */
function refusingContextPort(
  code: FoundationContextSealCode, order: string[] = [],
): FoundationContextSealPort {
  return {
    sealFoundationContext: () => {
      order.push("seal");
      return Object.freeze({
        code, detail: "the seal refused", layer: "FOUNDATION_CONTEXT_SEAL" as const,
        ok: false as const, upstream: null,
      });
    },
  };
}

/**
 * THE PRODUCTION PRE-LAUNCH CONTEXT SEAL, driven through the REAL dispatch (task-203a5ca7).
 *
 * These arms are the reason the seam exists: no provider effect may happen before the durable
 * context decision. They drive `createFoundationAttemptService(...).dispatch` over a real
 * SqliteEventStore and the real capture lifecycle, and inject only the seal PORT — the thing
 * whose refusal and whose ORDER are under test.
 */
describe("foundation attempt dispatch — pre-launch context seal (task-203a5ca7)", () => {
  it("refuses an unconfigured seal under its own code and layer, with zero provider effect", async () => {
    const store = readyStore("context-seal-unconfigured");
    const { order, service } = harness(store, {
      contextSeal: unconfiguredFoundationContextSealPort(),
    });

    const outcome = await service.dispatch(dispatchRequest());

    // The SEAL's own code and the SEAL's own layer, unrestamped as the attempt's.
    expectRefusal(outcome, "FOUNDATION_CONTEXT_SEAL_UNCONFIGURED", "FOUNDATION_CONTEXT_SEAL");
    // ZERO PARTIAL LAUNCH RESIDUE. "It refused" is not the same as "it left nothing behind":
    // both boundary counters are asserted, not just the returned verdict.
    expect(providerBoundaryProbe.launches).toHaveLength(0);
    expect(providerBoundaryProbe.commits).toHaveLength(0);
    expect(order).not.toContain("launch");
    expect(order).not.toContain("capture");
  });

  it("carries each distinct seal refusal code through unrestamped, with zero provider effect", async () => {
    const codes: readonly FoundationContextSealCode[] = [
      "FOUNDATION_CONTEXT_SEAL_CONFIGURATION_UNBOUND",
      "FOUNDATION_CONTEXT_SEAL_PROFILE_UNREADABLE",
      "FOUNDATION_CONTEXT_SEAL_REFUSED",
      "FOUNDATION_CONTEXT_SEAL_RUNTIME_UNOBSERVED",
      "FOUNDATION_CONTEXT_SEAL_UNCONFIGURED",
    ];
    // A SWEEP THAT GENERATES NOTHING PASSES. The generated count is asserted against the
    // roster length, so a table that silently emptied cannot read as five green cases.
    expect(codes.length).toBe(5);
    let generated = 0;
    for (const code of codes) {
      providerBoundaryProbe.commits.length = 0;
      providerBoundaryProbe.launches.length = 0;
      const store = readyStore(`context-seal-code-${code}`);
      const { service } = harness(store, { contextSeal: refusingContextPort(code) });

      const outcome = await service.dispatch(dispatchRequest());

      generated += 1;
      expectRefusal(outcome, code, "FOUNDATION_CONTEXT_SEAL");
      expect(providerBoundaryProbe.launches).toHaveLength(0);
      expect(providerBoundaryProbe.commits).toHaveLength(0);
    }
    expect(generated).toBe(codes.length);
  });

  it("seals the context BEFORE the provider boundary is ever crossed", async () => {
    const store = readyStore("context-seal-order");
    const { order, service } = harness(store);

    const outcome = await service.dispatch(dispatchRequest());

    // An outcome-only assertion cannot see an inverted order, so the SEQUENCE is asserted.
    expect(order).toContain("seal");
    expect(order).toContain("launch");
    expect(order.indexOf("seal")).toBeLessThan(order.indexOf("launch"));
    // The preparation must still precede the seal: the selection reads that preparation's own
    // durable capture context, so a seal taken first would describe an unprepared attempt.
    expect(order.indexOf("prepare")).toBeLessThan(order.indexOf("seal"));
    expect(outcome).toBeDefined();
  });
});

describe("foundation attempt dispatch — request fencing", () => {
  it("refuses every smuggled authority key with one exact code and layer", () => {
    const smuggled = [
      "grant", "effect", "attempt", "claim", "priorRegistration", "duplicateDelivery",
      "wrapperIdentity", "reconciliation", "freshRuntime", "registration",
    ];
    expect(smuggled.length).toBeGreaterThan(0);
    let generated = 0;
    for (const key of smuggled) {
      const template = { ...structuredClone(LAUNCH_TEMPLATE), [key]: { forged: true } };
      generated += 1;
      const decoded = decodeFoundationAttemptRequest(dispatchRequest({ launchTemplate: template }));
      expect(decoded.ok).toBe(false);
      expect(decoded).toMatchObject({
        code: "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    }
    expect(generated).toBe(smuggled.length);
  });

  it("refuses caller-supplied runtime capabilities with the exact local code", () => {
    const capabilities = ["fs", "facts", "clock"] as const;
    expect(capabilities).toHaveLength(3);
    let generated = 0;
    for (const capability of capabilities) {
      const runtime = {
        installedRoot: "C:\\installed", pinRoot: "C:\\pins", quotedObservation: {},
        [capability]: {},
      };
      const launchTemplate = { ...structuredClone(LAUNCH_TEMPLATE), runtime };
      const decoded = decodeFoundationAttemptRequest(dispatchRequest({ launchTemplate }));
      generated += 1;
      expect(decoded).toMatchObject({
        code: "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    }
    expect(generated).toBe(capabilities.length);
    expect(generated).toBeGreaterThan(0);
  });

  it("refuses an unknown top-level key and a missing one", () => {
    const extra = { ...dispatchRequest(), sessionSecret: "leak" };
    expectRefusal(
      decodeFoundationAttemptRequest(extra) as FoundationAttemptOutcome,
      "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", DAEMON_FOUNDATION_ATTEMPT);
    const missing = dispatchRequest();
    delete missing["binding"];
    expectRefusal(
      decodeFoundationAttemptRequest(missing) as FoundationAttemptOutcome,
      "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", DAEMON_FOUNDATION_ATTEMPT);
  });

  it("never invokes a getter on a hostile request", () => {
    let read = 0;
    const hostile = dispatchRequest();
    Object.defineProperty(hostile, "graphSnapshot", {
      configurable: true, enumerable: true,
      get: () => {
        read += 1;
        return SINGLE_NODE_GRAPH;
      },
    });
    const decoded = decodeFoundationAttemptRequest(hostile);
    expect(decoded.ok).toBe(false);
    expect(decoded).toMatchObject({ code: "FOUNDATION_ATTEMPT_REQUEST_MALFORMED" });
    expect(read).toBe(0);
  });

  it("contains revoked and throwing reflection proxies with the exact local refusal", () => {
    const revoked = Proxy.revocable(dispatchRequest(), {});
    revoked.revoke();
    const throwing = new Proxy(dispatchRequest(), {
      ownKeys: () => { throw new Error("hostile ownKeys"); },
    });
    const cases = [revoked.proxy, throwing];
    expect(cases).toHaveLength(2);
    expect(cases.length).toBeGreaterThan(0);
    for (const value of cases) {
      let decoded: unknown;
      try { decoded = decodeFoundationAttemptRequest(value); } catch { decoded = { threw: true }; }
      expect(decoded).toMatchObject({
        advisoryOnly: true, authority: "NONE", code: "FOUNDATION_ATTEMPT_REQUEST_MALFORMED",
        ok: false, refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    }
  });

  it("freezes the admitted request and round-trips the durable codec by digest", () => {
    const decoded = decodeFoundationAttemptRequest(dispatchRequest());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Object.isFrozen(decoded.request)).toBe(true);
    expect(Object.isFrozen(decoded.request.binding)).toBe(true);
    const encoded = encodeFoundationPayload({ b: 2, a: [1, "x"] });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const back = decodeFoundationPayload(encoded.bytes);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const again = encodeFoundationPayload(back.value);
    expect(again.ok && again.digest).toBe(encoded.digest);
    expect(again.ok && sameBytes(again.bytes, encoded.bytes)).toBe(true);
  });

  it("rejects every substituted PROVEN authority field against the durable tail", () => {
    const fixture = durableObservedFixture("durable-substitution");
    expect(readDurableFoundationObservation(
      fixture.store, fixture.bound, fixture.record, fixture.value)).not.toBeNull();
    const cases: readonly (readonly [string, (value: Record<string, unknown>) => void])[] = [
      ["outer truth", (value) => { value["truthClass"] = "UNKNOWN"; }],
      ["outer reason", (value) => { value["code"] = "CLAUDE_LAUNCH_CANCELLED";
        value["layer"] = "LAUNCHER"; }],
      ["grant id", (value) => { nested(value, "consumedGrant")["grantId"] = DIGEST_A; }],
      ["grant intent", (value) => { nested(value, "consumedGrant")["intentId"] = "intent-2"; }],
      ["grant wrapper", (value) => { nested(value, "consumedGrant")["wrapperIdentity"] = "wrapper-2"; }],
      ["grant state", (value) => { nested(value, "consumedGrant")["state"] = "UNUSED"; }],
      ["grant version", (value) => { nested(value, "consumedGrant")["version"] = 999; }],
      ["registration lock", (value) => { nested(value, "registration")["lockIdentity"] = "lock-2"; }],
      ["registration wrapper", (value) => { nested(value, "registration")["wrapperIdentity"] = "wrapper-2"; }],
      ["registration process", (value) => { nested(value, "registration")["processIdentity"] = "windows:7:7"; }],
      ["registration credential", (value) => { nested(value, "registration")["bootstrapCredentialDigest"] = DIGEST_C; }],
      ["registration moment", (value) => { nested(value, "registration")["registeredAt"] = "2026-08-15T00:00:09.000Z"; }],
      ["observation launcher", (value) => { nested(value, "observation")["launcherVersion"] = "forged/1"; }],
      ["observation truth", (value) => { const part = nested(value, "observation");
        part["truthClass"] = "UNKNOWN"; part["reasonCode"] = "CLAUDE_LAUNCH_CANCELLED";
        part["reasonLayer"] = "LAUNCHER"; }],
      ["observation activation", (value) => { nested(value, "observation")["activationDigest"] = DIGEST_B; }],
      ["observation grant", (value) => { nested(value, "observation")["grantId"] = DIGEST_C; }],
      ["observation lock", (value) => { nested(value, "observation")["lockIdentity"] = "lock-2"; }],
      ["observation wrapper", (value) => { nested(value, "observation")["wrapperIdentity"] = "wrapper-2"; }],
      ["observation process", (value) => { nested(value, "observation")["processIdentity"] = "windows:8:8"; }],
    ];
    expect(cases).toHaveLength(19);
    let generated = 0;
    for (const [, mutate] of cases) {
      const changed = structuredClone(fixture.value);
      mutate(changed);
      expect(readDurableFoundationObservation(
        fixture.store, fixture.bound, fixture.record, changed)).toBeNull();
      generated += 1;
    }
    expect(generated).toBe(cases.length);
    expect(generated).toBeGreaterThan(0);
  });
});

describe("foundation attempt dispatch — authority gates", () => {
  it("refuses a second execution-bearing node with no claim, activation or dispatch residue", async () => {
    const store = readyStore("multinode");
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;
    const run = harness(store);

    const outcome = await run.service.dispatch(
      dispatchRequest({ graphSnapshot: structuredClone(MULTI_NODE_GRAPH) }));

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_MULTI_NODE_UNSUPPORTED", DAEMON_FOUNDATION_ATTEMPT);
    expect(run.captureCalls).toHaveLength(0);
    expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
  });

  it("refuses a graph the scheduler admits that bears no execution node at all", async () => {
    const store = readyStore("no-bearing-node");
    const run = harness(store);
    // The scheduler ADMITS this graph — nothing is malformed about it — so the
    // refusal has to be this daemon's own, under its own layer.
    const inert = {
      completionNodeKey: NODE_KEY, edges: [],
      nodes: [{ executionBearing: false, nodeKey: NODE_KEY }],
    };

    const outcome = await run.service.dispatch(dispatchRequest({ graphSnapshot: inert }));

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_NODE_UNKNOWN", DAEMON_FOUNDATION_ATTEMPT);
    expect(run.captureCalls).toHaveLength(0);
    expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  it("refuses a node the graph does not bear and a session the activation does not hold", async () => {
    const store = readyStore("binding");
    const run = harness(store);

    const wrongNode = await run.service.dispatch(dispatchRequest({
      binding: { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: "dev-other", sessionId: SESSION_ID },
    }));
    expectRefusal(wrongNode, "FOUNDATION_ATTEMPT_BINDING_MISMATCH", DAEMON_FOUNDATION_ATTEMPT);
    expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);

    const wrongSession = await run.service.dispatch(dispatchRequest({
      binding: { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY, sessionId: "session-9" },
    }));
    expectRefusal(wrongSession, "FOUNDATION_ATTEMPT_BINDING_MISMATCH", DAEMON_FOUNDATION_ATTEMPT);
    expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  it("refuses an unverifiable pre-activation binding locally before any authority write", async () => {
    const store = readyStore("missing-session-binding");
    const run = harness(store);
    const envelope = JSON.parse(new TextDecoder().decode(activationBytes())) as {
      payload: { lease: { record: Record<string, unknown> } };
    };
    delete envelope.payload.lease.record["ownerSessionRef"];

    const outcome = await run.service.dispatch(dispatchRequest({
      bytes: encoder.encode(JSON.stringify(envelope)),
    }));

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_BINDING_MISMATCH", DAEMON_FOUNDATION_ATTEMPT);
    expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  it("refuses an unreservable dispatch identity before any authority write", async () => {
    const store = readyStore("oversized-identity");
    const run = harness(store);
    const wide = Object.fromEntries(Array.from(
      { length: 64 }, (_, index) => [`field${index}`, "x".repeat(8_192)]));
    const launchTemplate = {
      ...structuredClone(LAUNCH_TEMPLATE), launchSelection: wide, limits: wide,
    };

    const outcome = await run.service.dispatch(dispatchRequest({ launchTemplate }));

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_RECORD_DRIFT", DAEMON_FOUNDATION_ATTEMPT);
    expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  it("does not expose a whole-launch override that can mint PROVEN", async () => {
    const store = readyStore("whole-launch-override");
    let forgedCalls = 0;
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: captureAnswer,
      launch: async () => {
        forgedCalls += 1;
        return OBSERVED_RESULT;
      },
      launchOptions: { platform: "linux" },
      lifecycle: lifecycleFor(store), store,
    } as Parameters<typeof createFoundationAttemptService>[0]);

    const outcome = await service.dispatch(dispatchRequest());

    expectRefusal(outcome, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    expect(forgedCalls).toBe(0);
    const stored = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      reasonCode: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", reasonLayer: "LAUNCHER",
      resultManifest: null, truthClass: "UNKNOWN",
    });
  });

  it("does not forward a nested launcher dependency override", async () => {
    const store = readyStore("nested-launch-override");
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: captureAnswer,
      launchOptions: { deps: {}, platform: "linux" }, lifecycle: lifecycleFor(store), store,
    } as unknown as Parameters<typeof createFoundationAttemptService>[0]);

    const outcome = await service.dispatch(dispatchRequest());

    expectRefusal(outcome, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    const stored = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      reasonCode: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", reasonLayer: "LAUNCHER",
      resultManifest: null, truthClass: "UNKNOWN",
    });
  });

});

/**
 * A real store whose Nth EXPECTED-VERSION COMMIT aborts. Every other method is the genuine
 * store, so the abort is the only injected fact.
 *
 * BOTH commit seams are counted on ONE ordinal. The activation adapter commits through
 * `commitExpectedVersionDecisionLegs` (task-e194c5f6) while the budget and provider ledgers
 * still use the single-leg call, so watching only one of them would silently renumber which
 * commit "call 2" names — the injection would still fire, on a different write, and these
 * tests would keep passing while no longer testing what they say.
 */
const EXPECTED_VERSION_COMMITS = new Set([
  "commitExpectedVersionDecision",
  "commitExpectedVersionDecisionLegs",
]);

function abortingStore(store: SqliteEventStore, abortOnCall: number): {
  readonly fired: () => number; readonly store: SqliteEventStore;
} {
  let calls = 0, fired = 0;
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      if (typeof property !== "string" || !EXPECTED_VERSION_COMMITS.has(property)) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (input: CommitExpectedVersionDecisionInput) => {
        calls += 1;
        if (calls === abortOnCall) {
          fired += 1;
          throw new Error("injected SQLite transaction abort");
        }
        const forward = Reflect.get(target, property, receiver) as
          (value: unknown) => unknown;
        return forward.call(target, input);
      };
    },
  });
  return { fired: () => fired, store: proxy };
}

describe("foundation attempt dispatch — commit failures never launch", () => {
  it("aborts the activation commit, refuses with the ledger's own code, and launches nothing", async () => {
    const real = readyStore("abort-activation");
    const injected = abortingStore(real, 1);
    const run = harness(injected.store, { platform: "win32" });

    const outcome = await run.service.dispatch(dispatchRequest());

    expect(injected.fired()).toBe(1);
    expectRefusal(outcome, "ACTIVATION_LEDGER_STORE_UNAVAILABLE", "ACTIVATION_LEDGER");
    expect(run.captureCalls).toHaveLength(0);
    expect(real.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(real.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  it("aborts the reservation commit after a committed activation and still launches nothing", async () => {
    const real = readyStore("abort-reservation");
    // ORDINAL, AND IT MOVES WHEN A COMMIT IS ADDED — and it just moved again.
    // task-03049148 added the RESERVED -> ACTIVATED budget bind
    // (`activation-budget-binding.ts`), which commits inside
    // `runEffectActivateCommand` BEFORE the resource bind. One dispatch now
    // commits, in order: (1) the activation ledger record, (2) THE BUDGET BIND,
    // (3) the durable attempt-resource set bound by
    // `activation-resource-binding.ts`, (4) THIS reservation. Abort on 2 or 3 and
    // that bind absorbs it while the reservation succeeds, so the refusal arrives
    // from a later layer and this case silently stops testing the reservation. If
    // you add a commit to `runEffectActivateCommand`, count again here and in the
    // sibling Windows conformance case.
    const injected = abortingStore(real, 4);
    const run = harness(injected.store, { platform: "win32" });

    const outcome = await run.service.dispatch(dispatchRequest());

    expect(injected.fired()).toBe(1);
    expectRefusal(
      outcome, "FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE", DAEMON_FOUNDATION_ATTEMPT);
    expect(eventTypes(real, ACTIVATION_AGGREGATE)).toEqual(["EffectActivationCommitted"]);
    expect(real.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });
});

describe("foundation attempt dispatch — duplicate delivery and recovery", () => {
  it("keeps one claim and reservation across concurrent identical deliveries", async () => {
    const store = readyStore("concurrent");
    const run = harness(store);

    const first = run.service.dispatch(dispatchRequest());
    const second = run.service.dispatch(dispatchRequest());
    const loser = await second;
    const winner = await first;

    expectRefusal(winner, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    expectRefusal(loser, "FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS", DAEMON_FOUNDATION_ATTEMPT);
    expect(run.captureCalls).toHaveLength(0);
    expect(eventTypes(store, ACTIVATION_AGGREGATE)).toEqual(["EffectActivationCommitted"]);
    expect(eventTypes(store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
  });

  it("answers a replay after completion from the stored bytes without relaunching", async () => {
    const store = readyStore("replay");
    const run = harness(store);

    const first = await run.service.dispatch(dispatchRequest());
    expectRefusal(first, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    const stored = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(stored.ok).toBe(true);
    const second = await run.service.dispatch(dispatchRequest());

    expect(second.ok).toBe(true);
    expect(run.captureCalls).toHaveLength(0);
    expect(second.ok && stored.ok && second.digest).toBe(stored.ok ? stored.digest : "");
    expect(second.ok && second.record).toStrictEqual(stored.ok ? stored.record : null);
    expect(eventTypes(store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
  });

  it("refuses replay when launch-template bytes drift without overwriting", async () => {
    const store = readyStore("replay-template-drift");
    const run = harness(store);
    const first = await run.service.dispatch(dispatchRequest());
    expectRefusal(first, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    const before = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(before.ok).toBe(true);
    const changed = { ...structuredClone(LAUNCH_TEMPLATE), cwd: "D:/other-worktree" };

    const replay = await run.service.dispatch(dispatchRequest({ launchTemplate: changed }));

    expectRefusal(replay, "FOUNDATION_ATTEMPT_REPLAY_MISMATCH", DAEMON_FOUNDATION_ATTEMPT);
    expect(run.captureCalls).toHaveLength(0);
    expect(eventTypes(store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
    const stored = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(stored.ok && before.ok && stored.digest).toBe(before.ok ? before.digest : "");
  });

  it("reports the real runner's own UNSUPPORTED refusal on a non-Windows platform", async () => {
    const store = readyStore("platform");
    // NO launch port: this is the production default launcher, composed over the
    // durable authority ports, refusing at its own platform gate.
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: captureAnswer, launchOptions: { platform: "linux" },
      lifecycle: lifecycleFor(store), store,
    });

    const outcome = await service.dispatch(dispatchRequest());

    expectRefusal(outcome, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    const stored = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      reasonCode: "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", reasonLayer: "LAUNCHER",
      resultManifest: null, truthClass: "UNKNOWN",
    });
    // The grant was never consumed: the activation aggregate carries no tail.
    expect(eventTypes(store, ACTIVATION_AGGREGATE)).toEqual(["EffectActivationCommitted"]);
    // COMPOSITION, not export: the same production dispatch reached the attempt
    // release path, which now composes through `releaseWork`. NO ROW IS WRITTEN,
    // and that is the fail-closed answer rather than a regression: the safe
    // boundary (task-ded026d6), the terminal effect/resource facts
    // (task-6d400781) and the handoff (task-af9454f4) have no producer, so the
    // service reports what it has observed — nothing — and the kernel refuses.
    // A row here would mean the daemon had defaulted or minted one of them.
    const released = readAttemptRelease(store, ACTIVATION_AGGREGATE);
    expect(released.ok).toBe(false);
    expect(!released.ok && released.code).toBe("ATTEMPT_RELEASE_RECORD_ABSENT");
    // The dispatch answer is untouched by that refusal — the assertions above
    // already passed, and the durable dispatch record is still the real one.
  });

  it("refuses a read for an aggregate that has no dispatch record", () => {
    const store = readyStore("absent");
    expectRefusal(
      readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE) as FoundationAttemptOutcome,
      "FOUNDATION_ATTEMPT_RECORD_ABSENT", DAEMON_FOUNDATION_ATTEMPT);
    expectRefusal(
      readFoundationAttemptRecord(store, "") as FoundationAttemptOutcome,
      "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", DAEMON_FOUNDATION_ATTEMPT);
  });
});

describe("foundation attempt dispatch — the runtime closure is server-minted", () => {
  it("ignores a deps-supplied runtime capability set and never touches it", async () => {
    const store = readyStore("deps-runtime-ports");
    let touches = 0;
    const counting = {
      clock: { observedAt: () => { touches += 1; return DECIDED_AT; } },
      facts: { observe: async () => { touches += 1; return {}; } },
      fs: { hostPlatform: () => { touches += 1; return "win32"; } },
    };
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: captureAnswer, launchOptions: { platform: "linux" },
      lifecycle: lifecycleFor(store), runtimePorts: counting, store,
    } as unknown as Parameters<typeof createFoundationAttemptService>[0]);

    const outcome = await service.dispatch(dispatchRequest());

    expectRefusal(outcome, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    expect(touches).toBe(0);
  });

  it("refuses a quote whose digest no longer covers it, under the RUNTIME layer", async () => {
    const store = readyStore("quote-digest-drift");
    const run = harness(store);
    const quotedObservation = structuredClone(runtimeQuote()) as unknown as Record<string, unknown>;
    quotedObservation["reportedVersion"] = "claude/9.9.9-forged";
    const launchTemplate = {
      ...structuredClone(LAUNCH_TEMPLATE),
      runtime: { installedRoot: INSTALLED_ROOT, pinRoot: PIN_ROOT, quotedObservation },
    };

    const outcome = await run.service.dispatch(dispatchRequest({ launchTemplate }));

    expectRefusal(outcome, "CLAUDE_RUNTIME_QUOTE_INVALID", "RUNTIME");
    expect(run.captureCalls).toHaveLength(0);
    expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  it("refuses a runtime root the pin layer rejects, before any authority write", async () => {
    const store = readyStore("runtime-path-invalid");
    const run = harness(store);
    const launchTemplate = {
      ...structuredClone(LAUNCH_TEMPLATE),
      runtime: {
        installedRoot: `${INSTALLED_ROOT}${String.fromCharCode(7)}x`, pinRoot: PIN_ROOT,
        quotedObservation: runtimeQuote(),
      },
    };

    const outcome = await run.service.dispatch(dispatchRequest({ launchTemplate }));

    expectRefusal(outcome, "CLAUDE_RUNTIME_PATH_INVALID", "RUNTIME");
    expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  it("refuses every closure that does not declare exactly one EXECUTABLE", async () => {
    const closures: readonly (readonly Record<string, unknown>[])[] = [
      [{ kind: "PACKAGE", path: EXECUTABLE_PATH, sha256: DIGEST_A }],
      [
        { kind: "EXECUTABLE", path: EXECUTABLE_PATH, sha256: DIGEST_A },
        { kind: "EXECUTABLE", path: `${EXECUTABLE_PATH}.bak`, sha256: DIGEST_B },
      ],
    ];
    expect(closures).toHaveLength(2);
    let generated = 0;
    for (const closure of closures) {
      const store = readyStore(`closure-${generated}`);
      const run = harness(store);
      const launchTemplate = {
        ...structuredClone(LAUNCH_TEMPLATE),
        runtime: {
          installedRoot: INSTALLED_ROOT, pinRoot: PIN_ROOT,
          quotedObservation: runtimeQuote(closure),
        },
      };

      const outcome = await run.service.dispatch(dispatchRequest({ launchTemplate }));

      expectRefusal(outcome, "CLAUDE_RUNTIME_QUOTE_INVALID", "RUNTIME");
      expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
      generated += 1;
    }
    expect(generated).toBe(closures.length);
    expect(generated).toBeGreaterThan(0);
  });
});

/** Exactly the reservation body `foundation-attempt-service.ts` commits. The
 *  record commit is pinned at `expectedVersion` 1, so the dispatch aggregate has
 *  to reach version 1 first — and this is production store authority doing it,
 *  not a hand-written row. */
function reserveDispatch(
  store: SqliteEventStore, bound: FoundationAttemptBound, record: ActivationLedgerRecord,
): void {
  const reservation = encodeFoundationPayload({
    activationDigest: record.activationDigest, attemptAggregateId: bound.aggregateId,
    attemptId: record.attempt.attemptId, grantId: record.grant.grantId, nodeKey: bound.nodeKey,
    recordVersion: FOUNDATION_RESERVATION_VERSION, requestDigest: DIGEST_A,
    sessionId: bound.sessionId,
  });
  if (!reservation.ok) throw new Error(`reservation fixture refused: ${reservation.code}`);
  const written = commitFoundationPhase(
    store, bound, "RESERVED", reservation.bytes, 0, `${record.grant.grantId}:RESERVED`);
  if (written === null || written.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("reservation fixture was not committed");
  }
}

/** The sealed input manifest THIS daemon would hand the result builder, from the
 *  runner's own `buildInputManifest` — never hand-written. */
function sealedInput(): Record<string, unknown> {
  // The POSTLAUNCH record fixtures below never run through dispatch, and their
  // result-tree entries are cross-checked against this manifest by the runner's
  // own builder. They keep their own scope-shaped entry rather than borrowing
  // the dispatch proposal, which now names the real fixture repository's bytes.
  const built = buildInputManifest({
    baseIdentity: HEAD,
    entries: [{
      byteLength: 10, path: "pkg/src/base.ts", producer: { kind: "BASE" }, sha256: DIGEST_A,
    }] as never,
  });
  if (!built.ok) throw new Error(`input manifest fixture refused: ${built.code}`);
  return built.manifest as unknown as Record<string, unknown>;
}

interface ProvenGround {
  readonly bound: FoundationAttemptBound; readonly observation: unknown;
  readonly record: ActivationLedgerRecord; readonly registration: unknown;
  readonly store: SqliteEventStore;
}

/**
 * The durable precondition for a PROVEN record, with NO launcher anywhere: the
 * GRANT_CONSUMED -> PREFLIGHT_REGISTERED -> PROCESS_OBSERVED tail is built by
 * production `createFoundationLauncherAuthority`, and the (observation,
 * registration) pair below is whatever production
 * `readDurableFoundationObservation` validated against it — never a caller's copy.
 */
function provenGround(label: string): ProvenGround {
  const fixture = durableObservedFixture(label);
  const observed = readDurableFoundationObservation(
    fixture.store, fixture.bound, fixture.record, fixture.value);
  if (observed === null) throw new Error("durable observation fixture was refused");
  reserveDispatch(fixture.store, fixture.bound, fixture.record);
  return {
    bound: fixture.bound, observation: observed[0], record: fixture.record,
    registration: observed[1], store: fixture.store,
  };
}

describe("foundation attempt dispatch — the PROVEN record is durable", () => {
  it("persists result-manifest identity, the durable registration and raw stream digests", () => {
    const ground = provenGround("proven-record");
    const input = sealedInput();
    const answer = captureAnswer();
    const expected = buildResultManifest({
      authoredPaths: answer["authoredPaths"] as never,
      declaredArtifactRefs: answer["declaredArtifactRefs"] as never,
      inputManifest: input as never, resultTreeEntries: answer["resultTreeEntries"] as never,
      scopeObservation: answer["scopeObservation"] as never,
    });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;

    const outcome = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record, input,
      { answer, observation: ground.observation, registration: ground.registration });

    expect(outcome.ok).toBe(true);
    // Every assertion below reads the RE-DECODED, byte-compared durable bytes.
    const stored = readFoundationAttemptRecord(ground.store, ACTIVATION_AGGREGATE);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const durable = stored.record;
    // The shape only the PROVEN branch can produce.
    expect(durable["truthClass"]).toBe("PROVEN");
    expect(durable["reasonCode"]).toBeNull();
    expect(durable["reasonLayer"]).toBeNull();
    // The runner's own result-manifest identity, bound to THIS daemon's sealed
    // input. `null` here is precisely what every stored record carried before
    // this branch was ever executed, so it gets its own assertion.
    expect(durable["resultManifest"]).not.toBeNull();
    const manifest = nested(durable, "resultManifest");
    expect(manifest["sha256"]).toBe(expected.manifest.sha256);
    expect(manifest["manifestVersion"]).toBe("moe-workspace-result-manifest/1");
    expect(manifest["inputManifestSha256"]).toBe(input["sha256"]);
    expect(manifest["scopeObservationSha256"])
      .toBe((answer["scopeObservation"] as ScopeObservation).sha256);
    expect(manifest["baseIdentity"]).toBe(HEAD);
    expect(manifest["authoredPaths"]).toStrictEqual(["pkg/src/authored.ts"]);
    // The registration is the durable PROCESS_OBSERVED one, not the PREFLIGHT one.
    // Spread into a fresh literal: the durable bytes decode onto a NULL
    // prototype, which `toStrictEqual` reports as an invisible difference.
    expect({ ...nested(durable, "registration") }).toStrictEqual({ ...REGISTRATION });
    expect(nested(durable, "registration")["processIdentity"])
      .not.toBe(`pending:${ground.record.grant.wrapperIdentity}`);
    expect({ ...nested(durable, "observation") }).toStrictEqual({
      completedAt: "2026-08-15T00:00:02.000Z", consumedGrantDigest: DIGEST_A,
      freshRuntimeDigest: DIGEST_C, observationDigest: DIGEST_A, pinnedClosureDigest: DIGEST_B,
      quotedRuntimeDigest: DIGEST, registrationDigest: DIGEST_C, runtimeBindingDigest: DIGEST,
      startedAt: "2026-08-15T00:00:01.000Z",
    });
    // Raw evidence digests, exact values — "a digest is there" would pass for the wrong one.
    expect(durable["stdoutSha256"]).toBe(DIGEST_A);
    expect(durable["stderrSha256"]).toBe(DIGEST_B);
    expect(durable["activationDigest"]).toBe(ground.record.activationDigest);
    expect(durable["grantId"]).toBe(ground.record.grant.grantId);
    expect(durable["attemptId"]).toBe(ground.record.attempt.attemptId);
    const persisted = nested(durable, "inputManifest");
    expect(persisted["sha256"]).toBe(input["sha256"]);
    expect(persisted["manifestVersion"]).toBe(input["manifestVersion"]);
    expect(persisted["baseIdentity"]).toBe(HEAD);
    expect(persisted["entries"]).toHaveLength(1);
    // One record, committed under an event id COPIED from the grant.
    const events = ground.store.readEvents(DISPATCH_AGGREGATE);
    expect(events.map((event) => event.eventType))
      .toStrictEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
    expect(events[1]?.eventId).toBe(`${ground.record.grant.grantId}:RECORDED`);

    // A byte-identical replay adopts the one record it already wrote.
    const again = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record, input,
      { answer, observation: ground.observation, registration: ground.registration });
    expect(again.ok && again.digest).toBe(stored.digest);
    expect(ground.store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(2);

    // A DIFFERING record cannot overwrite it: the aggregate has moved past
    // `expectedVersion` 1 and the grant's own event id is already spent.
    const conflicting = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record, input,
      {
        answer: { authoredPaths: [] }, observation: ground.observation,
        registration: ground.registration,
      });

    expectRefusal(conflicting, "FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS", DAEMON_FOUNDATION_ATTEMPT);
    expect(ground.store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(2);
    const settled = readFoundationAttemptRecord(ground.store, ACTIVATION_AGGREGATE);
    expect(settled.ok && settled.digest).toBe(stored.digest);
  });

  it("refuses a sealed input manifest of the wrong shape as the DAEMON's own fact", () => {
    const ground = provenGround("proven-input-manifest");

    const outcome = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record, { baseIdentity: HEAD, entries: [] },
      {
        answer: captureAnswer(), observation: ground.observation,
        registration: ground.registration,
      });

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_INPUT_MANIFEST_INVALID", DAEMON_FOUNDATION_ATTEMPT);
    const stored = readFoundationAttemptRecord(ground.store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      reasonCode: "FOUNDATION_ATTEMPT_INPUT_MANIFEST_INVALID",
      reasonLayer: DAEMON_FOUNDATION_ATTEMPT, resultManifest: null, truthClass: "UNKNOWN",
    });
  });

  it("keeps the RUNNER's own code and layer when its builder refuses the manifest", () => {
    const ground = provenGround("proven-runner-manifest");
    // Shape-valid, so the daemon's structural fence admits it; the digest no
    // longer recomputes, so the RUNNER is the layer that answers. Two questions,
    // two layers — a test pinning only a code could not tell them apart.
    const drifted = { ...sealedInput(), sha256: DIGEST_C };

    const outcome = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record, drifted,
      {
        answer: captureAnswer(), observation: ground.observation,
        registration: ground.registration,
      });

    expectRefusal(outcome, "RUNNER_WORKSPACE_INPUT_MANIFEST_INVALID", RUNNER_WORKSPACE_LAYER);
    const stored = readFoundationAttemptRecord(ground.store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      reasonCode: "RUNNER_WORKSPACE_INPUT_MANIFEST_INVALID", reasonLayer: RUNNER_WORKSPACE_LAYER,
      resultManifest: null, truthClass: "UNKNOWN",
    });
  });

  it("persists an honest UNKNOWN when the capture answer is not the exact shape", () => {
    const ground = provenGround("proven-capture-unknown");

    const outcome = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record, sealedInput(),
      {
        answer: { authoredPaths: [] }, observation: ground.observation,
        registration: ground.registration,
      });

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN", DAEMON_FOUNDATION_ATTEMPT);
    const stored = readFoundationAttemptRecord(ground.store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      reasonCode: "FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN", reasonLayer: DAEMON_FOUNDATION_ATTEMPT,
      resultManifest: null, truthClass: "UNKNOWN",
    });
    // The durable registration and observation are still recorded honestly.
    expect({ ...nested(stored.ok ? stored.record : {}, "registration") })
      .toStrictEqual({ ...REGISTRATION });
  });
});

describe("foundation attempt dispatch — the record event type is stable", () => {
  it("names the two durable event types this service may ever write", () => {
    expect(FOUNDATION_DISPATCH_EVENT_TYPES).toStrictEqual({
      RECORDED: "FoundationAttemptRecorded", RESERVED: "FoundationDispatchReserved",
    });
  });
});

/**
 * THE PHYSICAL PROVIDER-RUN BOUNDARY, composed at the real dispatch call site.
 *
 * Every fact below is read back through the SHIPPED reader
 * (`readCurrentProviderRun`) rather than off the value dispatch returned: the
 * claim is that a durable, decision-verified provider run exists, and a return
 * value cannot say that. The launch here is the real launcher's own non-Windows
 * refusal, which is a BLIND handoff — `ok: true` carrying UNKNOWN facts — and a
 * blind handoff is exactly the case a composition that only ever ran on the
 * happy path would drop.
 */
describe("foundation attempt dispatch — the provider run reaches the ledger", () => {
  /** Every provider-run event in the store, read off the reserved type. */
  function providerEvents(store: SqliteEventStore) {
    return store.readEventsByTypeAfter(PROVIDER_RUN_EVENT_TYPE, 0n, 100).items;
  }

  /** The provider-run commit decisions, read from the durable decision log. */
  function providerDecisions(store: SqliteEventStore) {
    return store.readCommandDecisionsAfter(0n, 200).items
      .filter((decision) => decision.commandKind === PROVIDER_RUN_COMMAND_KIND);
  }

  /** Ask the production codec for the exact Foundation identity bytes. */
  function dispatchIdentityBytes(input: unknown): Uint8Array {
    const decoded = decodeFoundationAttemptRequest(input);
    if (!decoded.ok) throw new Error(`dispatch decode refused: ${decoded.code}`);
    const sealed = buildInputManifest({
      baseIdentity: decoded.request.inputManifest.baseIdentity,
      entries: decoded.request.inputManifest.entries as never,
    });
    if (!sealed.ok) throw new Error(`input manifest refused: ${sealed.code}`);
    const identity = identifyFoundationDispatch(
      decoded.request, sealed.manifest as unknown as Record<string, unknown>);
    if (!identity.ok) throw new Error(`dispatch identity refused: ${identity.code}`);
    return identity.bytes;
  }

  it("commits one blind provider record bound to the DURABLE lease session", async () => {
    const store = readyStore("provider-blind");
    const { service } = harness(store);
    const request = dispatchRequest();
    const expectedRequestBytes = dispatchIdentityBytes(request);

    const outcome = await service.dispatch(request);

    // The Foundation answer is unchanged: the launcher's own refusal, its own
    // layer. Composing the provider run must not restamp it.
    expectRefusal(outcome, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");

    // EXACTLY ONE physical composition: one event, one decision.
    expect(providerBoundaryProbe.launches).toHaveLength(1);
    expect(providerBoundaryProbe.commits).toHaveLength(1);
    const launch = providerBoundaryProbe.launches[0];
    const commit = providerBoundaryProbe.commits[0];
    if (launch === undefined || commit === undefined) throw new Error("provider boundary not called");
    expect(commit.input.launch).toBe(launch.result);
    expect(launch.input.providerRun).toEqual({
      attemptRef: "attempt-1", effectIntentId: "intent-1", epoch: 3,
      provider: "claude", runRef: DISPATCH_AGGREGATE,
    });
    const providerCommandId = `${DISPATCH_AGGREGATE}:provider-run`;
    expect(commit.input.key).toEqual({
      commandId: providerCommandId, principalId: SESSION_ID, projectId: PROJECT_ID,
    });
    expect(commit.input.correlationId).toBe(providerCommandId);
    expect(commit.input.decidedAt).toBe(DECIDED_AT);
    expect(commit.input.clock).toEqual({ observedEnd: null, observedStart: null });
    expect(sameBytes(commit.input.requestBytes, expectedRequestBytes)).toBe(true);
    expect(providerEvents(store)).toHaveLength(1);
    const decisions = providerDecisions(store);
    expect(decisions).toHaveLength(1);

    const read = readCurrentProviderRun(store, { attemptRef: "attempt-1", projectId: PROJECT_ID });
    if (!("record" in read)) {
      const code = "code" in read ? String(read.code) : "UNKNOWN";
      const layer = "layer" in read ? String(read.layer) : "UNKNOWN";
      throw new Error(`provider reader refused ${code}@${layer}`);
    }
    expect(read.ok).toBe(true);

    // THE RUN IDENTITY, server-derived field by field. `runRef` is the dispatch
    // aggregate the service already derived; nothing here is caller-supplied.
    expect(read.record.providerRunRef).toEqual({
      attemptRef: "attempt-1", effectIntentId: "intent-1", epoch: 3,
      provider: "claude", runRef: DISPATCH_AGGREGATE,
    });

    // THE BINDING THE READER ENFORCES. The reader requires the decision's
    // principal to be the lease's owner session; the two are deliberately
    // different values in this fixture, so a writer that used the envelope
    // principal would refuse PROVIDER_RUN_BINDING_MISMATCH instead of reading.
    expect(read.sessionId).toBe(SESSION_ID);
    expect(SESSION_ID).not.toBe(PRINCIPAL_ID);

    // A REFUSED launch is durable UNKNOWN evidence, not a success and not a gap.
    expect(read.record.launch.kind).toBe("REFUSED");
    expect(read.record.terminal).toBe("REFUSED");
    expect(read.record.infrastructure).toBe("LAUNCH_REFUSED");
    expect(read.record.upstreamRefusal?.code).toBe("TELEMETRY_LAUNCH_REFUSED");
    expect(read.record.upstreamRefusal?.layer).toBe("TELEMETRY_LAUNCH");
    // No daemon boot/monotonic observation exists to read, so both stay null
    // rather than being invented from the launcher's wall stamps.
    expect(read.record.observedStart).toBeNull();
    expect(read.record.observedEnd).toBeNull();

    const [decision] = decisions;
    expect(decision?.key.projectId).toBe(PROJECT_ID);
    expect(decision?.key.principalId).toBe(SESSION_ID);
  });

  /**
   * THE CALLER-AUTHORITY FENCE. Every name below is a fact only the physical
   * boundary may supply; a request carrying one must die at the decoder, before
   * any authority is built and before a single durable row exists.
   */
  const SMUGGLED_FIELDS = [
    "providerRun", "providerRunRef", "runRef", "epoch",
    "exit", "reconciliation", "terminal", "infrastructure",
    "observation", "safeBoundaryObserved", "launcher", "launch", "deps", "clock",
  ] as const;

  it.each(SMUGGLED_FIELDS.map((field) => [field]))(
    "refuses a request smuggling %s before any provider row exists",
    async (field: string) => {
      const store = readyStore(`smuggle-${field}`);
      const { service } = harness(store);

      const outcome = await service.dispatch({ ...dispatchRequest(), [field]: {} });

      expectRefusal(outcome, "FOUNDATION_ATTEMPT_REQUEST_MALFORMED", DAEMON_FOUNDATION_ATTEMPT);
      // Nothing was launched, composed or committed — not even an activation.
      expect(providerEvents(store)).toHaveLength(0);
      expect(providerDecisions(store)).toHaveLength(0);
      expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
      expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
    },
  );

  it("generated a nonempty smuggling sweep", () => {
    // A sweep that silently produced zero cases passes while testing nothing.
    expect(SMUGGLED_FIELDS.length).toBeGreaterThan(0);
  });

  /** Everything a second dispatch must not move. Counts AND bytes: a re-commit
   *  that happened to produce identical bytes would still move the counts. */
  function providerSnapshot(store: SqliteEventStore): {
    readonly bytes: readonly number[]; readonly decisions: number; readonly digest: string;
    readonly events: number; readonly horizon: bigint;
    readonly rawDecisions: number; readonly rawEvents: number;
  } {
    const read = readCurrentProviderRun(store, { attemptRef: "attempt-1", projectId: PROJECT_ID });
    if (!("recordDigest" in read)) throw new Error("a provider record must exist to snapshot");
    const providerEvent = providerEvents(store)[0];
    if (providerEvent === undefined) throw new Error("a provider event must exist to snapshot");
    return {
      bytes: Array.from(providerEvent.payload),
      decisions: providerDecisions(store).length, digest: read.recordDigest,
      events: providerEvents(store).length, horizon: store.readEventHorizon(),
      rawDecisions: store.readCommandDecisionsAfter(0n, 200).items.length,
      rawEvents: store.readEventsAfter(0n, 200).items.length,
    };
  }

  it("replays without launching, committing or moving a single provider byte", async () => {
    const store = readyStore("provider-replay");
    const run = harness(store);

    const first = await run.service.dispatch(dispatchRequest());
    expectRefusal(first, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    const before = providerSnapshot(store);
    expect(before.events).toBe(1);
    expect(providerBoundaryProbe.launches).toHaveLength(1);
    expect(providerBoundaryProbe.commits).toHaveLength(1);

    const replay = await run.service.dispatch(dispatchRequest());

    // A SECOND physical launch is the defect this whole task can introduce, and
    // even an idempotent provider commit cannot hide it from the adapter counter.
    expect(providerBoundaryProbe.launches).toHaveLength(1);
    expect(providerBoundaryProbe.commits).toHaveLength(1);
    // The replay adopts the stored Foundation record rather than dispatching.
    expect(replay.ok).toBe(true);
    expect(providerSnapshot(store)).toEqual(before);
  });

  it("refuses a drifted command before the provider boundary and preserves the run", async () => {
    const store = readyStore("provider-drift");
    const run = harness(store);

    const first = await run.service.dispatch(dispatchRequest());
    expectRefusal(first, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    const before = providerSnapshot(store);

    const changed = { ...structuredClone(LAUNCH_TEMPLATE), cwd: "D:/other-worktree" };
    const drifted = await run.service.dispatch(dispatchRequest({ launchTemplate: changed }));

    // The reservation fence answers FIRST — before any authority, adapter or
    // provider commit — so the drifted command never reaches the boundary.
    expectRefusal(drifted, "FOUNDATION_ATTEMPT_REPLAY_MISMATCH", DAEMON_FOUNDATION_ATTEMPT);
    expect(providerBoundaryProbe.launches).toHaveLength(1);
    expect(providerBoundaryProbe.commits).toHaveLength(1);
    expect(providerSnapshot(store)).toEqual(before);
  });

  it("keeps the provider ledger's own refusal when the provider commit aborts", async () => {
    const real = readyStore("provider-commit-abort");
    // ORDINAL, AND IT MOVES WHEN A COMMIT IS ADDED — and it just moved again.
    // One dispatch commits, in order: (1) the activation ledger record, (2) the
    // BUDGET BIND added by task-03049148, (3) the durable attempt-resource set,
    // (4) the Foundation reservation, (5) the prelaunch CAPTURE CONTEXT, (6) THIS
    // provider-run commit. Aborting 5 now hits the capture ledger and this case
    // would stop testing the provider one, so the number is 6. Count again rather
    // than trusting it.
    const injected = abortingStore(real, 6);
    const run = harness(injected.store);

    const outcome = await run.service.dispatch(dispatchRequest());

    expect(injected.fired()).toBe(1);
    // The LEDGER's own code and layer, preserved rather than restamped as a
    // Foundation code: which authority refused is the fact worth keeping.
    expectRefusal(outcome, "PROVIDER_RUN_STORE_UNAVAILABLE", "PROVIDER_RUN_LEDGER");
    expect(providerBoundaryProbe.launches).toHaveLength(1);
    expect(providerBoundaryProbe.commits).toHaveLength(1);
    expect(providerBoundaryProbe.commits[0]?.result).toStrictEqual({
      code: "PROVIDER_RUN_STORE_UNAVAILABLE", layer: "PROVIDER_RUN_LEDGER",
      ok: false, outcome: "REFUSED", storeCode: null,
    });
    // Zero residue at the provider boundary, and no false reader authority.
    expect(providerEvents(real)).toHaveLength(0);
    expect(providerDecisions(real)).toHaveLength(0);
    const read = readCurrentProviderRun(real, { attemptRef: "attempt-1", projectId: PROJECT_ID });
    expect(read).toStrictEqual({
      code: "PROVIDER_RUN_EVIDENCE_ABSENT", layer: "PROVIDER_RUN_READER",
      ok: false, outcome: "UNKNOWN", storeCode: null,
    });
  });

  it("refuses a foreign project against an accepted record and changes no counts", async () => {
    const store = readyStore("provider-foreign");
    const run = harness(store);

    await run.service.dispatch(dispatchRequest());
    const before = providerSnapshot(store);

    const foreign = readCurrentProviderRun(
      store, { attemptRef: "attempt-1", projectId: "proj-someone-else" });

    // The project gate answers before a single page is read: a store scoped to
    // another project holds no evidence about this one.
    expect(foreign).toMatchObject({
      code: "PROVIDER_RUN_BINDING_MISMATCH", layer: "PROVIDER_RUN_READER", ok: false,
    });
    expect(providerSnapshot(store)).toEqual(before);
  });
});

/**
 * PREPARE-BEFORE-LAUNCH, through the production service.
 *
 * The lifecycle here is the REAL one over a real temp repository; only its
 * boundary crossings are recorded. `providerBoundaryProbe.order` is the single
 * sequence both the lifecycle and the launch boundary write into, so "prepare
 * came first" is asserted as an ORDER rather than as two counters that could
 * both be satisfied by an inverted run.
 */
describe("foundation attempt dispatch — the workspace is prepared before launch", () => {
  it("prepares exactly once, before the launch boundary, and launches in the assignment", async () => {
    const run = harness(readyStore("prepare-order"));

    const outcome = await run.service.dispatch(dispatchRequest());

    // The runner refuses a non-Windows launch, which is downstream of both the
    // preparation and the launch boundary this case is about.
    expect(outcome.ok).toBe(false);
    expect(run.order.indexOf("prepare")).toBe(0);
    expect(run.order.indexOf("prepare")).toBeLessThan(run.order.indexOf("launch"));
    expect(run.order.filter((entry) => entry === "prepare")).toHaveLength(1);
    expect(run.order.filter((entry) => entry === "materialize")).toHaveLength(1);
    expect(providerBoundaryProbe.launches).toHaveLength(1);

    const prepared = run.prepared[0];
    if (prepared === undefined || !prepared.ok) throw new Error("preparation must have succeeded");
    // THE LAUNCH ROOT IS THE ASSIGNMENT, not the template's proposal.
    const launched = providerBoundaryProbe.launches[0];
    expect((launched?.input.request as Record<string, unknown>)["cwd"])
      .toBe(prepared.assignment.realWorktreePath);
    expect(prepared.assignment.baseIdentity).toBe(HEAD);
  });

  /**
   * THE SEPARATOR FOR "the assignment is the root". An accepted proposal that is
   * BYTE-EQUAL to the assignment cannot discriminate: passing the template
   * through unchanged would look identical. A proposal that names the SAME tree
   * with a trailing separator is admitted by the path comparison and is still a
   * different string, so the launch root proves whose value it is.
   */
  it("launches in the assignment even when the proposal spells the same tree differently", async () => {
    const run = harness(readyStore("prepare-spelling"));

    const outcome = await run.service.dispatch(dispatchRequest({
      launchTemplate: { ...structuredClone(LAUNCH_TEMPLATE), cwd: `${DERIVED_WORKTREE}${sep}` },
    }));

    expect(outcome.ok).toBe(false);
    const prepared = run.prepared[0];
    if (prepared === undefined || !prepared.ok) throw new Error("preparation must have succeeded");
    const launched = providerBoundaryProbe.launches[0];
    expect((launched?.input.request as Record<string, unknown>)["cwd"])
      .toBe(prepared.assignment.realWorktreePath);
    expect((launched?.input.request as Record<string, unknown>)["cwd"])
      .not.toBe(`${DERIVED_WORKTREE}${sep}`);
  });

  it("refuses a conflicting cwd proposal under the capture code, launching nothing", async () => {
    const run = harness(readyStore("prepare-mismatch"));

    const outcome = await run.service.dispatch(dispatchRequest({
      launchTemplate: { ...structuredClone(LAUNCH_TEMPLATE), cwd: join(REPOSITORY.root, "elsewhere") },
    }));

    expectRefusal(outcome, "FOUNDATION_CAPTURE_WORKSPACE_MISMATCH", DAEMON_FOUNDATION_CAPTURE);
    expect(providerBoundaryProbe.launches).toHaveLength(0);
    expect(run.order).not.toContain("launch");
    expect(run.captureCalls).toHaveLength(0);
  });

  it("records the unproven attempt under the deciding code and layer", async () => {
    const store = readyStore("prepare-mismatch-record");
    const run = harness(store);

    await run.service.dispatch(dispatchRequest({
      launchTemplate: { ...structuredClone(LAUNCH_TEMPLATE), cwd: join(REPOSITORY.root, "nope") },
    }));

    // The durable ADVISORY record, read back from the attempt aggregate the
    // service settles onto, carries the deciding authority's own pair.
    const stored = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      reasonCode: "FOUNDATION_CAPTURE_WORKSPACE_MISMATCH",
      reasonLayer: DAEMON_FOUNDATION_CAPTURE, resultManifest: null, truthClass: "SUSPECT",
    });
  });

  it("refuses when NO workspace catalog is configured, and launches nothing", async () => {
    const run = harness(readyStore("prepare-no-catalog"), { catalog: undefined });

    const outcome = await run.service.dispatch(dispatchRequest());

    expectRefusal(outcome, "FOUNDATION_CAPTURE_CATALOG_CONFIG_ABSENT", DAEMON_FOUNDATION_CAPTURE);
    expect(providerBoundaryProbe.launches).toHaveLength(0);
    expect(run.order).toEqual(["prepare"]);
  });

  it("threads ONE immutable captureRef, derived from the durable slot", async () => {
    const store = readyStore("prepare-ref");
    const run = harness(store);

    await run.service.dispatch(dispatchRequest());

    const prepared = run.prepared[0];
    if (prepared === undefined || !prepared.ok) throw new Error("preparation must have succeeded");
    expect(prepared.captureRef).toBe(deriveFoundationCaptureRef({
      attemptAggregateId: ACTIVATION_AGGREGATE, attemptId: "attempt-1", nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION_ID,
    }));
    const read = readFoundationCaptureContext(store, prepared.captureRef);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record.assignment.realWorktreePath).toBe(prepared.assignment.realWorktreePath);
  });

  it("RETAINS the worktree when settlement is unproven", async () => {
    const run = harness(readyStore("prepare-retain"));

    const outcome = await run.service.dispatch(dispatchRequest());

    expect(outcome.ok).toBe(false);
    // The lifecycle's own refusal arms release; a launch that could not be proven
    // must NOT, because the tree is the only evidence of what the attempt saw.
    expect(run.releases).toHaveLength(0);
    expect(run.order).not.toContain("release");
  });

  it("REPLAY neither prepares nor launches a second time", async () => {
    const store = readyStore("prepare-replay");
    const run = harness(store);

    const first = await run.service.dispatch(dispatchRequest());
    expectRefusal(first, "CLAUDE_LAUNCH_PLATFORM_UNSUPPORTED", "LAUNCHER");
    const preparesAfterFirst = run.order.filter((entry) => entry === "prepare").length;
    const launchesAfterFirst = providerBoundaryProbe.launches.length;
    expect(preparesAfterFirst).toBe(1);
    expect(launchesAfterFirst).toBe(1);

    // The replay is answered from the DURABLE record the first attempt settled.
    const replayed = await run.service.dispatch(dispatchRequest());

    expect(replayed.ok).toBe(true);
    expect(run.order.filter((entry) => entry === "prepare")).toHaveLength(preparesAfterFirst);
    expect(providerBoundaryProbe.launches).toHaveLength(launchesAfterFirst);
    expect(run.order.filter((entry) => entry === "materialize")).toHaveLength(1);
  });

  /**
   * THE COMPOSITION EDGE, driven rather than read. A registry that ignored its
   * `foundationLifecycle` option and always built its own fail-closed default
   * would look correct in every other test — the default refuses too. Only a
   * SENTINEL refusal that no default can produce separates "the registry used
   * what it was given" from "the registry used something that also refuses".
   */
  it("hands the SUPPLIED lifecycle to the service the registry builds", async () => {
    const store = readyStore("registry-wiring");
    // The dispatch entry derives the graph and the manifest before the service runs, so
    // reaching the lifecycle at all now requires the durable facts to be present. Without
    // them this case would refuse at ACTIVE_GRAPH_ABSENT and prove nothing about wiring.
    seedActiveGraphRevision(store);
    const SENTINEL = "FOUNDATION_CAPTURE_SENTINEL_ONLY_THIS_PORT_ANSWERS";
    let prepares = 0;
    const ports = createDaemonCommandPorts({
      clock: () => DECIDED_AT,
      foundationCatalogSource: (): unknown => CATALOG,
      foundationLifecycle: {
        prepareCapture: async () => {
          prepares += 1;
          return { code: SENTINEL, layer: DAEMON_FOUNDATION_CAPTURE, ok: false as const };
        },
        releaseWorktree: () => { throw new Error("release must not run on a refusal"); },
      },
      operatorPrincipalId: PRINCIPAL_ID, projectId: PROJECT_ID, store,
    });
    const handler = ports.registry.get(FOUNDATION_DISPATCH_COMMAND_KIND)?.asyncHandler;
    if (handler === undefined) throw new Error("the dispatch entry must carry an async handler");

    const request = dispatchRequest();
    const input = {
      envelope: {
        commandId: "cmd-registry-wiring", commandKind: FOUNDATION_DISPATCH_COMMAND_KIND,
        correlationId: "corr-registry-wiring", expectedVersion: 0,
        payload: {
          [FOUNDATION_DISPATCH_BYTES_KEY]:
            Buffer.from(request["activationRequestBytes"] as Uint8Array).toString("base64"),
          binding: request["binding"], launchTemplate: request["launchTemplate"],
        },
        requestDigest: DIGEST, schemaVersion: "moe-runtime-command-envelope/1",
        sessionCredential: "credential", targetAggregateId: ACTIVATION_AGGREGATE,
      },
      principal: { capabilities: [], principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    } as unknown as Parameters<typeof handler>[0];

    await expect(handler(input)).rejects.toMatchObject({ code: SENTINEL });
    expect(prepares).toBe(1);
    expect(providerBoundaryProbe.launches).toHaveLength(0);
  });

  it("keeps two concurrent deliveries on ONE captureRef and ONE worktree", async () => {
    const run = harness(readyStore("prepare-concurrent"));

    const [left, right] = await Promise.all([
      run.service.dispatch(dispatchRequest()), run.service.dispatch(dispatchRequest()),
    ]);

    // COUNTED FIRST, and asserted as EXACT rather than as a ceiling: `<= 1`
    // distinct ref is also satisfied by ZERO preparations, which is the shape a
    // dispatch that never prepared would produce.
    const accepted = run.prepared.filter((answer) => answer.ok);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    const refs = new Set(accepted.map(
      (answer) => (answer as { readonly captureRef: string }).captureRef));
    expect(refs.size).toBe(1);
    const roots = new Set(accepted.map(
      (answer) => (answer as { readonly assignment: { realWorktreePath: string } })
        .assignment.realWorktreePath));
    expect(roots.size).toBe(1);
    // The duplicate delivery loses at the reservation, so exactly one arm can
    // have reached the launcher.
    expect([left.ok, right.ok]).toContain(false);
  });

  /**
   * THE SEPARATOR for the case above, and DoD 4's non-crossing clause at the
   * DISPATCH layer the DoD names. Both arms above carry ONE identity, so the
   * reservation collapses the second into a duplicate and `refs.size === 1` is
   * guaranteed by construction — it is a dedup control, and it reads the same
   * whether or not two refs could cross. This case removes the dedup: two
   * identities distinct in aggregate, attemptId and session, asserted to keep
   * distinct refs, distinct worktrees, distinct launch roots and durable
   * contexts that carry only their own facts. Task rail 3's forbidden shape —
   * one module-global captureRef reused across dispatches — survives every
   * other case in this file and reds here.
   */
  it("keeps two DISTINCT parallel dispatches on refs and worktrees that cannot cross", async () => {
    const store = readyStore("prepare-parallel-distinct");
    const run = harness(store);

    await Promise.all([
      run.service.dispatch(dispatchRequest()), run.service.dispatch(secondDispatchRequest()),
    ]);

    // COUNTED FIRST. Two refs cannot be shown to differ if only one attempt ever
    // prepared, and a run where either arm refused never reaches the comparison.
    const accepted = run.prepared.filter((answer) => answer.ok);
    expect(accepted).toHaveLength(2);

    // Each ref is pinned to ITS OWN derivation rather than merely asserted
    // unequal: two wrong-but-different refs would satisfy inequality alone.
    const expectedFirst = deriveFoundationCaptureRef({
      attemptAggregateId: ACTIVATION_AGGREGATE, attemptId: "attempt-1", nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION_ID,
    });
    const expectedSecond = deriveFoundationCaptureRef({
      attemptAggregateId: SECOND_AGGREGATE, attemptId: SECOND_ATTEMPT_ID, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SECOND_SESSION_ID,
    });
    // The fixture's own control: the two identities must be distinguishable
    // BEFORE the service is asked to keep them apart.
    expect(expectedFirst).not.toBe(expectedSecond);
    const refs = accepted.map((answer) => (answer as { readonly captureRef: string }).captureRef);
    expect(new Set(refs)).toEqual(new Set([expectedFirst, expectedSecond]));

    const roots = accepted.map((answer) => (
      answer as { readonly assignment: { readonly realWorktreePath: string } }
    ).assignment.realWorktreePath);
    expect(new Set(roots).size).toBe(2);
    // THE LAUNCH ROOTS ARE THE TWO ASSIGNMENTS. A service that prepared two
    // trees and then launched both attempts in one of them crosses here.
    const launched = providerBoundaryProbe.launches.map(
      (entry) => (entry.input.request as Record<string, unknown>)["cwd"]);
    expect(launched).toHaveLength(2);
    expect(new Set(launched)).toEqual(new Set(roots));

    // The DURABLE side, read back by ref: each context carries its own identity
    // triple and neither names the other's tree.
    const first = readFoundationCaptureContext(store, expectedFirst);
    const second = readFoundationCaptureContext(store, expectedSecond);
    expect([first.ok, second.ok]).toEqual([true, true]);
    if (!first.ok || !second.ok) return;
    expect(first.record).toMatchObject({
      attemptAggregateId: ACTIVATION_AGGREGATE, attemptId: "attempt-1", sessionId: SESSION_ID,
    });
    expect(second.record).toMatchObject({
      attemptAggregateId: SECOND_AGGREGATE, attemptId: SECOND_ATTEMPT_ID,
      sessionId: SECOND_SESSION_ID,
    });
    expect(first.record.assignment.realWorktreePath)
      .not.toBe(second.record.assignment.realWorktreePath);
  });
});

/**
 * TASK RAIL 3 — "no module-global mutable context or map; each dispatch carries
 * one immutable durable captureRef in lexical state" — asserted STRUCTURALLY,
 * because half of it has no runtime observable in this repo.
 *
 * The worktree half is behavioural and is covered above: a module-global
 * assignment shared across dispatches reddens "keeps two DISTINCT parallel
 * dispatches...". The captureRef half is not. The ref the service carries is
 * read at exactly ONE place — the `captureResult` call, which runs only after a
 * PROVEN launch observation — and no honest case in this repository can produce
 * one: `@moe/runner` withholds `observeInstalledClaudeRuntime`,
 * `probeClaudeRuntime` and `capabilitySchemaDigestOf`, so no consumer can mint a
 * quote production accepts. That is why every capture assertion in this file
 * reads `toHaveLength(0)`, and why a module-global `let stickyRef` handing the
 * first dispatch's ref to every later one survives the entire daemon gate.
 *
 * What CAN be seen without faking that boundary is the SHAPE the rail forbids,
 * in the module's own source. LIMIT, stated so this is not trusted past its
 * reach: it inspects column-0 declarations only. A mutable container nested
 * inside a top-level `const` object literal, or state closed over in an imported
 * module, is invisible to it. It is a shape guard, not a behaviour guard.
 */
describe("foundation attempt dispatch — the module holds no cross-dispatch state", () => {
  it("declares no mutable top-level binding and no top-level mutable container", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "foundation-attempt-service.ts"), "utf8");
    const declarations = source.split("\n").filter((line) => /^[A-Za-z]/.test(line));

    // POSITIVE CONTROL, first: an unreadable file or a scan that matched nothing
    // would satisfy every emptiness assertion below without inspecting anything.
    expect(declarations.length).toBeGreaterThan(10);
    expect(declarations.some((line) => line.startsWith("export function"))).toBe(true);

    // Reported BY LINE rather than by count, so a regression names the shape.
    expect(declarations.filter((line) => /^(let|var)\s/.test(line))).toEqual([]);
    expect(declarations.filter(
      (line) => /^const\s.*=\s*new\s+(Map|Set|WeakMap|WeakSet)\b/.test(line))).toEqual([]);
  });
});

/**
 * DURABLE READBACK of a REAL producer answer.
 *
 * THE ONE BOUNDARY THAT IS NOT CROSSED HERE, stated first so nothing below is
 * trusted past its reach: the physical launch. Reaching `capture()` through
 * `dispatch()` needs a PROVEN launch observation, and `@moe/runner` withholds
 * `observeInstalledClaudeRuntime` / `probeClaudeRuntime` /
 * `capabilitySchemaDigestOf`, so no consumer here can mint a runtime quote
 * production accepts. Measured, not assumed — driving the production registry
 * end to end refuses `CLAUDE_RUNTIME_PATH_NOT_FILE` inside the real launcher.
 * Faking past it would mean hand-writing the runner's telemetry handoff, i.e.
 * this suite inventing a contract it does not own.
 *
 * WHAT IS THEREFORE REAL HERE, which is everything else on the path: the store,
 * the repository, the workspace lifecycle, the durable capture-context ledger,
 * the PRODUCER ITSELF, the runner's scanner and result sealer, and the durable
 * attempt row. `recordProvenFoundationAttempt` is handed exactly the arguments
 * `capture()` passes it.
 *
 * AND THE ASSERTIONS READ ROWS. `readFoundationAttemptRecord` re-decodes the
 * durable event and re-encodes it to prove the bytes round-trip, so a producer
 * that answered correctly while the store persisted something else cannot pass.
 */
describe("foundation attempt capture — a real producer answer reaches the durable row", () => {
  /** A store carrying BOTH a durable PROCESS_OBSERVED activation and a real
   *  prepared workspace, with its own worktree parent so arms cannot collide. */
  async function groundedCapture(label: string, authored: string | null): Promise<{
    readonly answer: unknown; readonly ground: ReturnType<typeof durableObservedFixture>;
    readonly input: Record<string, unknown>; readonly worktreeRoot: string;
  }> {
    const ground = durableObservedFixture(label);
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "moe-dispatch-readback-")));
    scratchRoots.push(parent);
    const lifecycle = createFoundationCaptureLifecycle({
      captureFs: createNodeFoundationCaptureFs(),
      catalogSource: (): unknown => ({
        ...CATALOG, entries: [{ ...CATALOG.entries[0], worktreeParent: parent }],
      }),
      clock: () => DECIDED_AT, materializer: createNodeWorktreeMaterializer(process.env),
      store: ground.store,
    });
    const prepared = await lifecycle.prepareCapture({
      attemptAggregateId: ACTIVATION_AGGREGATE, attemptId: ground.record.attempt.attemptId,
      nodeKey: NODE_KEY, projectId: PROJECT_ID, proposedBaseIdentity: HEAD, proposedCwd: null,
      proposedEntries: INPUT_MANIFEST.entries, requestDigest: DIGEST_A,
      reservationDigest: DIGEST_B, sessionId: SESSION_ID,
    });
    if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}@${prepared.layer}`);
    if (prepared.proof === null) throw new Error("prepare returned no prelaunch proof");
    // What the attempt did. A brand-new path lies outside every declared scope
    // and is a different fact — refused, not captured — so authoring means
    // rewriting a DECLARED file, exactly as a real attempt editing source does.
    if (authored !== null) {
      writeFileSync(join(prepared.assignment.realWorktreePath, REPOSITORY.paths[0]),
        Buffer.from(authored, "utf8"));
    }
    // THE SEALED INPUT THE SERVICE ITSELF PASSES at this seam: the AUTHORITY's
    // hydrated manifest, which is what `capture()` hands the store. The caller's
    // `buildInputManifest` proposal is deliberately NOT used here — a request may
    // propose a subset, and sealing a result against a subset refuses every
    // in-scope path the caller did not name.
    const sealed = { manifest: prepared.inputManifest, ok: true as const };
    if (!sealed.ok) throw new Error('input manifest fixture refused');
    // The REAL producer over the REAL durable record, driven by the same six
    // identifiers plus the same lexical proof the service passes.
    const answer = createFoundationCaptureProducer({ store: ground.store })({
      attemptId: ground.record.attempt.attemptId, baseIdentity: HEAD,
      captureRef: prepared.captureRef, nodeKey: NODE_KEY,
      observation: ground.value["observation"], proof: prepared.proof, sessionId: SESSION_ID,
    });
    reserveDispatch(ground.store, ground.bound, ground.record);
    return { answer, ground, input: sealed.manifest as unknown as Record<string, unknown>,
      worktreeRoot: prepared.assignment.realWorktreePath };
  }

  function storedRow(store: SqliteEventStore): Record<string, unknown> {
    const read = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    if (!read.ok) throw new Error(`the attempt row must be readable: ${JSON.stringify(read)}`);
    return read.record as unknown as Record<string, unknown>;
  }

  it("seals a real authored delta into the durable attempt row", async () => {
    const { answer, ground, input } = await groundedCapture(
      "readback-authored", "alpha authored by the attempt\n");

    // The producer ANSWERED rather than refused — asserted first, because a
    // refusal record would satisfy several of the shapes below by accident.
    expect((answer as Record<string, unknown>)["ok"]).not.toBe(false);
    expect((answer as Record<string, unknown>)["authoredPaths"])
      .toContain(REPOSITORY.paths[0]);

    const outcome = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record, input,
      { answer, observation: ground.value["observation"],
        registration: ground.value["registration"] });

    if (!outcome.ok) throw new Error(`settlement refused: ${JSON.stringify(outcome)}`);
    const durable = storedRow(ground.store);
    // The shape ONLY the PROVEN branch can produce. Before this task the
    // production callback answered `null`, which lands here as UNKNOWN with a
    // null manifest — so both halves get their own assertion.
    expect(durable["truthClass"]).toBe("PROVEN");
    expect(durable["reasonCode"]).toBeNull();
    expect(durable["resultManifest"]).not.toBeNull();
    const manifest = nested(durable, "resultManifest");
    expect(manifest["authoredPaths"]).toStrictEqual([REPOSITORY.paths[0]]);
    // THE BYTES THE ATTEMPT WROTE, digested by the runner's own scanner. A
    // manifest that echoed the input entry would carry the BASE digest, which
    // is exactly what a producer trusting caller data would have produced.
    const authoredEntries = manifest["authoredEntries"] as readonly Record<string, unknown>[];
    const authoredEntry = authoredEntries.find((entry) => entry["path"] === REPOSITORY.paths[0]);
    expect(authoredEntry?.["byteLength"])
      .toBe(Buffer.from("alpha authored by the attempt\n", "utf8").byteLength);
    expect(authoredEntry?.["sha256"]).toBe(createHash("sha256")
      .update(Buffer.from("alpha authored by the attempt\n", "utf8")).digest("hex"));
    // The untouched declared SIBLING survives as inherited rather than being
    // silently dropped. Before the seam was corrected to seal against the
    // authority's manifest, this exact path came back
    // RUNNER_WORKSPACE_PATH_UNDECLARED and no result sealed at all.
    const inherited = manifest["inheritedEntries"] as readonly Record<string, unknown>[];
    expect(inherited.map((entry) => entry["path"])).toStrictEqual([REPOSITORY.paths[1]]);
    expect(manifest["baseIdentity"]).toBe(HEAD);
  });

  it("answers a re-delivery from the durable row, with no rescan and no second decision", async () => {
    const { answer, ground, input, worktreeRoot } = await groundedCapture(
      "readback-replay", "the bytes the attempt authored\n");
    const outcome = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record, input,
      { answer, observation: ground.value["observation"],
        registration: ground.value["registration"] });
    if (!outcome.ok) throw new Error(`settlement refused: ${JSON.stringify(outcome)}`);
    const sealedDigest = nested(storedRow(ground.store), "resultManifest")["sha256"];
    const eventsBefore = eventTypes(ground.store, DISPATCH_AGGREGATE);
    expect(eventsBefore.length).toBeGreaterThan(0);

    // PHYSICAL PROOF OF NO RESCAN: the tree is changed underneath the settled
    // attempt. Anything that re-scanned would see these bytes; "it answered
    // quickly" would not have proved a thing.
    writeFileSync(join(worktreeRoot, REPOSITORY.paths[0]),
      Buffer.from("bytes written AFTER the attempt settled\n", "utf8"));
    const replayed = readFoundationAttemptRecord(ground.store, ACTIVATION_AGGREGATE);

    if (!replayed.ok) throw new Error("the durable row must still be readable");
    expect(nested(replayed.record as unknown as Record<string, unknown>,
      "resultManifest")["sha256"]).toBe(sealedDigest);
    // And no second decision: a re-delivery reads, it does not re-settle.
    expect(eventTypes(ground.store, DISPATCH_AGGREGATE)).toEqual(eventsBefore);
  });

  it("refuses the SAME answer when sealed against the caller's proposed manifest", async () => {
    const { answer, ground } = await groundedCapture("readback-proposal", "authored bytes\n");
    // The caller's proposal: `buildInputManifest` over the entries the REQUEST
    // named — lawfully a subset, since `entriesAgree` is an `.every()` over the
    // proposed list and admits a partial or empty one.
    const proposed = buildInputManifest({
      baseIdentity: HEAD, entries: INPUT_MANIFEST.entries as never,
    });
    if (!proposed.ok) throw new Error(`proposal fixture refused: ${proposed.code}`);

    const outcome = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record,
      proposed.manifest as unknown as Record<string, unknown>,
      { answer, observation: ground.value["observation"],
        registration: ground.value["registration"] });

    // THIS IS WHY `capture()` PASSES THE AUTHORITY'S MANIFEST. The identical
    // producer answer that seals cleanly above is rejected here, because a
    // declared path the caller did not name is "neither authored nor
    // inherited". Sealing against the proposal would let a caller decide which
    // in-scope paths are attributable — a proposal selecting, which the epic
    // forbids — and would leave the attempt UNKNOWN on every honest capture.
    expectRefusal(outcome, "RUNNER_WORKSPACE_PATH_UNDECLARED", RUNNER_WORKSPACE_LAYER);
  });

  it("seals an all-INHERITED manifest for a clean run rather than refusing", async () => {
    const { answer, ground, input } = await groundedCapture("readback-clean", null);

    expect((answer as Record<string, unknown>)["ok"]).not.toBe(false);
    expect((answer as Record<string, unknown>)["authoredPaths"]).toStrictEqual([]);

    const outcome = recordProvenFoundationAttempt(
      ground.store, ground.bound, ground.record, input,
      { answer, observation: ground.value["observation"],
        registration: ground.value["registration"] });

    if (!outcome.ok) throw new Error(`settlement refused: ${JSON.stringify(outcome)}`);
    const durable = storedRow(ground.store);
    expect(durable["truthClass"]).toBe("PROVEN");
    const manifest = nested(durable, "resultManifest");
    expect(manifest["authoredPaths"]).toStrictEqual([]);
    expect(manifest["authoredEntries"]).toStrictEqual([]);
    // A clean attempt seals EVERY declared path as inherited rather than
    // refusing. Asserted as the exact path list, so an empty manifest — which
    // an "authored nothing" answer could also produce — cannot satisfy it.
    const inherited = manifest["inheritedEntries"] as readonly Record<string, unknown>[];
    expect(inherited.map((entry) => entry["path"]))
      .toStrictEqual([REPOSITORY.paths[0], REPOSITORY.paths[1]]);
  });
});

/**
 * THE COMPOSITION EDGE, in the module that owns it.
 *
 * The behavioural arms above prove the producer's answer reaches the durable
 * row. What they cannot reach is `daemon-foundation-command.ts` composing it,
 * because that only becomes observable past the physical launch. This reads the
 * module's own source instead — a SHAPE guard, and graded as one.
 *
 * LIMIT, so this is not trusted past its reach: it proves the null stub is gone
 * and the real producer is composed by name. It cannot prove the composed value
 * is reached at runtime; only a case that crosses the launch boundary can.
 */
describe("foundation dispatch handler — the null capture stub is gone", () => {
  it("composes the production producer and declares no null-answering capture", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..",
      "daemon-foundation-command.ts"), "utf8");

    // POSITIVE CONTROL FIRST: an unreadable or renamed file would satisfy every
    // absence assertion below without inspecting anything.
    expect(source).toContain("createFoundationDispatchHandler");
    expect(source).toContain("createFoundationAttemptService");

    expect(source).toContain("createFoundationCaptureProducer({ store: options.store })");
    // The exact stub this task replaced, and any respelling of the same idea.
    expect(source).not.toContain("(): null => null");
    expect(source.split("\n").filter((line) => /captureResult\s*=\s*\(\s*\)\s*=>/.test(line)))
      .toEqual([]);
  });

  /**
   * THE SEAM ITSELF, and this arm exists because a drill caught its absence:
   * reverting `capture()` to seal against `input` left every behavioural arm
   * above GREEN, since those arms hand `recordProvenFoundationAttempt` a
   * manifest directly and so never exercise the service's choice of which one to
   * pass. The behavioural pair (authority seals / proposal refuses
   * RUNNER_WORKSPACE_PATH_UNDECLARED) proves the choice MATTERS; only this
   * proves production makes it. It is a SHAPE guard and is graded as one — the
   * choice becomes observable at runtime only past the physical launch.
   */
  it("seals the durable result against the authority's manifest, not the request's", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "foundation-attempt-service.ts"), "utf8");

    // POSITIVE CONTROL FIRST: a renamed file or a renamed callee would satisfy
    // the negative below by finding nothing at all.
    const settlement = source.slice(source.indexOf("recordProvenFoundationAttempt("));
    expect(settlement.length).toBeGreaterThan(0);
    expect(settlement).toContain("{ answer, observation, registration }");

    expect(settlement.slice(0, settlement.indexOf("{ answer,")))
      .toContain("prepared.inputManifest");
  });
});
