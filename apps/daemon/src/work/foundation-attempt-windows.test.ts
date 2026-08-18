import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
} from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  buildProviderRuntimeObservation, discoverInstalledClaudeRuntime, observeScope,
} from "@moe/runner";
import type { GitObserver, ProviderRuntimeObservation, ScopeObservation } from "@moe/runner";
import type { CommitExpectedVersionDecisionInput, SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { ActivationTelemetryLaunchInput } from "../activation/activation-telemetry-launch.js";

const observedBoundaryProbe = vi.hoisted(() => ({
  launches: [] as Array<{ readonly input: ActivationTelemetryLaunchInput; readonly result: unknown }>,
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
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  DAEMON_FOUNDATION_ATTEMPT, deriveDispatchAggregateId,
} from "./foundation-attempt-contracts.js";
import { createFoundationAttemptService, readFoundationAttemptRecord } from "./foundation-attempt-service.js";
import {
  PROVIDER_RUN_COMMAND_KIND, PROVIDER_RUN_EVENT_TYPE,
} from "../telemetry/provider-run-contracts.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-service.js";

const WINDOWS_ONLY = process.platform === "win32";
const encoder = new TextEncoder();
const scratchRoots: string[] = [];
const DIGEST = "a".repeat(64), DIGEST_A = "2".repeat(64), DIGEST_B = "3".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z", HEAD = "0".repeat(40);
const NODE_KEY = "dev-done", SESSION_ID = "session-1";

afterEach(() => {
  observedBoundaryProbe.launches.length = 0;
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

function readyStore(root: string): SqliteEventStore {
  const store = openHarnessStore(join(root, "project.db"));
  openedStores.push(store);
  seedReadyProject(store);
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
const BUDGET_VIEW = {
  accountId: "acct-1", meters: [{ available: 100, committed: 0, meter: "usd",
    quarantined: 0, reserved: 0 }], state: "OPEN", version: 2,
} as const;
const ADMISSION = {
  admissionRef: "adm-1", expectedVersion: 2,
  amounts: ["EXECUTION", "VERIFICATION", "INDEPENDENT_REVIEW", "FINAL_ACCEPTANCE", "CONTINGENCY"]
    .map((purpose) => ({ meter: "usd", purpose, quantity: purpose === "EXECUTION" ? 10 : 5 })),
} as const;
const GATE = { allowance: { decisionRef: "dec-1", outcome: "ALLOW" }, approval: null } as const;

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
      budget: { admission: ADMISSION, gate: GATE, view: BUDGET_VIEW },
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
  entries: [{ byteLength: 10, path: "pkg/src/base.ts", producer: { kind: "BASE" }, sha256: DIGEST_A }],
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
    baseIdentity: HEAD, declaredScopePaths: ["pkg/src"], gitObserver: fakeGit(),
    observedAt: "2026-08-15T00:00:02Z", observerVersion: "moe-runner-scope-observer/1",
    pathObserver: { exists: () => false, realpath: (path: string) => path },
    worktreeRoot: "fixture-root",
  });
  if (!scope.ok) throw new Error(`scope fixture refused: ${scope.code}`);
  const observation: ScopeObservation = scope.observation;
  return {
    authoredPaths: ["pkg/src/authored.ts"], declaredArtifactRefs: [{ byteLength: 7, sha256: DIGEST_B }],
    resultTreeEntries: [
      { byteLength: 10, kind: "REGULAR", origin: "INHERITED", path: "pkg/src/base.ts", sha256: DIGEST_A },
      { byteLength: 4, kind: "REGULAR", origin: "AUTHORED", path: "pkg/src/authored.ts", sha256: DIGEST_B },
    ], scopeObservation: observation,
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
    argv, bootstrapCredentialDigest: DIGEST_B, cwd: root, environment,
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

function abortingStore(store: SqliteEventStore, abortOnCall: number): SqliteEventStore {
  let calls = 0;
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "commitExpectedVersionDecision") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (input: CommitExpectedVersionDecisionInput) => {
        calls += 1;
        if (calls === abortOnCall) throw new Error("injected transaction abort");
        return target.commitExpectedVersionDecision(input);
      };
    },
  });
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
      captureResult: () => { throw new Error("capture must not run"); },
      launchOptions: { platform: "win32" }, store: fixture.store,
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
      captureResult: captureAnswer, launchOptions: { platform: "win32" },
      // ORDINAL, AND IT MOVES WHEN A COMMIT IS ADDED. One dispatch commits, in
      // order: (1) the activation ledger record, (2) the durable attempt-resource
      // set bound by `activation-resource-binding.ts`, (3) THIS reservation.
      // Aborting 2 lets the reservation succeed and the refusal then arrives from
      // a later layer, so this case would stop testing reservation failure.
      store: abortingStore(fixture.store, 3),
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
      captureResult: () => { throw new Error("capture must not run"); },
      launchOptions: { platform: "win32" }, store: fixture.store,
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
  /** The discovered runtime, or an explicit failure. Never a dynamic skip: a
   *  missing prerequisite on a Windows host is a red, not a quiet pass. */
  async function discovered(): Promise<{
    readonly installedRoot: string; readonly observation: ProviderRuntimeObservation;
  }> {
    const found = await discoverInstalledClaudeRuntime();
    if (!("ok" in found && found.ok === true)) {
      throw new Error(`installed runtime discovery refused: ${JSON.stringify(found)}`);
    }
    return { installedRoot: found.installedRoot, observation: found.observation };
  }

  function providerEvents(store: SqliteEventStore) {
    return store.readEventsByTypeAfter(PROVIDER_RUN_EVENT_TYPE, 0n, 100).items;
  }

  function providerDecisions(store: SqliteEventStore) {
    return store.readCommandDecisionsAfter(0n, 200).items
      .filter((decision) => decision.commandKind === PROVIDER_RUN_COMMAND_KIND);
  }

  it.runIf(WINDOWS_ONLY)("observes a real exited provider process and files it in the ledger", async () => {
    const { installedRoot, observation } = await discovered();
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
        bootstrapCredentialDigest: DIGEST_B, cwd: root,
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
      captureResult: captureAnswer, launchOptions: { platform: "win32" }, store,
    });

    try {
    const outcome = await service.dispatch(request);

    expect(outcome.ok).toBe(true);
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
});
