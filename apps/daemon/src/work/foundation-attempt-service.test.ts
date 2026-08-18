import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_LAUNCHER_VERSION, buildInputManifest, buildProviderRuntimeObservation,
  buildResultManifest, observeScope,
} from "@moe/runner";
import type { GitObserver, ProviderRuntimeObservation, ScopeObservation } from "@moe/runner";
import type { CommitExpectedVersionDecisionInput, SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { ActivationRunCommitInput } from "../activation/activation-run-commit.js";
import type { ActivationTelemetryLaunchInput } from "../activation/activation-telemetry-launch.js";

const providerBoundaryProbe = vi.hoisted(() => ({
  commits: [] as Array<{
    readonly input: ActivationRunCommitInput; readonly result: unknown;
  }>,
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
      providerBoundaryProbe.launches.push({ input: args[1], result });
      return result;
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
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { createFoundationLauncherAuthority } from "../activation/foundation-launch-authority.js";
import {
  PROVIDER_RUN_COMMAND_KIND, PROVIDER_RUN_EVENT_TYPE,
} from "../telemetry/provider-run-contracts.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import {
  DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_DISPATCH_EVENT_TYPES, FOUNDATION_RESERVATION_VERSION,
  RUNNER_WORKSPACE_LAYER, decodeFoundationAttemptRequest, decodeFoundationPayload,
  deriveDispatchAggregateId, encodeFoundationPayload, identifyFoundationDispatch, sameBytes,
} from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import { createFoundationAttemptService, readFoundationAttemptRecord } from "./foundation-attempt-service.js";
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

const encoder = new TextEncoder();
const scratchRoots: string[] = [];

afterEach(() => {
  providerBoundaryProbe.commits.length = 0;
  providerBoundaryProbe.launches.length = 0;
  cleanupRestoreHarnesses();
});
afterAll(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
});

/** Opened inside a case, never in a describe body: a held handle kills the worker. */
function readyStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-dispatch-${label}-`));
  scratchRoots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const HEAD = "0".repeat(40);
const DIGEST_A = "2".repeat(64), DIGEST_B = "3".repeat(64), DIGEST_C = "4".repeat(64);
const NODE_KEY = "dev-done";
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
const BUDGET_VIEW = {
  accountId: "acct-1", meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
  state: "OPEN", version: 2,
} as const;
const ADMISSION = {
  admissionRef: "adm-1",
  amounts: [
    { meter: "usd", purpose: "EXECUTION", quantity: 10 },
    { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
    { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
    { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
    { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
  ],
  expectedVersion: 2,
} as const;
const GATE = { allowance: { decisionRef: "dec-1", outcome: "ALLOW" }, approval: null } as const;
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
      activation: ACTIVATION_SECTION, budget: { admission: ADMISSION, gate: GATE, view: BUDGET_VIEW },
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

const LAUNCH_TEMPLATE = Object.freeze({
  argv: ["--print", "hello", "--model", "claude-opus-5", "--effort", "high"],
  bootstrapCredentialDigest: DIGEST_B, cwd: "C:/work", environment: {},
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
const INPUT_MANIFEST = Object.freeze({
  baseIdentity: HEAD,
  entries: [{ byteLength: 10, path: "pkg/src/base.ts", producer: { kind: "BASE" }, sha256: DIGEST_A }],
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
    authoredPaths: ["pkg/src/authored.ts"], declaredArtifactRefs: [{ byteLength: 7, sha256: DIGEST_C }],
    resultTreeEntries: [
      { byteLength: 10, kind: "REGULAR", origin: "INHERITED", path: "pkg/src/base.ts", sha256: DIGEST_A },
      { byteLength: 4, kind: "REGULAR", origin: "AUTHORED", path: "pkg/src/authored.ts", sha256: DIGEST_B },
    ],
    scopeObservation: scopeObservation(),
  };
}

interface Harness {
  readonly captureCalls: Record<string, unknown>[];
  readonly service: { dispatch(input: unknown): Promise<FoundationAttemptOutcome> };
}

interface HarnessOptions {
  readonly platform?: string;
}

/** Post-launch workspace observation is the ONLY dependency. No runtime
 *  capability is composed here — the service mints its own through @moe/runner. */
function harness(store: SqliteEventStore, options: HarnessOptions = {}): Harness {
  const captureCalls: Record<string, unknown>[] = [];
  const service = createFoundationAttemptService({
    captureResult: (input) => {
      captureCalls.push(input);
      return captureAnswer();
    },
    launchOptions: { platform: options.platform ?? "linux" }, store,
  });
  return { captureCalls, service };
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
      captureResult: captureAnswer,
      launch: async () => {
        forgedCalls += 1;
        return OBSERVED_RESULT;
      },
      launchOptions: { platform: "linux" },
      store,
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
      captureResult: captureAnswer,
      launchOptions: { deps: {}, platform: "linux" }, store,
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

/** A real store whose Nth `commitExpectedVersionDecision` aborts. Every other
 *  method is the genuine store, so the abort is the only injected fact. */
function abortingStore(store: SqliteEventStore, abortOnCall: number): {
  readonly fired: () => number; readonly store: SqliteEventStore;
} {
  let calls = 0, fired = 0;
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "commitExpectedVersionDecision") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (input: CommitExpectedVersionDecisionInput) => {
        calls += 1;
        if (calls === abortOnCall) {
          fired += 1;
          throw new Error("injected SQLite transaction abort");
        }
        return target.commitExpectedVersionDecision(input);
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
    // ORDINAL, AND IT MOVES WHEN A COMMIT IS ADDED. One dispatch now commits, in
    // order: (1) the activation ledger record, (2) the durable attempt-resource
    // set bound by `activation-resource-binding.ts`, (3) THIS reservation. Abort
    // on 2 and the resource bind absorbs it while the reservation succeeds, so
    // the refusal arrives from a later layer and this case silently stops testing
    // the reservation. If you add a commit to `runEffectActivateCommand`, count
    // again here and in the sibling Windows conformance case.
    const injected = abortingStore(real, 3);
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
      captureResult: captureAnswer, launchOptions: { platform: "linux" }, store,
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
      captureResult: captureAnswer, launchOptions: { platform: "linux" },
      runtimePorts: counting, store,
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
  const built = buildInputManifest({
    baseIdentity: HEAD, entries: INPUT_MANIFEST.entries as never,
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
    // ORDINAL, AND IT MOVES WHEN A COMMIT IS ADDED. One dispatch commits, in
    // order: (1) the activation ledger record, (2) the durable attempt-resource
    // set, (3) the Foundation reservation, (4) THIS provider-run commit. If a
    // commit is added anywhere earlier, this case silently starts aborting a
    // different one — count again rather than trusting the number.
    const injected = abortingStore(real, 4);
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
