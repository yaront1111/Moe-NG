import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  writeFileSync,
} from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { execFileSync } from "node:child_process";

import { DEFAULT_CONTEXT_BYTE_BUDGET, renderContext, selectContext } from "@moe/context";
import {
  buildProviderRuntimeObservation, createNodeFoundationCaptureFs, createNodeWorktreeMaterializer,
  deriveWorktreeTarget, discoverInstalledClaudeRuntime, hermeticGitEnvironment, observeScope,
} from "@moe/runner";
import type { GitObserver, ProviderRuntimeObservation, ScopeObservation } from "@moe/runner";
import type { CommitExpectedVersionDecisionInput, SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { ActivationTelemetryLaunchInput } from "../activation/activation-telemetry-launch.js";

const observedBoundaryProbe = vi.hoisted(() => ({
  launches: [] as Array<{ readonly input: ActivationTelemetryLaunchInput; readonly result: unknown }>,
}));

/**
 * EVERY settlement attempt the capture path makes, recorded and FORWARDED.
 *
 * The production writer still runs — this observes the seam, it does not replace it. It exists
 * because "the budget settles only after the terminal is durable" is an ORDERING claim, and the
 * durable ledger alone cannot witness it: when the terminal is missing the settlement refuses on
 * its own too, so a gate that had been deleted would leave the very same empty ledger behind.
 * The call itself is the only fact that separates "never attempted" from "attempted and refused".
 */
const settlementProbe = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

/** The terminal verdict the capture path ACTUALLY gated on, recorded as it was produced.
 *  Re-deriving it after the dispatch answers a different question: the dispatch appends to the
 *  activation aggregate on its way out, so a post-hoc call can refuse for a later reason. */
const terminalProbe = vi.hoisted(() => ({
  /** Opens the gate for the ONE arm that has to read what travels through it. `--version` is a
   *  real process but not a provider session, so no honest run on this host proves a terminal
   *  arc — and the settlement CONTEXT is durable audit truth that must be asserted anyway. The
   *  double supplies exactly the `ok` the gate reads and nothing else; the arm that uses it
   *  pins that the production reader still refuses, so it can never stand in for a real one. */
  forceOk: false,
  results: [] as unknown[],
}));

vi.mock("./effect-terminal-ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./effect-terminal-ledger.js")>();
  return {
    ...actual,
    recordTerminalEffect: (...args: Parameters<typeof actual.recordTerminalEffect>) => {
      const real = actual.recordTerminalEffect(...args);
      terminalProbe.results.push(real);
      if (!terminalProbe.forceOk) return real;
      return { ok: true, record: real } as unknown as ReturnType<typeof actual.recordTerminalEffect>;
    },
  };
});

vi.mock("../budget/budget-settlement-application.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../budget/budget-settlement-application.js")
  >();
  return {
    ...actual,
    applyProviderUsageToBudget: (
      ...args: Parameters<typeof actual.applyProviderUsageToBudget>
    ) => {
      settlementProbe.calls.push(args[1] as unknown as Record<string, unknown>);
      return actual.applyProviderUsageToBudget(...args);
    },
  };
});

vi.mock("../activation/activation-telemetry-launch.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../activation/activation-telemetry-launch.js")
  >();
  return {
    ...actual,
    launchActivationProviderRun: async (
      ...args: Parameters<typeof actual.launchActivationProviderRun>
    ) => {
      const result = await actual.launchActivationProviderRun(...args);
      observedBoundaryProbe.launches.push({ input: args[1], result });
      return result;
    },
  };
});

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import {
  ACTIVATION_WORLD_NODE_KEY, seedActivationWorld,
} from "../activation/activation-world-fixtures.js";
import {
  ACTIVATION_WITNESS, GOAL_ID, PROVIDER_OBSERVATION, envelope as bootstrapEnvelope,
  send as sendBootstrap,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore,
} from "../recovery/restore-test-harness.js";
import { createFoundationCaptureLifecycle } from "./foundation-capture-lifecycle.js";
import type { FoundationCaptureLifecycle } from "./foundation-capture-lifecycle.js";
import {
  DAEMON_FOUNDATION_ATTEMPT, deriveDispatchAggregateId,
} from "./foundation-attempt-contracts.js";
import { createFoundationAttemptService, readFoundationAttemptRecord } from "./foundation-attempt-service.js";
import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import { BUDGET_LEDGER_COMMAND_KIND } from "../budget/budget-ledger-contracts.js";
import { applyProviderUsageToBudget } from "../budget/budget-settlement-application.js";
import { readCurrentTerminalEffect } from "./effect-terminal-ledger.js";
import {
  PROVIDER_RUN_COMMAND_KIND, PROVIDER_RUN_EVENT_TYPE,
} from "../telemetry/provider-run-contracts.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-service.js";
import type { FoundationContextSealPort } from "./foundation-context-record.js";
import { produceLaunchTemplateFields } from "./launch-template-producer.js";
import type { LaunchTemplateFields } from "./launch-template-producer.js";

const WINDOWS_ONLY = process.platform === "win32";

/**
 * Whatever `discoverInstalledClaudeRuntime` answers on this host, success or
 * refusal. Derived from the production signature rather than restated, so a
 * widened refusal union cannot drift away from what these cases assert.
 */
type DiscoveryAnswer = Awaited<ReturnType<typeof discoverInstalledClaudeRuntime>>;

const encoder = new TextEncoder();
const scratchRoots: string[] = [];
const DIGEST = "a".repeat(64), DIGEST_B = "3".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const NODE_KEY = ACTIVATION_WORLD_NODE_KEY, SESSION_ID = "session-1";

afterEach(() => {
  observedBoundaryProbe.launches.length = 0;
  settlementProbe.calls.length = 0;
  terminalProbe.results.length = 0;
  terminalProbe.forceOk = false;
  cleanupRestoreHarnesses();
});
afterAll(() => {
  // Close every tracked store FIRST: three fixture tests never closed theirs, and a
  // held SQLite handle turns the rmSync below into a guaranteed EPERM on its root.
  while (openedStores.length > 0) {
    try {
      openedStores.pop()?.close();
    } catch {
      // Already closed by a test's own finally — double-close is not a defect here.
    }
  }
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root === undefined) continue;
    try {
      // 20×250ms: under full-fleet parallelism a trailing child/scanner handle can
      // hold the scratch root past 5×100ms. Seen reddening the whole file 2026-08-18.
      rmSync(root, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
    } catch (error) {
      // Best-effort per root: one held handle must neither fail a green suite nor
      // abort cleanup of the remaining roots. The OS temp cleaner owns the leftover.
      console.warn(`scratch root left behind: ${root}`, error);
    }
  }
});

