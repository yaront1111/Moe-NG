import {
  COMMAND_DECISION_IDENTITY_VERSION,
  COMMAND_DECISION_RECORD_VERSION,
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_DECISION_RESULT_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  DurableStoreError,
  EXPECTED_VERSION_DECISION_COVERAGE,
  MAX_PAGE_DECODED_BYTES,
} from "./store-contracts.js";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CursorPage,
} from "./store-contracts.js";
import {
  expectedVersionConflictResultBytes,
  identifyCommandDecision,
  identifyCommandDecisionId,
  identifyDecisionResult,
  internalReceiptCommandId,
  rejectionAuditAggregateId,
  rejectionAuditEventId,
  rejectionAuditPayload,
} from "./store-digests.js";
import {
  assertReadPageCursors,
  requirePageDecodedByteLimit,
  requireStoredDecodedByteCount,
  selectReadPagePrefix,
} from "./read-page-budget.js";
import { DECISION_DECODED_BYTES_SQL } from "./read-page-queries.js";
import {
  requireNonnegativeBigInt,
  requirePageLimit,
  snapshotCommandDecisionKey,
} from "./store-input.js";
import type { StoredCommandDecision } from "./store-internals.js";
import {
  bytesEqual,
  requireNullableStoredIdentifier,
  requireNullableStoredIntegerAtLeast,
  requireRowBytes,
  requireRowInteger,
  requireRowString,
  requireStoredIdentifier,
  requireStoredIntegerAtLeast,
  requireStoredPositiveBigIntText,
  requireStoredSha256,
  requireStoredTimestamp,
  toCommandDecisionRecord,
} from "./store-rows.js";
import { EventLedgerStore } from "./event-ledger.js";

export class DecisionReadModelStore extends EventLedgerStore {
  public getCommandDecision(rawKey: CommandDecisionKey): CommandDecisionRecord | null {
    return this.readOperation("read scoped command decision", () => {
      if (this.projectId === null) {
        throw new DurableStoreError(
          "PROJECT_SCOPE_REQUIRED",
          "scoped command decisions require a project-bound store handle",
        );
      }
      this.assertLiveProjectBinding();
      const key = snapshotCommandDecisionKey(rawKey);
      if (key.projectId !== this.projectId) {
        throw new DurableStoreError(
          "PROJECT_SCOPE_MISMATCH",
          "the command-decision key belongs to a different project",
        );
      }
      const decision = this.loadCommandDecisionByKey(key);
      return decision === null ? null : toCommandDecisionRecord(decision);
    });
  }

