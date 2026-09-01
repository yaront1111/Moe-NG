/**
 * Test support for the durable per-attempt resource authority.
 *
 * NOTHING HERE HAND-FORGES AN ACTIVATION, and nothing here COMMITS one either.
 * `parseActivationGrant` demands a hex64 grantId derived from the whole successor
 * intent, so the only coherent activation is the one `runEffectActivateCommand`
 * commits — and while policy cannot authoritatively ALLOW, that ingress refuses.
 * This module therefore carries NO policy precondition at all: it opens a bare
 * store and hands back the identities under test. Governor ruling
 * comment-937524c83a1945a5afae3ed8ac2405b9 forbids minting a committed activation
 * below the production admission path "by any name", so a suite that needs one
 * must change what it asserts rather than acquire it here.
 *
 * `activationBytes` REMAINS, and is bytes only — a command envelope, not an
 * authority. Its consumers drive `runEffectActivateCommand` themselves and own
 * their own worlds: resource-confirm-released-command.test.ts and
 * resource-reconcile-command.test.ts, both under
 * task-580ecb5cf8c2453da5507ed62789d8a7. Neither is edited by this module.
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
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { PRINCIPAL_ID, PROJECT_ID, openHarnessStore } from "../recovery/restore-test-harness.js";
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

/**
 * A REAL file-backed store holding NOTHING — no project, no policy decision, no
 * activation, no resource event — plus the binding a direct caller uses.
 *
 * WHAT THIS IS FOR, and what it can never be evidence of. It hosts absence and
 * corruption cases for the strict reader, and pre-authority refusal cases for the
 * binder and the applier: with the activation aggregate empty, `durableActivation`
 * refuses before a single row or report is admitted. It is NOT proof that a
 * resource set can be admitted, and no case may read a green result here as one.
 * A suite wanting an accepted bind needs a COMMITTED activation, which only
 * `runEffectActivateCommand` can produce and which production cannot currently
 * reach; manufacturing it here is exactly what the governor ruling forbids.
 *
 * The store is registered by `openHarnessStore`, so `cleanupRestoreHarnesses`
 * closes the handle — a held SQLite handle is the EPERM a retry cannot fix.
 */
export function openUnactivatedResourceFixture(label: string): ResourceFixture {
  // A generated case label is a TEST NAME, not a path: `:` and `"` are legal in
  // one and rejected by win32 in the other, and mkdtemp fails with ENOENT rather
  // than saying so. Only the directory is folded — the BINDING keeps the caller's
  // label verbatim, since two labels that differ only in punctuation must stay two
  // distinct command ids. `mkdtemp` appends its own random suffix, so a fold
  // cannot collide two roots.
  const path = label.replace(/[^\w.-]/gu, "_");
  const root = mkdtempSync(join(tmpdir(), `moe-attempt-resource-${path}-`));
  const store = openHarnessStore(join(root, "project.db"));
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