function scratch(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `moe-foundation-win-${label}-`)));
  scratchRoots.push(root);
  return root;
}

/** Every store this module opens, closed by afterAll before its root is removed. */
const openedStores: SqliteEventStore[] = [];

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root, encoding: "utf8", env: hermeticGitEnvironment(process.env),
    shell: false, windowsHide: true,
  }).trim();
}

/**
 * ONE real repository for this suite, with SHA-256 objects so its head is 64
 * hex: the durable observation validator demands that width, and the workspace
 * lifecycle resolves the launch root from the durable observation.
 */
const REPOSITORY = (() => {
  const root = scratch("repo");
  const parent = scratch("trees");
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

const HEAD = REPOSITORY.head;

const REAL_ENTRY = Object.freeze({
  byteLength: readFileSync(join(REPOSITORY.root, REPOSITORY.paths[0])).byteLength,
  path: REPOSITORY.paths[0], producer: { kind: "BASE" },
  sha256: createHash("sha256")
    .update(readFileSync(join(REPOSITORY.root, REPOSITORY.paths[0]))).digest("hex"),
});

/** The worktree this attempt derives. A caller may compute it; computing it is
 *  not choosing it — a disagreeing proposal refuses instead of winning. */
const DERIVED_WORKTREE = (() => {
  const derived = deriveWorktreeTarget({
    attemptId: "attempt-1", baseIdentity: HEAD, projectId: PROJECT_ID,
    sourceRepositoryRoot: REPOSITORY.root, worktreeParent: REPOSITORY.parent,
  });
  if (!derived.ok) throw new Error(`worktree fixture refused: ${derived.code}`);
  return derived.target.worktreePath;
})();

const CATALOG = Object.freeze({
  catalogVersion: "moe-foundation-repository-scope-catalog/1",
  entries: [{
    declaredPaths: [...REPOSITORY.paths], projectId: PROJECT_ID, repositoryRef: "repo-1",
    scopeRef: "scope-1", sourceRepositoryRoot: REPOSITORY.root,
    worktreeParent: REPOSITORY.parent,
  }],
});

/**
 * A worktree parent of THIS arm's own, and the target derived from it.
 *
 * The module-level `DERIVED_WORKTREE` is shared, and the retention arm above deliberately LEAVES
 * its tree behind. An arm that then materializes over that leftover has another arm's cleanup in
 * its preconditions: the materializer refuses a target that already exists, the dispatch refuses
 * before the gate under test is ever reached, and the arm reds on its own precondition rather
 * than on the property it names. Observed exactly that way at 19:18 local.
 */
function isolatedTarget(label: string): { readonly parent: string; readonly worktreePath: string } {
  const parent = scratch(label);
  const derived = deriveWorktreeTarget({
    attemptId: "attempt-1", baseIdentity: HEAD, projectId: PROJECT_ID,
    sourceRepositoryRoot: REPOSITORY.root, worktreeParent: parent,
  });
  if (!derived.ok) throw new Error(`worktree target refused: ${derived.code}`);
  return { parent, worktreePath: derived.target.worktreePath };
}

/** The REAL lifecycle over the real repository. */
function lifecycleFor(store: SqliteEventStore): FoundationCaptureLifecycle {
  return createFoundationCaptureLifecycle({
    captureFs: createNodeFoundationCaptureFs(),
    catalogSource: (): unknown => CATALOG,
    clock: () => DECIDED_AT,
    materializer: createNodeWorktreeMaterializer(process.env),
    store,
  });
}

/** `lifecycleFor`, but rooted at a parent only one arm uses. */
function isolatedLifecycleFor(store: SqliteEventStore, parent: string): FoundationCaptureLifecycle {
  return createFoundationCaptureLifecycle({
    captureFs: createNodeFoundationCaptureFs(),
    catalogSource: (): unknown => ({
      ...CATALOG, entries: [{ ...CATALOG.entries[0], worktreeParent: parent }],
    }),
    clock: () => DECIDED_AT,
    materializer: createNodeWorktreeMaterializer(process.env),
    store,
  });
}

function readyStore(root: string): SqliteEventStore {
  const store = openHarnessStore(join(root, "project.db"));
  openedStores.push(store);
  // The four bootstrap commands `seedReadyProject` drives, with ONE change: the
  // bound observation carries the fixture repository's real head. A bind cannot
  // be appended after activation — the reducer answers ILLEGAL_TRANSITION.
  for (const [kind, version, payload] of [
    ["project.register", 0, { owner: "owner-1" }],
    ["project.bind_repository", 1, {
      observation: {
        baseRevisionHash: HEAD, repositoryRef: "repo-1", scopeRef: "scope-1",
        truthClass: "DAEMON_VERIFIED",
      },
    }],
    ["provider.probe", 0, { observation: PROVIDER_OBSERVATION }],
    ["project.activate", 2, { witness: ACTIVATION_WITNESS }],
  ] as readonly (readonly [string, number, Record<string, unknown>])[]) {
    const outcome = sendBootstrap(store, bootstrapEnvelope(kind, version, payload));
    if (!outcome.ok) throw new Error(`fixture ${kind} refused: ${outcome.code}`);
  }
  // The rest of what `seedReadyProject` drives — the durable ACTIVE graph and authorized budget
  // root `effect.activate` now derives its budget from. This file re-runs the four bootstrap
  // commands itself only to carry the fixture repository's real head, so it still owes the world
  // every other seeder here gets. Idempotent: it enriches a world, it never rebuilds one.
  seedActivationWorld(store);
  return store;
}

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

function activationBytes(runtimeDigest: string): Uint8Array {
  const intent = {
    aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4,
    idempotencyKey: "idem-1", inputBinding: DIGEST, intentId: "intent-1",
    leaseBinding: LEASE_RECORD, predecessorCursor: "cursor-1",
    protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: runtimeDigest,
    state: "PENDING", version: 0,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: "cmd-dispatch-1", correlationId: "corr-dispatch", decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
    payload: {
      activation: {
        attempt: { aggregateId: "agg-1", attemptId: "attempt-1", intentId: "intent-1",
          state: "LAUNCH_REQUESTED", version: 0 },
        claim: { claimId: "claim-1", claimedAt: DECIDED_AT, intentId: "intent-1",
          lockIdentity: "lock-1", wrapperIdentity: "wrapper-1" },
        dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
        lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: runtimeDigest,
        tombstone: null, wrapperIdentity: "wrapper-1",
      },
      effect: { command: { kind: "claim" }, intent }, lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
    },
  }));
}

