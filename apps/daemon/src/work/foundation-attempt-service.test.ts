import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observeScope } from "@moe/runner";
import type { GitObserver, ScopeObservation } from "@moe/runner";
import type { CommitExpectedVersionDecisionInput, SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import {
  DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_ATTEMPT_RECORD_VERSION, FOUNDATION_DISPATCH_EVENT_TYPES,
  decodeFoundationAttemptRequest, decodeFoundationPayload, deriveDispatchAggregateId,
  encodeFoundationPayload, sameBytes,
} from "./foundation-attempt-contracts.js";
import { createFoundationAttemptService, readFoundationAttemptRecord } from "./foundation-attempt-service.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-service.js";

/**
 * Foundation attempt dispatch over a REAL SqliteEventStore and the REAL
 * activation ingress, scheduler validator and workspace manifest builders.
 *
 * ONLY TWO BOUNDARIES ARE EVER REPLACED: the physical Claude launch and the
 * physical post-launch workspace observation. Every claim, activation, grant,
 * reservation, registration and store decision below is production code — a
 * suite that stubbed those would be asserting its own fixtures.
 *
 * NOTHING HERE HAND-FORGES A GRANT. `parseActivationGrant` demands a hex64
 * grantId derived from the whole successor intent and `canonicalDigest` is not
 * exported, so a coherent activation can only come out of the production chain
 * (mem:gotcha-coherent-activation-fixture-needs-activateeffect). The activation
 * fixture below is therefore the ingress's own, driven end to end.
 */

const encoder = new TextEncoder();
const scratchRoots: string[] = [];

afterEach(cleanupRestoreHarnesses);
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

const LAUNCH_TEMPLATE = Object.freeze({
  argv: ["claude", "--model", "claude-opus-5"], bootstrapCredentialDigest: DIGEST_B,
  cwd: "C:/work", environment: { PATH: "C:/bin" },
  launchSelection: { effort: "high", model: "claude-opus-5" },
  limits: { stderrBytes: 1_024, stdoutBytes: 1_024, tailBytes: 256, timeoutMs: 1_000 },
  runtime: { executablePath: "C:/claude.exe" },
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
  readonly launchCalls: Record<string, unknown>[];
  readonly service: { dispatch(input: unknown): Promise<FoundationAttemptOutcome> };
}

interface HarnessOptions {
  readonly capture?: (input: Record<string, unknown>) => unknown;
  readonly launch?: (value: unknown) => Promise<unknown>;
}

function harness(store: SqliteEventStore, options: HarnessOptions = {}): Harness {
  const captureCalls: Record<string, unknown>[] = [];
  const launchCalls: Record<string, unknown>[] = [];
  const service = createFoundationAttemptService({
    captureResult: (input) => {
      captureCalls.push(input);
      return (options.capture ?? captureAnswer)(input);
    },
    launch: async (value) => {
      launchCalls.push(value as Record<string, unknown>);
      return await ((options.launch ?? (async () => OBSERVED_RESULT))(value) as Promise<never>);
    },
    store,
  });
  return { captureCalls, launchCalls, service };
}

function eventTypes(store: SqliteEventStore, aggregateId: string): readonly string[] {
  return store.readEvents(aggregateId).map((event) => event.eventType);
}

function expectRefusal(outcome: FoundationAttemptOutcome, code: string, refusedBy: string): void {
  expect(outcome).toMatchObject({ advisoryOnly: true, authority: "NONE", code, ok: false, refusedBy });
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
});

describe("foundation attempt dispatch — the accepted single-node path", () => {
  it("commits the activation and reservation before the first launch, then records", async () => {
    const store = readyStore("accepted");
    let seenAtLaunch: readonly string[] = [];
    const run = harness(store, {
      launch: async (value) => {
        seenAtLaunch = [
          ...eventTypes(store, ACTIVATION_AGGREGATE), ...eventTypes(store, DISPATCH_AGGREGATE),
        ];
        void value;
        return OBSERVED_RESULT;
      },
    });

    const outcome = await run.service.dispatch(dispatchRequest());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The durable activation and this service's reservation both PRECEDE the launch.
    expect(seenAtLaunch).toEqual(["EffectActivationCommitted", "FoundationDispatchReserved"]);
    expect(run.launchCalls).toHaveLength(1);
    expect(run.captureCalls).toHaveLength(1);
    const launched = run.launchCalls[0] ?? {};
    // Store-decoded authority, the admitted claim, and no caller-supplied prior.
    expect(launched).toMatchObject({
      attempt: { attemptId: "attempt-1", state: "RUNNING" },
      claim: CLAIM, duplicateDelivery: null, effect: { intentId: "intent-1", state: "ACTIVE" },
      grant: { intentId: "intent-1", state: "UNUSED" }, priorRegistration: null,
      wrapperIdentity: "wrapper-1",
    });
    expect(Object.keys(launched)).not.toContain("freshRuntime");
    const { record } = outcome;
    expect(record).toMatchObject({
      advisoryOnly: true, attemptId: "attempt-1", effectId: "intent-1", nodeKey: NODE_KEY,
      recordVersion: FOUNDATION_ATTEMPT_RECORD_VERSION, sessionId: SESSION_ID,
      stderrSha256: DIGEST_B, stdoutSha256: DIGEST_A, truthClass: "PROVEN",
      wrapperIdentity: "wrapper-1",
    });
    expect(record["observation"]).toMatchObject({
      freshRuntimeDigest: DIGEST_C, observationDigest: DIGEST_A, registrationDigest: DIGEST_C,
      runtimeBindingDigest: DIGEST,
    });
    // PROCESS_OBSERVED identity, not the pending preflight reservation.
    expect(record["registration"]).toMatchObject({ processIdentity: "windows:4242:99" });
    expect(record["resultManifest"]).toMatchObject({ baseIdentity: HEAD });
    expect(eventTypes(store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
    // The read model answers the identical bytes the dispatch returned.
    const reread = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(reread.ok && reread.digest).toBe(outcome.digest);
    expect(reread.ok && reread.record).toStrictEqual(record);
  });

  it("refuses a second execution-bearing node with no claim, activation or dispatch residue", async () => {
    const store = readyStore("multinode");
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;
    const run = harness(store);

    const outcome = await run.service.dispatch(
      dispatchRequest({ graphSnapshot: structuredClone(MULTI_NODE_GRAPH) }));

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_MULTI_NODE_UNSUPPORTED", DAEMON_FOUNDATION_ATTEMPT);
    expect(run.launchCalls).toHaveLength(0);
    expect(run.captureCalls).toHaveLength(0);
    expect(store.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
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
    expect(run.launchCalls).toHaveLength(0);
    expect(store.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
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
    const run = harness(injected.store);

    const outcome = await run.service.dispatch(dispatchRequest());

    expect(injected.fired()).toBe(1);
    expectRefusal(outcome, "ACTIVATION_LEDGER_STORE_UNAVAILABLE", "ACTIVATION_LEDGER");
    expect(run.launchCalls).toHaveLength(0);
    expect(run.captureCalls).toHaveLength(0);
    expect(real.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(real.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  it("aborts the reservation commit after a committed activation and still launches nothing", async () => {
    const real = readyStore("abort-reservation");
    const injected = abortingStore(real, 2);
    const run = harness(injected.store);

    const outcome = await run.service.dispatch(dispatchRequest());

    expect(injected.fired()).toBe(1);
    expectRefusal(
      outcome, "FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE", DAEMON_FOUNDATION_ATTEMPT);
    expect(run.launchCalls).toHaveLength(0);
    expect(eventTypes(real, ACTIVATION_AGGREGATE)).toEqual(["EffectActivationCommitted"]);
    expect(real.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });
});

describe("foundation attempt dispatch — duplicate delivery and recovery", () => {
  it("keeps one claim, one reservation and one launch across concurrent identical deliveries", async () => {
    const store = readyStore("concurrent");
    // Assigned synchronously by the executor; the default keeps the binding
    // callable for TypeScript, which cannot see that the executor already ran.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = harness(store, {
      launch: async () => {
        await gate;
        return OBSERVED_RESULT;
      },
    });

    const first = run.service.dispatch(dispatchRequest());
    const second = run.service.dispatch(dispatchRequest());
    const loser = await second;
    release();
    const winner = await first;

    expect(run.launchCalls).toHaveLength(1);
    expect(run.captureCalls).toHaveLength(1);
    expect(winner.ok).toBe(true);
    // The loser reached the reservation second and must not have launched.
    expectRefusal(loser, "FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS", DAEMON_FOUNDATION_ATTEMPT);
    expect(eventTypes(store, ACTIVATION_AGGREGATE)).toEqual(["EffectActivationCommitted"]);
    expect(eventTypes(store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
  });

  it("answers a replay after completion from the stored bytes without relaunching", async () => {
    const store = readyStore("replay");
    const run = harness(store);

    const first = await run.service.dispatch(dispatchRequest());
    const second = await run.service.dispatch(dispatchRequest());

    expect(first.ok && second.ok).toBe(true);
    expect(run.launchCalls).toHaveLength(1);
    expect(run.captureCalls).toHaveLength(1);
    expect(second.ok && first.ok && second.digest).toBe(first.ok ? first.digest : "");
    expect(second.ok && second.record).toStrictEqual(first.ok ? first.record : null);
    expect(eventTypes(store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
  });

  it("persists an honest UNKNOWN with no result manifest when capture cannot answer", async () => {
    const store = readyStore("capture-throw");
    const run = harness(store, {
      capture: () => {
        throw new Error("workspace observation failed");
      },
    });

    const outcome = await run.service.dispatch(dispatchRequest());

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN", DAEMON_FOUNDATION_ATTEMPT);
    expect(run.launchCalls).toHaveLength(1);
    const stored = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.record).toMatchObject({
      advisoryOnly: true, reasonCode: "FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN",
      reasonLayer: DAEMON_FOUNDATION_ATTEMPT, resultManifest: null, truthClass: "UNKNOWN",
    });
    // The observed process facts survive even though the result did not.
    expect(stored.record["registration"]).toMatchObject({ processIdentity: "windows:4242:99" });
  });

  it("records a SUSPECT advisory and never relaunches when the launch port throws", async () => {
    const store = readyStore("launch-throw");
    const run = harness(store, {
      launch: async () => {
        throw new Error("boundary lost");
      },
    });

    const outcome = await run.service.dispatch(dispatchRequest());

    expectRefusal(outcome, "FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN", DAEMON_FOUNDATION_ATTEMPT);
    const stored = readFoundationAttemptRecord(store, ACTIVATION_AGGREGATE);
    expect(stored.ok && stored.record).toMatchObject({
      resultManifest: null, truthClass: "SUSPECT",
    });
    // A restart-shaped redelivery adopts the stored fact instead of launching again.
    const again = await run.service.dispatch(dispatchRequest());
    expect(again.ok).toBe(true);
    expect(run.launchCalls).toHaveLength(1);
    expect(eventTypes(store, DISPATCH_AGGREGATE))
      .toEqual(["FoundationDispatchReserved", "FoundationAttemptRecorded"]);
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

describe("foundation attempt dispatch — the record event type is stable", () => {
  it("names the two durable event types this service may ever write", () => {
    expect(FOUNDATION_DISPATCH_EVENT_TYPES).toStrictEqual({
      RECORDED: "FoundationAttemptRecorded", RESERVED: "FoundationDispatchReserved",
    });
  });
});
