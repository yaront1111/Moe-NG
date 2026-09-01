import { createHash } from "node:crypto";

import type { AdditionalLegFence } from "./decision-ledger-fences.js";
import {
  COMMAND_DECISION_IDENTITY_VERSION,
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_DECISION_RESULT_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  COMMAND_REJECTION_AUDIT_VERSION,
  COMMAND_REQUEST_IDENTITY_VERSION,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
} from "./store-contracts.js";
import type { CommandDecisionKey, ReplayRequestFence } from "./store-contracts.js";
import {
  INTERNAL_IDENTIFIER_PREFIX,
  LEG_RECEIPT_SEPARATOR,
  textEncoder,
} from "./store-internals.js";
import type {
  CommandEffectInput,
  RejectionAuditPayloadInput,
  SnapshotCommitInput,
  SnapshotExpectedVersionRequest,
  StoredCommandDecision,
} from "./store-internals.js";

function updateLengthFramed(
  hash: ReturnType<typeof createHash>,
  value: Uint8Array,
): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}

/**
 * The one implementation of the commit-request preimage. Both the receipt path and the replay
 * proof go through it, so the two can never drift into disagreeing about what a request is.
 */
function identifyCommandRequestParts(
  aggregateId: string,
  fencedVersion: number,
  commandBytes: Uint8Array,
): string {
  const hash = createHash("sha256");
  updateLengthFramed(hash, textEncoder.encode(COMMAND_REQUEST_IDENTITY_VERSION));
  updateLengthFramed(hash, textEncoder.encode(aggregateId));
  const expectedVersion = Buffer.allocUnsafe(8);
  expectedVersion.writeBigUInt64BE(BigInt(fencedVersion));
  updateLengthFramed(hash, expectedVersion);
  updateLengthFramed(hash, commandBytes);
  return hash.digest("hex");
}

export function identifyCommandRequest(input: SnapshotCommitInput): string {
  return identifyCommandRequestParts(
    input.aggregateId,
    input.expectedVersion,
    input.commandBytes,
  );
}

/**
 * The digest a decision WOULD carry in {@link CommandDecisionRecord.replayRequestSha256} had it
 * been decided with `requestBytes`. A replay path compares this against the stored value to prove
 * SAME BYTES before echoing an earlier decision's authority.
 *
 * Both co-inputs are read back off the decision itself — they are the primary leg's fence, which
 * every commit path copies verbatim into the record — so the request bytes are the only free
 * variable and equality here is byte equality. Nothing is recomputed from live state, so an
 * honest replay of a decision whose aggregates have since advanced still matches.
 */
export function identifyReplayRequest(
  decision: ReplayRequestFence,
  requestBytes: Uint8Array,
): string {
  return identifyCommandRequestParts(
    decision.targetAggregateId,
    decision.expectedVersion,
    requestBytes,
  );
}

function updateUnsignedInteger(hash: ReturnType<typeof createHash>, value: number): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  updateLengthFramed(hash, encoded);
}

function updateUnsignedBigInteger(
  hash: ReturnType<typeof createHash>,
  value: bigint,
): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(value);
  updateLengthFramed(hash, encoded);
}

function updateString(hash: ReturnType<typeof createHash>, value: string): void {
  updateLengthFramed(hash, textEncoder.encode(value));
}

export function identifyCorrelation(correlationId: string): string {
  const hash = createHash("sha256");
  updateString(hash, "moe-command-correlation/1");
  updateString(hash, correlationId);
  return hash.digest("hex");
}

export function identifyCommandDecisionId(key: CommandDecisionKey): string {
  const hash = createHash("sha256");
  updateString(hash, "moe-command-decision-key/1");
  updateString(hash, key.projectId);
  updateString(hash, key.principalId);
  updateString(hash, key.commandId);
  return hash.digest("hex");
}

/**
 * `additionalLegs` carries legs 1..N of a multi-leg decision and is EMPTY for
 * every single-aggregate request, so the preimage — and therefore the digest and
 * the recorded request identity version — is byte-identical to the pre-leg
 * scheme for every input that scheme accepted. Legs 1..N must be hashed here:
 * two decisions that share a primary leg but fence different secondary
 * aggregates are different requests, and replay must tell them apart.
 */
export function identifyExpectedVersionRequest(
  input: SnapshotExpectedVersionRequest,
  additionalLegs: readonly AdditionalLegFence[] = [],
): string {
  const hash = createHash("sha256");
  updateString(hash, COMMAND_DECISION_REQUEST_IDENTITY_VERSION);
  updateString(hash, input.key.projectId);
  updateString(hash, input.key.principalId);
  updateString(hash, input.key.commandId);
  updateString(hash, input.commandKind);
  updateString(hash, input.targetAggregateId);
  updateUnsignedInteger(hash, input.expectedVersion);
  updateLengthFramed(hash, input.requestBytes);
  for (const leg of additionalLegs) {
    updateString(hash, leg.aggregateId);
    updateUnsignedInteger(hash, leg.expectedVersion);
  }
  return hash.digest("hex");
}

export function identifyDecisionResult(resultBytes: Uint8Array): string {
  const hash = createHash("sha256");
  updateString(hash, COMMAND_DECISION_RESULT_VERSION);
  updateLengthFramed(hash, resultBytes);
  return hash.digest("hex");
}

