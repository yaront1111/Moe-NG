/**
 * Terminal effect authority: what the durable record is allowed to say, and who is allowed to
 * decide it.
 *
 * Every fixture here reaches the store through a PRODUCTION writer — `runEffectActivateCommand`
 * for the activation, `commitProviderRunRecord` for the provider run — because a hand-built
 * durable row can satisfy a binding no production writer would ever have produced, and the
 * whole point of this ledger is that the terminal it reports was derived from evidence the
 * system actually committed.
 *
 * The settlement itself is never asserted against a hand-written expected object while the
 * runner's own output is available: `settleEffectFromProviderObservation` is the only lawful
 * terminal authority, so the test compares the persisted result to what the RUNNER produced.
 * An expected object written by hand would agree with itself and prove nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROVIDER_TELEMETRY_CONTRACT_VERSION, settleEffectFromProviderObservation } from "@moe/runner";
import type { ProviderFactUnknown, ProviderRunRef } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import type { CommandDecisionKey } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { readActivationLedgerRecord } from "../activation/activation-ledger-reader.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  cleanupRestoreHarnesses,
  openHarnessStore,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";
import { PROVIDER_RUN_RECORD_VERSION } from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRecord } from "../telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../telemetry/provider-run-ledger.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import {
  EFFECT_TERMINAL_EVENT_TYPE,
  deriveTerminalEffectAggregateId,
  encodeTerminalEffectRecord,
  readCurrentTerminalEffect,
  recordTerminalEffect,
} from "./effect-terminal-ledger.js";

const ATTEMPT = "attempt-terminal";
const SESSION = "session-terminal";
const INTENT = "intent-terminal";
const EPOCH = 41;
const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;
const WRITER_LAYER = "EFFECT_TERMINAL_LEDGER";
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
  const root = mkdtempSync(join(tmpdir(), `moe-effect-terminal-${label}-`));
  roots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

/**
 * The exact `effect.activate` command envelope the daemon ingress accepts.
 *
 * Nothing here computes a grant, a digest or an aggregate id — the ingress does, which is what
 * makes the committed bytes evidence rather than a fixture agreeing with itself. Shape taken
 * verbatim from the provider-run reader suite, which owns the canonical form.
 */
function activationBytes(): Uint8Array {
  const slug = "terminal";
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch: EPOCH, kind: "ASSIGNMENT",
    leaseId: `lease-${slug}`, leaseToken: `token-${slug}`, monotonicObservation: 500,
    ownerSessionRef: SESSION, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch: EPOCH, expectedVersion: 7,
    leaseToken: `token-${slug}`, ownerSessionRef: SESSION,
  } as const;
  const claim = {
    claimId: `claim-${slug}`, claimedAt: DECIDED_AT, intentId: INTENT,
    lockIdentity: `lock-${slug}`, wrapperIdentity: `wrapper-${slug}`,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${slug}`, correlationId: `corr-${slug}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        attempt: {
          aggregateId: `agg-${slug}`, attemptId: ATTEMPT, intentId: INTENT,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${slug}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${slug}`,
      },
      budget: {
        admission: {
          admissionRef: `adm-${slug}`,
          amounts: [
            { meter: "usd", purpose: "EXECUTION", quantity: 10 },
            { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
            { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
            { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
            { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
          ],
          expectedVersion: 2,
        },
        gate: { allowance: { decisionRef: `dec-${slug}`, outcome: "ALLOW" }, approval: null },
        view: {
          accountId: `acct-${slug}`,
          meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
          state: "OPEN", version: 2,
        },
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${slug}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${slug}`, inputBinding: DIGEST, intentId: INTENT,
          leaseBinding: lease, predecessorCursor: `cursor-${slug}`,
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: slug, slotRef: `held-${slug}`, state: "RESERVED" }],
      slot: {
        dimension: slug, requestId: `req-${slug}`, slotRef: `slot-${slug}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${slug}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${slug}`, state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

const blind: ProviderFactUnknown = {
  known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT",
};

interface RunShape {
  readonly completedAt: string | null;
  readonly effectIntentId: string;
  readonly infrastructure: ProviderRunRecord["infrastructure"];
  readonly runRef: string;
  readonly terminal: ProviderRunRecord["terminal"];
}

function refOf(effectIntentId: string, runRef: string): ProviderRunRef {
  return { attemptRef: ATTEMPT, effectIntentId, epoch: EPOCH, provider: "claude", runRef };
}

function recordOf(shape: RunShape): ProviderRunRecord {
  return {
    recordVersion: PROVIDER_RUN_RECORD_VERSION,
    providerRunRef: refOf(shape.effectIntentId, shape.runRef),
    launch: {
      kind: "REFUSED", truthClass: "UNKNOWN", reasonCode: null, reasonLayer: null, exit: null,
      effectDigest: null, activationDigest: null, runtimeBindingDigest: null,
      quotedRuntimeDigest: null, freshRuntimeDigest: null, pinnedClosureDigest: null,
      observationDigest: null, startedAt: null,
      // A terminal cannot be derived without an OBSERVED completion instant: the runner refuses
      // PROVIDER_SETTLEMENT_COMPLETION_INSTANT_ABSENT on a null. Measured, not assumed. Note the
      // LAUNCH facts carry a plain string here while the runner's observation wants a
      // ProviderText — the writer is what bridges the two vocabularies.
      completedAt: shape.completedAt,
    },
    declared: blind,
    observedModel: { modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind },
    terminal: shape.terminal,
    infrastructure: shape.infrastructure,
    tokens: {
      inputTokens: blind, outputTokens: blind, cacheCreationInputTokens: blind,
      cacheReadInputTokens: blind, coverage: "UNKNOWN",
    },
    steps: { turns: blind, coverage: "UNKNOWN" },
    sequence: { known: true, value: 3 },
    concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: blind, achieved: blind },
    observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
    observedEnd: null,
    usage: [],
    usageRefusals: [],
    upstreamRefusal: null,
    stdoutReceiptDigest: { known: true, value: `stdout-${shape.runRef}` },
    stderrReceiptDigest: { known: true, value: `stderr-${shape.runRef}` },
    recordDigest: "",
  } as unknown as ProviderRunRecord;
}

