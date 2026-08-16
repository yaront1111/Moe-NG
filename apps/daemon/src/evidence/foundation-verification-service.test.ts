import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  CLAUDE_LAUNCHER_VERSION, buildInputManifest, buildProviderRuntimeObservation,
  buildVerificationRecipe, observeScope,
} from "@moe/runner";
import type {
  DeclaredInput, GitObserver, LaunchedProcess, ProcessLauncher, ProviderRuntimeObservation,
  ScopeObservation, VerifierExitObservation, VerifierLaunchSpec,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { createFoundationLauncherAuthority } from "../activation/foundation-launch-authority.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import { deriveDispatchAggregateId } from "../work/foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "../work/foundation-attempt-contracts.js";
import {
  readDurableFoundationObservation, readFoundationAttemptRecord, recordProvenFoundationAttempt,
} from "../work/foundation-attempt-store.js";
import { encodeFoundationPayload } from "../work/foundation-attempt-codec.js";
import {
  FOUNDATION_VERIFICATION_CODES, FOUNDATION_VERIFICATION_COMMAND_KIND,
  FOUNDATION_VERIFICATION_EVENT_TYPES, FOUNDATION_VERIFICATION_LAYERS,
} from "./foundation-verification-contracts.js";
import type {
  FoundationRecipeRegistration, FoundationVerificationOutcome,
} from "./foundation-verification-contracts.js";
import {
  createFoundationVerificationService, deriveRecipeAggregateId, deriveVerificationAggregateId,
} from "./foundation-verification-service.js";

/**
 * Durable verification receipt dispatch over a REAL SqliteEventStore, the REAL
 * activation ingress and launcher authority, the REAL durable attempt writer and
 * the REAL `runVerifierProcess`.
 *
 * Nothing here hand-forges an activation: `parseActivationGrant` demands a hex64
 * grantId derived from the whole successor intent, so the only way to a coherent
 * grant is the production chain, driven end to end below.
 *
 * The recording launcher is used ONLY to prove a process was NOT started. It
 * never stands in for a successful run — every case that accepts evidence in the
 * step-4 suite drives a real child through `createNodeProcessLauncher`, because a
 * receipt minted from a fake process would be exactly the mock-backed acceptance
 * the task rails forbid.
 *
 * Each case derives its own effect intent from its label. `runVerifierProcess`
 * keeps a module-level run registry keyed by grantId, so two cases sharing an
 * intent would share a grant and the second would adopt the first one's run.
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

const DIGEST = "a".repeat(64);
const DIGEST_A = "2".repeat(64), DIGEST_B = "3".repeat(64), DIGEST_C = "4".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const HEAD = "0".repeat(40);
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
  accountId: "acct-1",
  meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
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
const INPUT_ENTRIES = Object.freeze([
  { byteLength: 10, path: "pkg/src/base.ts", producer: { kind: "BASE" }, sha256: DIGEST_A },
]);

/** Opened inside a case, never in a describe body: a held handle kills the worker. */
function readyStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-verify-${label}-`));
  scratchRoots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    throw new TypeError(`${key} is not a record`);
  }
  return found as Record<string, unknown>;
}

/** Label-derived so every case owns a distinct intent, aggregate and grant. */
function activationBytes(label: string): Uint8Array {
  const intentId = `intent-${label}`;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-${label}`, correlationId: `corr-${label}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: {
        attempt: {
          aggregateId: `agg-${label}`, attemptId: `attempt-${label}`, intentId,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim: {
          claimId: `claim-${label}`, claimedAt: DECIDED_AT, intentId, lockIdentity: "lock-1",
          wrapperIdentity: "wrapper-1",
        },
        dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
        lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: "wrapper-1",
      },
      budget: { admission: ADMISSION, gate: GATE, view: BUDGET_VIEW },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${label}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${label}`, inputBinding: DIGEST, intentId,
          leaseBinding: LEASE_RECORD, predecessorCursor: "cursor-1",
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

function fakeGit(): GitObserver {
  return {
    headCommit: () => HEAD, lsFilesIgnored: () => [], lsFilesTracked: () => [],
    statusPorcelainV2: () => encoder.encode(`# branch.oid ${HEAD}\0`), submodulePaths: () => [],
  };
}

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
    authoredPaths: ["pkg/src/authored.ts"],
    declaredArtifactRefs: [{ byteLength: 7, sha256: DIGEST_C }],
    resultTreeEntries: [
      {
        byteLength: 10, kind: "REGULAR", origin: "INHERITED", path: "pkg/src/base.ts",
        sha256: DIGEST_A,
      },
      {
        byteLength: 4, kind: "REGULAR", origin: "AUTHORED", path: "pkg/src/authored.ts",
        sha256: DIGEST_B,
      },
    ],
    scopeObservation: scopeObservation(),
  };
}

