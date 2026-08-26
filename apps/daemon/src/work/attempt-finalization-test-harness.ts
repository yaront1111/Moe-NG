/**
 * TEST-TIER. The durable world a POST-VERIFICATION finalization runs over.
 *
 * Every fact is seeded through the PRODUCTION writer that owns it — activation
 * ingress, the provider-run ledger, the terminal-effect ledger, the resource
 * authority, the five handoff sources and `commitPhase` for the receipt — so a
 * suite built on this harness is never reading back bytes the harness itself
 * invented in a shape production would refuse.
 *
 * NO `.js` BRIDGE. `runtime-entrypoint.test.ts` pins the bridge set to RUNTIME
 * modules only, and a test-tier module that grew one would be admitted into the
 * shipped graph.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProviderRuntimeObservation } from "@moe/runner";
import type {
  DeclaredInput, ProviderFactUnknown, ProviderRuntimeObservation, ProviderRunRef,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  deriveVerificationAggregateId,
} from "../evidence/foundation-verification-store.js";
import { commitPhase } from "../evidence/foundation-verification-store.js";
import { verificationReceiptBody } from "../evidence/foundation-verification-contracts.js";
import {
  PRINCIPAL_ID, PROJECT_ID, openHarnessStore, seedReadyProject, trackHarnessRoot,
} from "../recovery/restore-test-harness.js";
import { PROVIDER_RUN_RECORD_VERSION } from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRecord } from "../telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../telemetry/provider-run-ledger.js";
import { createFoundationVerificationService }
  from "../evidence/foundation-verification-service.js";
import { applyAttemptResourceReport } from "./attempt-resource-authority.js";
import { recordTerminalEffect } from "./effect-terminal-ledger.js";
import { seedReleaseHandoffSources } from "./release-handoff-test-harness.js";
import { attemptRecordBody } from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import { deriveDispatchAggregateId, encodeFoundationPayload }
  from "./foundation-attempt-codec.js";
import { commitFoundationPhase, readFoundationAttemptRecord } from "./foundation-attempt-store.js";

export { PRINCIPAL_ID, PROJECT_ID };

const encoder = new TextEncoder();

export const FINAL_DIGEST = "a".repeat(64);
export const FINAL_DECIDED_AT = "2026-08-15T00:00:00.000Z";
export const FINAL_SESSION_ID = "session-1";
export const FINAL_NODE_KEY = "dev-done";
export const FINAL_ATTEMPT_REF = "attempt-1";

const LEASE_RECORD = {
  authorityHashRef: FINAL_DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
  leaseId: "lease-1", leaseToken: "token-1", monotonicObservation: 500,
  ownerSessionRef: FINAL_SESSION_ID, serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;
const LEASE_PROOF = {
  authorityHashRef: FINAL_DIGEST, epoch: 3, expectedVersion: 7, leaseToken: "token-1",
  ownerSessionRef: FINAL_SESSION_ID,
} as const;
const RESOURCE_ROW = {
  capacityUnits: 1, effectIntentRef: "intent-ref-1", epoch: 1, external: false, fenceable: true,
  resourceId: "res-1", state: "ACTIVE",
} as const;
const EFFECT_INTENT = {
  aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4, idempotencyKey: "idem-1",
  inputBinding: FINAL_DIGEST, intentId: "intent-1", leaseBinding: LEASE_RECORD,
  predecessorCursor: "cursor-1", protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: FINAL_DIGEST, state: "PENDING", version: 0,
} as const;
const CLAIM = {
  claimId: "claim-1", claimedAt: FINAL_DECIDED_AT, intentId: "intent-1", lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
} as const;
const ACTIVATION_SECTION = {
  attempt: {
    aggregateId: "agg-1", attemptId: FINAL_ATTEMPT_REF, intentId: "intent-1",
    state: "LAUNCH_REQUESTED", version: 0,
  },
  claim: CLAIM, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: FINAL_DIGEST,
  tombstone: null, wrapperIdentity: "wrapper-1",
} as const;

export const FINAL_ACTIVATION_AGGREGATE = deriveActivationAggregateId(
  EFFECT_INTENT.aggregateId, EFFECT_INTENT.idempotencyKey);

function activationBytes(): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: "cmd-final-1", correlationId: "corr-final", decidedAt: FINAL_DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: ACTIVATION_SECTION,
      effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

const blindFact: ProviderFactUnknown = Object.freeze({
  known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT",
});

/** A PROVEN, EXITED, classified, completed run: the only shape whose derivation
 *  answers `safeBoundaryObserved: true`. */