const ACTIVATION_AGGREGATE = deriveActivationAggregateId("agg-1", "idem-1");
const DISPATCH_AGGREGATE = deriveDispatchAggregateId(ACTIVATION_AGGREGATE);
const GRAPH = Object.freeze({
  completionNodeKey: NODE_KEY, edges: [], nodes: [{ executionBearing: true, nodeKey: NODE_KEY }],
});
const INPUT_MANIFEST = Object.freeze({
  baseIdentity: HEAD,
  entries: [{ ...REAL_ENTRY }],
});
const SELECTION = Object.freeze({
  concurrencyCeiling: 4, configurationDigest: "1c".repeat(32),
  modelSnapshotEvidence: "claude-opus-5/build-2026-05-14",
  modelSnapshotKind: "DATED_SNAPSHOT", orchestrationDigest: "3e".repeat(32),
  policyDigest: "2d".repeat(32), profileRevisionId: "profile-revision-19",
  provider: "claude", reasoningEffort: "high", selectedModelId: "claude-opus-5",
});

function fakeGit(): GitObserver {
  return {
    headCommit: () => HEAD, lsFilesIgnored: () => [], lsFilesTracked: () => [],
    statusPorcelainV2: () => encoder.encode(`# branch.oid ${HEAD}\0`), submodulePaths: () => [],
  };
}

function captureAnswer(): Record<string, unknown> {
  const scope = observeScope({
    baseIdentity: HEAD, declaredScopePaths: [...REPOSITORY.paths], gitObserver: fakeGit(),
    observedAt: "2026-08-15T00:00:02Z", observerVersion: "moe-runner-scope-observer/1",
    pathObserver: { exists: () => false, realpath: (path: string) => path },
    worktreeRoot: "fixture-root",
  });
  if (!scope.ok) throw new Error(`scope fixture refused: ${scope.code}`);
  const observation: ScopeObservation = scope.observation;
  // The result tree INHERITS exactly the sealed input entry and authors nothing:
  // this control proves the physical boundary, not authorship.
  return {
    authoredPaths: [], declaredArtifactRefs: [],
    resultTreeEntries: [{
      byteLength: REAL_ENTRY.byteLength, kind: "REGULAR", origin: "INHERITED",
      path: REAL_ENTRY.path, sha256: REAL_ENTRY.sha256,
    }], scopeObservation: observation,
  };
}

/**
 * NO RUNTIME CAPABILITY IS COMPOSED HERE. The filesystem, host observer and
 * clock the pin protocol needs are minted inside @moe/runner from the three
 * plain data fields below, so this suite proves the shipped composition rather
 * than a test-owned one: a real broker launch that a test filesystem could not
 * have faked. `pinRoot` is a scratch directory the RUNNER creates — its absence
 * is physical evidence that no launch was ever attempted.
 */
interface WindowsFixture {
  readonly pinRoot: string; readonly request: Record<string, unknown>;
  readonly root: string; readonly store: SqliteEventStore;
}

/**
 * The Claude this host really has installed, or null. Production observation
 * spawns `<executable> --version` through the shipped broker and keeps only the
 * shape this provider reports, so a stand-in binary CANNOT be dressed up as one
 * any more: the host observer is minted inside @moe/runner and takes no port.
 */
function installedClaude(): string | null {
  const home = process.env["USERPROFILE"];
  const candidates = [
    ...(home === undefined ? [] : [join(home, ".local", "bin", CLAUDE_EXE)]),
    ...(process.env["Path"] ?? process.env["PATH"] ?? "").split(";")
      .filter((entry) => entry.length > 0).map((entry) => join(entry, CLAUDE_EXE)),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found === undefined ? null : realpathSync(found);
}

const CLAUDE_EXE = "claude.exe";
const REAL_CLAUDE = WINDOWS_ONLY ? installedClaude() : null;

interface FixtureOptions {
  /** An installed Claude to observe for real; omitted means a stand-in copy. */
  readonly executable?: string;
  readonly argv?: readonly string[];
  readonly timeoutMs: number;
}

function windowsFixture(label: string, options: FixtureOptions): WindowsFixture {
  const root = scratch(label);
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  const executablePath = options.executable ?? standIn(root);
  const installedRoot = realpathSync(join(executablePath, ".."));
  const sha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
  const quote = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: DIGEST_B, clock: { observedAt: () => DECIDED_AT },
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { os: "win32", arch: arch(), osVersion: release() },
    reportedVersion: `${basename(executablePath)}/${sha256.slice(0, 12)}`,
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: executablePath, sha256 }],
  });
  if (!quote.ok) throw new Error(`runtime quote refused: ${quote.code}`);
  const environment = {
    COMSPEC: process.env["ComSpec"] ?? join(systemRoot, "System32", "cmd.exe"),
    PATH: process.env["Path"] ?? join(systemRoot, "System32"),
    SYSTEMROOT: systemRoot, TEMP: root, TMP: root,
  };
  // `--version` exits by itself in about half a second and never opens a
  // session; the model and effort flags are what the launch-selection gate
  // proves the argv against, so they are not decoration.
  const argv = [...options.argv ?? ["--version", "--model", "claude-opus-5", "--effort", "high"]];
  const pinRoot = join(root, "pins");
  const timeoutMs = options.timeoutMs;
  const launchTemplate = {
    argv, bootstrapCredentialDigest: DIGEST_B, cwd: DERIVED_WORKTREE, environment,
    launchSelection: SELECTION,
    limits: { stderrBytes: 65_536, stdoutBytes: 65_536, tailBytes: 1_024, timeoutMs },
    runtime: { installedRoot, pinRoot, quotedObservation: quote.observation },
  };
  const request = {
    activationRequestBytes: activationBytes(quote.observation.observationDigest),
    binding: { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY, sessionId: SESSION_ID },
    graphSnapshot: structuredClone(GRAPH), inputManifest: structuredClone(INPUT_MANIFEST),
    launchTemplate,
  };
  return { pinRoot, request, root, store: readyStore(root) };
}

/** A harmless real Windows executable under a Claude name. It is a genuine
 *  binary the broker can start, and production observation still refuses it —
 *  which is the point of the case that uses it. */
function standIn(root: string): string {
  const installed = join(root, "installed");
  mkdirSync(installed);
  const executable = join(installed, CLAUDE_EXE);
  copyFileSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "where.exe"), executable);
  return realpathSync(executable);
}

function eventTypes(store: SqliteEventStore, aggregateId: string): readonly string[] {
  return store.readEvents(aggregateId).map((event) => event.eventType);
}

