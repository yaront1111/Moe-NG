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
import { loadVerifiedDecisionLegRoster } from "./decision-leg-roster-read.js";

/**
 * Above this many cached decisions the cache is dropped whole and rebuilt on demand: a bound on
 * memory for a long-lived handle, never a correctness fence (every entry is re-derivable).
 */
const DECODED_DECISION_CACHE_LIMIT = 100_000;

export class DecisionReadModelStore extends EventLedgerStore {
  /**
   * Decoded decisions by position, for the paged read path only. A committed decision never
   * changes at its position (the ledger is append-only), so one decode plus sha verification is
   * good for the life of this handle. Without it every read model walked the whole ledger from
   * position 0 on every request, re-running two to three SELECTs, the receipt validation and the
   * hashing per decision each time: one control-room surface read cost ~14 s of CPU and the
   * daemon stopped answering its pollers (measured 2026-09-05). The startup validation scan and
   * the by-key read keep decoding fresh: they exist to prove the rows, not to serve them.
   */
  readonly #decodedByPosition = new Map<bigint, StoredCommandDecision>();

  // A snapshot read like its paged sibling below: decoding a decision loads
  // its receipt and validates the aggregate tail across several SELECTs, which
  // must all observe one WAL snapshot or a concurrent commit reads as corrupt.
  public getCommandDecision(rawKey: CommandDecisionKey): CommandDecisionRecord | null {
    return this.readSnapshotOperation("read scoped command decision", () => {
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
    if (liveBindingAlreadyValidated) {
      const cached = this.#decodedByPosition.get(decisionPosition);
      if (cached !== undefined) return cached;
    }
    const row = this.database
      .prepare(COMMAND_DECISION_BY_POSITION_QUERY)
      .get(decisionPosition);
    if (row === undefined) return null;
    const decoded = this.mapCommandDecision(row, liveBindingAlreadyValidated);
    if (liveBindingAlreadyValidated) {
      if (this.#decodedByPosition.size >= DECODED_DECISION_CACHE_LIMIT) {
        this.#decodedByPosition.clear();
      }
      this.#decodedByPosition.set(decisionPosition, decoded);
    }
    return decoded;
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
      loadDecisionLegRoster: (decisionId, liveBindingAlreadyValidated) =>
        loadVerifiedDecisionLegRoster(
          {
            loadReceipt: (commandId, validateAggregateTail, bindingValidated) =>
              this.loadReceipt(commandId, validateAggregateTail, bindingValidated),
            prepare: (sql) => this.database.prepare(sql),
          },
          decisionId,
          liveBindingAlreadyValidated,
        ),
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