function runRecord(ref: ProviderRunRef, observed: boolean): ProviderRunRecord {
  return {
    concurrency: { achieved: blindFact, declaredCeiling: blindFact, fact: "NO_CONCURRENCY_FACTS" },
    declared: blindFact,
    infrastructure: observed ? "NONE" : "EXIT_UNOBSERVED",
    launch: {
      activationDigest: null, completedAt: FINAL_DECIDED_AT, effectDigest: null,
      exit: observed ? { code: 0, kind: "EXITED" } : { kind: "UNOBSERVED" },
      freshRuntimeDigest: null, kind: "OBSERVED", observationDigest: null,
      pinnedClosureDigest: null, quotedRuntimeDigest: null, reasonCode: null, reasonLayer: null,
      runtimeBindingDigest: null, startedAt: FINAL_DECIDED_AT, truthClass: "PROVEN",
    },
    observedEnd: null,
    observedModel: { modelId: blindFact, snapshotEvidence: blindFact, snapshotKind: "UNKNOWN" },
    observedStart: { bootId: "boot-1", monotonicObservation: 12, serverWallSeconds: 1_700_000_000 },
    providerRunRef: ref, recordDigest: "", recordVersion: PROVIDER_RUN_RECORD_VERSION,
    sequence: { known: true, value: 3 },
    steps: { coverage: "UNKNOWN", turns: blindFact },
    stderrReceiptDigest: { known: true, value: "stderr-final" },
    stdoutReceiptDigest: { known: true, value: "stdout-final" },
    terminal: "COMPLETED",
    tokens: {
      cacheCreationInputTokens: blindFact, cacheReadInputTokens: blindFact, coverage: "UNKNOWN",
      inputTokens: blindFact, outputTokens: blindFact,
    },
    upstreamRefusal: null, usage: [], usageRefusals: [],
  };
}

/** The run committed through the PRODUCTION ledger writer, its ref read out of
 *  the durable activation binding rather than hand-guessed. */
export function seedProviderRun(
  store: SqliteEventStore, label: string, observed = true,
): void {
  const binding = readFoundationActivationByAttempt(store, PROJECT_ID, FINAL_ATTEMPT_REF);
  if (binding.status !== "BOUND") {
    throw new Error(`attempt unbound: ${binding.status}/${String(binding.code)}`);
  }
  const outcome = commitProviderRunRecord(store, {
    correlationId: `corr-run-${label}`, decidedAt: FINAL_DECIDED_AT,
    key: {
      commandId: `cmd-run-${label}`, principalId: binding.ownerSessionRef, projectId: PROJECT_ID,
    },
    record: runRecord({
      attemptRef: binding.attemptId, effectIntentId: binding.effectIntentId, epoch: binding.epoch,
      provider: "claude", runRef: `run-${label}`,
    }, observed),
    requestBytes: encoder.encode(`provider-run-request-${label}`),
  });
  if (!outcome.ok) throw new Error(`provider run refused: ${outcome.code} at ${outcome.layer}`);
}

/** THROWS rather than seeding less than it was asked for: a fixture that quietly
 *  skipped a writer would make a derived-false case pass for the wrong reason.
 *
 *  MEASURED: an UNOBSERVED run cannot carry a terminal effect at all — the ledger
 *  PROJECTS its settlement from the durable run, so `recordTerminalEffect` answers
 *  EFFECT_TERMINAL_NOT_PROVEN. Every unobserved-boundary world therefore seeds
 *  RESOURCES ONLY, which is exactly the shape that drains. */