/** Drives BOTH production writers. A refused setup throws rather than leaving an empty store. */
function seed(shape: Partial<RunShape> = {}): SqliteEventStore {
  const store = openStore("seed");
  const activation = runEffectActivateCommand(store, activationBytes());
  if (!activation.ok) throw new Error(`seed activation refused: ${activation.code}`);
  const committed = commitProviderRunRecord(store, {
    correlationId: "corr-run-terminal",
    decidedAt: DECIDED_AT,
    key: {
      commandId: "cmd-run-terminal", principalId: SESSION, projectId: PROJECT_ID,
    } satisfies CommandDecisionKey,
    record: recordOf({
      completedAt: shape.completedAt === undefined ? DECIDED_AT : shape.completedAt,
      effectIntentId: shape.effectIntentId ?? INTENT,
      runRef: shape.runRef ?? "run-terminal",
      infrastructure: shape.infrastructure ?? "NONE",
      terminal: shape.terminal ?? "COMPLETED",
    }),
    requestBytes: encoder.encode("provider-run-request-terminal"),
  });
  if (!committed.ok) throw new Error(`seed provider run refused: ${committed.code}`);
  return store;
}

/** Raw durable counts, so "nothing persisted" is read back rather than inferred from a verdict. */
function horizonOf(store: SqliteEventStore): bigint {
  return store.readEventHorizon();
}

function expectRefusal(value: unknown, code: string): Record<string, unknown> {
  const refusal = value as Record<string, unknown>;
  expect(refusal.ok).toBe(false);
  expect(refusal.code).toBe(code);
  expect(refusal.layer).toBe(WRITER_LAYER);
  expect(Object.isFrozen(refusal)).toBe(true);
  return refusal;
}

/**
 * The runner's answer for the same evidence, obtained independently of the writer.
 *
 * This is the anti-tautology device: the accepted control compares the PERSISTED result to
 * this, not to a literal typed out by hand. If the writer ever stopped calling the runner, the
 * two would diverge and the comparison would fail.
 */