export function internalReceiptCommandId(decisionId: string): string {
  return `${INTERNAL_IDENTIFIER_PREFIX}decision-effect:${decisionId}`;
}

/**
 * Leg 0 keeps the canonical receipt ID untouched, so a one-leg decision is
 * byte-identical to a single-aggregate one and the strict decision reader's
 * `receiptCommandId === internalReceiptCommandId(decisionId)` check still holds.
 */
export function legReceiptCommandId(decisionId: string, legIndex: number): string {
  const canonical = internalReceiptCommandId(decisionId);
  return legIndex === 0 ? canonical : `${canonical}${LEG_RECEIPT_SEPARATOR}${legIndex}`;
}

export function rejectionAuditAggregateId(decisionId: string): string {
  return `${INTERNAL_IDENTIFIER_PREFIX}command-rejection:${decisionId}`;
}

export function rejectionAuditEventId(decisionId: string): string {
  const hash = createHash("sha256");
  updateString(hash, "moe-command-rejection-event-id/1");
  updateString(hash, decisionId);
  return `${INTERNAL_IDENTIFIER_PREFIX}command-rejection-event:${hash.digest("hex")}`;
}

export function expectedVersionConflictResultBytes(
  expectedVersion: number,
  observedVersion: number,
): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      code: "EXPECTED_VERSION_CONFLICT",
      expectedVersion,
      observedVersion,
      version: COMMAND_DECISION_RESULT_VERSION,
    }),
  );
}

export function rejectionAuditPayload(input: RejectionAuditPayloadInput): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      auditVersion: COMMAND_REJECTION_AUDIT_VERSION,
      commandId: input.commandId,
      commandKind: input.commandKind,
      decisionId: input.decisionId,
      expectedVersion: input.expectedVersion,
      observedVersion: input.observedVersion,
      principalId: input.principalId,
      projectId: input.projectId,
      requestSha256: input.requestSha256,
      targetAggregateId: input.targetAggregateId,
    }),
  );
}

export function identifyCommandDecision(decision: StoredCommandDecision): string {
  const hash = createHash("sha256");
  updateString(hash, COMMAND_DECISION_IDENTITY_VERSION);
  updateUnsignedBigInteger(hash, decision.decisionPosition);
  updateString(hash, decision.decisionId);
  updateString(hash, decision.legRosterVersion);
  updateUnsignedInteger(hash, decision.legCount);
  updateString(hash, decision.legRosterSha256);
  updateString(hash, decision.recordVersion);
  updateString(hash, decision.key.projectId);
  updateString(hash, decision.key.principalId);
  updateString(hash, decision.key.commandId);
  updateString(hash, decision.commandKind);
  updateString(hash, decision.coverage);
  updateString(hash, decision.requestIdentityVersion);
  updateString(hash, decision.requestSha256);
  updateString(hash, decision.targetAggregateId);
  updateUnsignedInteger(hash, decision.expectedVersion);
  updateUnsignedInteger(hash, decision.observedVersion);
  updateString(hash, decision.effectDisposition);
  updateString(hash, decision.resultCode);
  updateString(hash, decision.resultVersion);
  updateString(hash, decision.resultSha256);
  updateLengthFramed(hash, decision.resultBytes);
  updateString(hash, decision.decidedAt);
  updateString(hash, decision.correlationSha256);
  updateString(hash, decision.receiptCommandId);
  updateString(hash, decision.auditEventId ?? "");
  updateString(
    hash,
    decision.previousVersion === null ? "" : String(decision.previousVersion),
  );
  updateString(
    hash,
    decision.currentVersion === null ? "" : String(decision.currentVersion),
  );
  updateUnsignedInteger(hash, decision.businessEventIds.length);
  updateUnsignedInteger(hash, decision.outboxMessageIds.length);
  updateString(hash, decision.effectIdentityVersion);
  updateString(hash, decision.effectSha256);
  return hash.digest("hex");
}

export function identifyCommandEffects(input: CommandEffectInput): string {
  const hash = createHash("sha256");
  updateString(hash, COMMAND_EFFECT_IDENTITY_VERSION);
  updateString(hash, input.aggregateId);
  updateString(hash, input.commandId);
  updateString(hash, input.committedAt);
  updateString(hash, input.requestSha256);
  updateUnsignedInteger(hash, input.previousVersion);
  updateUnsignedInteger(hash, input.currentVersion);
  updateUnsignedInteger(hash, input.events.length);
  for (const event of input.events) {
    updateUnsignedInteger(hash, event.aggregateSequence);
    updateUnsignedInteger(hash, event.commandEventIndex);
    updateUnsignedBigInteger(hash, event.globalPosition);
    updateString(hash, event.eventId);
    updateString(hash, event.eventType);
    updateString(hash, EVENT_RECORD_VERSION);
    updateString(hash, OPAQUE_PAYLOAD_CODEC_VERSION);
    updateLengthFramed(hash, event.payload);
    updateLengthFramed(hash, event.metadata);
    updateUnsignedInteger(hash, event.outbox.length);
    for (const message of event.outbox) {
      updateUnsignedInteger(hash, message.eventOutboxIndex);
      updateUnsignedBigInteger(hash, message.outboxPosition);
      updateString(hash, message.messageId);
      updateString(hash, message.topic);
      updateLengthFramed(hash, message.payload);
      updateLengthFramed(hash, message.headers);
    }
  }
  return hash.digest("hex");
}
