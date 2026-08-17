/**
 * Test support for the durable per-attempt resource authority.
 *
 * NOTHING HERE HAND-FORGES AN ACTIVATION. `parseActivationGrant` demands a hex64
 * grantId derived from the whole successor intent, so the only coherent
 * activation is the one `runEffectActivateCommand` commits. Every fixture below
 * drives that production ingress and then reads the store back, so the attemptRef
 * and effect intent the binder re-reads are genuinely durable rather than values
 * this suite wrote and immediately trusted.
 *
 * The row builder is deliberately spread-last so a sweep can add an EXTRA key or
 * replace one with a hostile value; `exactRecord` inside `parseRows` is what must
 * refuse those, not this helper.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import {
  PRINCIPAL_ID, PROJECT_ID, openHarnessStore, seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RESOURCE_RECORD_VERSION, deriveAttemptResourceAggregateId,
} from "./attempt-resource-authority-contracts.js";
import type { AttemptResourceBinding } from "./attempt-resource-authority-contracts.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";

const encoder = new TextEncoder();

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const SESSION_ID = "session-1";

export const ACTIVATION_COMMAND_ID = "cmd-resource-1";
export const ACTIVATION_CORRELATION_ID = "corr-resource";

const LEASE_RECORD = {
  authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT", leaseId: "lease-1",
  leaseToken: "token-1", monotonicObservation: 500, ownerSessionRef: SESSION_ID,
  serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;
const LEASE_PROOF = {
  authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: "token-1",
  ownerSessionRef: SESSION_ID,
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
const EFFECT_INTENT = {
  aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4, idempotencyKey: "idem-1",
  inputBinding: DIGEST, intentId: "intent-1", leaseBinding: LEASE_RECORD,
  predecessorCursor: "cursor-1", protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST, state: "PENDING", version: 0,
} as const;
const ACTIVATION_SECTION = {
  attempt: {
    aggregateId: "agg-1", attemptId: "attempt-1", intentId: "intent-1",
    state: "LAUNCH_REQUESTED", version: 0,
  },
  claim: {
    claimId: "claim-1", claimedAt: DECIDED_AT, intentId: "intent-1", lockIdentity: "lock-1",
    wrapperIdentity: "wrapper-1",
  },
  dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DIGEST, tombstone: null,
  wrapperIdentity: "wrapper-1",
} as const;

export const ACTIVATION_AGGREGATE = deriveActivationAggregateId(
  EFFECT_INTENT.aggregateId, EFFECT_INTENT.idempotencyKey);

/** The attempt id and effect intent id the COMMITTED activation carries, so a
 *  test can pin what the binder re-read instead of what it was handed. */
export const DURABLE_ATTEMPT_REF = "attempt-1";
export const DURABLE_EFFECT_INTENT_REF = "intent-1";

export function resourceRow(
  resourceId: string, overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    capacityUnits: 1, effectIntentRef: `intent-ref-${resourceId}`, epoch: 1, external: false,
    fenceable: true, resourceId, state: "ACTIVE", ...overrides,
  };
}

/** Three distinct ACTIVE members. `reserveProviderSlot` refuses any other state,
 *  so all-ACTIVE is the only set that can reach a bind through production. */
export const cleanRows = (): Record<string, unknown>[] =>
  [resourceRow("res-1"), resourceRow("res-2"), resourceRow("res-3")];

/** Passes the claim leg — `parseRows` does not dedupe and `reserveProviderSlot`
 *  only checks state — so the activation commits while the bind must refuse. */
export const duplicateRows = (): Record<string, unknown>[] =>
  [resourceRow("res-1"), resourceRow("res-1"), resourceRow("res-3")];

/** res-2 cannot be fenced, so `adapterFail` on a SIBLING must quarantine it
 *  rather than release capacity that may still be physically held. All three are
 *  ACTIVE, so the set is still bindable. */
export const failableRows = (): Record<string, unknown>[] =>
  [resourceRow("res-1"), resourceRow("res-2", { fenceable: false }), resourceRow("res-3")];

export function activationBytes(
  rows: readonly unknown[], commandId = ACTIVATION_COMMAND_ID,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId, correlationId: ACTIVATION_CORRELATION_ID, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: structuredClone(ACTIVATION_SECTION),
      budget: { admission: ADMISSION, gate: GATE, view: BUDGET_VIEW },
      effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: { dimension: "default", requestId: "req-1", rows, slotRef: "slot-1" },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

export interface ResourceFixture {
  readonly binding: AttemptResourceBinding;
  readonly store: SqliteEventStore;
}

/** A binding whose commandId is distinct from the ingress's, so a direct call
 *  cannot collide with the command key production already used. */
export const directBinding = (commandId: string): AttemptResourceBinding => Object.freeze({
  activationAggregateId: ACTIVATION_AGGREGATE, commandId,
  correlationId: ACTIVATION_CORRELATION_ID, principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
});

/** A committed activation over `rows`, plus the binding a direct caller uses. */
export function activatedWith(label: string, rows: readonly unknown[]): ResourceFixture {
  const root = mkdtempSync(join(tmpdir(), `moe-attempt-resource-${label}-`));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  const outcome = runEffectActivateCommand(store, activationBytes(rows));
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.code}`);
  return { binding: directBinding(`cmd-direct-${label}`), store };
}

/**
 * A well-formed record body, so a planted event can drift exactly ONE field.
 * A guard no honest fixture can reach is unguarded, and the only way to reach the
 * reader's replay guards is to plant bytes the production writer would never emit.
 */
export const resourceBody = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  attemptRef: DURABLE_ATTEMPT_REF, effectIntentRef: DURABLE_EFFECT_INTENT_REF, memberCount: 3,
  members: cleanRows(), projectId: PROJECT_ID,
  recordVersion: ATTEMPT_RESOURCE_RECORD_VERSION, truthClass: "DAEMON_VERIFIED", ...overrides,
});

/** Exactly what the production writer would emit for this value. */
export function canonicalBytes(value: unknown): Uint8Array {
  const encoded = encodeFoundationPayload(value);
  if (!encoded.ok) throw new Error(`fixture is not encodable: ${encoded.code}`);
  return encoded.bytes;
}

/** Decodes fine, but re-encodes to DIFFERENT bytes: `JSON.stringify` keeps
 *  insertion order while the canonical form sorts keys. */
export const driftedBytes = (value: Record<string, unknown>): Uint8Array =>
  encoder.encode(JSON.stringify(value));

/** Appends bytes the production writer would never emit, so a replay guard can
 *  be reached at all. `expectedVersion` is the head this plant expects. */
export function plantResourceEvent(
  store: SqliteEventStore, eventType: string, payload: Uint8Array, expectedVersion: number,
  label: string,
): void {
  store.commitExpectedVersionDecision({
    commandKind: "test.plant_attempt_resource", committedResultBytes: payload,
    correlationId: `plant-${label}`, decidedAt: DECIDED_AT,
    events: [{ eventId: `plant-${label}`, eventType, payload }],
    expectedVersion,
    key: { commandId: `plant-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: payload,
    targetAggregateId: deriveAttemptResourceAggregateId(ACTIVATION_AGGREGATE),
  });
}