function sealedInput(): Record<string, unknown> {
  const built = buildInputManifest({ baseIdentity: HEAD, entries: INPUT_ENTRIES as never });
  if (!built.ok) throw new Error(`input manifest fixture refused: ${built.code}`);
  return built.manifest as unknown as Record<string, unknown>;
}

/** A genuinely digest-bound quote from the runner's own observation builder. */
function runtimeQuote(): ProviderRuntimeObservation {
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: DIGEST_B, clock: { observedAt: () => DECIDED_AT },
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: "claude/2.0.0",
    resolvedRuntimeClosure: [
      { kind: "EXECUTABLE", path: "C:\\installed\\claude.exe", sha256: DIGEST_A },
    ] as never,
  });
  if (!built.ok) throw new Error(`runtime quote fixture refused: ${built.code}`);
  return built.observation;
}

interface Ground {
  readonly attemptAggregateId: string;
  readonly bound: FoundationAttemptBound;
  readonly recordDigest: string;
  readonly store: SqliteEventStore;
}

/**
 * A durable attempt record, produced by the production chain only: activation
 * ingress -> launcher authority GRANT_CONSUMED/PREFLIGHT/PROCESS_OBSERVED ->
 * `readDurableFoundationObservation` -> `recordProvenFoundationAttempt`. The
 * observation/registration pair is whatever production validated, never a copy.
 * `answer` decides whether the durable record lands PROVEN or UNKNOWN.
 */
