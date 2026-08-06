import type { DatabaseSync } from "node:sqlite";

import {
  COMMAND_DECISION_IDENTITY_VERSION,
  COMMAND_DECISION_RECORD_VERSION,
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_DECISION_RESULT_VERSION,
  DurableStoreError,
  EXPECTED_VERSION_DECISION_COVERAGE,
  IdempotencyConflictError,
} from "./store-contracts.js";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandDecisionResponse,
  CommandReceipt,
  CommitExpectedVersionDecisionInput,
  CommitInput,
  CommitResult,
  CursorPage,
  PendingOutboxMessage,
  StoredEvent,
  StoreHealth,
} from "./store-contracts.js";
import {
  expectedVersionConflictResultBytes,
  identifyCommandDecision,
  identifyCommandDecisionId,
  identifyCommandRequest,
  identifyDecisionResult,
  identifyExpectedVersionRequest,
  internalReceiptCommandId,
  rejectionAuditAggregateId,
  rejectionAuditEventId,
  rejectionAuditPayload,
} from "./store-digests.js";
import {
  invalidInput,
  snapshotCommittedProposal,
  snapshotDecisionMetadata,
  snapshotExpectedVersionRequest,
} from "./store-input.js";
import {
  EMPTY_BYTES,
  INTERNAL_IDENTIFIER_PREFIX,
  PENDING_EFFECT_SHA256,
} from "./store-internals.js";
import type {
  SnapshotCommittedProposal,
  SnapshotCommitInput,
  SnapshotDecisionMetadata,
  StoredCommandDecision,
  StoredCommitResult,
} from "./store-internals.js";
import {
  requireInsertedPosition,
  toCommandDecisionResponse,
} from "./store-rows.js";
import { DecisionReadModelStore } from "./decision-read-model.js";

class DecisionLedgerStore extends DecisionReadModelStore {
  public constructor(
    database: DatabaseSync,
    databasePath: string | null,
    durability: StoreHealth["durability"],
    projectId: string | null,
    writeProjectAsserted: boolean,
  ) {
    super(database, databasePath, durability, projectId, writeProjectAsserted);
  }

  public validateStartup(): void {
    this.validateAllReceipts();
    this.validateAllCommandDecisions();
    this.validateReservedDecisionNamespace();
  }

