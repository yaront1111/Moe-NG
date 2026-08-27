/**
 * The server-owned `ReleaseHandoff` builder (task-a20e8ef668b54c3abbfce37a505252eb).
 *
 * EVERY WORLD HERE IS FILE-BACKED AND REACHED THROUGH PRODUCTION WRITERS. The activation
 * comes from `runEffectActivateCommand` over `seedReadyProject`, exactly as
 * `release-terminal-evidence.test.ts` composes it, so the durable rows the builder reads
 * were committed by the system rather than shaped by a fixture.
 *
 * WHAT THE ABSENCE CASES PROVE. With the activation committed and no other source written,
 * each of the builder's six sources is genuinely ABSENT, and the assertion is on WHICH
 * source is named and WHICH code it carries — not merely that the build refused. A builder
 * that collapsed two sources onto one code would stay green under a bare "refused" check.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import type { FoundationAttemptBinding } from "../activation/activation-attempt-reader.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_EVENT_TYPE,
  deriveAttemptJournalAggregateId,
} from "../journal/journal-contracts.js";
import { deriveProviderRunAggregateId } from "../telemetry/provider-run-contracts.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import { applyAttemptResourceReport } from "./attempt-resource-authority.js";
import {
  deriveFoundationArtifactAggregateId,
} from "./foundation-artifact-ledger.js";
import { readSealedFoundationContext } from "./foundation-context-record.js";
import {
  DAEMON_RELEASE_HANDOFF, RELEASE_HANDOFF_CODES, RELEASE_HANDOFF_IDENTITY_KEYS,
  RELEASE_HANDOFF_SOURCES, SCHEDULER_HANDOFF_KEYS,
} from "./release-handoff-contracts.js";
import type { ReleaseHandoffIdentity } from "./release-handoff-contracts.js";
import { buildReleaseHandoff } from "./release-handoff-builder.js";
import { handoffAggregateIds } from "./release-handoff-classify.js";
import { seedReleaseHandoffSources } from "./release-handoff-test-harness.js";
import {
  STEP_CHECKPOINTED_EVENT_TYPE, STEP_CHECKPOINT_COMMAND_KIND,
  STEP_FINISHED_EVENT_TYPE, STEP_FINISH_COMMAND_KIND, STEP_STARTED_EVENT_TYPE,
  STEP_START_COMMAND_KIND, deriveAttemptStepAggregateId, deriveStepRef,
} from "./step-lifecycle-contracts.js";

const SLUG = "relhof";
const ATTEMPT = `attempt-${SLUG}`;
const INTENT = `intent-${SLUG}`;
const SESSION = `session-${SLUG}`;
const NODE_KEY = "dev-done";
const EPOCH = 41;
const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;
const ACTIVATION_AGGREGATE = deriveActivationAggregateId(`agg-${SLUG}`, `idem-${SLUG}`);
const encoder = new TextEncoder();

const roots: string[] = [];

/** A held SQLite handle EPERMs temp cleanup on win32 and kills the vitest worker outright. */
afterEach(() => {
  cleanupRestoreHarnesses();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  }
});

function openStore(label: string): { readonly store: SqliteEventStore; readonly storePath: string } {
  const root = mkdtempSync(join(tmpdir(), `moe-release-handoff-${label}-`));
  roots.push(root);
  const storePath = join(root, "project.db");
  const store = openHarnessStore(storePath);
  seedReadyProject(store);
  return Object.freeze({ store, storePath });
}

const row = (resourceId: string): Record<string, unknown> => ({
  capacityUnits: 1, effectIntentRef: `intent-ref-${resourceId}`, epoch: 1, external: false,
  fenceable: true, resourceId, state: "ACTIVE",
});

/** The exact `effect.activate` envelope the daemon ingress accepts; the ingress derives
 *  every grant, digest and aggregate id, so the committed bytes are evidence. */