function ground(label: string, answer: Record<string, unknown>): Ground {
  const store = readyStore(label);
  const activationAggregate = deriveActivationAggregateId(`agg-${label}`, `idem-${label}`);
  const activated = runEffectActivateCommand(store, activationBytes(label));
  if (!activated.ok) throw new Error(`activation refused: ${activated.code}`);
  const initial = readFoundationActivationHistory(
    activationAggregate, store.readEvents(activationAggregate), PROJECT_ID);
  if (!initial.ok) throw new Error(`activation unreadable: ${initial.result.status}`);
  const { record } = initial.history;
  const claim = {
    claimId: `claim-${label}`, claimedAt: DECIDED_AT, intentId: `intent-${label}`,
    lockIdentity: "lock-1", wrapperIdentity: "wrapper-1",
  };
  const authority = createFoundationLauncherAuthority({
    aggregateId: activationAggregate, correlationId: `corr-tail-${label}`,
    key: { commandId: `cmd-tail-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    projectId: PROJECT_ID, store,
  });
  const consumed = authority.consumeGrantDurably(record.grant, record.grant.wrapperIdentity);
  const grant = nested(consumed as Record<string, unknown>, "grant");
  authority.commitProcessRegistration({
    claim, phase: "PREFLIGHT", prior: null,
    registration: {
      ...REGISTRATION, processIdentity: `pending:${record.grant.wrapperIdentity}`,
      registeredAt: "2026-08-15T00:00:00.500Z",
    },
  });
  authority.commitProcessRegistration({
    claim, phase: "STARTED", prior: null, registration: REGISTRATION,
  });
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: activationAggregate, claim, commandId: `cmd-dispatch-${label}`,
    correlationId: `corr-dispatch-${label}`, nodeKey: NODE_KEY, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId: SESSION_ID,
    target: deriveDispatchAggregateId(activationAggregate),
  });
  const value = {
    code: null, consumedGrant: grant, kind: "OBSERVED", layer: null,
    observation: {
      ...OBSERVATION, activationDigest: record.activationDigest, grantId: record.grant.grantId,
      launcherVersion: CLAUDE_LAUNCHER_VERSION, lockIdentity: REGISTRATION.lockIdentity,
      processIdentity: REGISTRATION.processIdentity, reasonCode: null, reasonLayer: null,
      truthClass: "PROVEN", wrapperIdentity: REGISTRATION.wrapperIdentity,
    },
    ok: true, registration: { ...REGISTRATION }, truthClass: "PROVEN",
  };
  const observed = readDurableFoundationObservation(store, bound, record, value);
  if (observed === null) throw new Error("durable observation fixture was refused");
  recordProvenFoundationAttempt(store, bound, record, sealedInput(), {
    answer, observation: observed[0], registration: observed[1],
  });
  // The digest always comes from the RE-DECODED durable record, never from the
  // writer's return value: the UNKNOWN ground's writer answers with a refusal.
  const stored = readFoundationAttemptRecord(store, activationAggregate);
  if (!stored.ok) throw new Error(`record fixture unreadable: ${stored.code}`);
  return { attemptAggregateId: activationAggregate, bound, recordDigest: stored.digest, store };
}

/** A PROVEN durable record: the capture answer is the shape the result builder
 *  accepts, so the record carries a real result manifest. */
function provenGround(label: string): Ground {
  return ground(label, captureAnswer());
}

/**
 * An UNKNOWN durable record produced by the SAME production writer: the capture
 * answer is missing its required keys, so `recordProvenFoundationAttempt` takes
 * its advisory branch and persists truthClass UNKNOWN with a reason code. This
 * is a real durable state, not a hand-written one.
 */
function unprovenGround(label: string): Ground {
  return ground(label, { authoredPaths: ["pkg/src/authored.ts"] });
}

interface Recorder {
  readonly launcher: ProcessLauncher;
  readonly launches: VerifierLaunchSpec[];
}

/**
 * Proves ABSENCE only. If a case ever reaches it the returned process never
 * closes on its own, so an ordering bug surfaces as a bounded test failure
 * rather than a hang that looks like a slow suite.
 */
function recordingLauncher(): Recorder {
  const launches: VerifierLaunchSpec[] = [];
  const launcher: ProcessLauncher = {
    launch: (spec: VerifierLaunchSpec): LaunchedProcess => {
      launches.push(spec);
      const closed = new Promise<VerifierExitObservation>((resolve) => {
        setTimeout(() => resolve({ exitCode: 0, signal: null }), 50).unref?.();
      });
      return {
        closed, kill: () => undefined, onStderr: () => undefined, onStdout: () => undefined,
        pid: 4242,
      };
    },
  };
  return { launcher, launches };
}

const VERIFIER_IDENTITY = Object.freeze({
  capabilitySchemaDigest: DIGEST_B, verifierId: "moe-verifier", verifierVersion: "1.0.0",
});

function declaredInputs(): readonly DeclaredInput[] {
  return [{ path: "pkg/src/base.ts", ref: { byteLength: 10, sha256: DIGEST_A } }];
}

function registration(
  recipeAggregateId: string, argv: readonly string[],
): FoundationRecipeRegistration {
  return {
    argv, declaredInputs: declaredInputs(), declaredOutputPaths: [], recipeAggregateId,
    runtimeObservation: runtimeQuote(), verifierIdentity: VERIFIER_IDENTITY,
  };
}

/** An argv the wrapper's launch gate accepts: an absolute executable path. */
const VERIFIER_ARGV = Object.freeze([process.execPath, "-e", "process.exit(0)"]);

/**
 * Durable corruption, injected through the store's OWN commit port rather than a
 * hook on the service: a real sealed recipe whose stored `sha256` has been
 * replaced, so the bytes decode cleanly and only `recipeSealMatches` can catch it.
 */
function sealTamperedRecipe(store: SqliteEventStore, recipeAggregateId: string): void {
  const built = buildVerificationRecipe({
    argv: VERIFIER_ARGV, declaredInputs: declaredInputs(), declaredOutputPaths: [],
    verifierIdentity: VERIFIER_IDENTITY,
  });
  if (!built.ok) throw new Error(`recipe fixture refused: ${built.code}`);
  const encoded = encodeFoundationPayload({
    recipe: { ...built.recipe, sha256: "c".repeat(64) },
    recipeAggregateId, runtimeObservation: runtimeQuote(),
  });
  if (!encoded.ok) throw new Error("tampered recipe fixture could not be encoded");
  const target = deriveRecipeAggregateId(recipeAggregateId);
  store.commitExpectedVersionDecision({
    commandKind: FOUNDATION_VERIFICATION_COMMAND_KIND, committedResultBytes: encoded.bytes,
    correlationId: `corr-tamper-${recipeAggregateId}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `${recipeAggregateId}:TAMPERED`,
      eventType: FOUNDATION_VERIFICATION_EVENT_TYPES.RECIPE_SEALED, payload: encoded.bytes,
    }],
    expectedVersion: 0,
    key: {
      commandId: `cmd-tamper-${recipeAggregateId}`, principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    },
    requestBytes: encoded.bytes, targetAggregateId: target,
  });
}

