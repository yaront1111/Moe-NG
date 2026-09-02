/**
 * THE SETTLEMENT WORLD, shared by every suite that needs a PRODUCTION-APPLIED budget settlement.
 *
 * Extracted verbatim from budget-settlement-application.test.ts (task-f432799c) so the coverage
 * reader can reach a settled record without duplicating ~100 lines of constants or importing one
 * .test.ts from another. Nothing here was rewritten: the identities, the activation payload and
 * the normalization route are byte-for-byte what the settlement suite already proved.
 *
 * EVERY DURABLE FACT THESE HELPERS WRITE COMES FROM A PRODUCTION WRITER. The reservation comes
 * from a real `effect.activate` through `runEffectActivateCommand`, so the attempt/reservation
 * join is the one production makes; the provider run comes from `commitProviderRunRecord`; the
 * measurement identities are minted by the scheduler's own `normalizeUsageMeasurement`, and the
 * correlation composite by `encodeProviderRunRef`. A hand-typed composite or a hand-written
 * identity would satisfy a check the authority would have refused.
 *
 * THIS MODULE ASSERTS NOTHING AND REGISTERS NO HOOKS. A fixture that asserts is a test nobody
 * runs by name, and a fixture that registers `afterAll` makes teardown order implicit across
 * files. Consumers call `cleanupSettlementScratchRoots` from their own hook.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeProviderRunRef, normalizeUsageMeasurement } from "@moe/scheduler";
import type { NormalizedMeasurement } from "@moe/scheduler";
import type { CommandDecisionKey, SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { readActivationLedgerRecord } from "../activation/activation-ledger-reader.js";
import { GOAL_ID } from "../bootstrap/bootstrap-test-fixtures.js";
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
import { readCurrentBudgetLedger } from "./budget-current-projection.js";
import { applyProviderUsageToBudget } from "./budget-settlement-application.js";

export { GOAL_ID, PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses };

const encoder = new TextEncoder();
const scratchRoots: string[] = [];

/** Drops every scratch root this module minted. Call it from the consuming suite's `afterAll`. */
export function cleanupSettlementScratchRoots(): void {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
}

export const DIGEST = "a".repeat(64);
export const DECIDED_AT = "2026-08-15T00:00:00.000Z";
export const COMMAND_ID = "cmd-activate-1";
export const ATTEMPT = "attempt-1";
export const INTENT = "intent-1";
export const EPOCH = 3;
export const RUN_REF = "run-settlement-1";
export const PROVIDER = "claude";

