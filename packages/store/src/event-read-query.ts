import { MAX_PAGE_DECODED_BYTES } from "./store-contracts.js";
import type {
  CursorPage,
  PendingOutboxMessage,
  StoredEvent,
} from "./store-contracts.js";
import {
  assertReadPageCursors,
  requirePageDecodedByteLimit,
  requireStoredDecodedByteCount,
  selectReadPagePrefix,
} from "./read-page-budget.js";
import {
  EVENT_DECODED_BYTES_SQL,
  OUTBOX_DECODED_BYTES_SQL,
  STORED_EVENT_DECISION_JOIN,
  STORED_EVENT_SELECT_COLUMNS,
} from "./read-page-queries.js";
import {
  requireIdentifier,
  requireNonnegativeBigInt,
  requirePageLimit,
  requireSafeNonnegativeInteger,
} from "./store-input.js";
import {
  requireStoredIntegerAtLeast,
  requireStoredPositiveBigIntText,
} from "./store-rows.js";
import { EventReadMaterializationStore } from "./event-read-materialization.js";

/**
 * Internal bounded-page query layer. Every page keeps its `limit + 1` size preflight
 * and its blob materialization on one deferred read snapshot, so a concurrent WAL
 * write cannot split them and a later excluded row is never decoded.
 */
export class EventReadQueryStore extends EventReadMaterializationStore {
  protected aggregateEventPage(
    aggregateId: string,
    afterAggregateSequence = 0,
    limit = 100,
    maxDecodedBytes = MAX_PAGE_DECODED_BYTES,
  ): CursorPage<StoredEvent, number> {
    return this.readSnapshotOperation("read aggregate events", () => {
      this.assertCachedProjectBinding();
      const safeAggregateId = requireIdentifier(aggregateId, "aggregateId");
      const safeAfter = requireSafeNonnegativeInteger(
        afterAggregateSequence,
        "afterAggregateSequence",
      );
      const safeLimit = requirePageLimit(limit);
      const safeDecodedByteLimit = requirePageDecodedByteLimit(maxDecodedBytes);
      const candidateRows = this.database
        .prepare(`
        SELECT
          events.aggregate_sequence,
          CAST(${EVENT_DECODED_BYTES_SQL} AS TEXT) AS decoded_bytes
        FROM domain_events AS events
        ${STORED_EVENT_DECISION_JOIN}
        WHERE events.aggregate_id = ? AND events.aggregate_sequence > ?
        ORDER BY events.aggregate_sequence
        LIMIT ?
        `)
        .all(safeAggregateId, safeAfter, safeLimit + 1);
      const selection = selectReadPagePrefix(
        candidateRows.map((row) => ({
          cursor: requireStoredIntegerAtLeast(row, "aggregate_sequence", 1),
          decodedBytes: requireStoredDecodedByteCount(row),
        })),
        safeLimit,
        safeDecodedByteLimit,
      );
      const lastSequence = selection.selected.at(-1)?.cursor;
      if (lastSequence === undefined) {
        return this.page<StoredEvent, number>([], false, null);
      }
      const rows = this.database
        .prepare(`
        SELECT ${STORED_EVENT_SELECT_COLUMNS}
        FROM domain_events AS events
        ${STORED_EVENT_DECISION_JOIN}
        WHERE events.aggregate_id = ?
          AND events.aggregate_sequence > ?
          AND events.aggregate_sequence <= ?
        ORDER BY events.aggregate_sequence
        LIMIT ?
        `)
        .all(safeAggregateId, safeAfter, lastSequence, selection.selected.length);
      const items = rows.map((row) => this.mapStoredEvent(row));
      assertReadPageCursors(
        items.map((event) => event.aggregateSequence),
        selection.selected,
      );
      return this.page(
        items,
        selection.hasMore,
        lastSequence,
      );
    });
  }

