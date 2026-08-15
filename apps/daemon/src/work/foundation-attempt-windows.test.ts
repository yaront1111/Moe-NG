import { createHash } from "node:crypto";
import {
  copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync,
} from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { arch, release, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { buildProviderRuntimeObservation, observeScope } from "@moe/runner";
import type { ClaudeLaunchRequest, GitObserver, ScopeObservation } from "@moe/runner";
import type { CommitExpectedVersionDecisionInput, SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

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
import type { FoundationAttemptOutcome } from "./foundation-attempt-service.js";

const WINDOWS_ONLY = process.platform === "win32";
const encoder = new TextEncoder();
const scratchRoots: string[] = [];
const DIGEST = "a".repeat(64), DIGEST_A = "2".repeat(64), DIGEST_B = "3".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z", HEAD = "0".repeat(40);
const NODE_KEY = "dev-done", SESSION_ID = "session-1";

afterEach(cleanupRestoreHarnesses);
afterAll(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
});

function scratch(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `moe-foundation-win-${label}-`)));
  scratchRoots.push(root);
  return root;
}

function readyStore(root: string): SqliteEventStore {
  const store = openHarnessStore(join(root, "project.db"));
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

type RuntimeFs = ClaudeLaunchRequest["runtime"]["fs"];
type RuntimeWriteHandle = Awaited<ReturnType<RuntimeFs["openExclusiveWrite"]>>;

async function walk(base: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(base, prefix), { withFileTypes: true })) {
    const child = prefix === "" ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...await walk(base, child));
    else found.push(child);
  }
  return found;
}

function nodeRuntimeFs(): RuntimeFs {
  return Object.freeze({
    hostPlatform: (): string => process.platform,
    realpath: async (path: string): Promise<string> => await realpath(path),
    entryKind: async (path: string) => {
      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) return "REPARSE" as const;
        if (stats.isDirectory()) return "DIRECTORY" as const;
        return stats.isFile() ? "FILE" as const : "OTHER" as const;
      } catch { return "MISSING" as const; }
    },
    readChunks: (path: string): AsyncIterable<Uint8Array> =>
      createReadStream(path) as unknown as AsyncIterable<Uint8Array>,
    listFiles: async (path: string): Promise<readonly string[]> =>
      (await walk(path)).map((entry) => relative(path, join(path, entry))).sort(),
    ensureDirectory: async (path: string): Promise<void> => { await mkdir(path, { recursive: true }); },
    createDirectoryExclusive: async (path: string): Promise<void> => { await mkdir(path); },
    openExclusiveWrite: async (path: string): Promise<RuntimeWriteHandle> => {
      const handle = await open(path, "wx");
      return Object.freeze({
        write: async (chunk: Uint8Array): Promise<void> => { await handle.write(chunk); },
        close: async (): Promise<void> => { await handle.sync(); await handle.close(); },
      });
    },
    rename: async (from: string, to: string): Promise<void> => { await rename(from, to); },
    removeTree: async (path: string): Promise<void> => { await rm(path, { force: true, recursive: true }); },
  });
}

interface WindowsFixture {
  readonly marker: string; readonly request: Record<string, unknown>;
  readonly runtimePorts: Pick<ClaudeLaunchRequest["runtime"], "clock" | "facts" | "fs">;
  readonly root: string; readonly store: SqliteEventStore;
}