function activationBytes(): Uint8Array {
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch: EPOCH, kind: "ASSIGNMENT",
    leaseId: `lease-${SLUG}`, leaseToken: `token-${SLUG}`, monotonicObservation: 500,
    ownerSessionRef: SESSION, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch: EPOCH, expectedVersion: 7,
    leaseToken: `token-${SLUG}`, ownerSessionRef: SESSION,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${SLUG}`, correlationId: `corr-${SLUG}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        attempt: {
          aggregateId: `agg-${SLUG}`, attemptId: ATTEMPT, intentId: INTENT,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim: {
          claimId: `claim-${SLUG}`, claimedAt: DECIDED_AT, intentId: INTENT,
          lockIdentity: `lock-${SLUG}`, wrapperIdentity: `wrapper-${SLUG}`,
        },
        dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${SLUG}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${SLUG}`,
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${SLUG}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${SLUG}`, inputBinding: DIGEST, intentId: INTENT,
          leaseBinding: lease, predecessorCursor: `cursor-${SLUG}`,
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: SLUG, slotRef: `held-${SLUG}`, state: "RESERVED" }],
      slot: { dimension: SLUG, requestId: `req-${SLUG}`, rows: [row("res-a")],
        slotRef: `slot-${SLUG}` },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

interface World {
  readonly binding: FoundationAttemptBinding;
  readonly identity: ReleaseHandoffIdentity;
  readonly store: SqliteEventStore;
  readonly storePath: string;
}

/**
 * TERMINALISED THROUGH THE PRODUCTION AUTHORITY, never by planting a state. A member
 * left ACTIVE is MOVABLE, and rail 0 forbids composing a checkpoint over one — the
 * builder refuses `RELEASE_TERMINAL_RESOURCES_MOVABLE`, which is asserted on its own
 * below rather than silently worked around here.
 */
function terminaliseResources(store: SqliteEventStore, label: string): void {
  const reported = applyAttemptResourceReport(store, {
    activationAggregateId: ACTIVATION_AGGREGATE, commandId: `cmd-resources-${label}`,
    correlationId: `corr-resources-${label}`, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
  }, { disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: "res-a" });
  if (!reported.ok) throw new Error(`resource report refused: ${reported.code}`);
}

/** A committed activation and NOTHING else. The activation is the only source the
 *  builder needs before it can name which of the others is missing. */
function activatedWorld(label: string): World {
  const { store, storePath } = openStore(label);
  const activated = runEffectActivateCommand(store, activationBytes());
  if (!activated.ok) throw new Error(`activation refused: ${JSON.stringify(activated)}`);
  const bound = readFoundationActivationByAttempt(store, PROJECT_ID, ATTEMPT);
  if (bound.status !== "BOUND") throw new Error(`binding refused: ${JSON.stringify(bound)}`);
  return {
    binding: bound,
    identity: Object.freeze({
      attemptRef: ATTEMPT, nodeKey: NODE_KEY, projectId: PROJECT_ID, sessionId: SESSION,
    }),
    store, storePath,
  };
}

const STEP_COMMAND_KINDS = new Set<string>([
  STEP_START_COMMAND_KIND, STEP_FINISH_COMMAND_KIND, STEP_CHECKPOINT_COMMAND_KIND,
]);

function expectWriterProvenance(
  store: SqliteEventStore, activationDigest: string, sessionId: string,
): void {
  const decisions = store.readCommandDecisionsAfter(0n, 1_000).items;
  const stepKinds = decisions.map(({ commandKind }) => commandKind)
    .filter((kind) => STEP_COMMAND_KINDS.has(kind));
  expect(stepKinds).toHaveLength(4);
  expect(stepKinds).toEqual([
    STEP_START_COMMAND_KIND, STEP_FINISH_COMMAND_KIND,
    STEP_START_COMMAND_KIND, STEP_CHECKPOINT_COMMAND_KIND,
  ]);
  expect(decisions.filter(({ commandKind }) => commandKind === JOURNAL_APPEND_COMMAND_KIND))
    .toHaveLength(1);
  expect(store.getCommandDecision({
    commandId: `cmd-handoff-journal-${activationDigest.slice(0, 8)}`,
    principalId: sessionId, projectId: PROJECT_ID,
  })).toMatchObject({
    commandKind: JOURNAL_APPEND_COMMAND_KIND, effectDisposition: "EFFECTS_COMMITTED",
  });
  expect(store.readEvents(deriveAttemptStepAggregateId(activationDigest))
    .map(({ eventType }) => eventType)).toEqual([
    STEP_STARTED_EVENT_TYPE, STEP_FINISHED_EVENT_TYPE,
    STEP_STARTED_EVENT_TYPE, STEP_CHECKPOINTED_EVENT_TYPE,
  ]);
  expect(store.readEvents(deriveAttemptJournalAggregateId(activationDigest))
    .map(({ eventType }) => eventType)).toEqual([JOURNAL_APPEND_EVENT_TYPE]);
}

