import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_LAUNCHER_VERSION, observeScope } from "@moe/runner";
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
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { createFoundationLauncherAuthority } from "../activation/foundation-launch-authority.js";
import {
  DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_DISPATCH_EVENT_TYPES,
  decodeFoundationAttemptRequest, decodeFoundationPayload, deriveDispatchAggregateId,
  encodeFoundationPayload, sameBytes,
} from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import { createFoundationAttemptService, readFoundationAttemptRecord } from "./foundation-attempt-service.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-service.js";
import { readDurableFoundationObservation } from "./foundation-attempt-store.js";

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
  runtime: { installedRoot: "C:\\installed", pinRoot: "C:\\pins", quotedObservation: {} },
});
const RUNTIME_PORTS = {
  clock: {}, facts: {}, fs: {},
} as unknown as Parameters<typeof createFoundationAttemptService>[0]["runtimePorts"];
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
  readonly runtimeTouches: () => number;
  readonly service: { dispatch(input: unknown): Promise<FoundationAttemptOutcome> };
}

interface HarnessOptions {
  readonly platform?: string;
}

function harness(store: SqliteEventStore, options: HarnessOptions = {}): Harness {
  const captureCalls: Record<string, unknown>[] = [];
  let runtimeTouches = 0;
  const runtimePorts = {
    clock: { observedAt: () => "2026-08-15T00:00:00.000Z" }, facts: {},
    fs: { hostPlatform: () => { runtimeTouches += 1; return "win32"; } },
  } as unknown as Parameters<typeof createFoundationAttemptService>[0]["runtimePorts"];
  const service = createFoundationAttemptService({
    captureResult: (input) => {
      captureCalls.push(input);
      return captureAnswer();
    },
    launchOptions: { platform: options.platform ?? "linux" }, runtimePorts, store,
  });
  return { captureCalls, runtimeTouches: () => runtimeTouches, service };
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
    expect(run.runtimeTouches()).toBe(0);
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
    expect(run.runtimeTouches()).toBe(0);
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
    expect(run.runtimeTouches()).toBe(0);
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
    expect(run.runtimeTouches()).toBe(0);
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
      runtimePorts: RUNTIME_PORTS,
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
      launchOptions: { deps: {}, platform: "linux" },
      runtimePorts: RUNTIME_PORTS, store,
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
    expect(run.runtimeTouches()).toBe(0);
    expect(run.captureCalls).toHaveLength(0);
    expect(real.readEvents(ACTIVATION_AGGREGATE)).toHaveLength(0);
    expect(real.readEvents(DISPATCH_AGGREGATE)).toHaveLength(0);
  });

  it("aborts the reservation commit after a committed activation and still launches nothing", async () => {
    const real = readyStore("abort-reservation");
    const injected = abortingStore(real, 2);
    const run = harness(injected.store, { platform: "win32" });

    const outcome = await run.service.dispatch(dispatchRequest());

    expect(injected.fired()).toBe(1);
    expectRefusal(
      outcome, "FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE", DAEMON_FOUNDATION_ATTEMPT);
    expect(run.runtimeTouches()).toBe(0);
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
      captureResult: captureAnswer, launchOptions: { platform: "linux" },
      runtimePorts: RUNTIME_PORTS, store,
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
