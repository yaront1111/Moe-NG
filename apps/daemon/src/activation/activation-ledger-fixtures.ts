/**
 * Shared fixtures for the activation-ledger suites.
 *
 * TEST TIER BY CONSTRUCTION, exactly like `work/work-race-fixtures.ts`: nothing
 * a published unit reaches, so it carries NO `.js` bridge and the bridge guard
 * in `runtime-entrypoint.test.ts` expects none.
 *
 * These live here rather than inside one suite because the codec, reader and
 * commit suites all need the same fully populated record, and a fixture copied
 * per suite drifts silently — the copies stop agreeing about what a legal
 * activation looks like, and each suite keeps passing against its own private
 * idea of one.
 */

import { createHash } from "node:crypto";

import { SUPERVISOR_ACTIVATION_VERSION, SUPERVISOR_EFFECT_PROTOCOL_VERSION } from "@moe/runner";
import { EVENT_RECORD_VERSION, OPAQUE_PAYLOAD_CODEC_VERSION } from "@moe/store";
import type { StoredEvent } from "@moe/store";

import { encodeActivationLedgerRecord } from "./activation-ledger-codec.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  ACTIVATION_LEDGER_RECORD_VERSION,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "./activation-ledger-contracts.js";

export const EFFECT_AGGREGATE = "effect-aggregate-1";
export const IDEMPOTENCY_KEY = "idem-key-1";
export const GRANT_ID = "grant-0001";
export const DERIVED = deriveActivationAggregateId(EFFECT_AGGREGATE, IDEMPOTENCY_KEY);

export function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A fully populated record: every field DoD 1 names, with production-legal states. */
export function record(overrides: Partial<ActivationLedgerRecord> = {}): ActivationLedgerRecord {
  return {
    activationDigest: digestOf("activation"),
    activationVersion: SUPERVISOR_ACTIVATION_VERSION,
    attempt: {
      aggregateId: EFFECT_AGGREGATE,
      attemptId: "attempt-1",
      intentId: "intent-1",
      state: "RUNNING",
      version: 8,
    },
    budgetReservation: {
      accountId: "account-1",
      admissionRef: "admission-1",
      attemptRef: "attempt-1",
      lines: [{ meter: "tokens", purpose: "EXECUTION", quantity: 10 }],
      neverStartedProofRef: null,
      reservationId: "reservation-1",
      state: "ACTIVATED",
      version: 3,
    },
    budgetView: {
      accountId: "account-1",
      meters: [{ available: 90, committed: 0, meter: "tokens", quarantined: 0, reserved: 10 }],
      state: "OPEN",
      version: 3,
    },
    effectIntent: {
      aggregateId: EFFECT_AGGREGATE,
      desiredState: "ACTIVE",
      expectedGraphEpoch: 4,
      idempotencyKey: IDEMPOTENCY_KEY,
      inputBinding: digestOf("input"),
      intentId: "intent-1",
      leaseBinding: {
        authorityHashRef: digestOf("authority"),
        bootId: "boot-1",
        epoch: 2,
        kind: "ASSIGNMENT",
        leaseId: "lease-1",
        leaseToken: "token-1",
        monotonicObservation: 1_000,
        ownerSessionRef: "session-1",
        serverWallDeadline: 2_000,
        state: "ACTIVE",
        version: 5,
      },
      predecessorCursor: "cursor-1",
      protocolVersion: SUPERVISOR_EFFECT_PROTOCOL_VERSION,
      runtimeObservationDigest: digestOf("runtime"),
      state: "ACTIVE",
      version: 7,
    },
    grant: {
      grantId: GRANT_ID,
      intentId: "intent-1",
      state: "UNUSED",
      version: 0,
      wrapperIdentity: "wrapper-1",
    },
    lease: {
      authorityHashRef: digestOf("authority"),
      bootId: "boot-1",
      epoch: 2,
      kind: "ASSIGNMENT",
      leaseId: "lease-1",
      leaseToken: "token-1",
      monotonicObservation: 1_000,
      ownerSessionRef: "session-1",
      serverWallDeadline: 2_000,
      state: "ACTIVE",
      version: 5,
    },
    predecessorAttemptVersion: 7,
    predecessorIntentVersion: 6,
    providerSlot: {
      attemptRef: "attempt-1",
      dimension: "provider:claude",
      requestId: "request-1",
      slotRef: "slot-1",
      state: "ACTIVE",
    },
    recordVersion: ACTIVATION_LEDGER_RECORD_VERSION,
    ...overrides,
  };
}

export function encodedBytes(value: ActivationLedgerRecord = record()): Uint8Array {
  const encoded = encodeActivationLedgerRecord(value);
  if (!encoded.ok) throw new Error(`fixture failed to encode: ${encoded.code}`);
  return encoded.bytes;
}

export function storedEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    aggregateId: DERIVED,
    aggregateSequence: 1,
    commandId: "command-1",
    committedAt: "2026-08-14T00:00:00.000Z",
    domainSchemaVersion: "moe-domain-schema/0",
    eventId: GRANT_ID,
    eventType: ACTIVATION_LEDGER_EVENT_TYPE,
    globalPosition: 1n,
    metadata: new Uint8Array(0),
    payload: encodedBytes(),
    payloadCodecVersion: OPAQUE_PAYLOAD_CODEC_VERSION,
    recordVersion: EVENT_RECORD_VERSION,
    requestSha256: digestOf("request"),
    ...overrides,
  };
}