describe("release handoff builder — roster and admission (task-a20e8ef6)", () => {
  it("mirrors the scheduler's nine-key roster exactly and in both directions", () => {
    expect([...SCHEDULER_HANDOFF_KEYS].sort()).toEqual([
      "activeProcessResourceFacts", "artifactDigest", "completedSteps", "contextDigest",
      "inputDigest", "journalDigest", "nextSafeAction", "truthClass", "worktreeDigest",
    ]);
    expect(SCHEDULER_HANDOFF_KEYS).toHaveLength(9);
    expect(new Set(SCHEDULER_HANDOFF_KEYS).size).toBe(9);
  });

  it("names seven sources and ten codes, duplicate-free", () => {
    expect(new Set(RELEASE_HANDOFF_SOURCES).size).toBe(RELEASE_HANDOFF_SOURCES.length);
    expect(new Set(RELEASE_HANDOFF_CODES).size).toBe(RELEASE_HANDOFF_CODES.length);
    expect(RELEASE_HANDOFF_SOURCES).toHaveLength(7);
    expect(RELEASE_HANDOFF_CODES).toHaveLength(10);
  });

  it("refuses REQUEST_INVALID for an identity carrying an extra key", () => {
    const world = activatedWorld("extra-key");
    const smuggled = { ...world.identity, truthClass: "HUMAN_APPROVED" };
    const built = buildReleaseHandoff(world.store, smuggled as unknown as ReleaseHandoffIdentity);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.code).toBe("RELEASE_HANDOFF_REQUEST_INVALID");
    expect(built.layer).toBe(DAEMON_RELEASE_HANDOFF);
    expect(built.source).toBeNull();
  });

  it("refuses REQUEST_INVALID for a NON-ENUMERABLE fifth own property", () => {
    // `Object.keys` cannot see this key, so an arity check built on it would admit the
    // request and silently ignore what the caller hid. The builder uses
    // `getOwnPropertyNames`, which is what the scheduler's own `exactRecord` uses.
    const world = activatedWorld("hidden-key");
    const hidden: Record<string, unknown> = { ...world.identity };
    Object.defineProperty(hidden, "truthClass", {
      configurable: true, enumerable: false, value: "HUMAN_APPROVED", writable: false,
    });
    expect(Object.keys(hidden)).toHaveLength(4);
    expect(Object.getOwnPropertyNames(hidden)).toHaveLength(5);
    const built = buildReleaseHandoff(world.store, hidden as unknown as ReleaseHandoffIdentity);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.code).toBe("RELEASE_HANDOFF_REQUEST_INVALID");
  });

  it("refuses REQUEST_INVALID for a Symbol-keyed fifth own property", () => {
    const world = activatedWorld("symbol-key");
    const hidden = { ...world.identity, [Symbol("hidden")]: 1 };
    expect(Object.getOwnPropertyNames(hidden)).toHaveLength(4);
    expect(Reflect.ownKeys(hidden)).toHaveLength(5);
    const built = buildReleaseHandoff(
      world.store, hidden as unknown as ReleaseHandoffIdentity);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.code).toBe("RELEASE_HANDOFF_REQUEST_INVALID");
    expect(built.layer).toBe(DAEMON_RELEASE_HANDOFF);
    expect(built.source).toBeNull();
  });

  it("refuses REQUEST_INVALID when a Symbol replaces one required identity key", () => {
    const world = activatedWorld("symbol-replaces-key");
    const partial: Record<PropertyKey, unknown> = { ...world.identity };
    delete partial["sessionId"];
    partial[Symbol("sessionId")] = world.identity.sessionId;
    expect(Reflect.ownKeys(partial)).toHaveLength(4);
    const built = buildReleaseHandoff(
      world.store, partial as unknown as ReleaseHandoffIdentity);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.code).toBe("RELEASE_HANDOFF_REQUEST_INVALID");
    expect(built.layer).toBe(DAEMON_RELEASE_HANDOFF);
    expect(built.source).toBeNull();
  });

  it("refuses REQUEST_INVALID without invoking an identity accessor", () => {
    const world = activatedWorld("identity-accessor");
    const hostile = { ...world.identity };
    Object.defineProperty(hostile, "sessionId", {
      enumerable: true,
      get(): never { throw new Error("identity accessor must stay unread"); },
    });
    const built = buildReleaseHandoff(
      world.store, hostile as unknown as ReleaseHandoffIdentity);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.code).toBe("RELEASE_HANDOFF_REQUEST_INVALID");
    expect(built.layer).toBe(DAEMON_RELEASE_HANDOFF);
    expect(built.source).toBeNull();
  });

  it("refuses REQUEST_INVALID when identity shape inspection throws", () => {
    const world = activatedWorld("identity-revoked-proxy");
    const hostile = Proxy.revocable({ ...world.identity }, {});
    hostile.revoke();
    const built = buildReleaseHandoff(
      world.store, hostile.proxy as unknown as ReleaseHandoffIdentity);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.code).toBe("RELEASE_HANDOFF_REQUEST_INVALID");
    expect(built.layer).toBe(DAEMON_RELEASE_HANDOFF);
    expect(built.source).toBeNull();
  });

  it("refuses REQUEST_INVALID for each missing identity key, all four generated", () => {
    const world = activatedWorld("missing-keys");
    const observed = RELEASE_HANDOFF_IDENTITY_KEYS.map((key) => {
      const partial: Record<string, unknown> = { ...world.identity };
      delete partial[key];
      const built = buildReleaseHandoff(
        world.store, partial as unknown as ReleaseHandoffIdentity);
      return built.ok ? "BUILT" : `${built.code}/${String(built.source)}`;
    });
    // A sweep that silently produced zero cases would pass; the count is asserted.
    expect(observed).toHaveLength(4);
    expect(observed).toEqual(Array.from(
      { length: 4 }, () => "RELEASE_HANDOFF_REQUEST_INVALID/null"));
  });
});