function seedTerminality(store: SqliteEventStore, label: string, effects: boolean): void {
  if (effects) {
    const effect = recordTerminalEffect(store, {
      attemptRef: FINAL_ATTEMPT_REF, projectId: PROJECT_ID,
    });
    if (!effect.ok) throw new Error(`terminal effect refused for ${label}: ${effect.code}`);
  }
  const resources = applyAttemptResourceReport(store, {
    activationAggregateId: FINAL_ACTIVATION_AGGREGATE, commandId: `cmd-resources-${label}`,
    correlationId: `corr-resources-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
  }, { disposition: "FAILED", epoch: 1, kind: "FAIL", resourceId: RESOURCE_ROW.resourceId });
  if (!resources.ok) throw new Error(`resource report refused: ${resources.code}`);
}

export interface FinalizationWorld {
  readonly bound: FoundationAttemptBound;
  readonly record: ActivationLedgerRecord;
  readonly recordDigest: string;
  readonly store: SqliteEventStore;
  readonly storePath: string;
}

/**
 * A store whose named methods are replaced and whose others are BOUND TO THE REAL
 * INSTANCE. A `Proxy` cannot be used here: `SqliteEventStore` reads a `#core`
 * private field, and a forwarded call whose `this` is the proxy throws a
 * TypeError rather than exercising the path under test.
 */
export function withStoreOverride(
  store: SqliteEventStore, overrides: Partial<Record<string, unknown>>,
): SqliteEventStore {
  const forwarded: Record<string, unknown> = {};
  // EVERY method the class declares, not a hand-kept list: a forwarder missing one
  // would make an arm fail for a plumbing reason that reads like a real refusal.
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object)) {
    if (key === "constructor") continue;
    const method = (store as unknown as Record<string, unknown>)[key];
    if (typeof method === "function") {
      forwarded[key] = (method as (...a: never[]) => unknown).bind(store);
    }
  }
  return Object.assign(forwarded, overrides) as unknown as SqliteEventStore;
}

export interface FinalizationWorldOptions {
  /** `false` leaves the dispatch aggregate empty: an attempt no dispatch sealed. */
  readonly attemptRecord?: boolean;
  /** `false` seeds a run whose exit the host never saw: the boundary derives
   *  `false` on its own merits with a real `completedAt` still on the record. */
  readonly boundaryObserved?: boolean;
  readonly journal?: boolean;
  readonly providerRun?: boolean;
  /** `false` leaves the resource set ACTIVE, so the pre-release fence defers. */
  readonly terminal?: boolean;
  /** `false` seeds the RESOURCE half only: a terminal resource set with a
   *  non-terminal effect, which is the shape the kernel DRAINS. */
  readonly terminalEffects?: boolean;
}

/** A committed activation, read BACK from the store rather than kept from the
 *  command result, so the record this harness calls "durable" really is. */
export function finalizationWorld(
  label: string, options: FinalizationWorldOptions = {},
): FinalizationWorld {
  const root = trackHarnessRoot(mkdtempSync(join(tmpdir(), `moe-finalize-${label}-`)));
  const storePath = join(root, "project.db");
  const store = openHarnessStore(storePath);
  seedReadyProject(store);
  const activated = runEffectActivateCommand(store, activationBytes());
  if (!activated.ok) throw new Error(`activation refused: ${activated.code}`);
  if (options.providerRun !== false) {
    seedProviderRun(store, label, options.boundaryObserved !== false);
  }
  if (options.terminal !== false) {
    seedTerminality(store, label, options.terminalEffects !== false);
  }
  const history = readFoundationActivationHistory(
    FINAL_ACTIVATION_AGGREGATE, store.readEvents(FINAL_ACTIVATION_AGGREGATE), PROJECT_ID);
  if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
  const { record } = history.history;
  if (options.journal !== false) {
    seedReleaseHandoffSources(store, {
      activationDigest: record.activationDigest,
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, attemptRef: record.attempt.attemptId,
      effectId: record.effectIntent.intentId, leaseRef: record.lease.leaseId,
      nodeKey: FINAL_NODE_KEY, projectId: PROJECT_ID, sessionId: FINAL_SESSION_ID,
    });
  }
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: FINAL_ACTIVATION_AGGREGATE, claim: CLAIM, commandId: "cmd-final-release",
    correlationId: "corr-final-release", nodeKey: FINAL_NODE_KEY, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, sessionId: FINAL_SESSION_ID,
    target: deriveDispatchAggregateId(FINAL_ACTIVATION_AGGREGATE),
  });
  // A dispatched attempt ALWAYS has a durable RECORDED row before any
  // verification names it, so every world carries one: an absent record is a
  // separate case, not the default state a finalization runs over.
  const recordDigest = options.attemptRecord === false
    ? "" : seedProvenAttemptRecord(store, bound, record);
  return { bound, record, recordDigest, store, storePath };
}

/**
 * A PROVEN durable attempt record over the SAME activation the release world
 * committed, composed by `attemptRecordBody` and committed through
 * `commitFoundationPhase` — the production writer pair. `loadDurable` demands
 * PROVEN plus both manifests plus a readable activation history, and this is the
 * cheapest world that satisfies all three without a git-materialized tree.
 */