function expectRefusal(outcome: FoundationAttemptOutcome, code: string, refusedBy: string): void {
  expect(outcome).toMatchObject({ advisoryOnly: true, authority: "NONE", code, ok: false, refusedBy });
}

/**
 * BOTH expected-version commit seams share ONE ordinal. The activation adapter commits through
 * `commitExpectedVersionDecisionLegs` (task-e194c5f6) while the budget and provider ledgers use
 * the single-leg call; counting only one would renumber which commit `abortOnCall` names, and
 * the injection would fire on a different write while this test still passed.
 */
const EXPECTED_VERSION_COMMITS = new Set([
  "commitExpectedVersionDecision",
  "commitExpectedVersionDecisionLegs",
]);

function abortingStore(store: SqliteEventStore, abortOnCall: number): SqliteEventStore {
  let calls = 0;
  return new Proxy(store, {
    get(target, property, receiver) {
      if (typeof property !== "string" || !EXPECTED_VERSION_COMMITS.has(property)) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (input: CommitExpectedVersionDecisionInput) => {
        calls += 1;
        if (calls === abortOnCall) throw new Error("injected transaction abort");
        const forward = Reflect.get(target, property, receiver) as (value: unknown) => unknown;
        return forward.call(target, input);
      };
    },
  });
}

/**
 * The pre-launch context seal these arms are NOT about. Dispatch now refuses before any
 * provider effect unless a context manifest is durably sealed (task-203a5ca7), and the real
 * seal needs the whole 11-item context matrix world. These arms grade launch, settlement and
 * release, so they bind a stand-in that seals; the PRODUCTION seal composition is driven over a
 * real store in `foundation-context-record.test.ts`.
 */
function sealedTemplateFixture(): LaunchTemplateFields {
  const selected = selectContext({
    byteBudget: DEFAULT_CONTEXT_BYTE_BUDGET,
    exclusions: [],
    mandatory: [{ content: "exercise the Windows attempt", id: "mission-1",
      kind: "MANDATORY", section: "mission" }],
    optional: [],
  });
  if (selected.kind !== "ADMITTED") {
    throw new Error(`fixture selection refused: ${selected.code}`);
  }
  const renderedContext = renderContext(selected.selection);
  const produced = produceLaunchTemplateFields({
    capabilities: {
      authority: "DAEMON_VERIFIED", capabilitySchemaDigest: DIGEST, concurrencyCeiling: 1,
      configurationDigest: "5a".repeat(32), evidence: "DURABLE",
      limits: { stderrBytes: 65_536, stdoutBytes: 131_072, tailBytes: 4_096,
        timeoutMs: 600_000 },
      modelSnapshotEvidence: "claude-cli-2.0.14-2026-05-01",
      modelSnapshotKind: "DATED_SNAPSHOT", ok: true,
      orchestrationDigest: "6b".repeat(32), outcome: "CURRENT",
      policyDigest: "7c".repeat(32), profileRevisionId: "profile-revision-1",
      reasoningEffort: "high", selectedModelId: "claude-opus-5",
    },
    mission: { instructions: "exercise the Windows attempt",
      test: "pnpm --filter @moe/daemon test", title: "Windows attempt",
      workspace: "D:\\projexts\\moe-next" },
    renderedContext,
    runtimeObservation: { adapterCapabilitySchemaDigest: DIGEST,
      platformIdentity: "win32-x64", reportedVersion: "2.0.14" },
  });
  if (!produced.ok) {
    throw new Error(`fixture producer refused: ${produced.code}@${produced.layer}`);
  }
  return produced;
}

const SEALED_TEMPLATE: LaunchTemplateFields = sealedTemplateFixture();

function sealingContextPort(): FoundationContextSealPort {
  return {
    sealFoundationContext: () => Object.freeze({
      bytes: SEALED_TEMPLATE.renderedContext.bytes,
      contextManifestDigest: SEALED_TEMPLATE.renderedContext.manifest.digest,
      ok: true as const, template: SEALED_TEMPLATE,
    }),
  };
}