describe("release handoff builder — the accepted checkpoint (task-a20e8ef6)", () => {
  it("builds an exact nine-key frozen handoff over seven durable sources", () => {
    const world = activatedWorld("accepted");
    terminaliseResources(world.store, "accepted");
    const inputManifestDigest = seedReleaseHandoffSources(world.store, {
      activationDigest: world.binding.activationDigest,
      attemptAggregateId: world.binding.activationAggregateId, attemptRef: ATTEMPT,
      effectId: world.binding.effectIntentId, leaseRef: `lease-${SLUG}`, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION,
    });
    const durable = readSealedFoundationContext(world.store, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID, sessionId: SESSION,
    }, {
      configurationDigest: "c".repeat(64), graphContentHash: "a".repeat(64), graphEpoch: 3,
      graphRevisionRef: "graph-revision-1", inputManifestDigest, nodeKey: NODE_KEY,
    });
    if (!durable.ok) throw new Error(`context read refused: ${durable.code}`);
    const providerRun = readCurrentProviderRun(world.store, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    });
    if (!("ok" in providerRun) || !providerRun.ok) {
      throw new Error(`provider run refused: ${JSON.stringify(providerRun)}`);
    }
    const aggregateIds = handoffAggregateIds(
      world.binding, world.identity, providerRun.record.providerRunRef);
    expect(aggregateIds).toHaveLength(6);
    expect(new Set(aggregateIds).size).toBe(6);
    expect(aggregateIds).toContain(deriveProviderRunAggregateId(providerRun.record.providerRunRef));
    const built = buildReleaseHandoff(world.store, world.identity);
    if (!built.ok) throw new Error(`refused ${built.code}/${String(built.source)} :: ${String(built.upstream?.code)}@${String(built.upstream?.layer)}`);
    expect(Object.keys(built.handoff).sort()).toEqual([...SCHEDULER_HANDOFF_KEYS].sort());
    expect(built.handoff.truthClass).toBe("DAEMON_VERIFIED");
    expect(Object.isFrozen(built.handoff)).toBe(true);
    expect(Object.isFrozen(built.handoff.completedSteps)).toBe(true);
    expect(Object.isFrozen(built.handoff.activeProcessResourceFacts)).toBe(true);
    // THE DENOMINATOR RIDES WITH THE ROSTER, so an empty set stays distinguishable
    // from an unmeasured one. One resource was bound and terminalised, so the count
    // is 1 and the member is named.
    expect([...built.handoff.activeProcessResourceFacts])
      .toEqual(["resources.enumerated:1", "resources.terminal:res-a"]);
    // `nextSafeAction` is the durable STEP IDENTITY the step lifecycle minted, never
    // a command kind: asserted against `deriveStepRef`, the production deriver.
    expect(built.handoff.nextSafeAction)
      .toBe(deriveStepRef(world.binding.activationDigest, 1));
    expect([...built.handoff.completedSteps])
      .toEqual([deriveStepRef(world.binding.activationDigest, 0)]);
    // FIVE DIGEST FAMILIES, all 64-hex and all DISTINCT: an implementation that
    // aliased two of them would satisfy the shape and lose a fact.
    const digests = [
      built.handoff.artifactDigest, built.handoff.contextDigest, built.handoff.inputDigest,
      built.handoff.journalDigest, built.handoff.worktreeDigest,
    ];
    expect(digests.every((digest) => /^[0-9a-f]{64}$/u.test(digest))).toBe(true);
    expect(new Set(digests).size).toBe(5);
    expect(built.handoff.contextDigest).toBe(durable.record.manifest.digest);
    expect(built.handoff.contextDigest).not.toBe(durable.record.recordDigest);
  });

  it("records step and journal authority through five production command decisions", () => {
    const world = activatedWorld("writer-provenance");
    seedReleaseHandoffSources(world.store, {
      activationDigest: world.binding.activationDigest,
      attemptAggregateId: world.binding.activationAggregateId, attemptRef: ATTEMPT,
      effectId: world.binding.effectIntentId, leaseRef: `lease-${SLUG}`, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION,
    });
    expectWriterProvenance(world.store, world.binding.activationDigest, SESSION);
  });

  it("rebuilds the frozen handoff from production-written facts after close and reopen", () => {
    const world = activatedWorld("close-reopen");
    terminaliseResources(world.store, "close-reopen");
    seedReleaseHandoffSources(world.store, {
      activationDigest: world.binding.activationDigest,
      attemptAggregateId: world.binding.activationAggregateId, attemptRef: ATTEMPT,
      effectId: world.binding.effectIntentId, leaseRef: `lease-${SLUG}`, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION,
    });
    const before = buildReleaseHandoff(world.store, world.identity);
    if (!before.ok) throw new Error(`pre-close handoff refused: ${before.code}`);
    const beforeBytes = JSON.stringify(before.handoff);
    world.store.close();

    const reopened = openHarnessStore(world.storePath);
    try {
      const after = buildReleaseHandoff(reopened, world.identity);
      if (!after.ok) throw new Error(`reopened handoff refused: ${after.code}`);
      expect(JSON.stringify(after.handoff)).toBe(beforeBytes);
      expect(Object.isFrozen(after.handoff)).toBe(true);
      expectWriterProvenance(reopened, world.binding.activationDigest, SESSION);

      const foreign = buildReleaseHandoff(reopened, {
        ...world.identity, sessionId: "session-somebody-else",
      });
      expect(foreign.ok).toBe(false);
      if (foreign.ok) throw new Error("unreachable");
      expect(foreign.code).toBe("RELEASE_HANDOFF_SOURCE_FOREIGN");
      expect(foreign.source).toBeNull();
      expect(foreign.upstream).toEqual({
        code: "FOUNDATION_BINDING_SESSION_MISMATCH",
        layer: "DAEMON_RELEASE_HANDOFF_CROSS_CHECK",
      });
      expect("handoff" in foreign).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("refuses a MOVABLE resource set rather than composing a checkpoint over it", () => {
    // The same world WITHOUT `terminaliseResources`: rail 0's safety ordering, and the
    // reason a premature DRAINING row can never be forced through this path.
    const world = activatedWorld("movable");
    seedReleaseHandoffSources(world.store, {
      activationDigest: world.binding.activationDigest,
      attemptAggregateId: world.binding.activationAggregateId, attemptRef: ATTEMPT,
      effectId: world.binding.effectIntentId, leaseRef: `lease-${SLUG}`, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION,
    });
    const built = buildReleaseHandoff(world.store, world.identity);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.code).toBe("RELEASE_HANDOFF_SOURCE_STALE");
    expect(built.source).toBe("terminal-evidence");
    expect(built.upstream).toEqual({
      code: "RELEASE_TERMINAL_RESOURCES_MOVABLE", layer: "RELEASE_TERMINAL_EVIDENCE",
    });
  });
});

