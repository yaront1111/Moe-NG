import type { StatementSync } from "node:sqlite";

import {
  COMMAND_DECISION_IDENTITY_VERSION,
  COMMAND_DECISION_RECORD_VERSION,
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_DECISION_RESULT_VERSION,
  DurableStoreError,
  EXPECTED_VERSION_DECISION_COVERAGE,
} from "./store-contracts.js";
import {
  identifyCommandDecision,
  identifyDecisionResult,
} from "./store-digests.js";
import { PENDING_EFFECT_SHA256 } from "./store-internals.js";
import type {
  SnapshotDecisionMetadata,
  SnapshotExpectedVersionRequest,
  StoredCommandDecision,
} from "./store-internals.js";
import { requireInsertedPosition } from "./store-rows.js";
import type {
  CanonicalDecisionEffect,
  DecisionIdentities,
} from "./decision-ledger-canonical.js";

const COMMAND_DECISION_INSERT_STATEMENT = `
        INSERT INTO command_decisions (
          project_id,
          principal_id,
          command_id,
          command_kind,
          decision_id,
          record_version,
          coverage,
          request_identity_version,
          request_sha256,
          target_aggregate_id,
          expected_version,
          observed_version,
          effect_disposition,
          result_code,
          result_version,
          result_bytes,
          result_sha256,
          decided_at,
          correlation_sha256,
          receipt_command_id,
          audit_event_id,
          previous_version,
          current_version,
          business_event_count,
          outbox_count,
          effect_identity_version,
          effect_sha256,
          decision_identity_version,
          decision_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ` as const;

const COMMAND_DECISION_FINALIZE_STATEMENT = `
          UPDATE command_decisions
          SET decision_sha256 = ?
          WHERE decision_position = ? AND decision_sha256 = ?
        ` as const;

export interface CanonicalDecisionInput {
  readonly effect: CanonicalDecisionEffect;
  readonly identities: DecisionIdentities;
  readonly metadata: SnapshotDecisionMetadata;
  readonly observedVersion: number;
  readonly request: SnapshotExpectedVersionRequest;
}

export interface DecisionRecordContext {
  readonly prepare: (sql: string) => StatementSync;
}

/**
 * Inserts the canonical decision with a pending digest, then compare-and-sets the
 * finalized digest. Must run inside the caller's already-open transaction.
 */
export function writeCanonicalDecision(
  ctx: DecisionRecordContext,
  input: CanonicalDecisionInput,
): StoredCommandDecision {
  const resultSha256 = identifyDecisionResult(input.effect.resultBytes);
  const decisionPosition = insertPendingDecision(ctx, input, resultSha256);
  const pendingDecision = pendingStoredDecision(input, resultSha256, decisionPosition);
  const decisionSha256 = identifyCommandDecision(pendingDecision);
  const finalized = ctx
    .prepare(COMMAND_DECISION_FINALIZE_STATEMENT)
    .run(decisionSha256, decisionPosition, PENDING_EFFECT_SHA256);
  if (finalized.changes !== 1) {
    throw new DurableStoreError(
      "STORE_UNAVAILABLE",
      "SQLite did not finalize the command decision digest",
    );
  }
  return { ...pendingDecision, decisionSha256 } as StoredCommandDecision;
}

function insertPendingDecision(
  ctx: DecisionRecordContext,
  input: CanonicalDecisionInput,
  resultSha256: string,
): bigint {
  const { effect, identities, metadata, observedVersion, request } = input;
  const insertDecision = ctx.prepare(COMMAND_DECISION_INSERT_STATEMENT);
  insertDecision.setReadBigInts(true);
  return requireInsertedPosition(
    insertDecision.run(
      request.key.projectId,
      request.key.principalId,
      request.key.commandId,
      request.commandKind,
      identities.decisionId,
      COMMAND_DECISION_RECORD_VERSION,
      EXPECTED_VERSION_DECISION_COVERAGE,
      COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
      identities.requestSha256,
      request.targetAggregateId,
      request.expectedVersion,
      observedVersion,
      effect.effectDisposition,
      effect.resultCode,
      COMMAND_DECISION_RESULT_VERSION,
      effect.resultBytes,
      resultSha256,
      metadata.decidedAt,
      metadata.correlationSha256,
      identities.receiptCommandId,
      effect.auditEventId,
      effect.previousVersion,
      effect.currentVersion,
      effect.businessEventIds.length,
      effect.outboxMessageIds.length,
      effect.receipt.effectIdentityVersion,
      effect.receipt.effectSha256,
      COMMAND_DECISION_IDENTITY_VERSION,
      PENDING_EFFECT_SHA256,
    ),
    "command decision position",
  );
}

function pendingStoredDecision(
  input: CanonicalDecisionInput,
  resultSha256: string,
  decisionPosition: bigint,
): StoredCommandDecision {
  const { effect, identities, metadata, observedVersion, request } = input;
  return {
    auditEventId: effect.auditEventId,
    businessEventIds: effect.businessEventIds,
    commandKind: request.commandKind,
    correlationSha256: metadata.correlationSha256,
    coverage: EXPECTED_VERSION_DECISION_COVERAGE,
    currentVersion: effect.currentVersion,
    decidedAt: metadata.decidedAt,
    decisionId: identities.decisionId,
    decisionIdentityVersion: COMMAND_DECISION_IDENTITY_VERSION,
    decisionPosition,
    decisionSha256: PENDING_EFFECT_SHA256,
    effectDisposition: effect.effectDisposition,
    effectIdentityVersion: effect.receipt.effectIdentityVersion,
    effectSha256: effect.receipt.effectSha256,
    expectedVersion: request.expectedVersion,
    key: request.key,
    observedVersion,
    outboxMessageIds: effect.outboxMessageIds,
    previousVersion: effect.previousVersion,
    receiptCommandId: identities.receiptCommandId,
    recordVersion: COMMAND_DECISION_RECORD_VERSION,
    // The accepted branch's receipt commits the caller's request bytes under the primary leg's
    // fence, so its request identity IS the replay proof. The rejected branch's receipt commits
    // the audit payload instead, which proves nothing about the request, so it offers null.
    replayRequestSha256:
      effect.effectDisposition === "EFFECTS_COMMITTED" ? effect.receipt.requestSha256 : null,
    requestIdentityVersion: COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
    requestSha256: identities.requestSha256,
    resultBytes: effect.resultBytes,
    resultCode: effect.resultCode,
    resultSha256,
    resultVersion: COMMAND_DECISION_RESULT_VERSION,
    targetAggregateId: request.targetAggregateId,
  } as StoredCommandDecision;
}
