import {
  DurableStoreError,
  MAX_PAGE_DECODED_BYTES,
} from "./store-contracts.js";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CursorPage,
} from "./store-contracts.js";
import { requirePageDecodedByteLimit } from "./read-page-budget.js";
import { decodeStoredCommandDecision } from "./decision-read-decode.js";
import type { DecisionDecodeContext } from "./decision-read-decode.js";
import { materializeDecisionCursorPage } from "./decision-read-pages.js";
import {
  COMMAND_DECISION_BY_KEY_QUERY,
  COMMAND_DECISION_BY_POSITION_QUERY,
  COMMAND_DECISION_CANDIDATE_PAGE_QUERY,
  COMMAND_DECISION_POSITION_SCAN_QUERY,
  REJECTION_AUDIT_EVENT_QUERY,
  RESERVED_DECISION_NAMESPACE_QUERY,
} from "./decision-read-sql.js";
import {
  requireNonnegativeBigInt,
  requirePageLimit,
  snapshotCommandDecisionKey,
} from "./store-input.js";
import type { StoredCommandDecision } from "./store-internals.js";
import {
  requireRowInteger,
  requireStoredPositiveBigIntText,
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
      const materialized = materializeDecisionCursorPage({
        candidates: this.database
          .prepare(COMMAND_DECISION_CANDIDATE_PAGE_QUERY)
          .all(safeAfter, safeLimit + 1),
        loadByPosition: (position) =>
          this.loadCommandDecisionByPosition(position, true),
        safeDecodedByteLimit,
        safeLimit,
      });
      return this.page(
        materialized.items,
        materialized.hasMore,
        materialized.nextCursor,
      );
    });
  }

  protected loadCommandDecisionByKey(key: CommandDecisionKey): StoredCommandDecision | null {
    const row = this.database
      .prepare(COMMAND_DECISION_BY_KEY_QUERY)
      .get(key.projectId, key.principalId, key.commandId);
    return row === undefined ? null : this.mapCommandDecision(row);
  }

  private loadCommandDecisionByPosition(
    decisionPosition: bigint,
    liveBindingAlreadyValidated = false,
  ): StoredCommandDecision | null {
    const row = this.database
      .prepare(COMMAND_DECISION_BY_POSITION_QUERY)
      .get(decisionPosition);
    return row === undefined
      ? null
      : this.mapCommandDecision(row, liveBindingAlreadyValidated);
  }

  private mapCommandDecision(
    row: Record<string, unknown>,
    liveBindingAlreadyValidated = false,
  ): StoredCommandDecision {
    return decodeStoredCommandDecision(
      row,
      this.decisionDecodeContext(),
      liveBindingAlreadyValidated,
    );
  }

  private decisionDecodeContext(): DecisionDecodeContext {
    return {
      assertAggregateTail: (aggregateId) => this.assertAggregateTail(aggregateId),
      loadReceipt: (commandId, validateAggregateTail, liveBindingAlreadyValidated) =>
        this.loadReceipt(commandId, validateAggregateTail, liveBindingAlreadyValidated),
      loadRejectionAuditRow: (auditEventId) =>
        this.database.prepare(REJECTION_AUDIT_EVENT_QUERY).get(auditEventId),
      projectId: this.projectId,
      requireStoredVersion: <const Version extends string>(
        row: Record<string, unknown>,
        column: string,
        expected: Version,
      ): Version => this.requireStoredVersion(row, column, expected),
    };
  }

  protected validateAllCommandDecisions(): void {
    const rows = this.database
      .prepare(COMMAND_DECISION_POSITION_SCAN_QUERY)
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
      .prepare(RESERVED_DECISION_NAMESPACE_QUERY)
      .get();
    if (requireRowInteger(row ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "reserved command-decision ledger rows are missing their lifetime tombstone",
      );
    }
  }
}