/**
 * A store that lets ONE writer in the moment the builder first calls `readEventHorizon`,
 * exactly as a second connection would.
 *
 * THE TRIGGER IS CHOSEN, not incidental, and two earlier choices were MEASURED WRONG before
 * this one. The window has to sit after every source has read but before the builder's own
 * post-read comparison, and only one point qualifies: the SECOND read of the ARTIFACT
 * aggregate, which is `readArtifactDigest` beginning (the first is the builder's own count
 * capture). By then step, journal, capture and context are read; the append lands on the STEP
 * aggregate, which nothing later touches.
 *
 * WHAT THE OTHER TWO TRIGGERS PROVED, kept because both are real properties of neighbouring
 * modules: firing on the first `readEventHorizon` lands inside
 * `readFoundationActivationByAttempt`, before any source read, and the step reader answers
 * `STEP_RECORD_DRIFT`. Firing on the resource aggregate lands inside
 * `deriveReleaseTerminalEvidence`, whose horizon check is GLOBAL — so ANY concurrent write
 * during its walk refuses, and even the unrelated-aggregate control came back
 * `RELEASE_TERMINAL_RESOURCE_UNKNOWN`. That global scope belongs to task-6d400781's module,
 * not this one, and is disclosed rather than worked around.
 *
 * `Reflect.get` with the real store as receiver keeps its private fields reachable; nothing
 * here stubs a count or fabricates a row.
 */