  public readCommandDecisionsAfter(
    afterDecisionPosition: bigint,
    limit = 100,
    maxDecodedBytes = MAX_PAGE_DECODED_BYTES,
  ): CursorPage<CommandDecisionRecord, bigint> {
    return this.readSnapshotOperation("read scoped command decisions", () => {
      if (this.projectId === null) {
        throw new DurableStoreError(
          "PROJECT_SCOPE_REQUIRED",
          "scoped command decisions require a project-bound store handle",
        );
      }
      this.assertLiveProjectBinding();
      const safeAfter = requireNonnegativeBigInt(
        afterDecisionPosition,
        "afterDecisionPosition",
      );
      const safeLimit = requirePageLimit(limit);
      const safeDecodedByteLimit = requirePageDecodedByteLimit(maxDecodedBytes);
      const candidateRows = this.database
        .prepare(`
          SELECT
            CAST(decisions.decision_position AS TEXT) AS decision_position,
            CAST(${DECISION_DECODED_BYTES_SQL} AS TEXT) AS decoded_bytes
          FROM command_decisions AS decisions
          WHERE decisions.decision_position > ?
          ORDER BY decisions.decision_position
          LIMIT ?
        `)
        .all(safeAfter, safeLimit + 1);
      const selection = selectReadPagePrefix(
        candidateRows.map((row) => ({
          cursor: requireStoredPositiveBigIntText(row, "decision_position"),
          decodedBytes: requireStoredDecodedByteCount(row),
        })),
        safeLimit,
        safeDecodedByteLimit,
      );
      const items = selection.selected.map(({ cursor: position }) => {
        const decision = this.loadCommandDecisionByPosition(position, true);
        if (decision === null) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            `command decision ${position} disappeared during its cursor read`,
          );
        }
        return toCommandDecisionRecord(decision);
      });
      assertReadPageCursors(
        items.map((decision) => decision.decisionPosition),
        selection.selected,
      );
      return this.page(
        items,
        selection.hasMore,
        items.length === 0 ? null : items.at(-1)!.decisionPosition,
      );
    });
  }

  protected loadCommandDecisionByKey(key: CommandDecisionKey): StoredCommandDecision | null {
    const row = this.database
      .prepare(`
        SELECT
          CAST(decision_position AS TEXT) AS decision_position,
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
        FROM command_decisions
        WHERE project_id = ? AND principal_id = ? AND command_id = ?
      `)
      .get(key.projectId, key.principalId, key.commandId);
    return row === undefined ? null : this.mapCommandDecision(row);
  }

  private loadCommandDecisionByPosition(
    decisionPosition: bigint,
    liveBindingAlreadyValidated = false,
  ): StoredCommandDecision | null {
    const row = this.database
      .prepare(`
        SELECT
          CAST(decision_position AS TEXT) AS decision_position,
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
        FROM command_decisions
        WHERE decision_position = ?
      `)
      .get(decisionPosition);
    return row === undefined
      ? null
      : this.mapCommandDecision(row, liveBindingAlreadyValidated);
  }

  private mapCommandDecision(
    row: Record<string, unknown>,
    liveBindingAlreadyValidated = false,
  ): StoredCommandDecision {
    const decisionPosition = requireStoredPositiveBigIntText(row, "decision_position");
    const key = Object.freeze({
      commandId: requireStoredIdentifier(row, "command_id"),
      principalId: requireStoredIdentifier(row, "principal_id"),
      projectId: requireStoredIdentifier(row, "project_id"),
    });
    if (this.projectId === null || key.projectId !== this.projectId) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command decision ${decisionPosition} is outside the database project binding`,
      );
    }
    const decisionId = requireStoredSha256(row, "decision_id");
    if (identifyCommandDecisionId(key) !== decisionId) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command decision ${decisionPosition} has a mismatched composite identity`,
      );
    }
    const recordVersion = this.requireStoredVersion(
      row,
      "record_version",
      COMMAND_DECISION_RECORD_VERSION,
    );
    const coverage = this.requireStoredVersion(
      row,
      "coverage",
      EXPECTED_VERSION_DECISION_COVERAGE,
    );
    const requestIdentityVersion = this.requireStoredVersion(
      row,
      "request_identity_version",
      COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
    );
    const requestSha256 = requireStoredSha256(row, "request_sha256");
    const commandKind = requireStoredIdentifier(row, "command_kind");
    const targetAggregateId = requireStoredIdentifier(row, "target_aggregate_id");
    const expectedVersion = requireStoredIntegerAtLeast(row, "expected_version", 0);
    const observedVersion = requireStoredIntegerAtLeast(row, "observed_version", 0);
    const rawDisposition = requireRowString(row, "effect_disposition");
    if (
      rawDisposition !== "EFFECTS_COMMITTED" &&
      rawDisposition !== "NO_BUSINESS_EFFECT"
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command decision ${decisionPosition} has an unsupported effect disposition`,
      );
    }
    const resultVersion = this.requireStoredVersion(
      row,
      "result_version",
      COMMAND_DECISION_RESULT_VERSION,
    );
    const resultBytes = requireRowBytes(row, "result_bytes");
    const resultSha256 = requireStoredSha256(row, "result_sha256");
    if (identifyDecisionResult(resultBytes) !== resultSha256) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command decision ${decisionPosition} result digest does not match`,
      );
    }
    const decidedAt = requireStoredTimestamp(row, "decided_at");
    const correlationSha256 = requireStoredSha256(row, "correlation_sha256");
    const receiptCommandId = requireStoredIdentifier(row, "receipt_command_id");
    const auditEventId = requireNullableStoredIdentifier(row, "audit_event_id");
    const previousVersion = requireNullableStoredIntegerAtLeast(
      row,
      "previous_version",
      0,
    );
    const currentVersion = requireNullableStoredIntegerAtLeast(row, "current_version", 1);
    const businessEventCount = requireStoredIntegerAtLeast(
      row,
      "business_event_count",
      0,
    );
    const outboxCount = requireStoredIntegerAtLeast(row, "outbox_count", 0);
    const effectIdentityVersion = this.requireStoredVersion(
      row,
      "effect_identity_version",
      COMMAND_EFFECT_IDENTITY_VERSION,
    );
    const effectSha256 = requireStoredSha256(row, "effect_sha256");
    const decisionIdentityVersion = this.requireStoredVersion(
      row,
      "decision_identity_version",
      COMMAND_DECISION_IDENTITY_VERSION,
    );
    const decisionSha256 = requireStoredSha256(row, "decision_sha256");
    if (receiptCommandId !== internalReceiptCommandId(decisionId)) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command decision ${decisionPosition} has a non-canonical internal receipt link`,
      );
    }
    const receipt = this.loadReceipt(
      receiptCommandId,
      true,
      liveBindingAlreadyValidated,
    );
    if (receipt === null || receipt.effectSha256 !== effectSha256) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command decision ${decisionPosition} does not match its effect receipt`,
      );
    }

    let stored: StoredCommandDecision;
    if (rawDisposition === "EFFECTS_COMMITTED") {
      if (
        requireRowString(row, "result_code") !== "EFFECTS_COMMITTED" ||
        auditEventId !== null ||
        previousVersion === null ||
        currentVersion === null ||
        observedVersion !== expectedVersion ||
        previousVersion !== expectedVersion ||
        receipt.aggregateId !== targetAggregateId ||
        receipt.previousVersion !== previousVersion ||
        receipt.currentVersion !== currentVersion ||
        receipt.eventIds.length !== businessEventCount ||
        receipt.outboxMessageIds.length !== outboxCount
      ) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `effectful command decision ${decisionPosition} has contradictory durable fields`,
        );
      }
      stored = {
        auditEventId: null,
        businessEventIds: receipt.eventIds,
        commandKind,
        correlationSha256,
        coverage,
        currentVersion,
        decidedAt,
        decisionId,
        decisionIdentityVersion,
        decisionPosition,
        decisionSha256,
        effectDisposition: "EFFECTS_COMMITTED",
        effectIdentityVersion,
        effectSha256,
        expectedVersion,
        key,
        observedVersion,
        outboxMessageIds: receipt.outboxMessageIds,
        previousVersion,
        receiptCommandId,
        recordVersion,
        requestIdentityVersion,
        requestSha256,
        resultBytes,
        resultCode: "EFFECTS_COMMITTED",
        resultSha256,
        resultVersion,
        targetAggregateId,
      };
    } else {
      const expectedAuditEventId = rejectionAuditEventId(decisionId);
      const expectedAuditAggregateId = rejectionAuditAggregateId(decisionId);
      const expectedResultBytes = expectedVersionConflictResultBytes(
        expectedVersion,
        observedVersion,
      );
      if (
        requireRowString(row, "result_code") !== "EXPECTED_VERSION_CONFLICT" ||
        auditEventId !== expectedAuditEventId ||
        previousVersion !== null ||
        currentVersion !== null ||
        observedVersion === expectedVersion ||
        businessEventCount !== 0 ||
        outboxCount !== 0 ||
        receipt.aggregateId !== expectedAuditAggregateId ||
        receipt.previousVersion !== 0 ||
        receipt.currentVersion !== 1 ||
        receipt.eventIds.length !== 1 ||
        receipt.eventIds[0] !== auditEventId ||
        receipt.outboxMessageIds.length !== 0 ||
        this.assertAggregateTail(expectedAuditAggregateId) !== 1 ||
        !bytesEqual(resultBytes, expectedResultBytes)
      ) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `no-business-effect command decision ${decisionPosition} has contradictory durable fields`,
        );
      }
      const auditRow = this.database
        .prepare(`
          SELECT aggregate_id, command_id, event_type, payload, metadata
          FROM domain_events
          WHERE event_id = ?
        `)
        .get(auditEventId);
      const expectedAuditPayload = rejectionAuditPayload({
        commandId: key.commandId,
        commandKind,
        decisionId,
        expectedVersion,
        observedVersion,
        principalId: key.principalId,
        projectId: key.projectId,
        requestSha256,
        targetAggregateId,
      });
      if (
        auditRow === undefined ||
        requireStoredIdentifier(auditRow, "aggregate_id") !== expectedAuditAggregateId ||
        requireStoredIdentifier(auditRow, "command_id") !== receiptCommandId ||
        requireStoredIdentifier(auditRow, "event_type") !==
          "command.expected-version-rejected" ||
        !bytesEqual(requireRowBytes(auditRow, "payload"), expectedAuditPayload) ||
        requireRowBytes(auditRow, "metadata").byteLength !== 0
      ) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `command decision ${decisionPosition} has a malformed rejection audit event`,
        );
      }
      stored = {
        auditEventId,
        businessEventIds: [],
        commandKind,
        correlationSha256,
        coverage,
        currentVersion: null,
        decidedAt,
        decisionId,
        decisionIdentityVersion,
        decisionPosition,
        decisionSha256,
        effectDisposition: "NO_BUSINESS_EFFECT",
        effectIdentityVersion,
        effectSha256,
        expectedVersion,
        key,
        observedVersion,
        outboxMessageIds: [],
        previousVersion: null,
        receiptCommandId,
        recordVersion,
        requestIdentityVersion,
        requestSha256,
        resultBytes,
        resultCode: "EXPECTED_VERSION_CONFLICT",
        resultSha256,
        resultVersion,
        targetAggregateId,
      };
    }

    if (identifyCommandDecision(stored) !== decisionSha256) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command decision ${decisionPosition} digest does not match its durable fields`,
      );
    }
    return stored;
  }

  protected validateAllCommandDecisions(): void {
    const rows = this.database
      .prepare("SELECT CAST(decision_position AS TEXT) AS decision_position FROM command_decisions ORDER BY decision_position")
      .all();
    for (const row of rows) {
      const decisionPosition = requireStoredPositiveBigIntText(row, "decision_position");
      if (this.loadCommandDecisionByPosition(decisionPosition) === null) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `command decision ${decisionPosition} disappeared during startup validation`,
        );
      }
    }
  }

  protected validateReservedDecisionNamespace(): void {
    const row = this.database
      .prepare(`
        SELECT count(*) AS violations
        FROM (
          SELECT receipts.command_id AS durable_id
          FROM command_receipts AS receipts
          LEFT JOIN command_decisions AS decisions
            ON decisions.receipt_command_id = receipts.command_id
          WHERE receipts.command_id GLOB 'moe-internal:*'
            AND (
              receipts.command_id NOT GLOB 'moe-internal:decision-effect:*'
              OR decisions.decision_position IS NULL
            )

          UNION ALL

          SELECT events.event_id AS durable_id
          FROM domain_events AS events
          LEFT JOIN command_decisions AS decisions
            ON decisions.receipt_command_id = events.command_id
          WHERE (
              events.command_id GLOB 'moe-internal:*'
              OR events.aggregate_id GLOB 'moe-internal:*'
              OR events.event_id GLOB 'moe-internal:*'
            )
            AND decisions.decision_position IS NULL

          UNION ALL

          SELECT heads.aggregate_id AS durable_id
          FROM aggregate_heads AS heads
          WHERE heads.aggregate_id GLOB 'moe-internal:*'
            AND NOT EXISTS (
              SELECT 1
              FROM command_receipts AS receipts
              INNER JOIN command_decisions AS decisions
                ON decisions.receipt_command_id = receipts.command_id
              WHERE receipts.aggregate_id = heads.aggregate_id
            )
        )
      `)
      .get();
    if (requireRowInteger(row ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "reserved command-decision ledger rows are missing their lifetime tombstone",
      );
    }
  }
}
