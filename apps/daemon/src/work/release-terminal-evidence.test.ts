/**
 * The durable terminality facts a release needs: WHICH of an attempt's effects and resources
 * were proven terminal, read from each item's OWN authority.
 *
 * Every fixture reaches the store through a PRODUCTION writer — `runEffectActivateCommand` for
 * the activation, `commitProviderRunRecord` for the provider run, `recordTerminalEffect` for the
 * terminal effect, `bindAttemptResources` / `applyAttemptResourceReport` for the resource set.
 * A hand-built durable row can satisfy a shape no production writer would ever have produced,
 * and the whole point of this record is that what it reports was committed by the system.
 *
 * THE TWO PLANTED ROWS ARE DOCUMENTED, NOT CASUAL. `recordTerminalEffect` derives its intent id
 * from the activation's single `effectIntent`, so no production writer can give one attempt a
 * SECOND terminal record, and no production writer can emit an undecodable one. Those two states
 * are reachable only by planting, and both are states this record must survive, so they are
 * planted through the store's own write API and named as such at each call site.
 *
 * REFS ARE ASSERTED AGAINST DURABLE READS, never against the fixture's own locals, wherever the
 * durable read is available: an expectation written by hand agrees with itself and proves nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderFactUnknown, ProviderRunRef } from "@moe/runner";
import type { CommandDecisionKey, SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE, deriveActivationAggregateId,
} from "../activation/activation-ledger-contracts.js";
import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import { PROVIDER_RUN_RECORD_VERSION } from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRecord } from "../telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../telemetry/provider-run-ledger.js";
import { applyAttemptResourceReport } from "./attempt-resource-authority.js";
import {
  ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
  DAEMON_ATTEMPT_RESOURCE, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import type { AttemptResourceBinding } from "./attempt-resource-authority-contracts.js";
import { readAttemptResources } from "./attempt-resource-reader.js";
import {
  decodeFoundationPayload, encodeFoundationPayload,
} from "./foundation-attempt-codec.js";
import {
  EFFECT_TERMINAL_RECORD_VERSION, encodeTerminalEffectRecord,
} from "./effect-terminal-contracts.js";
import {
  EFFECT_TERMINAL_EVENT_TYPE, deriveTerminalEffectAggregateId, readCurrentTerminalEffect,
  recordTerminalEffect,
} from "./effect-terminal-ledger.js";
import {
  RELEASE_TERMINAL_CODES, deriveReleaseTerminalEvidence,
} from "./release-terminal-evidence.js";
import type {
  ReleaseTerminalOutcome, ReleaseTerminalRequest,
} from "./release-terminal-evidence.js";

const ATTEMPT = "attempt-release-terminal";
const INTENT = "intent-release-terminal";
const SESSION = "session-release-terminal";
const SLUG = "reltrm";
const EPOCH = 41;
const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;
const OWN_LAYER = "RELEASE_TERMINAL_EVIDENCE";
const ACTIVATION_AGGREGATE = deriveActivationAggregateId(`agg-${SLUG}`, `idem-${SLUG}`);
const SELECTOR = Object.freeze({ attemptRef: ATTEMPT, projectId: PROJECT_ID });
const NOISE_EVENT_TYPE = "ReleaseTerminalNoiseRecorded";
const NOISE_COUNT = 240;
/** One activation row plus four same-type terminal rows, with page slack. A walk of the whole
 *  stream would have to deliver all NOISE_COUNT noise rows and blow straight past this. */
const INDEXED_ITEM_BOUND = 24;
const AGGREGATE_READ_BOUND = 12;
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

function openStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-release-terminal-${label}-`));
  roots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

const row = (
  resourceId: string, overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  capacityUnits: 1, effectIntentRef: `intent-ref-${resourceId}`, epoch: 1, external: false,
  fenceable: true, resourceId, state: "ACTIVE", ...overrides,
});

/** All fenceable: an `adapterFail` FAILED on one member releases every member. */
const fenceableRows = (): Record<string, unknown>[] => [row("res-a"), row("res-b")];
/** `res-q` cannot be fenced, so a sibling failure QUARANTINES it instead of releasing it. */
const mixedRows = (): Record<string, unknown>[] =>
  [row("res-a"), row("res-q", { fenceable: false })];
/** Passes the claim leg — `parseRows` does not dedupe and `reserveProviderSlot` only checks
 *  state — so the activation commits while the ingress's own bind refuses. The only honest way
 *  to reach an attempt that durably holds NO resource set. */
const duplicateRows = (): Record<string, unknown>[] => [row("res-a"), row("res-a")];

/** The exact `effect.activate` envelope the daemon ingress accepts; the ingress derives every
 *  grant, digest and aggregate id, so the committed bytes are evidence rather than a fixture. */
function activationBytes(rows: readonly unknown[]): Uint8Array {
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
      slot: { dimension: SLUG, requestId: `req-${SLUG}`, rows, slotRef: `slot-${SLUG}` },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

const blind: ProviderFactUnknown = {
  known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT",
};

function providerRunRecord(): ProviderRunRecord {
  const providerRunRef: ProviderRunRef = {
    attemptRef: ATTEMPT, effectIntentId: INTENT, epoch: EPOCH, provider: "claude",
    runRef: `run-${SLUG}`,
  };
  return {
    recordVersion: PROVIDER_RUN_RECORD_VERSION, providerRunRef,
    launch: {
      kind: "REFUSED", truthClass: "UNKNOWN", reasonCode: null, reasonLayer: null, exit: null,
      effectDigest: null, activationDigest: null, runtimeBindingDigest: null,
      quotedRuntimeDigest: null, freshRuntimeDigest: null, pinnedClosureDigest: null,
      observationDigest: null, startedAt: null, completedAt: DECIDED_AT,
    },
    declared: blind,
    observedModel: { modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind },
    terminal: "COMPLETED", infrastructure: "NONE",
    tokens: {
      inputTokens: blind, outputTokens: blind, cacheCreationInputTokens: blind,
      cacheReadInputTokens: blind, coverage: "UNKNOWN",
    },
    steps: { turns: blind, coverage: "UNKNOWN" },
    sequence: { known: true, value: 3 },
    concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: blind, achieved: blind },
    observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
    observedEnd: null, usage: [], usageRefusals: [], upstreamRefusal: null,
    stdoutReceiptDigest: { known: true, value: `stdout-${SLUG}` },
    stderrReceiptDigest: { known: true, value: `stderr-${SLUG}` },
    recordDigest: "",
  } as unknown as ProviderRunRecord;
}

const binding = (commandId: string): AttemptResourceBinding => Object.freeze({
  activationAggregateId: ACTIVATION_AGGREGATE, commandId, correlationId: `corr-${SLUG}`,
  principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
});

interface SeedShape {
  /** Report `res-a` FAILED, which is what drives members out of ACTIVE. */
  readonly failResource: boolean;
  /** Commit the provider run and record the terminal effect. */
  readonly terminaliseEffect: boolean;
  /** The activation's slot rows. THE INGRESS BINDS THESE ITSELF (activation-resource-binding.ts),
   *  so nothing here calls `bindAttemptResources` — a second bind is an expected-version
   *  conflict, not a fixture. */
  readonly rows: readonly Record<string, unknown>[];
}

const DEFAULT_SEED: SeedShape = Object.freeze({
  failResource: true, rows: fenceableRows(), terminaliseEffect: true,
});

/** Drives every production writer in order. A refused setup THROWS rather than leaving a
 *  half-seeded store that a later assertion would read as a legitimate answer. */
function seed(label: string, shape: Partial<SeedShape> = {}): SqliteEventStore {
  const plan: SeedShape = { ...DEFAULT_SEED, ...shape };
  const store = openStore(label);
  const activation = runEffectActivateCommand(store, activationBytes(plan.rows));
  if (!activation.ok) throw new Error(`seed activation refused: ${activation.code}`);
  if (plan.terminaliseEffect) {
    const run = commitProviderRunRecord(store, {
      correlationId: `corr-run-${SLUG}`, decidedAt: DECIDED_AT,
      key: {
        commandId: `cmd-run-${SLUG}`, principalId: SESSION, projectId: PROJECT_ID,
      } satisfies CommandDecisionKey,
      record: providerRunRecord(), requestBytes: encoder.encode(`provider-run-${SLUG}`),
    });
    if (!run.ok) throw new Error(`seed provider run refused: ${run.code}`);
    const terminal = recordTerminalEffect(store, SELECTOR);
    if (!terminal.ok) throw new Error(`seed terminal effect refused: ${terminal.code}`);
  }
  if (!plan.failResource) return store;
  const failed = applyAttemptResourceReport(store, binding(`fail-${label}`), {
    disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: "res-a",
  });
  if (!failed.ok) throw new Error(`seed resource failure refused: ${failed.code}`);
  return store;
}

function evidenceOf(outcome: ReleaseTerminalOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`expected evidence, refused with ${outcome.code}`);
  return { ...outcome } as unknown as Record<string, unknown>;
}

function refusalOf(outcome: ReleaseTerminalOutcome): {
  code: string; layer: string; upstream: { code: string; layer: string } | null;
} {
  if (outcome.ok) throw new Error("expected a refusal, received evidence");
  return {
    code: outcome.code, layer: outcome.layer,
    upstream: outcome.upstream === null
      ? null : { code: outcome.upstream.code, layer: outcome.upstream.layer },
  };
}

/** The intent id the COMMITTED activation carries, read back rather than assumed. */
function durableIntentId(store: SqliteEventStore): string {
  const bound = readFoundationActivationByAttempt(store, PROJECT_ID, ATTEMPT);
  if (bound.status !== "BOUND") throw new Error(`activation not bound: ${bound.status}`);
  return bound.effectIntentId;
}

/** The resource ids and states the DURABLE set carries, read through the production reader. */
function durableResourceStates(store: SqliteEventStore): Record<string, string> {
  const current = readAttemptResources(store, ACTIVATION_AGGREGATE, PROJECT_ID);
  if (!current.ok) throw new Error(`resource set not readable: ${current.code}`);
  return Object.fromEntries(current.members.map((member) => [member.resourceId, member.state]));
}

interface Plant {
  readonly aggregateId: string;
  readonly eventType: string;
  readonly expectedVersion: number;
  readonly label: string;
  readonly payload: Uint8Array;
}

/**
 * PLANTED, and only because no production writer can produce these states: the terminal-effect
 * writer derives its intent id from the activation's single effect intent, so neither a SECOND
 * terminal record for one attempt nor an UNDECODABLE one has an honest route into the store, and
 * a guard no honest fixture can reach is a guard nothing tests.
 */
function plant(store: SqliteEventStore, input: Plant): void {
  store.commitExpectedVersionDecision({
    commandKind: "test.plant_release_terminal", committedResultBytes: input.payload,
    correlationId: `plant-${input.label}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `plant-${input.label}`, eventType: input.eventType, payload: input.payload,
    }],
    expectedVersion: input.expectedVersion,
    key: { commandId: `plant-${input.label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: input.payload, targetAggregateId: input.aggregateId,
  });
}

const terminalAggregate = (intentId: string): string =>
  deriveTerminalEffectAggregateId({ attemptRef: ATTEMPT, intentId, projectId: PROJECT_ID });

function terminalBytes(intentId: string, settlement: unknown, state = "SUCCEEDED"): Uint8Array {
  return encodeTerminalEffectRecord({
    attemptRef: ATTEMPT, intentId, projectId: PROJECT_ID,
    recordVersion: EFFECT_TERMINAL_RECORD_VERSION, settlement, terminalState: state,
  });
}

function plantTerminalEffect(
  store: SqliteEventStore, intentId: string, settlement: unknown, attemptRef = ATTEMPT,
): void {
  const selector = { attemptRef, intentId, projectId: PROJECT_ID };
  const payload = encodeTerminalEffectRecord({
    attemptRef, intentId, projectId: PROJECT_ID,
    recordVersion: EFFECT_TERMINAL_RECORD_VERSION, settlement, terminalState: "SUCCEEDED",
  });
  plant(store, {
    aggregateId: deriveTerminalEffectAggregateId(selector),
    eventType: EFFECT_TERMINAL_EVENT_TYPE, expectedVersion: 0,
    label: `terminal-${attemptRef}-${intentId}`, payload,
  });
}

/** The settlement the REAL writer persisted, so a planted sibling is realistic bytes. */
function durableSettlement(store: SqliteEventStore): unknown {
  const current = readCurrentTerminalEffect(
    store, { attemptRef: ATTEMPT, intentId: INTENT, projectId: PROJECT_ID });
  if (!current.ok) throw new Error(`terminal effect not readable: ${current.code}`);
  return current.record.settlement;
}

describe("release terminal evidence — frozen vocabulary", () => {
  it("publishes a closed code list with no duplicate member", () => {
    expect(RELEASE_TERMINAL_CODES.length).toBeGreaterThan(0);
    expect(new Set(RELEASE_TERMINAL_CODES).size).toBe(RELEASE_TERMINAL_CODES.length);
    expect([...RELEASE_TERMINAL_CODES].sort()).toEqual([
      "RELEASE_TERMINAL_BINDING_UNREADABLE",
      "RELEASE_TERMINAL_EFFECT_ENUMERATION_UNREADABLE",
      "RELEASE_TERMINAL_EFFECT_UNKNOWN",
      "RELEASE_TERMINAL_REQUEST_INVALID",
      "RELEASE_TERMINAL_RESOURCE_UNKNOWN",
    ].sort());
  });
});

describe("release terminal evidence — accepted control", () => {
  it("reports every effect and resource terminal, with refs read from durable authority", () => {
    const store = seed("all-terminal");
    const states = durableResourceStates(store);
    expect(states).toEqual({ "res-a": "RELEASED", "res-b": "RELEASED" });
    expect(evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR))).toEqual({
      attemptRef: ATTEMPT, effectsTerminal: true, enumeratedEffects: 1, enumeratedResources: 2,
      nonTerminalEffectRefs: [], nonTerminalResourceRefs: [], ok: true, projectId: PROJECT_ID,
      releasable: true, resourcesTerminal: true,
      terminalEffectRefs: [durableIntentId(store)],
      terminalResourceRefs: Object.keys(states).sort(),
    });
  });

  it("enumerates a SECOND terminal record for the same attempt rather than ignoring it", () => {
    const store = seed("two-effects");
    plantTerminalEffect(store, "intent-planted-second", durableSettlement(store));
    const evidence = evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR));
    expect(evidence.enumeratedEffects).toBe(2);
    expect(evidence.terminalEffectRefs).toEqual(
      [durableIntentId(store), "intent-planted-second"].sort());
    expect(evidence.effectsTerminal).toBe(true);
    expect(evidence.releasable).toBe(true);
  });
});

describe("release terminal evidence — one non-terminal item", () => {
  it("flags resources not terminal, keeps every member listed, and blocks release", () => {
    const store = seed("quarantined", { rows: mixedRows() });
    expect(durableResourceStates(store)).toEqual({
      "res-a": "RELEASED", "res-q": "QUARANTINED",
    });
    const evidence = evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR));
    expect(evidence.resourcesTerminal).toBe(false);
    expect(evidence.releasable).toBe(false);
    expect(evidence.terminalResourceRefs).toEqual(["res-a"]);
    expect(evidence.nonTerminalResourceRefs).toEqual(["res-q"]);
    // A false flag with a COMPLETE list: nothing is dropped because it was not terminal.
    expect(evidence.enumeratedResources).toBe(2);
    expect(evidence.effectsTerminal).toBe(true);
  });

  it("flags effects not terminal when the attempt has no terminal record yet", () => {
    const store = seed("no-terminal-effect", { terminaliseEffect: false });
    const evidence = evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR));
    expect(evidence.effectsTerminal).toBe(false);
    expect(evidence.releasable).toBe(false);
    expect(evidence.terminalEffectRefs).toEqual([]);
    expect(evidence.nonTerminalEffectRefs).toEqual([durableIntentId(store)]);
    expect(evidence.enumeratedEffects).toBe(1);
  });

  it("still enumerates a still-ACTIVE resource set as non-terminal", () => {
    const store = seed("active-set", { failResource: false });
    expect(durableResourceStates(store)).toEqual({ "res-a": "ACTIVE", "res-b": "ACTIVE" });
    const evidence = evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR));
    expect(evidence.resourcesTerminal).toBe(false);
    expect(evidence.terminalResourceRefs).toEqual([]);
    expect(evidence.nonTerminalResourceRefs).toEqual(["res-a", "res-b"]);
    expect(evidence.releasable).toBe(false);
  });
});

/**
 * THE ZERO DECISION, measured rather than chosen. An attempt with NO durable resource set is
 * reachable (nothing was ever bound), and it is answered FALSE with an explicit count of 0 —
 * never a vacuous true. Zero enumerated EFFECTS is unreachable in the opposite direction: a
 * BOUND activation always carries exactly one effect intent, which is why the enumeration is
 * seeded from the binding and every accepted answer counts at least one.
 */
describe("release terminal evidence — the zero decision", () => {
  it("answers an unbound resource set FALSE with a zero count, never vacuously true", () => {
    const store = seed("no-resources", { failResource: false, rows: duplicateRows() });
    // POSITIVE CONTROL: the set really is absent, not merely empty-looking.
    const absent = readAttemptResources(store, ACTIVATION_AGGREGATE, PROJECT_ID);
    expect(absent.ok ? "bound" : absent.code).toBe("ATTEMPT_RESOURCE_RECORD_ABSENT");
    const evidence = evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR));
    expect(evidence.enumeratedResources).toBe(0);
    expect(evidence.resourcesTerminal).toBe(false);
    expect(evidence.terminalResourceRefs).toEqual([]);
    expect(evidence.nonTerminalResourceRefs).toEqual([]);
    expect(evidence.releasable).toBe(false);
  });

  it("always enumerates at least the binding's own effect intent", () => {
    const store = seed("seeded-enumeration", { terminaliseEffect: false });
    const evidence = evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR));
    expect(evidence.enumeratedEffects).toBeGreaterThanOrEqual(1);
    expect([
      ...(evidence.terminalEffectRefs as string[]),
      ...(evidence.nonTerminalEffectRefs as string[]),
    ]).toContain(durableIntentId(store));
  });
});

/**
 * DoD 2. A caller identifies the attempt; it may never say what was terminal. Exact-record
 * admission is what makes that structural, so the sweep asserts it GENERATED cases — a sweep
 * that silently produced zero would pass while testing nothing.
 */
describe("release terminal evidence — caller authority refused", () => {
  const FORBIDDEN = Object.freeze([
    "effectsTerminal", "enumeratedEffects", "enumeratedResources", "intentId",
    "nonTerminalEffectRefs", "nonTerminalResourceRefs", "releasable", "resourcesTerminal",
    "terminalEffectRefs", "terminalResourceRefs",
  ] as const);

  it("refuses every caller-supplied terminality key by exact-record admission", () => {
    const store = seed("caller-keys");
    const claims: Record<string, unknown> = {
      effectsTerminal: true, enumeratedEffects: 9, enumeratedResources: 9, intentId: INTENT,
      nonTerminalEffectRefs: [], nonTerminalResourceRefs: [], releasable: true,
      resourcesTerminal: true, terminalEffectRefs: [INTENT], terminalResourceRefs: ["res-q"],
    };
    let generated = 0;
    for (const key of FORBIDDEN) {
      generated += 1;
      expect(refusalOf(deriveReleaseTerminalEvidence(
        store, { ...SELECTOR, [key]: claims[key] },
      ))).toEqual({
        code: "RELEASE_TERMINAL_REQUEST_INVALID", layer: OWN_LAYER, upstream: null,
      });
    }
    expect(generated).toBe(FORBIDDEN.length);
    expect(generated).toBeGreaterThan(0);
  });

  it("cannot honour a caller-claimed terminal ref for a non-terminal effect", () => {
    const store = seed("claimed-ref", { rows: mixedRows(), terminaliseEffect: false });
    // The claim names an effect whose DURABLE state is not terminal. The request type admits no
    // such field, so the claim is unrepresentable — the directive below proves it at COMPILE
    // time, and widening the request to accept a terminal ref reds the daemon typecheck (an
    // unused @ts-expect-error is itself an error) before this suite ever runs.
    const claimed = deriveReleaseTerminalEvidence(store, {
      ...SELECTOR,
      // @ts-expect-error a caller may say WHICH attempt, never WHAT was terminal.
      terminalEffectRefs: [INTENT],
    });
    expect(refusalOf(claimed)).toEqual({
      code: "RELEASE_TERMINAL_REQUEST_INVALID", layer: OWN_LAYER, upstream: null,
    });
    // And the honest answer, asked properly, still refuses to call either one terminal.
    const evidence = evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR));
    expect(evidence.terminalEffectRefs).toEqual([]);
    expect(evidence.terminalResourceRefs).toEqual(["res-a"]);
  });

  it("refuses a request that is not an exact two-key record", () => {
    const store = seed("shape");
    const cases: readonly unknown[] = [
      null, undefined, [], "attempt", { attemptRef: ATTEMPT }, { projectId: PROJECT_ID },
      { attemptRef: "", projectId: PROJECT_ID }, { attemptRef: ATTEMPT, projectId: 7 },
    ];
    let generated = 0;
    for (const request of cases) {
      generated += 1;
      expect(refusalOf(deriveReleaseTerminalEvidence(
        store, request as ReleaseTerminalRequest,
      )).code).toBe("RELEASE_TERMINAL_REQUEST_INVALID");
    }
    expect(generated).toBe(cases.length);
  });
});

/**
 * FAIL CLOSED, AND KEEP THE ARMS APART. An item whose terminal state cannot be READ is UNKNOWN
 * and blocks release; it is never dropped from the answer and never assumed terminal. "No
 * terminal record" is a different fact — it is a readable durable NO — and the two demand
 * opposite repairs, so they must never produce the same outcome.
 */
describe("release terminal evidence — unknown blocks, never skips", () => {
  it("refuses the whole answer when an enumerated terminal record does not decode", () => {
    const store = seed("undecodable");
    // Planted: the production writer cannot emit bytes its own codec rejects.
    plant(store, {
      aggregateId: terminalAggregate(INTENT), eventType: EFFECT_TERMINAL_EVENT_TYPE,
      expectedVersion: 1, label: "undecodable", payload: encoder.encode("not-a-record"),
    });
    // A silently omitted effect is the false release this record exists to prevent, so the
    // answer is a refusal — NOT evidence carrying a shorter list.
    expect(refusalOf(deriveReleaseTerminalEvidence(store, SELECTOR))).toEqual({
      code: "RELEASE_TERMINAL_EFFECT_ENUMERATION_UNREADABLE", layer: OWN_LAYER, upstream: null,
    });
  });

  it("keeps the effect ledger's own code and layer when its reader refuses", () => {
    const store = seed("ambiguous-effect");
    // Two DIFFERENT decodable records for one identity: the ledger answers AMBIGUOUS rather
    // than picking one, and that verdict must arrive here unflattened.
    plant(store, {
      aggregateId: terminalAggregate(INTENT), eventType: EFFECT_TERMINAL_EVENT_TYPE,
      expectedVersion: 1, label: "ambiguous",
      payload: terminalBytes(INTENT, durableSettlement(store), "FAILED"),
    });
    expect(refusalOf(deriveReleaseTerminalEvidence(store, SELECTOR))).toEqual({
      code: "RELEASE_TERMINAL_EFFECT_UNKNOWN", layer: OWN_LAYER,
      upstream: { code: "EFFECT_TERMINAL_AMBIGUOUS", layer: "EFFECT_TERMINAL_LEDGER" },
    });
  });

  it("keeps the resource authority's own code and layer when its reader refuses", () => {
    const store = seed("ambiguous-resources");
    const aggregateId = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);
    const events = store.readEvents(aggregateId);
    const head = events[0];
    if (head === undefined) throw new Error("fixture bound no resource set");
    // A SECOND bind event: the reader refuses AMBIGUOUS rather than folding two sets.
    plant(store, {
      aggregateId, eventType: ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
      expectedVersion: events.length, label: "second-bind", payload: head.payload,
    });
    expect(refusalOf(deriveReleaseTerminalEvidence(store, SELECTOR))).toEqual({
      code: "RELEASE_TERMINAL_RESOURCE_UNKNOWN", layer: OWN_LAYER,
      upstream: { code: "ATTEMPT_RESOURCE_RECORD_AMBIGUOUS", layer: DAEMON_ATTEMPT_RESOURCE },
    });
  });

  it("gives ABSENT and UNREADABLE distinct outcomes, they demand opposite repairs", () => {
    const absent = seed("absent-arm", { terminaliseEffect: false });
    const unreadable = seed("unreadable-arm");
    plant(unreadable, {
      aggregateId: terminalAggregate(INTENT), eventType: EFFECT_TERMINAL_EVENT_TYPE,
      expectedVersion: 1, label: "unreadable-arm", payload: encoder.encode("{"),
    });
    // ABSENT is a readable durable NO: evidence, flag false, item still enumerated.
    const answered = evidenceOf(deriveReleaseTerminalEvidence(absent, SELECTOR));
    expect(answered.effectsTerminal).toBe(false);
    expect(answered.nonTerminalEffectRefs).toEqual([durableIntentId(absent)]);
    // UNREADABLE is no answer at all.
    expect(refusalOf(deriveReleaseTerminalEvidence(unreadable, SELECTOR)).code)
      .toBe("RELEASE_TERMINAL_EFFECT_ENUMERATION_UNREADABLE");
  });
});

interface ReadCounts {
  readonly aggregateReads: string[];
  readonly indexedItems: number[];
  readonly indexedTypes: string[];
}

/** A thin COUNTING WRAPPER that delegates every call to the real store — never a second
 *  implementation of one, which would make the bound a property of the fake. */
function countingStore(store: SqliteEventStore, counts: ReadCounts): SqliteEventStore {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      const call = (value as (...args: unknown[]) => unknown).bind(target);
      if (property === "readEventsByTypeAfter") {
        return (...args: unknown[]): unknown => {
          counts.indexedTypes.push(String(args[0]));
          const page = call(...args) as { items: readonly unknown[] };
          counts.indexedItems.push(page.items.length);
          return page;
        };
      }
      if (property === "readEvents") {
        return (...args: unknown[]): unknown => {
          counts.aggregateReads.push(String(args[0]));
          return call(...args);
        };
      }
      return call;
    },
  }) as SqliteEventStore;
}

/** Foreign traffic of an unrelated type: present in the stream, invisible to a type index. */
function seedNoise(store: SqliteEventStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    plant(store, {
      aggregateId: `noise-aggregate-${index}`, eventType: NOISE_EVENT_TYPE, expectedVersion: 0,
      label: `noise-${index}`, payload: encoder.encode(`noise-${index}`),
    });
  }
}

describe("release terminal evidence — bounded, index-backed reads", () => {
  it("reads in proportion to this attempt's own items, not to the whole stream", () => {
    const store = seed("bounded");
    seedNoise(store, NOISE_COUNT);
    // Neighbours of the SAME type, for other attempts: the index carries them, the answer
    // must not.
    const settlement = durableSettlement(store);
    for (const other of ["attempt-other-1", "attempt-other-2", "attempt-other-3"]) {
      plantTerminalEffect(store, `${other}-intent`, settlement, other);
    }
    // POSITIVE CONTROL on the fixture: the noise is genuinely in the stream.
    expect(store.readEventsByTypeAfter(NOISE_EVENT_TYPE, 0n, NOISE_COUNT * 2).items.length)
      .toBe(NOISE_COUNT);
    expect(Number(store.readEventHorizon())).toBeGreaterThan(NOISE_COUNT);

    const counts: ReadCounts = { aggregateReads: [], indexedItems: [], indexedTypes: [] };
    const evidence = evidenceOf(deriveReleaseTerminalEvidence(
      countingStore(store, counts), SELECTOR));
    expect(evidence.releasable).toBe(true);

    const items = counts.indexedItems.reduce((total, page) => total + page, 0);
    // A full-stream walk would have to deliver every one of the NOISE_COUNT noise rows.
    expect(items).toBeLessThanOrEqual(INDEXED_ITEM_BOUND);
    expect(items).toBeGreaterThan(0);
    expect(counts.aggregateReads.length).toBeLessThanOrEqual(AGGREGATE_READ_BOUND);
    // Only the two index families this answer is entitled to read.
    expect([...new Set(counts.indexedTypes)].sort()).toEqual(
      [ACTIVATION_LEDGER_EVENT_TYPE, EFFECT_TERMINAL_EVENT_TYPE].sort());
  });

  it("derives the same bytes twice and writes nothing", () => {
    const store = seed("invariance");
    const before = store.readEventHorizon();
    const first = evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR));
    const second = evidenceOf(deriveReleaseTerminalEvidence(store, SELECTOR));
    expect(second).toEqual(first);
    expect(store.readEventHorizon()).toBe(before);
    const outcome = deriveReleaseTerminalEvidence(store, SELECTOR);
    expect(Object.isFrozen(outcome)).toBe(true);
    if (!outcome.ok) throw new Error("expected evidence");
    expect(Object.isFrozen(outcome.terminalEffectRefs)).toBe(true);
    expect(Object.isFrozen(outcome.terminalResourceRefs)).toBe(true);
  });

  it("freezes its refusals too", () => {
    const store = seed("frozen-refusal");
    const partial = { attemptRef: ATTEMPT } as unknown as ReleaseTerminalRequest;
    expect(Object.isFrozen(deriveReleaseTerminalEvidence(store, partial))).toBe(true);
  });
});

/**
 * The arm the scheduler probe exists for. `decodeAttemptResourceBody` carries a member's `state`
 * VERBATIM and does not prove it is a scheduler vocabulary member — its own header says so — so a
 * planted token reads back intact. Nothing may call such a row terminal.
 */
describe("release terminal evidence — an unreadable resource STATE", () => {
  it("refuses when no scheduler reducer can read a member's state, never assuming terminal", () => {
    const store = seed("foreign-state");
    const aggregateId = deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE);
    const events = store.readEvents(aggregateId);
    const head = events[0];
    if (head === undefined) throw new Error("fixture bound no resource set");
    const decoded = decodeFoundationPayload(head.payload);
    if (!decoded.ok) throw new Error("the durable bind body does not decode");
    const members = decoded.value["members"] as Record<string, unknown>[];
    // Planted, and only reachable this way: every production writer persists a state some public
    // scheduler reducer returned, so a token outside that vocabulary has no honest route in.
    const drifted = encodeFoundationPayload({
      ...decoded.value,
      members: members.map((member, index) =>
        index === 0 ? { ...member, state: "NOT_A_SCHEDULER_STATE" } : member),
    });
    if (!drifted.ok) throw new Error("the planted body is not encodable");
    plant(store, {
      aggregateId, eventType: ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
      expectedVersion: events.length, label: "foreign-state", payload: drifted.bytes,
    });
    // POSITIVE CONTROL: the resource authority really does hand the token back verbatim, so the
    // refusal below is this module's probe answering and not the reader refusing first.
    expect(durableResourceStates(store)["res-a"]).toBe("NOT_A_SCHEDULER_STATE");
    expect(refusalOf(deriveReleaseTerminalEvidence(store, SELECTOR))).toEqual({
      code: "RELEASE_TERMINAL_RESOURCE_UNKNOWN", layer: OWN_LAYER,
      upstream: { code: "AUTHORITY_MALFORMED_INPUT", layer: "SCHEDULER_RESOURCE_AUTHORITY" },
    });
  });
});