describe("foundation attempt dispatch — real Windows conformance", () => {
  /**
   * The shipped host observer runs the named executable through the REAL Windows
   * broker and demands the version shape this provider reports. A binary that is
   * not the installed Claude runtime therefore cannot be pinned — which is the
   * whole point of minting the observer inside @moe/runner instead of accepting
   * one. `CLAUDE_RUNTIME_OBSERVATION_INVALID` is only reachable AFTER a real
   * child process ran and its stdout was read: an absent broker would have
   * answered `PROCESS_BOUNDARY_BROKER_UNRESOLVED` instead, so this code is
   * physical evidence that the boundary launched, not that it was skipped.
   */
  it.runIf(WINDOWS_ONLY)("refuses a runtime the shipped observer cannot prove, and never relaunches", async () => {
    const fixture = windowsFixture("unproven-runtime", { timeoutMs: 10_000 });
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: () => { throw new Error("capture must not run"); },
      launchOptions: { platform: "win32" }, lifecycle: lifecycleFor(fixture.store),
      store: fixture.store,
    });

    const outcome = await service.dispatch(fixture.request);

    expectRefusal(outcome, "CLAUDE_RUNTIME_OBSERVATION_INVALID", "RUNTIME");
    // Nothing was pinned, so no provider process was ever started from one.
    expect(existsSync(fixture.pinRoot)).toBe(false);
    const stored = readFoundationAttemptRecord(fixture.store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      advisoryOnly: true, reasonCode: "CLAUDE_RUNTIME_OBSERVATION_INVALID", reasonLayer: "RUNTIME",
      resultManifest: null, truthClass: "SUSPECT",
    });
    const before = eventTypes(fixture.store, ACTIVATION_AGGREGATE);
    expect(before).toContain("EffectActivationCommitted");
    expect(before).not.toContain("FoundationLaunchProcessObserved");
    for (const type of before) expect(before.filter((entry) => entry === type)).toHaveLength(1);
    expect(eventTypes(fixture.store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);

    const replay = await service.dispatch(structuredClone(fixture.request));

    // Answered from the stored bytes: no second observation, no second broker run.
    expect(replay.ok).toBe(true);
    expect(replay.ok && replay.digest).toBe(stored.ok ? stored.digest : "");
    expect(eventTypes(fixture.store, ACTIVATION_AGGREGATE)).toEqual(before);
    expect(existsSync(fixture.pinRoot)).toBe(false);
    const changed = structuredClone(fixture.request);
    (changed["launchTemplate"] as Record<string, unknown>)["cwd"] = join(fixture.root, "other");
    const refused = await service.dispatch(changed);
    expectRefusal(refused, "FOUNDATION_ATTEMPT_REPLAY_MISMATCH", DAEMON_FOUNDATION_ATTEMPT);
    expect(eventTypes(fixture.store, ACTIVATION_AGGREGATE)).toEqual(before);
  }, 60_000);

  it.runIf(WINDOWS_ONLY)("reservation failure reaches no runtime or physical launch", async () => {
    const fixture = windowsFixture("reservation-abort", { timeoutMs: 10_000 });
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: captureAnswer, launchOptions: { platform: "win32" },
      lifecycle: lifecycleFor(fixture.store),
      // ORDINAL, AND IT MOVES WHEN A COMMIT IS ADDED — and it just moved again.
      // task-03049148 added the RESERVED -> ACTIVATED budget bind, which commits
      // inside `runEffectActivateCommand` before the resource bind. One dispatch
      // commits, in order: (1) the activation ledger record, (2) THE BUDGET BIND,
      // (3) the durable attempt-resource set bound by
      // `activation-resource-binding.ts`, (4) THIS reservation. Aborting 2 or 3
      // lets the reservation succeed and the refusal then arrives from a later
      // layer, so this case would stop testing reservation failure. This is the
      // sibling case the service suite's ordinal comment tells you to count.
      store: abortingStore(fixture.store, 4),
    });

    const outcome = await service.dispatch(fixture.request);

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE", DAEMON_FOUNDATION_ATTEMPT);
    // The pinned copy is the runner's FIRST physical act, and it never happened:
    // nothing was launched under a reservation this dispatch never won.
    expect(existsSync(fixture.pinRoot)).toBe(false);
    expect(eventTypes(fixture.store, ACTIVATION_AGGREGATE)).toEqual(["EffectActivationCommitted"]);
    expect(eventTypes(fixture.store, DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  /**
   * THE ANTI-FORGERY CASE, against the Claude this host really installed.
   *
   * The binary is genuine, its bytes are hashed for real and the closure it
   * declares is the one on disk — everything a caller CAN assemble is true here.
   * It is still refused, because `adapterCapabilitySchemaDigest` and the reported
   * version can only come from an observation @moe/runner made itself, and this
   * quote was assembled outside it. `CLAUDE_RUNTIME_OBSERVATION_CHANGED` is
   * reachable only AFTER the shipped broker ran the real `--version` probe and
   * the fresh facts were compared, so it is physical evidence of the comparison,
   * not of a skipped one.
   *
   * That is also why no case here reaches PROVEN: the public surface withholds
   * `observeInstalledClaudeRuntime`, `probeClaudeRuntime` and
   * `capabilitySchemaDigestOf`, so NO consumer can mint a quote production would
   * accept. Faking one would mean reimplementing that authority in a test, and a
   * green PROVEN bought that way would certify nothing. The gap is reported as a
   * prerequisite instead.
   */
  it.runIf(REAL_CLAUDE !== null)("refuses a self-assembled quote for the real installed Claude", async () => {
    expect(REAL_CLAUDE).not.toBeNull();
    expect(existsSync(REAL_CLAUDE as string)).toBe(true);
    const fixture = windowsFixture(
      "real-claude-quote", { executable: REAL_CLAUDE as string, timeoutMs: 120_000 });
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: () => { throw new Error("capture must not run"); },
      launchOptions: { platform: "win32" }, lifecycle: lifecycleFor(fixture.store),
      store: fixture.store,
    });

    const outcome = await service.dispatch(fixture.request);

    expectRefusal(outcome, "CLAUDE_RUNTIME_OBSERVATION_CHANGED", "RUNTIME");
    const stored = readFoundationAttemptRecord(fixture.store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      advisoryOnly: true, reasonCode: "CLAUDE_RUNTIME_OBSERVATION_CHANGED", reasonLayer: "RUNTIME",
      resultManifest: null, truthClass: "SUSPECT",
    });
    const activation = eventTypes(fixture.store, ACTIVATION_AGGREGATE);
    expect(activation).not.toContain("FoundationLaunchProcessObserved");
    expect(eventTypes(fixture.store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);

    const replay = await service.dispatch(structuredClone(fixture.request));

    expect(replay.ok && replay.digest).toBe(stored.ok ? stored.digest : "");
    expect(eventTypes(fixture.store, ACTIVATION_AGGREGATE)).toEqual(activation);
  }, 300_000);
});

/**
 * THE ONE REAL OBSERVED PHYSICAL CONTROL.
 *
 * The suite above states that no case reaches a PROVEN runtime because the
 * public surface withholds `observeInstalledClaudeRuntime`. THAT PREMISE IS NOW
 * STALE: `discoverInstalledClaudeRuntime()` is public, takes no argument, and
 * mints the quote itself from the runtime this host really installed — which is
 * precisely why it cannot be steered by a test. So the gap the older cases
 * reported as a prerequisite is closed, and this control exercises it.
 *
 * WHAT IT DOES NOT CLAIM: `--version` proves a real child process started,
 * exited on its own and was observed. It is NOT a completed provider result, and
 * nothing below reads it as one.
 */