function service(store: SqliteEventStore, launcher: ProcessLauncher): ReturnType<
  typeof createFoundationVerificationService
> {
  return createFoundationVerificationService({ launcher, store });
}

function eventTypes(store: SqliteEventStore, aggregateId: string): readonly string[] {
  return store.readEvents(aggregateId).map((event) => event.eventType);
}

function expectDaemonRefusal(
  outcome: FoundationVerificationOutcome, code: string, layer: string,
): void {
  expect(outcome).toMatchObject({ code, layer, ok: false, source: "DAEMON_VERIFICATION" });
}

const CANDIDATE_ROOT = isAbsolute("C:\\candidate") ? "C:\\candidate" : "/candidate";

describe("foundation verification — the frozen vocabularies are iterable and closed", () => {
  it("declares distinct codes and layers with no wrapper code restated", () => {
    expect(FOUNDATION_VERIFICATION_CODES.length).toBeGreaterThan(0);
    expect(new Set(FOUNDATION_VERIFICATION_CODES).size)
      .toBe(FOUNDATION_VERIFICATION_CODES.length);
    expect(new Set(FOUNDATION_VERIFICATION_LAYERS).size)
      .toBe(FOUNDATION_VERIFICATION_LAYERS.length);
    for (const code of FOUNDATION_VERIFICATION_CODES) {
      expect(code.startsWith("FOUNDATION_VERIFICATION_")).toBe(true);
      expect(code.startsWith("VERIFIER_PROCESS_")).toBe(false);
      expect(code.startsWith("RUNNER_EVIDENCE_")).toBe(false);
    }
  });
});

