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
  requireRowString,
  requireStoredIntegerAtLeast,
  requireStoredPositiveBigIntText,
} from "./store-rows.js";
import { EventReadMaterializationStore } from "./event-read-materialization.js";

/**
 * Exclusive upper bound of an aggregate-id prefix range, computed in CODE POINT
 * space. SQLite compares TEXT under BINARY collation — memcmp over UTF-8 bytes —
 * and code point order equals UTF-8 byte order, so bumping the prefix's last
 * code point yields the smallest string no id starting with the prefix can
 * reach. An increment landing in the surrogate gap continues at U+E000: no
 * well-formed string carries a lone surrogate, so nothing lives in between.
 * Trailing U+10FFFF code points cannot be bumped and are dropped instead; a
 * prefix made ONLY of them has no upper bound at all, and `null` is exact
 * there because any id sorting at or above such a prefix necessarily starts
 * with it.
 */
function aggregateIdPrefixUpperBound(prefix: string): string | null {
  const codePoints = [...prefix];
  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const code = codePoints[index]!.codePointAt(0)!;
    if (code < 0x10_ff_ff) {
      const bumped = code + 1 === 0xd8_00 ? 0xe0_00 : code + 1;
      return codePoints.slice(0, index).join("") + String.fromCodePoint(bumped);
    }
  }
  return null;
}

/**
 * The two phases of the event-type page. Exported for the EXPLAIN QUERY PLAN
 * contract case so the plan is pinned against the text production runs, not a
 * copy. Both carry `events.event_type = ?` as a bound parameter: filtering only
 * the candidate phase would materialize non-matching rows inside the position
 * window and desynchronize assertReadPageCursors.
 */
export const EVENT_TYPE_PAGE_CANDIDATE_QUERY = `
        SELECT
          CAST(events.global_position AS TEXT) AS global_position,
          CAST(${EVENT_DECODED_BYTES_SQL} AS TEXT) AS decoded_bytes
        FROM domain_events AS events
        ${STORED_EVENT_DECISION_JOIN}
        WHERE events.event_type = ? AND events.global_position > ?
        ORDER BY events.global_position
        LIMIT ?
        ` as const;

export const EVENT_TYPE_PAGE_MATERIALIZE_QUERY = `
        SELECT ${STORED_EVENT_SELECT_COLUMNS}
        FROM domain_events AS events
        ${STORED_EVENT_DECISION_JOIN}
        WHERE events.event_type = ?
          AND events.global_position > ?
          AND events.global_position <= ?
        ORDER BY events.global_position
        LIMIT ?
        ` as const;

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

  /**
   * Every DISTINCT aggregate id in one id-prefix range, sorted ascending in the
   * store's BINARY collation, touching aggregate-id bytes ONLY: no payload,
   * metadata or decision column is selected and no stored record is decoded, so
   * discovery works even over rows a materializing read would refuse.
   *
   * Deliberately NOT a cursor page and never truncated: the result is bounded
   * by DISTINCT REAL AGGREGATES, not by stored events, and an id-only row
   * carries none of the blob weight the byte-budgeted pages exist to meter.
   */
  protected aggregateIdPrefixEnumeration(aggregateIdPrefix: string): readonly string[] {
    return this.readSnapshotOperation("enumerate aggregate ids", () => {
      this.assertCachedProjectBinding();
      const safePrefix = requireIdentifier(aggregateIdPrefix, "aggregateIdPrefix");
      const upperBound = aggregateIdPrefixUpperBound(safePrefix);
      const rows = upperBound === null
        ? this.database
          .prepare(`
        SELECT DISTINCT events.aggregate_id
        FROM domain_events AS events
        WHERE events.aggregate_id >= ?
        ORDER BY events.aggregate_id
        `)
          .all(safePrefix)
        : this.database
          .prepare(`
        SELECT DISTINCT events.aggregate_id
        FROM domain_events AS events
        WHERE events.aggregate_id >= ? AND events.aggregate_id < ?
        ORDER BY events.aggregate_id
        `)
          .all(safePrefix, upperBound);
      return Object.freeze(rows.map((row) => requireRowString(row, "aggregate_id")));
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

  protected eventTypePage(
    eventType: string,
    afterGlobalPosition: bigint,
    limit = 100,
    maxDecodedBytes = MAX_PAGE_DECODED_BYTES,
  ): CursorPage<StoredEvent, bigint> {
    return this.readSnapshotOperation("read events by type", () => {
      this.assertCachedProjectBinding();
      const safeEventType = requireIdentifier(eventType, "eventType");
      const safeAfter = requireNonnegativeBigInt(
        afterGlobalPosition,
        "afterGlobalPosition",
      );
      const safeLimit = requirePageLimit(limit);
      const safeDecodedByteLimit = requirePageDecodedByteLimit(maxDecodedBytes);
      const candidateRows = this.database
        .prepare(EVENT_TYPE_PAGE_CANDIDATE_QUERY)
        .all(safeEventType, safeAfter, safeLimit + 1);
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
      // safeEventType is bound again here on purpose; see the query constants.
      const rows = this.database
        .prepare(EVENT_TYPE_PAGE_MATERIALIZE_QUERY)
        .all(safeEventType, safeAfter, lastPosition, selection.selected.length);
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