describe("foundation attempt dispatch — the observed physical control", () => {
  /**
   * The discovered runtime, or the refusal this host produced. Still never a
   * dynamic skip (task-4db73e90): a missing prerequisite is ASSERTED, not
   * quietly passed. A runner without an installed claude runtime proves that
   * discovery fails closed with its named typed code, which IS the coverage the
   * capability-present arm would otherwise have carried alone.
   */
  async function discovered(): Promise<
    | {
        readonly ok: true; readonly installedRoot: string;
        readonly observation: ProviderRuntimeObservation;
      }
    | { readonly ok: false; readonly refusal: DiscoveryAnswer }
  > {
    const found = await discoverInstalledClaudeRuntime();
    if (!("ok" in found && found.ok === true)) return { ok: false, refusal: found };
    return { installedRoot: found.installedRoot, observation: found.observation, ok: true };
  }

  /**
   * The capability-absent assertion. ONLY the missing-runtime code is admitted
   * here: any other refusal — an ambiguous duplicate, an invalid search path, an
   * unsupported platform — is a real red and is rethrown verbatim, so a broken
   * discovery can never hide behind the honest branch.
   */
  function assertRuntimeAbsent(refusal: DiscoveryAnswer): void {
    const code = "code" in refusal ? refusal.code : undefined;
    if (code !== "CLAUDE_RUNTIME_PATH_MISSING") {
      throw new Error(`installed runtime discovery refused: ${JSON.stringify(refusal)}`);
    }
    expect(refusal).toMatchObject({
      code: "CLAUDE_RUNTIME_PATH_MISSING", layer: "RUNTIME", truthClass: "UNKNOWN",
    });
  }

  function providerEvents(store: SqliteEventStore) {
    return store.readEventsByTypeAfter(PROVIDER_RUN_EVENT_TYPE, 0n, 100).items;
  }

  function providerDecisions(store: SqliteEventStore) {
    return store.readCommandDecisionsAfter(0n, 200).items
      .filter((decision) => decision.commandKind === PROVIDER_RUN_COMMAND_KIND);
  }

  it.runIf(WINDOWS_ONLY)("observes a real exited provider process and files it in the ledger", async () => {
    const found = await discovered();
    // task-4db73e90: this host has no installed claude runtime — assert the
    // typed refusal instead of skipping the case.
    if (!found.ok) return assertRuntimeAbsent(found.refusal);
    const { installedRoot, observation } = found;
    const root = scratch("observed-control");
    const store = readyStore(root);
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const pinRoot = join(root, "pins");
    const request = {
      activationRequestBytes: activationBytes(observation.observationDigest),
      binding: { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY, sessionId: SESSION_ID },
      graphSnapshot: structuredClone(GRAPH),
      inputManifest: structuredClone(INPUT_MANIFEST),
      launchTemplate: {
        argv: ["--version", "--model", "claude-opus-5", "--effort", "high"],
        bootstrapCredentialDigest: DIGEST_B, cwd: DERIVED_WORKTREE,
        environment: {
          COMSPEC: process.env["ComSpec"] ?? join(systemRoot, "System32", "cmd.exe"),
          PATH: process.env["Path"] ?? join(systemRoot, "System32"),
          SYSTEMROOT: systemRoot, TEMP: root, TMP: root,
        },
        launchSelection: SELECTION,
        limits: { stderrBytes: 65_536, stdoutBytes: 65_536, tailBytes: 1_024, timeoutMs: 120_000 },
        runtime: { installedRoot, pinRoot, quotedObservation: observation },
      },
    };
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: captureAnswer, launchOptions: { platform: "win32" },
      lifecycle: lifecycleFor(store), store,
    });

    try {
    const outcome = await service.dispatch(request);

    expect(outcome.ok).toBe(true);
    // SETTLEMENT RELEASED THE TREE. A proven durable result is the ONLY thing
    // that may, and the physical evidence is that the derived worktree — which
    // had to exist for the launch to run in it — is gone afterwards.
    expect(existsSync(DERIVED_WORKTREE)).toBe(false);
    expect(observedBoundaryProbe.launches).toHaveLength(1);
    expect(observedBoundaryProbe.launches[0]?.input.providerRun).toEqual({
      attemptRef: "attempt-1", effectIntentId: "intent-1", epoch: 3,
      provider: "claude", runRef: DISPATCH_AGGREGATE,
    });
    // The runner's pin root is its FIRST physical act; its existence is evidence
    // the boundary was actually reached rather than short-circuited.
    expect(existsSync(pinRoot)).toBe(true);

    const read = readCurrentProviderRun(store, { attemptRef: "attempt-1", projectId: PROJECT_ID });
    expect(read).toMatchObject({ ok: true });
    if (!("record" in read)) throw new Error("the observed run must be readable");
    expect(read.record.providerRunRef).toEqual({
      attemptRef: "attempt-1", effectIntentId: "intent-1", epoch: 3,
      provider: "claude", runRef: DISPATCH_AGGREGATE,
    });
    expect(read.sessionId).toBe(SESSION_ID);
    expect(SESSION_ID).not.toBe(PRINCIPAL_ID);
    // A REAL process ran and exited on its own. This is the arm the blind cases
    // in the sibling suite cannot reach.
    expect(read.record.launch.kind).toBe("OBSERVED");
    expect(read.record.launch.exit).toMatchObject({ code: 0, kind: "EXITED" });
    // AND THE HONEST LIMIT OF THIS CONTROL, pinned rather than hidden: the process
    // ran and exited, but `--version` output is not a provider stream, so the
    // runner refuses its telemetry with its OWN code and layer. Asserting `null`
    // here would have been the "mislabel version output as a completed provider
    // result" defect — the physical facts are proven, the provider facts are not.
    expect(read.record.upstreamRefusal).toMatchObject({
      code: "TELEMETRY_STREAM_ANOMALOUS", layer: "TELEMETRY_SCHEMA", ok: false,
    });
    expect(read.record.terminal).not.toBe("SUCCEEDED");
    expect(Object.isFrozen(read.record)).toBe(true);
    expect(providerEvents(store)).toHaveLength(1);
    expect(providerDecisions(store)).toHaveLength(1);

    const eventsBefore = eventTypes(store, ACTIVATION_AGGREGATE);
    const digestBefore = read.recordDigest;

    // REPLAY: no second physical launch, no second provider row, same bytes.
    const replay = await service.dispatch(structuredClone(request));
    expect(replay.ok).toBe(true);
    expect(observedBoundaryProbe.launches).toHaveLength(1);
    expect(providerEvents(store)).toHaveLength(1);
    expect(providerDecisions(store)).toHaveLength(1);
    expect(eventTypes(store, ACTIVATION_AGGREGATE)).toEqual(eventsBefore);
    const reread = readCurrentProviderRun(store, { attemptRef: "attempt-1", projectId: PROJECT_ID });
    expect("recordDigest" in reread && reread.recordDigest).toBe(digestBefore);

    // CONFLICT: one identity-covered byte, refused BEFORE the physical boundary.
    const changed = structuredClone(request);
    (changed["launchTemplate"] as Record<string, unknown>)["cwd"] = join(root, "other");
    const refused = await service.dispatch(changed);
    expectRefusal(refused, "FOUNDATION_ATTEMPT_REPLAY_MISMATCH", DAEMON_FOUNDATION_ATTEMPT);
    expect(observedBoundaryProbe.launches).toHaveLength(1);
    expect(providerEvents(store)).toHaveLength(1);
    expect(eventTypes(store, ACTIVATION_AGGREGATE)).toEqual(eventsBefore);

    } finally {
      // Handles first, temp root after: a held handle throws EPERM on cleanup.
      store.close();
    }
  }, 300_000);

  /**
   * THE OTHER HALF OF THE FENCE, and it needs a real launch to reach: release is
   * inside the capture path, so only an attempt that actually ran can prove that
   * an UNPROVEN settlement keeps its tree. A capture answer that throws leaves
   * the durable record unproven while the process itself really executed — the
   * exact state where deleting the worktree would destroy the only evidence.
   */
  it.runIf(WINDOWS_ONLY)("RETAINS the worktree when the capture answer is unproven", async () => {
    const found = await discovered();
    // task-4db73e90: this host has no installed claude runtime — assert the
    // typed refusal instead of skipping the case.
    if (!found.ok) return assertRuntimeAbsent(found.refusal);
    const { installedRoot, observation } = found;
    const root = scratch("unproven-retention");
    const store = readyStore(root);
    const systemRoot = process.env["SystemRoot"] ?? "C:\Windows";
    const request = {
      activationRequestBytes: activationBytes(observation.observationDigest),
      binding: { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY, sessionId: SESSION_ID },
      graphSnapshot: structuredClone(GRAPH),
      inputManifest: structuredClone(INPUT_MANIFEST),
      launchTemplate: {
        argv: ["--version", "--model", "claude-opus-5", "--effort", "high"],
        bootstrapCredentialDigest: DIGEST_B, cwd: DERIVED_WORKTREE,
        environment: {
          COMSPEC: process.env["ComSpec"] ?? join(systemRoot, "System32", "cmd.exe"),
          PATH: process.env["Path"] ?? join(systemRoot, "System32"),
          SYSTEMROOT: systemRoot, TEMP: root, TMP: root,
        },
        launchSelection: SELECTION,
        limits: { stderrBytes: 65_536, stdoutBytes: 65_536, tailBytes: 1_024, timeoutMs: 120_000 },
        runtime: { installedRoot, pinRoot: join(root, "pins"), quotedObservation: observation },
      },
    };
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: () => { throw new Error("the capture answer is unavailable"); },
      launchOptions: { platform: "win32" }, lifecycle: lifecycleFor(store), store,
    });

    try {
      const outcome = await service.dispatch(request);

      // The process ran, so the tree existed; the settlement could not be proven,
      // so the tree is STILL there. Both halves matter: a green assertion on
      // retention alone would also pass if nothing had ever been materialized.
      expect(observedBoundaryProbe.launches).toHaveLength(1);
      expect(outcome.ok).toBe(false);
      expect(existsSync(DERIVED_WORKTREE)).toBe(true);
    } finally {
      store.close();
    }
  }, 300_000);

  /**
   * THE ORDERING GATE ITSELF, and it needs a real launch for the same reason release does:
   * `capture()` is the only place the gate exists, and no blind arm reaches it.
   *
   * The claim under test is the one the production comment makes load-bearing — the budget
   * settles ONLY after the terminal effect is durable, because `recordTerminalEffect` refusing is
   * what makes committed telemetry a PRECONDITION of settlement rather than a coincidence. A
   * settlement wired ahead of it would read UNKNOWN forever while its own UNKNOWN arm passed
   * green, which is the silent-money failure this row exists to prevent.
   *
   * `--version` is a real provider process that really exits, so the run is DURABLE while its
   * telemetry is not a provider stream — the runner refuses it and no terminal arc is proven.
   * That is exactly the state the gate is for, reached physically rather than simulated.
   */
  it.runIf(WINDOWS_ONLY)("attempts NO budget settlement while the terminal effect is not durable", async () => {
    const found = await discovered();
    // task-4db73e90: this host has no installed claude runtime — assert the
    // typed refusal instead of skipping the case.
    if (!found.ok) return assertRuntimeAbsent(found.refusal);
    const { installedRoot, observation } = found;
    const root = scratch("terminal-gate");
    const isolated = isolatedTarget("terminal-gate-trees");
    const store = readyStore(root);
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const pinRoot = join(root, "pins");
    const request = {
      activationRequestBytes: activationBytes(observation.observationDigest),
      binding: { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY, sessionId: SESSION_ID },
      graphSnapshot: structuredClone(GRAPH),
      inputManifest: structuredClone(INPUT_MANIFEST),
      launchTemplate: {
        argv: ["--version", "--model", "claude-opus-5", "--effort", "high"],
        bootstrapCredentialDigest: DIGEST_B, cwd: isolated.worktreePath,
        environment: {
          COMSPEC: process.env["ComSpec"] ?? join(systemRoot, "System32", "cmd.exe"),
          PATH: process.env["Path"] ?? join(systemRoot, "System32"),
          SYSTEMROOT: systemRoot, TEMP: root, TMP: root,
        },
        launchSelection: SELECTION,
        limits: { stderrBytes: 65_536, stdoutBytes: 65_536, tailBytes: 1_024, timeoutMs: 120_000 },
        runtime: { installedRoot, pinRoot, quotedObservation: observation },
      },
    };
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: captureAnswer, launchOptions: { platform: "win32" },
      lifecycle: isolatedLifecycleFor(store, isolated.parent), store,
    });

    try {
      const outcome = await service.dispatch(request);

      // THE CAPTURE PATH REALLY RAN. Without this, every assertion below would also hold for a
      // dispatch that refused long before the gate existed.
      expect(outcome.ok).toBe(true);
      expect(observedBoundaryProbe.launches).toHaveLength(1);
      expect(existsSync(pinRoot)).toBe(true);

      // THE TELEMETRY IS DURABLE. The gap this arm is about is the TERMINAL, not the run: a
      // missing run would close the gate for a different reason and prove nothing about ordering.
      const run = readCurrentProviderRun(store, { attemptRef: "attempt-1", projectId: PROJECT_ID });
      expect(run).toMatchObject({ ok: true });
      expect(providerDecisions(store)).toHaveLength(1);

      // AND THE TERMINAL IS NOT — asserted by its own code and layer, from both the reader and
      // the writer, because "absent" and "refused to derive" are different facts.
      expect(readCurrentTerminalEffect(
        store, { attemptRef: "attempt-1", intentId: "intent-1", projectId: PROJECT_ID },
      )).toMatchObject({ code: "EFFECT_TERMINAL_ABSENT", layer: "EFFECT_TERMINAL_LEDGER", ok: false });
      // The verdict the GATE saw, captured as the dispatch produced it: exactly one call, and
      // its own code, layer and upstream pair rather than "it did not succeed".
      expect(terminalProbe.results).toHaveLength(1);
      expect(terminalProbe.results[0]).toMatchObject({
        code: "EFFECT_TERMINAL_EVIDENCE_ABSENT", layer: "EFFECT_TERMINAL_LEDGER", ok: false,
      });

      // THE MONEY DID NOT MOVE: no settlement decision under this attempt's own command id, no
      // settlement row, and the reservation still ACTIVATED rather than quarantined.
      expect(store.readCommandDecisionsAfter(0n, 500).items.filter(
        (decision) => decision.commandKind === BUDGET_LEDGER_COMMAND_KIND
          && decision.key.commandId === "settle-attempt-1",
      )).toHaveLength(0);
      const ledger = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
      if (!ledger.ok) throw new Error(`the ledger must read back: ${ledger.code}`);
      expect(ledger.settlements).toHaveLength(0);
      expect(ledger.reservations
        .filter((entry) => entry.attemptRef === "attempt-1")
        .map((entry) => entry.state)).toEqual(["ACTIVATED"]);

      // AND THE GATE ITSELF. Both halves are drilled: under `if (terminal.ok)` -> `if (true)`
      // the ungated settlement really commits, so the decision filter above reds at 1 — the
      // money moves on evidence no terminal proved. This line is kept beside it because it is
      // the DIRECT witness: it separates "never attempted" from "attempted and refused", which
      // stays true even for a future state where the ungated settlement would refuse instead.
      expect(settlementProbe.calls).toHaveLength(0);
    } finally {
      store.close();
    }
  }, 300_000);

  /**
   * WHAT THE SETTLEMENT ASSERTS ABOUT ITSELF, once the gate opens.
   *
   * `decidedAt` reaches the durable decision row as `committedAt` and `principalId` is a third of
   * `budgetDecisionKey`: together they are the audit answer to WHO decided this settlement and
   * WHEN. Both must come from durable facts this dispatch already holds — the activation's own
   * decided-at and the lease owner session — never from a daemon clock (there is none) and never
   * from the project, which decides nothing. A settlement stamped 1970 by a project passes every
   * balance assertion ever written, which is exactly why this arm asserts the KEY, not the money.
   */
  it.runIf(WINDOWS_ONLY)("settles under the ACTIVATION's decided-at and the LEASE OWNER as principal", async () => {
    const found = await discovered();
    // task-4db73e90: this host has no installed claude runtime — assert the
    // typed refusal instead of skipping the case.
    if (!found.ok) return assertRuntimeAbsent(found.refusal);
    const { installedRoot, observation } = found;
    const root = scratch("settlement-key");
    const isolated = isolatedTarget("settlement-key-trees");
    const store = readyStore(root);
    const systemRoot = process.env["SystemRoot"] ?? "C:\Windows";
    const request = {
      activationRequestBytes: activationBytes(observation.observationDigest),
      binding: { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY, sessionId: SESSION_ID },
      graphSnapshot: structuredClone(GRAPH),
      inputManifest: structuredClone(INPUT_MANIFEST),
      launchTemplate: {
        argv: ["--version", "--model", "claude-opus-5", "--effort", "high"],
        bootstrapCredentialDigest: DIGEST_B, cwd: isolated.worktreePath,
        environment: {
          COMSPEC: process.env["ComSpec"] ?? join(systemRoot, "System32", "cmd.exe"),
          PATH: process.env["Path"] ?? join(systemRoot, "System32"),
          SYSTEMROOT: systemRoot, TEMP: root, TMP: root,
        },
        launchSelection: SELECTION,
        limits: { stderrBytes: 65_536, stdoutBytes: 65_536, tailBytes: 1_024, timeoutMs: 120_000 },
        runtime: { installedRoot, pinRoot: join(root, "pins"), quotedObservation: observation },
      },
    };
    const service = createFoundationAttemptService({
      context: sealingContextPort(),
      captureResult: captureAnswer, launchOptions: { platform: "win32" },
      lifecycle: isolatedLifecycleFor(store, isolated.parent), store,
    });
    terminalProbe.forceOk = true;

    try {
      const outcome = await service.dispatch(request);

      expect(outcome.ok).toBe(true);
      expect(observedBoundaryProbe.launches).toHaveLength(1);
      // THE DOUBLE NEVER STANDS IN FOR A DERIVATION: the production reader was still driven and
      // still refused on this host's evidence. Only the gate's boolean was supplied.
      expect(terminalProbe.results[0]).toMatchObject({
        code: "EFFECT_TERMINAL_EVIDENCE_ABSENT", layer: "EFFECT_TERMINAL_LEDGER", ok: false,
      });

      // THE DURABLE ROW FIRST, because it is the audit a recovery reads rather than the argument
      // the seam passed: the decision carries the stamp as `decidedAt` and the principal as a
      // third of its own key. Both are drilled — an epoch stamp and a project principal each
      // redden this assertion by name.
      const settlement = store.readCommandDecisionsAfter(0n, 500).items.filter(
        (decision) => decision.commandKind === BUDGET_LEDGER_COMMAND_KIND
          && decision.key.commandId === "settle-attempt-1",
      );
      expect(settlement).toHaveLength(1);
      expect(settlement[0]).toMatchObject({
        decidedAt: DECIDED_AT,
        key: {
          commandId: "settle-attempt-1", principalId: SESSION_ID, projectId: PROJECT_ID,
        },
      });
      // The two values a fabricated stamp and a project principal would have produced, named so
      // the assertion above cannot pass by coincidence.
      expect(DECIDED_AT).not.toBe(new Date(0).toISOString());
      expect(SESSION_ID).not.toBe(PROJECT_ID);

      // THEN THE CONTEXT THE SEAM BUILT, field for field. It carries what the decision key does
      // not — `correlationId` and the attempt this settlement is for — and is drilled on its own
      // (a mutated correlation reddens here and nowhere else).
      expect(settlementProbe.calls).toHaveLength(1);
      expect(settlementProbe.calls[0]).toStrictEqual({
        attemptRef: "attempt-1",
        context: {
          commandId: "settle-attempt-1", correlationId: "budget-settlement-attempt-1",
          decidedAt: DECIDED_AT, principalId: SESSION_ID,
        },
        projectId: PROJECT_ID,
      });
    } finally {
      store.close();
    }
  }, 300_000);

  /**
   * THE INSTRUMENT'S OWN CONTROL. `toHaveLength(0)` above is only evidence if a call would have
   * been seen; a probe wired to a module the service does not import would read zero forever.
   */
  it("records a settlement call when one is really made", () => {
    const store = readyStore(scratch("settlement-probe-control"));
    try {
      const refused = applyProviderUsageToBudget(store, {
        attemptRef: "attempt-absent",
        context: {
          commandId: "settle-attempt-absent", correlationId: "corr-probe",
          decidedAt: DECIDED_AT, principalId: SESSION_ID,
        },
        projectId: PROJECT_ID,
      });

      // The production module answered — the probe forwards rather than replaces it.
      expect(refused).toMatchObject({
        code: "BUDGET_SETTLEMENT_RUN_ABSENT", layer: "BUDGET_SETTLEMENT_APPLICATION", ok: false,
      });
      expect(settlementProbe.calls).toHaveLength(1);
      expect(settlementProbe.calls[0]).toMatchObject({ attemptRef: "attempt-absent" });
    } finally {
      store.close();
    }
  });
});