  public commitExpectedVersionDecision(
    rawInput: CommitExpectedVersionDecisionInput,
  ): CommandDecisionResponse {
    this.requireOpen();
    if (this.projectId === null || !this.writeProjectAsserted) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_REQUIRED",
        "scoped command decisions require an explicitly project-asserted store handle",
      );
    }
    const request = snapshotExpectedVersionRequest(rawInput);
    if (request.key.projectId !== this.projectId) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_MISMATCH",
        `the command belongs to project ${JSON.stringify(request.key.projectId)}, but this database is bound to ${JSON.stringify(this.projectId)}`,
      );
    }
    if (request.targetAggregateId.startsWith(INTERNAL_IDENTIFIER_PREFIX)) {
      return invalidInput("targetAggregateId uses Moe's reserved internal identifier namespace");
    }
    const requestSha256 = identifyExpectedVersionRequest(request);
    const decisionId = identifyCommandDecisionId(request.key);
    const receiptCommandId = internalReceiptCommandId(decisionId);
    const preflight = this.readOperation("preflight expected-version decision", () => {
      this.assertDurableProjectBinding();
      return {
        historical: this.loadCommandDecisionByKey(request.key),
        observedVersion: this.assertAggregateTail(request.targetAggregateId),
      };
    });
    if (preflight.historical !== null) {
      return this.reconcileHistoricalDecision(
        request.key,
        requestSha256,
        new DurableStoreError(
          "STORE_CORRUPT",
          "a command decision disappeared between preflight and locked replay",
        ),
      );
    }
    let metadata: SnapshotDecisionMetadata;
    try {
      metadata = snapshotDecisionMetadata(request.inputRecord);
    } catch (metadataError) {
      return this.reconcileHistoricalDecision(
        request.key,
        requestSha256,
        metadataError,
      );
    }
    let preflightProposal: SnapshotCommittedProposal | null = null;
    let proposalFailure: Readonly<{ readonly error: unknown }> | null = null;
    if (preflight.observedVersion === request.expectedVersion) {
      try {
        preflightProposal = snapshotCommittedProposal(
          request,
          receiptCommandId,
          metadata.decidedAt,
        );
      } catch (error) {
        proposalFailure = { error };
      }
    }

    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.normalizeOperationalError(error, "begin expected-version decision transaction");
    }
    let commitAttempted = false;
    try {
      this.assertDurableProjectBinding();
      const historical = this.loadCommandDecisionByKey(request.key);
      if (historical !== null) {
        if (historical.requestSha256 !== requestSha256) {
          throw new IdempotencyConflictError(request.key);
        }
        commitAttempted = true;
        this.database.exec("COMMIT");
        return toCommandDecisionResponse(historical, "REPLAYED");
      }

      const collidingDecision = this.database
        .prepare("SELECT 1 AS value FROM command_decisions WHERE decision_id = ?")
        .get(decisionId);
      if (collidingDecision !== undefined) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          "a scoped command decision ID collides with a different composite key",
        );
      }
      if (this.loadReceipt(receiptCommandId, false) !== null) {
        throw new DurableStoreError(
          "DURABLE_ID_CONFLICT",
          "the internal decision receipt ID is already occupied",
        );
      }

      const observedVersion = this.assertAggregateTail(request.targetAggregateId);
      let resultBytes: Uint8Array;
      let resultCode: CommandDecisionRecord["resultCode"];
      let effectDisposition: CommandDecisionRecord["effectDisposition"];
      let receipt: StoredCommitResult;
      let auditEventId: string | null;
      let previousVersion: number | null;
      let currentVersion: number | null;
      let businessEventIds: readonly string[];
      let outboxMessageIds: readonly string[];

      if (observedVersion === request.expectedVersion) {
        if (proposalFailure !== null) {
          throw proposalFailure.error;
        }
        const proposal =
          preflightProposal ??
          snapshotCommittedProposal(request, receiptCommandId, metadata.decidedAt);
        const receiptRequestSha256 = identifyCommandRequest(proposal.commitInput);
        receipt = this.writeCommitEffects(
          proposal.commitInput,
          receiptRequestSha256,
          observedVersion,
        );
        resultBytes = proposal.resultBytes;
        resultCode = "EFFECTS_COMMITTED";
        effectDisposition = "EFFECTS_COMMITTED";
        auditEventId = null;
        previousVersion = receipt.previousVersion;
        currentVersion = receipt.currentVersion;
        businessEventIds = receipt.eventIds;
        outboxMessageIds = receipt.outboxMessageIds;
      } else {
        const auditAggregateId = rejectionAuditAggregateId(decisionId);
        auditEventId = rejectionAuditEventId(decisionId);
        if (this.assertAggregateTail(auditAggregateId) !== 0) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            "the internal rejection-audit aggregate is already occupied",
          );
        }
        const auditPayload = rejectionAuditPayload({
          commandId: request.key.commandId,
          commandKind: request.commandKind,
          decisionId,
          expectedVersion: request.expectedVersion,
          observedVersion,
          principalId: request.key.principalId,
          projectId: request.key.projectId,
          requestSha256,
          targetAggregateId: request.targetAggregateId,
        });
        const auditCommitInput: SnapshotCommitInput = {
          aggregateId: auditAggregateId,
          commandBytes: auditPayload,
          commandId: receiptCommandId,
          committedAt: metadata.decidedAt,
          events: [
            {
              eventId: auditEventId,
              eventType: "command.expected-version-rejected",
              metadata: EMPTY_BYTES,
              outbox: [],
              payload: auditPayload,
            },
          ],
          expectedVersion: 0,
        };
        receipt = this.writeCommitEffects(
          auditCommitInput,
          identifyCommandRequest(auditCommitInput),
          0,
        );
        resultBytes = expectedVersionConflictResultBytes(
          request.expectedVersion,
          observedVersion,
        );
        resultCode = "EXPECTED_VERSION_CONFLICT";
        effectDisposition = "NO_BUSINESS_EFFECT";
        previousVersion = null;
        currentVersion = null;
        businessEventIds = [];
        outboxMessageIds = [];
      }

      const resultSha256 = identifyDecisionResult(resultBytes);
      const insertDecision = this.database.prepare(`
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
      `);
      insertDecision.setReadBigInts(true);
      const decisionPosition = requireInsertedPosition(
        insertDecision.run(
          request.key.projectId,
          request.key.principalId,
          request.key.commandId,
          request.commandKind,
          decisionId,
          COMMAND_DECISION_RECORD_VERSION,
          EXPECTED_VERSION_DECISION_COVERAGE,
          COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
          requestSha256,
          request.targetAggregateId,
          request.expectedVersion,
          observedVersion,
          effectDisposition,
          resultCode,
          COMMAND_DECISION_RESULT_VERSION,
          resultBytes,
          resultSha256,
          metadata.decidedAt,
          metadata.correlationSha256,
          receiptCommandId,
          auditEventId,
          previousVersion,
          currentVersion,
          businessEventIds.length,
          outboxMessageIds.length,
          receipt.effectIdentityVersion,
          receipt.effectSha256,
          COMMAND_DECISION_IDENTITY_VERSION,
          PENDING_EFFECT_SHA256,
        ),
        "command decision position",
      );

      const pendingDecision = {
        auditEventId,
        businessEventIds,
        commandKind: request.commandKind,
        correlationSha256: metadata.correlationSha256,
        coverage: EXPECTED_VERSION_DECISION_COVERAGE,
        currentVersion,
        decidedAt: metadata.decidedAt,
        decisionId,
        decisionIdentityVersion: COMMAND_DECISION_IDENTITY_VERSION,
        decisionPosition,
        decisionSha256: PENDING_EFFECT_SHA256,
        effectDisposition,
        effectIdentityVersion: receipt.effectIdentityVersion,
        effectSha256: receipt.effectSha256,
        expectedVersion: request.expectedVersion,
        key: request.key,
        observedVersion,
        outboxMessageIds,
        previousVersion,
        receiptCommandId,
        recordVersion: COMMAND_DECISION_RECORD_VERSION,
        requestIdentityVersion: COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
        requestSha256,
        resultBytes,
        resultCode,
        resultSha256,
        resultVersion: COMMAND_DECISION_RESULT_VERSION,
        targetAggregateId: request.targetAggregateId,
      } as StoredCommandDecision;
      const decisionSha256 = identifyCommandDecision(pendingDecision);
      const finalized = this.database
        .prepare(`
          UPDATE command_decisions
          SET decision_sha256 = ?
          WHERE decision_position = ? AND decision_sha256 = ?
        `)
        .run(decisionSha256, decisionPosition, PENDING_EFFECT_SHA256);
      if (finalized.changes !== 1) {
        throw new DurableStoreError(
          "STORE_UNAVAILABLE",
          "SQLite did not finalize the command decision digest",
        );
      }
      const stored = { ...pendingDecision, decisionSha256 } as StoredCommandDecision;

      commitAttempted = true;
      this.database.exec("COMMIT");
      return toCommandDecisionResponse(stored, "DECIDED");
    } catch (error) {
      const transactionEndedAfterCommitAttempt = commitAttempted && !this.database.isTransaction;
      let rollbackError: unknown;
      if (this.database.isTransaction) {
        try {
          this.database.exec("ROLLBACK");
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
        }
      }
      if (transactionEndedAfterCommitAttempt || rollbackError !== undefined) {
        const causes = rollbackError === undefined ? [error] : [error, rollbackError];
        this.poison();
        throw new DurableStoreError(
          "OUTCOME_UNKNOWN",
          "the scoped command decision could not be proven; reopen and reconcile by composite key",
          { cause: new AggregateError(causes) },
        );
      }
      if (error instanceof DurableStoreError) {
        throw error;
      }
      throw this.normalizeOperationalError(error, "commit expected-version decision");
    }
  }

  private reconcileHistoricalDecision(
    key: CommandDecisionKey,
    requestSha256: string,
    missingDecisionError: unknown,
  ): CommandDecisionResponse {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.normalizeOperationalError(error, "begin replay reconciliation transaction");
    }
    try {
      this.assertDurableProjectBinding();
      const historical = this.loadCommandDecisionByKey(key);
      if (historical !== null && historical.requestSha256 !== requestSha256) {
        throw new IdempotencyConflictError(key);
      }
      this.database.exec("ROLLBACK");
      if (historical !== null) {
        return toCommandDecisionResponse(historical, "REPLAYED");
      }
      throw missingDecisionError;
    } catch (error) {
      if (this.database.isTransaction) {
        try {
          this.database.exec("ROLLBACK");
        } catch (rollbackError) {
          this.poison();
          throw new DurableStoreError(
            "STORE_UNAVAILABLE",
            "replay reconciliation could not release its read lock",
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
      }
      if (error instanceof DurableStoreError) {
        throw error;
      }
      throw this.normalizeOperationalError(error, "reconcile command replay");
    }
  }

}

