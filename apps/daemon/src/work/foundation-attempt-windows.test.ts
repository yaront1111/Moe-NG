import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
} from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { buildProviderRuntimeObservation, observeScope } from "@moe/runner";
import type { GitObserver, ScopeObservation } from "@moe/runner";
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

/**
 * NO RUNTIME CAPABILITY IS COMPOSED HERE. The filesystem, host observer and
 * clock the pin protocol needs are minted inside @moe/runner from the three
 * plain data fields below, so this suite proves the shipped composition rather
 * than a test-owned one: a real broker launch that a test filesystem could not
 * have faked. `pinRoot` is a scratch directory the RUNNER creates — its absence
 * is physical evidence that no launch was ever attempted.
 */
interface WindowsFixture {
  readonly marker: string; readonly pinRoot: string;
  readonly request: Record<string, unknown>;
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
  const argv = [...options.argv ?? ["--version"]];
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
  return { marker, pinRoot, request, root, store: readyStore(root) };
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
    const fixture = windowsFixture("unproven-runtime", null, 10_000);
    const service = createFoundationAttemptService({
      captureResult: () => { throw new Error("capture must not run"); },
      launchOptions: { platform: "win32" }, store: fixture.store,
    });

    const outcome = await service.dispatch(fixture.request);

    expectRefusal(outcome, "CLAUDE_RUNTIME_OBSERVATION_INVALID", "RUNTIME");
    // Nothing was pinned and no provider process ever started.
    expect(existsSync(fixture.pinRoot)).toBe(false);
    expect(existsSync(fixture.marker)).toBe(false);
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
    const fixture = windowsFixture("reservation-abort", null, 10_000);
    const service = createFoundationAttemptService({
      captureResult: captureAnswer, launchOptions: { platform: "win32" },
      store: abortingStore(fixture.store, 2),
    });

    const outcome = await service.dispatch(fixture.request);

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE", DAEMON_FOUNDATION_ATTEMPT);
    // The pinned copy is the runner's FIRST physical act; the marker is the
    // provider's. Neither exists, so nothing was launched under a lost reservation.
    expect(existsSync(fixture.pinRoot)).toBe(false);
    expect(existsSync(fixture.marker)).toBe(false);
    expect(eventTypes(fixture.store, ACTIVATION_AGGREGATE)).toEqual(["EffectActivationCommitted"]);
    expect(eventTypes(fixture.store, DISPATCH_AGGREGATE)).toHaveLength(0);
  });
});