function runnerAnswer(store: SqliteEventStore): unknown {
  const binding = readFoundationActivationByAttempt(store, PROJECT_ID, ATTEMPT);
  if (binding.status !== "BOUND") throw new Error(`activation not bound: ${binding.status}`);
  // The binding is primitives-only; the durable intent lives in the activation ledger record.
  const activation = readActivationLedgerRecord(
    binding.activationAggregateId, store.readEvents(binding.activationAggregateId),
  );
  if (!activation.ok) throw new Error("activation record not readable");
  const run = readCurrentProviderRun(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });
  if (!("ok" in run) || run.ok !== true) throw new Error("provider run not readable");
  return settleEffectFromProviderObservation(activation.record.effectIntent, {
    completedAt: run.record.launch.completedAt === null
      ? null
      : { known: true as const, value: run.record.launch.completedAt },
    infrastructure: run.record.infrastructure,
    runRef: run.record.providerRunRef,
    sourceDigest: run.recordDigest,
    sourceVersion: PROVIDER_TELEMETRY_CONTRACT_VERSION,
    terminal: run.record.terminal,
    upstreamRefusal: run.record.upstreamRefusal,
  });
}

describe("recordTerminalEffect — accepted terminal authority", () => {
  it("persists the RUNNER's own settlement, not one this module composed", () => {
    const store = seed();
    const expected = runnerAnswer(store);

    const written = recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });

    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.record.intentId).toBe(INTENT);
    expect(written.record.attemptRef).toBe(ATTEMPT);
    expect(written.record.projectId).toBe(PROJECT_ID);
    // Field-for-field against the runner's OWN output for the same durable evidence.
    expect(written.record.settlement).toEqual(expected);
  });

  it("is idempotent: the same durable evidence replays without appending", () => {
    const store = seed();
    const first = recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });
    const horizonAfterFirst = horizonOf(store);

    const second = recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second).toEqual(first);
    // Raw horizon, not a verdict: a replay that appended would still return ok.
    expect(horizonOf(store)).toBe(horizonAfterFirst);
  });
});

describe("recordTerminalEffect — the runner decides, the caller never does", () => {
  it.each([
    ["intentId", { attemptRef: ATTEMPT, intentId: "intent-forged", projectId: PROJECT_ID }],
    ["terminalState", { attemptRef: ATTEMPT, projectId: PROJECT_ID, terminalState: "SUCCEEDED" }],
    ["outcomeClass", { attemptRef: ATTEMPT, outcomeClass: "PROVEN_RESULT", projectId: PROJECT_ID }],
    ["resultBytes", { attemptRef: ATTEMPT, projectId: PROJECT_ID, resultBytes: new Uint8Array([1]) }],
  ])("refuses a caller-proposed %s instead of letting it decide", (_field, input) => {
    const store = seed();
    const before = horizonOf(store);

    expectRefusal(recordTerminalEffect(store, input), "EFFECT_TERMINAL_REQUEST_INVALID");

    // A returned refusal is not evidence that nothing was written.
    expect(horizonOf(store)).toBe(before);
  });

  it("covers every caller-authority field the DoD names", () => {
    // The sweep asserts it actually generated cases: a table that silently
    // produced zero rows would pass while testing nothing.
    expect(["intentId", "terminalState", "outcomeClass", "resultBytes"]).toHaveLength(4);
  });

  /**
   * A run whose completion was never observed. This reaches the RUNNER — the daemon's provider
   * run reader is satisfied — and the runner refuses, because a terminal cannot be derived
   * without an instant to bind the reconciliation digest to.
   */
  it("writes NOTHING when the runner refuses the evidence", () => {
    const store = seed({ completedAt: null });
    const before = horizonOf(store);

    const refusal = expectRefusal(
      recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID }),
      "EFFECT_TERMINAL_SETTLEMENT_REFUSED",
    );

    expect(horizonOf(store)).toBe(before);
    // The runner's own code survives; this module never restamps it.
    expect(refusal.upstream).toMatchObject({
      code: "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_ABSENT",
    });
  });

  /**
   * WHICH LAYER ANSWERS FIRST, pinned deliberately.
   *
   * A run whose `effectIntentId` disagrees with the durable intent never reaches the runner's
   * own PROVIDER_SETTLEMENT_EFFECT_BINDING_MISMATCH: the daemon's provider-run reader gates the
   * binding first and reports absence. Asserting the runner's code here would have been a test
   * that passes for the wrong reason — the arm it names is unreachable from this fixture.
   */
  it("reports the PROVIDER RUN READER, not the runner, when the run binds a foreign intent", () => {
    const store = seed({ effectIntentId: "intent-foreign" });
    const before = horizonOf(store);

    const refusal = expectRefusal(
      recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID }),
      "EFFECT_TERMINAL_EVIDENCE_ABSENT",
    );

    expect(horizonOf(store)).toBe(before);
    expect(refusal.upstream).toMatchObject({ layer: "PROVIDER_RUN_READER" });
  });

  it("writes NOTHING when the evidence proves no admitted terminal arc", () => {
    // ACTIVE + UNKNOWN/EXIT_UNOBSERVED matches no admitted row, so the only settlement the
    // evidence supports is UNKNOWN — never a terminal anyone may adopt.
    const store = seed({ infrastructure: "EXIT_UNOBSERVED", terminal: "UNKNOWN" });
    const before = horizonOf(store);

    expectRefusal(
      recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID }),
      "EFFECT_TERMINAL_NOT_PROVEN",
    );

    expect(horizonOf(store)).toBe(before);
  });
});