export const LEASE_RECORD = {
  authorityHashRef: DIGEST, bootId: "boot-1", epoch: EPOCH, kind: "ASSIGNMENT",
  leaseId: "lease-1", leaseToken: "token-1", monotonicObservation: 500,
  ownerSessionRef: "session-1", serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;

export const LEASE_PROOF = {
  authorityHashRef: DIGEST, epoch: EPOCH, expectedVersion: 7,
  leaseToken: "token-1", ownerSessionRef: "session-1",
} as const;

export const EFFECT_INTENT = {
  aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4,
  idempotencyKey: "idem-1", inputBinding: DIGEST, intentId: INTENT,
  leaseBinding: LEASE_RECORD, predecessorCursor: "cursor-1",
  protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
  state: "PENDING", version: 0,
} as const;

export const ACTIVATION_SECTION = {
  attempt: {
    aggregateId: "agg-1", attemptId: ATTEMPT, intentId: INTENT,
    state: "LAUNCH_REQUESTED", version: 0,
  },
  claim: {
    claimId: "claim-1", claimedAt: DECIDED_AT, intentId: INTENT,
    lockIdentity: "lock-1", wrapperIdentity: "wrapper-1",
  },
  dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
  tombstone: null, wrapperIdentity: "wrapper-1",
} as const;

export const AGGREGATE_ID = deriveActivationAggregateId(
  EFFECT_INTENT.aggregateId,
  EFFECT_INTENT.idempotencyKey,
);

export const blind = { known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT" } as const;

export function readyStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-settle-${label}-`));
  scratchRoots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

/** A genuinely empty durable store for the first two refusal rungs. */
export function openUnactivatedBudgetFixture(label: string): SqliteEventStore {
  const path = label.replace(/[^\w.-]/gu, "_");
  const root = mkdtempSync(join(tmpdir(), `moe-settle-${path}-`));
  scratchRoots.push(root);
  return openHarnessStore(join(root, "project.db"));
}

/** Store-wide: a per-aggregate read would miss a write in a neighbouring aggregate. */
export const storeWideEventHorizon = (store: SqliteEventStore): bigint =>
  store.readEventHorizon();

export function activateBytes(commandId: string = COMMAND_ID): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId, correlationId: "corr-activate", decidedAt: DECIDED_AT, expectedVersion: 0,
    kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: ACTIVATION_SECTION,
      effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: {
        dimension: "default", requestId: "req-1", slotRef: "slot-1",
        rows: [{
          capacityUnits: 1, effectIntentRef: "intent-ref-1", epoch: 1, external: false,
          fenceable: true, resourceId: "res-1", state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/** The activated store: reservation ACTIVATED and bound to the attempt by PRODUCTION. */
export function activatedStore(label: string): SqliteEventStore {
  const store = readyStore(label);
  const outcome = runEffectActivateCommand(store, activateBytes());
  if (!("ok" in outcome) || outcome.ok !== true) {
    throw new Error(`the activation fixture was refused: ${JSON.stringify(outcome).slice(0, 200)}`);
  }
  return store;
}

export interface Held {
  readonly attemptRef: string;
  readonly meters: readonly string[];
  readonly reservationId: string;
  readonly state: string;
}

/** The durable reservation, read through the committed projection — never a suite-built view. */
export function heldOf(store: SqliteEventStore): Held {
  const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!current.ok) throw new Error(`the durable ledger must read back: ${current.code}`);
  const durable = readActivationLedgerRecord(AGGREGATE_ID, store.readEvents(AGGREGATE_ID));
  if (!durable.ok) throw new Error(`the activation record must read back: ${durable.code}`);
  const attemptRef = durable.record.attempt.attemptId;
  const reservation = current.reservations.find((entry) => entry.attemptRef === attemptRef);
  if (reservation === undefined) throw new Error("no reservation is bound to the attempt");
  return {
    attemptRef,
    meters: [...new Set(reservation.lines.map((line) => line.meter))],
    reservationId: reservation.reservationId,
    state: reservation.state,
  };
}

/**
 * A SECOND independent activation in the same store.
 *
 * Everything that decides identity is distinct — attempt, intent, aggregate, idempotency key and
 * command id — so the ledger ends up holding TWO activated reservations. Without a second one,
 * "find the reservation bound to this attempt" and "find any activated reservation" pick the same
 * row, and no arm can tell the two apart. Measured: dropping the attempt from the filter was a
 * SURVIVING mutant until this fixture existed.
 */
export const SECOND_ATTEMPT = "attempt-2";

export function secondActivateBytes(): Uint8Array {
  const intent = { ...EFFECT_INTENT, aggregateId: "agg-2", idempotencyKey: "idem-2", intentId: "intent-2" };
  return encoder.encode(JSON.stringify({
    commandId: "cmd-activate-2", correlationId: "corr-activate-2", decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        ...ACTIVATION_SECTION,
        attempt: {
          aggregateId: "agg-2", attemptId: SECOND_ATTEMPT, intentId: "intent-2",
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim: { ...ACTIVATION_SECTION.claim, claimId: "claim-2", intentId: "intent-2" },
      },
      effect: { command: { kind: "claim" }, intent },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: {
        dimension: "default", requestId: "req-2", slotRef: "slot-2",
        rows: [{
          capacityUnits: 1, effectIntentRef: "intent-ref-2", epoch: 1, external: false,
          fenceable: true, resourceId: "res-2", state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

export function activatedReservationCount(store: SqliteEventStore): number {
  const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!current.ok) throw new Error(`the ledger must read back: ${current.code}`);
  return current.reservations.filter((entry) => entry.state === "ACTIVATED").length;
}

export const compositeFor = (attemptRef: string, runRef = RUN_REF): string =>
  encodeProviderRunRef({ attemptRef, epoch: EPOCH, provider: PROVIDER, runRef });

export interface UsageShape {
  readonly coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  readonly meter: string;
  readonly quantity: number | null;
  readonly runRef?: string;
}

export const SOURCE_OF = {
  COMPLETE: "PROVIDER_REPORTED_COMPLETE",
  PARTIAL: "PROVIDER_REPORTED_PARTIAL",
  UNKNOWN: "UNKNOWN",
} as const;

/** The three-key envelope the measurement authority admits. `identity` is ITS to derive. */
export function envelopeOf(attemptRef: string, shape: UsageShape, index: number): unknown {
  return {
    measurement: {
      coverage: shape.coverage,
      meter: shape.meter,
      observedInterval: { endRef: "interval-end-1", startRef: "interval-start-1" },
      providerRunRef: compositeFor(attemptRef, shape.runRef ?? RUN_REF),
      quantity: shape.quantity,
      rawReceiptDigest: "ab".repeat(32),
      sequence: index,
      source: SOURCE_OF[shape.coverage],
      sourceParserVersion: 1,
    },
    pricebookBinding: null,
    truncated: false,
  };
}

/**
 * Normalized through the SCHEDULER'S OWN authority, so `identity` is the value production would
 * have derived. Writing an identity by hand here would be asserting a coverage the authority
 * never granted — the exact laundering `budget-ledger-holds` normalizes server-side to prevent.
 */
export function usageRows(
  attemptRef: string, shapes: readonly UsageShape[],
): readonly NormalizedMeasurement[] {
  return shapes.map((shape, index) => {
    const normalized = normalizeUsageMeasurement(envelopeOf(attemptRef, shape, index));
    if (!normalized.ok) {
      throw new Error(`usage fixture refused: ${JSON.stringify(normalized.issues).slice(0, 200)}`);
    }
    return normalized.record;
  });
}

export function runRecord(
  attemptRef: string, usage: readonly NormalizedMeasurement[],
): ProviderRunRecord {
  return {
    recordVersion: PROVIDER_RUN_RECORD_VERSION,
    providerRunRef: { attemptRef, effectIntentId: INTENT, epoch: EPOCH, provider: PROVIDER, runRef: RUN_REF },
    launch: {
      kind: "REFUSED", truthClass: "UNKNOWN", reasonCode: null, reasonLayer: null, exit: null,
      effectDigest: null, activationDigest: null, runtimeBindingDigest: null,
      quotedRuntimeDigest: null, freshRuntimeDigest: null, pinnedClosureDigest: null,
      observationDigest: null, startedAt: null, completedAt: DECIDED_AT,
    },
    declared: blind,
    observedModel: { modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind },
    terminal: "UNKNOWN",
    infrastructure: "NONE",
    tokens: {
      inputTokens: blind, outputTokens: blind, cacheCreationInputTokens: blind,
      cacheReadInputTokens: blind, coverage: "UNKNOWN",
    },
    steps: { turns: blind, coverage: "UNKNOWN" },
    sequence: { known: true, value: 3 },
    concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: blind, achieved: blind },
    observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
    observedEnd: null,
    usage,
    usageRefusals: [],
    upstreamRefusal: null,
    stdoutReceiptDigest: { known: true, value: "stdout-1" },
    stderrReceiptDigest: { known: true, value: "stderr-1" },
    recordDigest: "",
  } as unknown as ProviderRunRecord;
}

export function commitRun(
  store: SqliteEventStore, attemptRef: string, usage: readonly NormalizedMeasurement[],
  commandId = "cmd-run-1",
): void {
  const committed = commitProviderRunRecord(store, {
    correlationId: "corr-run-1",
    decidedAt: DECIDED_AT,
    // The reader binds telemetry to the SESSION that held the lease, not to the activation's
    // principal: `key.principalId` must be the attempt's ownerSessionRef or every record is
    // refused PROVIDER_RUN_BINDING_MISMATCH. Measured, not guessed.
    key: {
      commandId, principalId: LEASE_RECORD.ownerSessionRef, projectId: PROJECT_ID,
    } satisfies CommandDecisionKey,
    record: runRecord(attemptRef, usage),
    requestBytes: encoder.encode(`provider-run-${commandId}`),
  });
  if (!committed.ok) {
    throw new Error(`the provider-run fixture was refused: ${JSON.stringify(committed).slice(0, 200)}`);
  }
}

export const SETTLEMENT_CONTEXT = {
  commandId: "cmd-settle-1",
  correlationId: "corr-settle-1",
  decidedAt: DECIDED_AT,
  principalId: PRINCIPAL_ID,
} as const;

export const applySettlement = (
  store: SqliteEventStore, attemptRef: string, context = SETTLEMENT_CONTEXT,
): unknown => applyProviderUsageToBudget(store, { attemptRef, context, projectId: PROJECT_ID });