export interface DecisionLedgerCore {
  readonly close: () => void;
  readonly commit: (input: CommitInput) => CommitResult;
  readonly commitExpectedVersionDecision: (
    input: CommitExpectedVersionDecisionInput,
  ) => CommandDecisionResponse;
  readonly getAggregateVersion: (aggregateId: string) => number;
  readonly getCommandDecision: (key: CommandDecisionKey) => CommandDecisionRecord | null;
  readonly getCommandReceipt: (commandId: string) => CommandReceipt | null;
  readonly getHealth: () => StoreHealth;
  readonly readAggregateEvents: (
    aggregateId: string,
    afterAggregateSequence?: number,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<StoredEvent, number>;
  readonly readCommandDecisionsAfter: (
    afterDecisionPosition: bigint,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<CommandDecisionRecord, bigint>;
  readonly readEvents: (aggregateId: string) => readonly StoredEvent[];
  readonly readEventsAfter: (
    afterGlobalPosition: bigint,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<StoredEvent, bigint>;
  readonly readPendingOutbox: (limit?: number) => readonly PendingOutboxMessage[];
  readonly readPendingOutboxPage: (
    afterOutboxPosition: bigint,
    limit?: number,
    maxDecodedBytes?: number,
  ) => CursorPage<PendingOutboxMessage, bigint>;
  readonly validateStartup: () => void;
}

export function createDecisionLedgerCore(
  database: DatabaseSync,
  databasePath: string | null,
  durability: StoreHealth["durability"],
  projectId: string | null,
  writeProjectAsserted: boolean,
): DecisionLedgerCore {
  const ledger = new DecisionLedgerStore(
    database,
    databasePath,
    durability,
    projectId,
    writeProjectAsserted,
  );
  return Object.freeze({
    close: () => ledger.close(),
    commit: (input: CommitInput) => ledger.commit(input),
    commitExpectedVersionDecision: (input: CommitExpectedVersionDecisionInput) =>
      ledger.commitExpectedVersionDecision(input),
    getAggregateVersion: (aggregateId: string) => ledger.getAggregateVersion(aggregateId),
    getCommandDecision: (key: CommandDecisionKey) => ledger.getCommandDecision(key),
    getCommandReceipt: (commandId: string) => ledger.getCommandReceipt(commandId),
    getHealth: () => ledger.getHealth(),
    readAggregateEvents: (
      aggregateId: string,
      afterAggregateSequence?: number,
      limit?: number,
      maxDecodedBytes?: number,
    ) =>
      ledger.readAggregateEvents(
        aggregateId,
        afterAggregateSequence,
        limit,
        maxDecodedBytes,
      ),
    readCommandDecisionsAfter: (
      afterDecisionPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readCommandDecisionsAfter(afterDecisionPosition, limit, maxDecodedBytes),
    readEvents: (aggregateId: string) => ledger.readEvents(aggregateId),
    readEventsAfter: (
      afterGlobalPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readEventsAfter(afterGlobalPosition, limit, maxDecodedBytes),
    readPendingOutbox: (limit?: number) => ledger.readPendingOutbox(limit),
    readPendingOutboxPage: (
      afterOutboxPosition: bigint,
      limit?: number,
      maxDecodedBytes?: number,
    ) => ledger.readPendingOutboxPage(afterOutboxPosition, limit, maxDecodedBytes),
    validateStartup: () => ledger.validateStartup(),
  });
}