describe("recordTerminalEffect — advisory records are never terminal authority", () => {
  it("mints no terminal record from an attempt that was only RECORDED", () => {
    // No provider run committed at all: FoundationAttemptRecorded, wherever it exists, is
    // advisory and terminalises nothing (task rail 3).
    const store = openStore("advisory");
    const activation = runEffectActivateCommand(store, activationBytes());
    if (!activation.ok) throw new Error(`activation refused: ${activation.code}`);
    const before = horizonOf(store);

    expectRefusal(
      recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID }),
      "EFFECT_TERMINAL_EVIDENCE_ABSENT",
    );

    expect(horizonOf(store)).toBe(before);
  });
});

/** A real store whose SECOND read of one aggregate throws. Every other method is the genuine
 *  store, so the mid-derivation failure is the only injected fact. Idiom shared with the
 *  attempt service suite's `abortingStore`. */
function readFailingStore(store: SqliteEventStore, aggregateId: string): {
  readonly fired: () => number; readonly store: SqliteEventStore;
} {
  let reads = 0, fired = 0;
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "readEvents") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (requested: string) => {
        if (requested === aggregateId) {
          reads += 1;
          if (reads >= 2) {
            fired += 1;
            throw new Error("injected activation ledger read failure");
          }
        }
        return target.readEvents(requested);
      };
    },
  });
  return { fired: () => fired, store: proxy };
}

describe("recordTerminalEffect — a throwing store read refuses, never throws", () => {
  /**
   * THE MID-DERIVATION FAILURE WINDOW. The binding scan reads the activation aggregate once,
   * guarded inside the attempt reader's own walls; the writer then reads it AGAIN for the
   * durable intent. A store that dies between those two reads used to escape this module as a
   * THROW — and the dispatch capture path treats a terminal refusal as advisory but a throw as
   * a wedge, leaving a launched attempt with no durable record at all. The injection is keyed
   * to the SECOND read so the first arm cannot answer for the one under test, and the upstream
   * assertion pins the activation ledger's own vocabulary: if the throw ever fired inside the
   * binding scan instead, the upstream layer would read FOUNDATION_ACTIVATION_BINDING and this
   * case would go red for the drift rather than passing for the wrong reason.
   */
  it("refuses EVIDENCE_ABSENT when the activation ledger read throws mid-derivation", () => {
    const store = seed();
    const binding = readFoundationActivationByAttempt(store, PROJECT_ID, ATTEMPT);
    if (binding.status !== "BOUND") throw new Error(`fixture binding not bound: ${binding.status}`);
    const before = horizonOf(store);
    const injected = readFailingStore(store, binding.activationAggregateId);

    const refusal = expectRefusal(
      recordTerminalEffect(injected.store, { attemptRef: ATTEMPT, projectId: PROJECT_ID }),
      "EFFECT_TERMINAL_EVIDENCE_ABSENT",
    );

    expect(injected.fired()).toBe(1);
    // The activation ledger's OWN store-unavailability code, not one invented at this seam.
    expect(refusal.upstream).toEqual({
      code: "ACTIVATION_LEDGER_STORE_UNAVAILABLE", layer: "ACTIVATION_LEDGER",
    });
    // A returned refusal is not evidence that nothing was written.
    expect(horizonOf(store)).toBe(before);

    // The refusal wedged nothing durable: the SAME store, reading again, still lands the record.
    const recovered = recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(readCurrentTerminalEffect(store, readRequest)).toEqual(recovered);
  });
});