  protected globalEventPage(
    afterGlobalPosition: bigint,
    limit = 100,
    maxDecodedBytes = MAX_PAGE_DECODED_BYTES,
  ): CursorPage<StoredEvent, bigint> {
    return this.readSnapshotOperation("read global events", () => {
      this.assertCachedProjectBinding();
      const safeAfter = requireNonnegativeBigInt(
        afterGlobalPosition,
        "afterGlobalPosition",
      );
      const safeLimit = requirePageLimit(limit);
      const safeDecodedByteLimit = requirePageDecodedByteLimit(maxDecodedBytes);
      const candidateRows = this.database
        .prepare(`
        SELECT
          CAST(events.global_position AS TEXT) AS global_position,
          CAST(${EVENT_DECODED_BYTES_SQL} AS TEXT) AS decoded_bytes
        FROM domain_events AS events
        ${STORED_EVENT_DECISION_JOIN}
        WHERE events.global_position > ?
        ORDER BY events.global_position
        LIMIT ?
        `)
        .all(safeAfter, safeLimit + 1);
      const selection = selectReadPagePrefix(
        candidateRows.map((row) => ({
          cursor: requireStoredPositiveBigIntText(row, "global_position"),
          decodedBytes: requireStoredDecodedByteCount(row),
        })),
        safeLimit,
        safeDecodedByteLimit,
      );
      const lastPosition = selection.selected.at(-1)?.cursor;
      if (lastPosition === undefined) {
        return this.page<StoredEvent, bigint>([], false, null);
      }
      const rows = this.database
        .prepare(`
        SELECT ${STORED_EVENT_SELECT_COLUMNS}
        FROM domain_events AS events
        ${STORED_EVENT_DECISION_JOIN}
        WHERE events.global_position > ? AND events.global_position <= ?
        ORDER BY events.global_position
        LIMIT ?
        `)
        .all(safeAfter, lastPosition, selection.selected.length);
      const items = rows.map((row) => this.mapStoredEvent(row));
      assertReadPageCursors(
        items.map((event) => event.globalPosition),
        selection.selected,
      );
      return this.page(
        items,
        selection.hasMore,
        lastPosition,
      );
    });
  }

  protected pendingOutboxPage(
    afterOutboxPosition: bigint,
    limit = 100,
    maxDecodedBytes = MAX_PAGE_DECODED_BYTES,
  ): CursorPage<PendingOutboxMessage, bigint> {
    return this.readSnapshotOperation("read pending outbox", () => {
      this.assertCachedProjectBinding();
      const safeAfter = requireNonnegativeBigInt(
        afterOutboxPosition,
        "afterOutboxPosition",
      );
      const safeLimit = requirePageLimit(limit);
      const safeDecodedByteLimit = requirePageDecodedByteLimit(maxDecodedBytes);
      const candidateRows = this.database
        .prepare(`
        SELECT
          CAST(outbox_messages.outbox_position AS TEXT) AS outbox_position,
          CAST(${OUTBOX_DECODED_BYTES_SQL} AS TEXT) AS decoded_bytes
        FROM outbox_messages AS outbox_messages
        WHERE outbox_messages.delivered_at IS NULL
          AND outbox_messages.outbox_position > ?
        ORDER BY outbox_messages.outbox_position
        LIMIT ?
        `)
        .all(safeAfter, safeLimit + 1);
      const selection = selectReadPagePrefix(
        candidateRows.map((row) => ({
          cursor: requireStoredPositiveBigIntText(row, "outbox_position"),
          decodedBytes: requireStoredDecodedByteCount(row),
        })),
        safeLimit,
        safeDecodedByteLimit,
      );
      const lastPosition = selection.selected.at(-1)?.cursor;
      if (lastPosition === undefined) {
        return this.page<PendingOutboxMessage, bigint>([], false, null);
      }
      const rows = this.database
        .prepare(`
        SELECT
          CAST(outbox_messages.outbox_position AS TEXT) AS outbox_position,
          outbox_messages.message_id,
          outbox_messages.event_id,
          outbox_messages.topic,
          outbox_messages.payload,
          outbox_messages.headers,
          outbox_messages.created_at,
          outbox_messages.delivery_attempts
        FROM outbox_messages AS outbox_messages
        WHERE outbox_messages.delivered_at IS NULL
          AND outbox_messages.outbox_position > ?
          AND outbox_messages.outbox_position <= ?
        ORDER BY outbox_messages.outbox_position
        LIMIT ?
        `)
        .all(safeAfter, lastPosition, selection.selected.length);
      const items = rows.map((row) => this.mapOutboxMessage(row));
      assertReadPageCursors(
        items.map((message) => message.outboxPosition),
        selection.selected,
      );
      return this.page(
        items,
        selection.hasMore,
        lastPosition,
      );
    });
  }
}