function interposing(
  store: SqliteEventStore, trigger: string, occurrence: number, onTriggered: () => void,
): SqliteEventStore {
  let seen = 0;
  return new Proxy(store, {
    get(base: SqliteEventStore, key: string | symbol): unknown {
      const value: unknown = Reflect.get(base, key, base);
      if (typeof value !== "function") return value;
      if (key !== "readEvents") return value.bind(base);
      return (aggregateId: string): unknown => {
        if (aggregateId === trigger) {
          seen += 1;
          if (seen === occurrence) onTriggered();
        }
        return base.readEvents(aggregateId);
      };
    },
  });
}

const ARTIFACT_AGGREGATE = deriveFoundationArtifactAggregateId(ACTIVATION_AGGREGATE);

/** A durable append onto one aggregate, through the store's own decision writer. */
function appendNoise(store: SqliteEventStore, aggregateId: string, slug: string): void {
  const payload = encoder.encode("{}");
  store.commitExpectedVersionDecision({
    commandKind: "test.interposed_write", committedResultBytes: payload,
    correlationId: `corr-noise-${slug}`, decidedAt: DECIDED_AT,
    events: [{ eventId: `noise-${slug}`, eventType: "ReleaseHandoffNoise", payload }],
    expectedVersion: store.readEvents(aggregateId).length,
    key: { commandId: `cmd-noise-${slug}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: payload, targetAggregateId: aggregateId,
  });
}

describe("release handoff builder — the horizon is aggregate-scoped (task-a20e8ef6)", () => {
  function seededWorld(label: string): World {
    const built = activatedWorld(label);
    terminaliseResources(built.store, label);
    seedReleaseHandoffSources(built.store, {
      activationDigest: built.binding.activationDigest,
      attemptAggregateId: built.binding.activationAggregateId, attemptRef: ATTEMPT,
      effectId: built.binding.effectIntentId, leaseRef: `lease-${SLUG}`, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION,
    });
    return built;
  }

  it("REFUSES HORIZON_MOVED when a WATCHED aggregate grows mid-build", () => {
    const world = seededWorld("horizon-watched");
    const stepAggregate = deriveAttemptStepAggregateId(world.binding.activationDigest);
    const before = world.store.readEvents(stepAggregate).length;
    const raced = interposing(world.store, ARTIFACT_AGGREGATE, 2,
      () => { appendNoise(world.store, stepAggregate, "watched"); });
    const built = buildReleaseHandoff(raced, world.identity);
    // THE AGGREGATE REALLY MOVED, read out of the store rather than assumed.
    expect(world.store.readEvents(stepAggregate).length).toBe(before + 1);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.code).toBe("RELEASE_HANDOFF_SOURCE_HORIZON_MOVED");
    expect(built.upstream).toEqual({
      code: "RELEASE_HANDOFF_AGGREGATE_MOVED",
      layer: "DAEMON_RELEASE_HANDOFF_CROSS_CHECK",
    });
  });

  it("BUILDS ANYWAY when an UNRELATED aggregate grows mid-build — the scope control", () => {
    // Without this arm a GLOBAL horizon check would satisfy the case above and would
    // then refuse nearly every release on a busy daemon: green in a quiet test, useless
    // in production. The two arms together are what pin the scope.
    const world = seededWorld("horizon-unrelated");
    const unrelated = "some-entirely-unrelated-aggregate";
    const before = world.store.readEventHorizon();
    const raced = interposing(world.store, ARTIFACT_AGGREGATE, 2,
      () => { appendNoise(world.store, unrelated, "unrelated"); });
    const built = buildReleaseHandoff(raced, world.identity);
    // THE GLOBAL HORIZON REALLY MOVED, so a global check would have refused.
    expect(world.store.readEventHorizon()).not.toBe(before);
    expect(world.store.readEvents(unrelated)).toHaveLength(1);
    if (!built.ok) {
      throw new Error(`the scope control refused: ${built.code}/${String(built.source)}`);
    }
    expect(Object.keys(built.handoff).sort()).toEqual([...SCHEDULER_HANDOFF_KEYS].sort());
  });
});

describe("release handoff builder — per-source absence attribution (task-a20e8ef6)", () => {
  it("names step-record ABSENT first when no step lifecycle row exists", () => {
    const world = activatedWorld("step-absent");
    const built = buildReleaseHandoff(world.store, world.identity);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.source).toBe("step-record");
    expect(built.code).toBe("RELEASE_HANDOFF_SOURCE_ABSENT");
    expect(built.layer).toBe(DAEMON_RELEASE_HANDOFF);
    // The upstream reader's OWN code and layer, unrestamped.
    expect(built.upstream).toEqual({
      code: "STEP_RECORD_ABSENT", layer: "DAEMON_STEP_LIFECYCLE",
    });
  });

  it("returns no handoff field at all on a refusal", () => {
    const world = activatedWorld("no-partial");
    const built = buildReleaseHandoff(world.store, world.identity);
    expect(built.ok).toBe(false);
    expect(Object.keys(built).sort()).toEqual(["code", "layer", "ok", "source", "upstream"]);
    expect("handoff" in built).toBe(false);
  });
});