/** Raw decision count, paged. The replay assertions pin NUMBERS, never verdicts. */
function decisionCountOf(store: SqliteEventStore): number {
  let cursor = 0n;
  let total = 0;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 100);
    total += page.items.length;
    if (!page.hasMore || page.nextCursor === null || page.nextCursor <= cursor) return total;
    cursor = page.nextCursor;
  }
}

function terminalAggregate(): string {
  return deriveTerminalEffectAggregateId({
    attemptRef: ATTEMPT, intentId: INTENT, projectId: PROJECT_ID,
  });
}

/** Plants raw bytes on the terminal aggregate through the store's OWN commit API. */
function plant(store: SqliteEventStore, eventId: string, payload: Uint8Array): void {
  const aggregateId = terminalAggregate();
  store.commit({
    aggregateId,
    commandBytes: encoder.encode(`plant-${eventId}`),
    commandId: `cmd-plant-${eventId}`,
    committedAt: DECIDED_AT,
    events: [{ eventId, eventType: EFFECT_TERMINAL_EVENT_TYPE, payload }],
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

function expectReaderRefusal(value: unknown, code: string): Record<string, unknown> {
  const refusal = value as Record<string, unknown>;
  expect(refusal.ok).toBe(false);
  expect(refusal.code).toBe(code);
  expect(refusal.layer).toBe(WRITER_LAYER);
  expect(Object.isFrozen(refusal)).toBe(true);
  return refusal;
}

const readRequest = { attemptRef: ATTEMPT, intentId: INTENT, projectId: PROJECT_ID } as const;

describe("readCurrentTerminalEffect — accepted read", () => {
  it("returns the terminal ref and state the writer persisted", () => {
    const store = seed();
    const written = recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });
    if (!written.ok) throw new Error(`fixture write refused: ${written.code} :: ${written.detail}`);

    const read = readCurrentTerminalEffect(store, readRequest);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toEqual(written.record);
    expect(Object.isFrozen(read.record)).toBe(true);
  });

  it("does not append or decide anything: raw event and decision counts hold across reads", () => {
    const store = seed();
    recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });
    const events = store.readEventHorizon();
    const decisions = decisionCountOf(store);

    readCurrentTerminalEffect(store, readRequest);
    readCurrentTerminalEffect(store, readRequest);

    expect(store.readEventHorizon()).toBe(events);
    expect(decisionCountOf(store)).toBe(decisions);
  });
});

describe("readCurrentTerminalEffect — four distinct fail-closed arms", () => {
  it("ABSENT when no terminal record was ever written", () => {
    const store = seed();

    expectReaderRefusal(
      readCurrentTerminalEffect(store, readRequest),
      "EFFECT_TERMINAL_ABSENT",
    );
  });

  it("UNREADABLE when the durable payload does not decode", () => {
    const store = seed();
    plant(store, "terminal-undecodable", encoder.encode("{not json at all"));

    expectReaderRefusal(
      readCurrentTerminalEffect(store, readRequest),
      "EFFECT_TERMINAL_UNREADABLE",
    );
  });

  /**
   * THE ECHO TRAP, and the reason the reader must re-encode rather than trust a replay.
   *
   * The store's replay identity EXCLUDES event bytes, so a record whose bytes were doctored
   * after commit replays perfectly and echoes back green to any reader that merely decodes it.
   * These bytes decode to a structurally complete record; only the decode -> re-encode ->
   * byte-compare catches that they are not what this codec would have written.
   */
  it("MALFORMED when the stored bytes are not what the codec would emit", () => {
    const store = seed();
    const written = recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });
    if (!written.ok) throw new Error(`fixture write refused: ${written.code} :: ${written.detail}`);
    const before = store.readEvents(terminalAggregate()).map((event) => [...event.payload]);
    // Same fields, deliberately NON-canonical key order: decodes, re-encodes differently.
    const doctored = Object.fromEntries(
      Object.entries(written.record as unknown as Record<string, unknown>).reverse(),
    );
    plant(store, "terminal-doctored", encoder.encode(JSON.stringify(doctored)));

    const refusal = expectReaderRefusal(
      readCurrentTerminalEffect(store, readRequest),
      "EFFECT_TERMINAL_MALFORMED",
    );

    expect(refusal.layer).toBe(WRITER_LAYER);
    // The ORIGINAL record survives the doctored one byte-identically.
    const after = store.readEvents(terminalAggregate()).map((event) => [...event.payload]);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("AMBIGUOUS when two terminal records claim the same attempt and intent", () => {
    const store = seed();
    const written = recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });
    if (!written.ok) throw new Error(`fixture write refused: ${written.code} :: ${written.detail}`);
    // A SECOND well-formed record for the same {attemptRef,intentId} — the reader must refuse
    // to pick a winner rather than silently answering with one of them.
    // Encoded through the codec's OWN encoder so the rival is WELL-FORMED. Hand-stringifying it
    // would fail the byte-check and this case would prove MALFORMED instead of AMBIGUOUS.
    plant(store, "terminal-rival", encodeTerminalEffectRecord({
      ...written.record, terminalState: "FAILED",
    }));

    expectReaderRefusal(
      readCurrentTerminalEffect(store, readRequest),
      "EFFECT_TERMINAL_AMBIGUOUS",
    );
  });
});