describe("foundation verification — identity loading refuses before any process starts", () => {
  it("refuses a request that is not the exact identity shape, launching nothing", async () => {
    const ground = provenGround("malformed");
    const recorder = recordingLauncher();
    const outcome = await service(ground.store, recorder.launcher).verify({
      attemptAggregateId: ground.attemptAggregateId, candidateRoot: CANDIDATE_ROOT,
      expectedRecordDigest: ground.recordDigest, recipeAggregateId: "recipe-1",
      verificationId: "verify-1",
      // A payload the caller may not present: durable state is never replaceable.
      inputManifest: sealedInput(),
    });

    expectDaemonRefusal(
      outcome, "FOUNDATION_VERIFICATION_REQUEST_MALFORMED", "DAEMON_VERIFICATION_REQUEST");
    expect(recorder.launches).toHaveLength(0);
  });

  it("carries the store's own code and layer when the attempt identity resolves to nothing",
    async () => {
      const ground = provenGround("absent-attempt");
      const recorder = recordingLauncher();
      const svc = service(ground.store, recorder.launcher);
      expect(svc.sealRecipe(registration("recipe-absent", VERIFIER_ARGV)).ok).toBe(true);

      const outcome = await svc.verify({
        attemptAggregateId: "activation-that-does-not-exist", candidateRoot: CANDIDATE_ROOT,
        expectedRecordDigest: ground.recordDigest, recipeAggregateId: "recipe-absent",
        verificationId: "verify-absent",
      });

      // The store's vocabulary, unrestamped — this service has no code for it.
      expect(outcome).toMatchObject({
        code: "FOUNDATION_ATTEMPT_RECORD_ABSENT", layer: "DAEMON_FOUNDATION_ATTEMPT", ok: false,
        source: "FOUNDATION_ATTEMPT",
      });
      expect(recorder.launches).toHaveLength(0);
    });

  it("refuses a record digest that no longer matches the durable record", async () => {
    const ground = provenGround("stale-digest");
    const recorder = recordingLauncher();
    const svc = service(ground.store, recorder.launcher);
    expect(svc.sealRecipe(registration("recipe-stale", VERIFIER_ARGV)).ok).toBe(true);

    const outcome = await svc.verify({
      attemptAggregateId: ground.attemptAggregateId, candidateRoot: CANDIDATE_ROOT,
      expectedRecordDigest: "b".repeat(64), recipeAggregateId: "recipe-stale",
      verificationId: "verify-stale",
    });

    expectDaemonRefusal(
      outcome, "FOUNDATION_VERIFICATION_CANDIDATE_STALE", "DAEMON_VERIFICATION_IDENTITY");
    expect(recorder.launches).toHaveLength(0);
  });

  it("refuses a recipe identity that resolves to nothing", async () => {
    const ground = provenGround("absent-recipe");
    const recorder = recordingLauncher();

    const outcome = await service(ground.store, recorder.launcher).verify({
      attemptAggregateId: ground.attemptAggregateId, candidateRoot: CANDIDATE_ROOT,
      expectedRecordDigest: ground.recordDigest, recipeAggregateId: "recipe-never-sealed",
      verificationId: "verify-no-recipe",
    });

    expectDaemonRefusal(
      outcome, "FOUNDATION_VERIFICATION_RECIPE_UNRESOLVED", "DAEMON_VERIFICATION_IDENTITY");
    expect(recorder.launches).toHaveLength(0);
  });

  it("refuses a durably stored recipe whose seal no longer re-derives", async () => {
    const ground = provenGround("broken-seal");
    const recorder = recordingLauncher();
    const svc = service(ground.store, recorder.launcher);
    // Corruption is injected at the DURABLE layer through the store's own commit
    // port — the same port the service writes through — never through a test
    // hook on the service. The recipe reaching `recipeSealMatches` is the one
    // that was read back out of the store.
    sealTamperedRecipe(ground.store, "recipe-broken");

    const outcome = await svc.verify({
      attemptAggregateId: ground.attemptAggregateId, candidateRoot: CANDIDATE_ROOT,
      expectedRecordDigest: ground.recordDigest, recipeAggregateId: "recipe-broken",
      verificationId: "verify-broken-seal",
    });

    expectDaemonRefusal(
      outcome, "FOUNDATION_VERIFICATION_RECIPE_SEAL_INVALID", "DAEMON_VERIFICATION_IDENTITY");
    expect(recorder.launches).toHaveLength(0);
  });

  it("refuses an attempt whose durable record is not PROVEN", async () => {
    const ground = unprovenGround("unproven");
    const recorder = recordingLauncher();
    const svc = service(ground.store, recorder.launcher);
    expect(svc.sealRecipe(registration("recipe-unproven", VERIFIER_ARGV)).ok).toBe(true);
    // The fixture really is an UNKNOWN record, so the refusal below cannot be
    // answered by anything else.
    const stored = readFoundationAttemptRecord(ground.store, ground.attemptAggregateId);
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.record["truthClass"]).toBe("UNKNOWN");

    const outcome = await svc.verify({
      attemptAggregateId: ground.attemptAggregateId, candidateRoot: CANDIDATE_ROOT,
      expectedRecordDigest: ground.recordDigest, recipeAggregateId: "recipe-unproven",
      verificationId: "verify-unproven",
    });

    expectDaemonRefusal(
      outcome, "FOUNDATION_VERIFICATION_ATTEMPT_UNPROVEN", "DAEMON_VERIFICATION_IDENTITY");
    expect(recorder.launches).toHaveLength(0);
  });
});

describe("foundation verification — the activation is committed before the run", () => {
  it("never leaves a run with no activation when the wrapper refuses", async () => {
    const ground = provenGround("activation-first");
    const recorder = recordingLauncher();
    const svc = service(ground.store, recorder.launcher);
    expect(svc.sealRecipe(registration("recipe-order", VERIFIER_ARGV)).ok).toBe(true);

    // A relative candidate root is refused by the WRAPPER's launch gate, not by
    // this service — so the refusal necessarily happens after activation, which
    // is the ordering this case exists to pin.
    const outcome = await svc.verify({
      attemptAggregateId: ground.attemptAggregateId, candidateRoot: "relative/candidate",
      expectedRecordDigest: ground.recordDigest, recipeAggregateId: "recipe-order",
      verificationId: "verify-order",
    });

    // The wrapper's own code and layer, carried through unrestamped.
    expect(outcome).toMatchObject({
      code: "VERIFIER_PROCESS_WORKSPACE_INVALID", layer: "LAUNCH_GATE", ok: false,
      source: "VERIFIER_PROCESS",
    });
    const types = eventTypes(ground.store, deriveVerificationAggregateId("verify-order"));
    // An activation with no receipt is the safe direction; a receipt with no
    // activation is an effect nothing authorised.
    expect(types).toContain(FOUNDATION_VERIFICATION_EVENT_TYPES.ACTIVATED);
    expect(types).not.toContain(FOUNDATION_VERIFICATION_EVENT_TYPES.RECEIPTED);
  });
});