export function seedProvenAttemptRecord(
  store: SqliteEventStore, bound: FoundationAttemptBound, record: ActivationLedgerRecord,
): string {
  const reserved = encodeFoundationPayload({
    activationDigest: record.activationDigest, attemptAggregateId: bound.aggregateId,
    attemptId: record.attempt.attemptId, grantId: record.grant.grantId, nodeKey: bound.nodeKey,
    recordVersion: "moe-foundation-attempt-reservation/1", requestDigest: FINAL_DIGEST,
    sessionId: bound.sessionId,
  });
  if (!reserved.ok) throw new Error("reservation fixture refused");
  const first = commitFoundationPhase(
    store, bound, "RESERVED", reserved.bytes, 0, `${record.grant.grantId}:RESERVED`);
  if (first === null || first.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("reservation fixture was not committed");
  }
  const body = attemptRecordBody(bound, record, {
    baseIdentity: "b".repeat(40), entries: [], manifestVersion: "moe-workspace-input/1",
    sha256: FINAL_DIGEST,
  }, {
    observation: {}, reasonCode: null, reasonLayer: null,
    resultManifest: { manifestVersion: "moe-workspace-result/1", sha256: FINAL_DIGEST },
    registration: {}, truthClass: "PROVEN",
  });
  const encoded = encodeFoundationPayload(body);
  if (!encoded.ok) throw new Error("attempt record fixture refused");
  const second = commitFoundationPhase(
    store, bound, "RECORDED", encoded.bytes, 1, `${record.grant.grantId}:RECORDED`);
  if (second === null || second.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error("attempt record fixture was not committed");
  }
  const stored = readFoundationAttemptRecord(store, bound.aggregateId);
  if (!stored.ok) throw new Error(`attempt record unreadable: ${stored.code}`);
  return stored.digest;
}

const VERIFIER_IDENTITY = Object.freeze({
  capabilitySchemaDigest: "b".repeat(64), verifierId: "moe-verifier", verifierVersion: "1.0.0",
});

function runtimeQuote(): ProviderRuntimeObservation {
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: "b".repeat(64), clock: { observedAt: () => FINAL_DECIDED_AT },
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: "claude/2.0.0",
    resolvedRuntimeClosure: [
      { kind: "EXECUTABLE", path: "C:\\installed\\claude.exe", sha256: FINAL_DIGEST },
    ] as never,
  });
  if (!built.ok) throw new Error(`runtime quote fixture refused: ${built.code}`);
  return built.observation;
}

/** A real sealed recipe through the service's own `sealRecipe`, so
 *  `recipeSealMatches` re-derives it rather than being handed a literal. */
export function seedSealedRecipe(
  store: SqliteEventStore, recipeAggregateId: string,
): string {
  const declaredInputs: readonly DeclaredInput[] = [
    { path: "pkg/src/base.ts", ref: { byteLength: 10, sha256: FINAL_DIGEST } },
  ];
  const sealed = createFoundationVerificationService({
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, store,
  }).sealRecipe({
    argv: [process.execPath, "-e", "process.exit(0)"], declaredInputs, declaredOutputPaths: [],
    recipeAggregateId, runtimeObservation: runtimeQuote(), verifierIdentity: VERIFIER_IDENTITY,
  });
  if (!sealed.ok) throw new Error(`recipe seal fixture refused: ${sealed.code}`);
  return sealed.sha256;
}

export interface SeededReceipt {
  readonly attemptAggregateId: string;
  readonly receiptSha256: string;
  readonly verificationId: string;
}

/**
 * A RECEIPTED row through `commitPhase` — the same writer the verification
 * service uses — composed by `verificationReceiptBody` so the body's key set can
 * never drift from the one `readStoredReceipt` byte-verifies.
 */
export function seedReceipt(
  store: SqliteEventStore, parts: {
    readonly attemptAggregateId: string; readonly candidateRoot?: string;
    readonly recipeAggregateId?: string; readonly recipeSha256?: string;
    readonly recordDigest?: string; readonly sha256?: string;
    readonly verdict?: "FAILED" | "PASSED"; readonly verificationId: string;
  },
): SeededReceipt {
  const sha256 = parts.sha256 ?? "d".repeat(64);
  const aggregate = deriveVerificationAggregateId(parts.verificationId);
  const body = verificationReceiptBody({
    attemptAggregateId: parts.attemptAggregateId,
    candidateRoot: parts.candidateRoot ?? "/candidate",
    capture: {
      completedAt: FINAL_DECIDED_AT, durationMs: 5, exitCode: 0, signal: null,
      startedAt: FINAL_DECIDED_AT,
      stderr: { bytes: 0, sha256: "e".repeat(64), truncated: false },
      stdout: { bytes: 0, sha256: "f".repeat(64), truncated: false },
    } as never,
    receipt: { recipeSha256: parts.recipeSha256 ?? "c".repeat(64), sha256 } as never,
    recipeAggregateId: parts.recipeAggregateId ?? "recipe-1",
    recordDigest: parts.recordDigest ?? FINAL_DIGEST,
    verdict: parts.verdict ?? "PASSED", verificationId: parts.verificationId,
  });
  const commit = commitPhase(
    store, { principalId: PRINCIPAL_ID, projectId: PROJECT_ID }, aggregate, "RECEIPTED",
    body, store.readEvents(aggregate).length, "RECEIPTED");
  if (commit.kind !== "COMMITTED") throw new Error(`receipt fixture refused: ${commit.kind}`);
  return { attemptAggregateId: parts.attemptAggregateId, receiptSha256: sha256,
    verificationId: parts.verificationId };
}