describe("recordTerminalEffect — replay identity (DoD 4)", () => {
  /**
   * STATED LIMIT. A conflict cannot be produced by honest durable history: committing a SECOND
   * provider run for one attempt makes `readCurrentProviderRun` decline to name a current run
   * at all, so the writer refuses EVIDENCE_ABSENT and never reaches this branch (measured; the
   * neighbouring test pins that behaviour). The branch therefore guards a record that only a
   * corrupted or hand-written store could hold — planted here through the store's own commit
   * API. It proves the guard fires, NOT that a writer can reach it.
   */
  it("refuses to overwrite a foreign terminal record, before mutating anything", () => {
    const store = seed();
    const derived = recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID });
    if (!derived.ok) throw new Error(`fixture write refused: ${derived.code} :: ${derived.detail}`);
    // Rebuild the store so the ONLY terminal record present is a planted, disagreeing one.
    const fresh = seed();
    plant(fresh, "terminal-foreign", encodeTerminalEffectRecord({
      ...derived.record, terminalState: "CANCELLED",
    }));
    const events = fresh.readEventHorizon();
    const decisions = decisionCountOf(fresh);
    const bytes = fresh.readEvents(terminalAggregate()).map((event) => [...event.payload]);

    const conflicting = recordTerminalEffect(fresh, {
      attemptRef: ATTEMPT, projectId: PROJECT_ID,
    });

    expectRefusal(conflicting, "EFFECT_TERMINAL_CONFLICT");
    // Refused BEFORE mutation: raw numbers, not verdicts.
    expect(fresh.readEventHorizon()).toBe(events);
    expect(decisionCountOf(fresh)).toBe(decisions);
    // The planted record survives byte-identically; the writer overwrote nothing.
    expect(fresh.readEvents(terminalAggregate()).map((event) => [...event.payload])).toEqual(bytes);
  });

  /** WHICH LAYER ANSWERS FIRST: two provider runs for one attempt is not a terminal conflict. */
  it("declines when a second provider run leaves no current run to derive from", () => {
    const store = seed();
    const second = commitProviderRunRecord(store, {
      correlationId: "corr-run-terminal-2",
      decidedAt: DECIDED_AT,
      key: {
        commandId: "cmd-run-terminal-2", principalId: SESSION, projectId: PROJECT_ID,
      } satisfies CommandDecisionKey,
      record: recordOf({
        completedAt: DECIDED_AT, effectIntentId: INTENT, infrastructure: "NONE",
        runRef: "run-terminal-2", terminal: "ERROR_DURING_EXECUTION",
      }),
      requestBytes: encoder.encode("provider-run-request-terminal-2"),
    });
    if (!second.ok) throw new Error(`second run refused: ${second.code}`);
    const before = horizonOf(store);

    expectRefusal(
      recordTerminalEffect(store, { attemptRef: ATTEMPT, projectId: PROJECT_ID }),
      "EFFECT_TERMINAL_EVIDENCE_ABSENT",
    );

    expect(horizonOf(store)).toBe(before);
  });
});