function windowsFixture(label: string, command: string | null, timeoutMs: number): WindowsFixture {
  const root = scratch(label), installed = join(root, "installed");
  mkdirSync(installed);
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  const source = command === null ? join(systemRoot, "System32", "where.exe") : process.execPath;
  const executable = join(installed, "claude.exe");
  copyFileSync(source, executable);
  const installedRoot = realpathSync(installed), executablePath = realpathSync(executable);
  const sha256 = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
  const platformIdentity = { os: "win32", arch: arch(), osVersion: release() };
  const reportedVersion = `${basename(source)}/${command === null ? sha256.slice(0, 12) : process.version}`;
  const quote = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: DIGEST_B, clock: { observedAt: () => DECIDED_AT },
    pinningMethod: "CONTENT_ADDRESSED_COPY", platformIdentity, reportedVersion,
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: executablePath, sha256 }],
  });
  if (!quote.ok) throw new Error(`runtime quote refused: ${quote.code}`);
  const marker = join(root, "launched.txt");
  const environment = {
    COMSPEC: process.env["ComSpec"] ?? join(systemRoot, "System32", "cmd.exe"),
    PATH: process.env["Path"] ?? join(systemRoot, "System32"),
    SYSTEMROOT: systemRoot, TEMP: root, TMP: root,
  };
  const script = command?.replace("$MARKER", () => JSON.stringify(marker)) ?? null;
  const argv = script === null
    ? ["definitely-not-a-command", "--model", "claude-opus-5", "--effort", "high"]
    : ["-e", script, "--", "--model", "claude-opus-5", "--effort", "high"];
  const launchTemplate = {
    argv, bootstrapCredentialDigest: DIGEST_B, cwd: root, environment,
    launchSelection: SELECTION,
    limits: { stderrBytes: 65_536, stdoutBytes: 65_536, tailBytes: 1_024, timeoutMs },
    runtime: { installedRoot, pinRoot: join(root, "pins"), quotedObservation: quote.observation },
  };
  const request = {
    activationRequestBytes: activationBytes(quote.observation.observationDigest),
    binding: { attemptAggregateId: ACTIVATION_AGGREGATE, nodeKey: NODE_KEY, sessionId: SESSION_ID },
    graphSnapshot: structuredClone(GRAPH), inputManifest: structuredClone(INPUT_MANIFEST),
    launchTemplate,
  };
  return {
    marker, request, root, store: readyStore(root), runtimePorts: {
      clock: { observedAt: () => "2026-08-15T00:00:01.000Z" },
      facts: { observe: async () => ({ adapterCapabilitySchemaDigest: DIGEST_B,
        platformIdentity, reportedVersion }) }, fs: nodeRuntimeFs(),
    },
  };
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
  it.runIf(WINDOWS_ONLY)("launches through the shipped broker once and adopts replay", async () => {
    const fixture = windowsFixture("proven", null, 10_000);
    let captures = 0;
    const service = createFoundationAttemptService({
      captureResult: () => { captures += 1; return captureAnswer(); },
      launchOptions: { platform: "win32" }, runtimePorts: fixture.runtimePorts, store: fixture.store,
    });

    const first = await service.dispatch(fixture.request);

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(captures).toBe(1);
    const activation = eventTypes(fixture.store, ACTIVATION_AGGREGATE);
    expect(activation).toEqual([
      "EffectActivationCommitted", "FoundationActivationGrantConsumed",
      "FoundationLaunchPreflightRegistered", "FoundationLaunchProcessObserved",
    ]);
    expect(new Set(activation).size).toBe(4);
    for (const type of activation) expect(activation.filter((entry) => entry === type)).toHaveLength(1);
    expect(eventTypes(fixture.store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
    expect(first.record).toMatchObject({
      advisoryOnly: true, reasonCode: null, reasonLayer: null, resultManifest: { baseIdentity: HEAD },
      truthClass: "PROVEN",
    });
    expect(first.record["registration"]).toMatchObject({ processIdentity: expect.stringMatching(/^windows:/u) });
    expect(first.record["observation"]).toMatchObject({
      observationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      registrationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const replay = await service.dispatch(structuredClone(fixture.request));
    expect(replay.ok && replay.digest).toBe(first.digest);
    expect(captures).toBe(1);
    expect(eventTypes(fixture.store, ACTIVATION_AGGREGATE)).toEqual(activation);
    const changed = structuredClone(fixture.request);
    (changed["launchTemplate"] as Record<string, unknown>)["cwd"] = join(fixture.root, "other");
    const refused = await service.dispatch(changed);
    expectRefusal(refused, "FOUNDATION_ATTEMPT_REPLAY_MISMATCH", DAEMON_FOUNDATION_ATTEMPT);
    expect(eventTypes(fixture.store, ACTIVATION_AGGREGATE)).toEqual(activation);
  }, 60_000);

  it.runIf(WINDOWS_ONLY)("persists exact stream uncertainty and never relaunches", async () => {
    const fixture = windowsFixture(
      "timeout", "require('node:fs').writeFileSync($MARKER, 'launched');setInterval(()=>{},1000)", 100);
    const service = createFoundationAttemptService({
      captureResult: () => { throw new Error("capture must not run"); },
      launchOptions: { platform: "win32" }, runtimePorts: fixture.runtimePorts, store: fixture.store,
    });

    const outcome = await service.dispatch(fixture.request);

    expectRefusal(outcome, "CLAUDE_LAUNCH_STREAM_ERROR", "OUTPUT");
    expect(existsSync(fixture.marker)).toBe(true);
    const stored = readFoundationAttemptRecord(fixture.store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      reasonCode: "CLAUDE_LAUNCH_STREAM_ERROR", reasonLayer: "OUTPUT",
      resultManifest: null, truthClass: "SUSPECT",
    });
    const before = eventTypes(fixture.store, ACTIVATION_AGGREGATE);
    expect(before).toEqual([
      "EffectActivationCommitted", "FoundationActivationGrantConsumed",
      "FoundationLaunchPreflightRegistered", "FoundationLaunchProcessObserved",
    ]);
    const replay = await service.dispatch(structuredClone(fixture.request));
    expect(replay.ok).toBe(true);
    expect(eventTypes(fixture.store, ACTIVATION_AGGREGATE)).toEqual(before);
  }, 60_000);

  it.runIf(WINDOWS_ONLY)("reservation failure reaches no runtime or physical launch", async () => {
    const fixture = windowsFixture("reservation-abort", null, 10_000);
    let runtimeFacts = 0;
    const service = createFoundationAttemptService({
      captureResult: captureAnswer, launchOptions: { platform: "win32" },
      runtimePorts: { ...fixture.runtimePorts, facts: { observe: async () => {
        runtimeFacts += 1; return await fixture.runtimePorts.facts.observe();
      } } }, store: abortingStore(fixture.store, 2),
    });

    const outcome = await service.dispatch(fixture.request);

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE", DAEMON_FOUNDATION_ATTEMPT);
    expect(runtimeFacts).toBe(0);
    expect(eventTypes(fixture.store, ACTIVATION_AGGREGATE)).toEqual(["EffectActivationCommitted"]);
    expect(eventTypes(fixture.store, DISPATCH_AGGREGATE)).toHaveLength(0);
  });
});
