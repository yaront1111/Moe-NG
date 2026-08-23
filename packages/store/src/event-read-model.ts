import {
  MAX_PAGE_DECODED_BYTES,
  MAX_PAGE_SIZE,
} from "./store-contracts.js";
import type {
  CommandReceipt,
  CursorPage,
  PendingOutboxMessage,
  StoredEvent,
} from "./store-contracts.js";
import { limitExceeded, requireIdentifier } from "./store-input.js";
import { requireRowString, requireStoredPositiveBigIntText } from "./store-rows.js";
import { EventReadQueryStore } from "./event-read-query.js";

export { RECEIPT_OUTBOX_QUERY } from "./event-read-materialization.js";

/**
 * Public bounded event read surface. It is a compatibility facade over the internal
 * decode, materialization, and query layers; it adds no query or decoding behavior.
 */
export class EventReadModelStore extends EventReadQueryStore {
  // Snapshot reads, not bare reads: assertAggregateTail issues two SELECTs
  // (head, then tail), and without one WAL snapshot a writer committing
  // between them would surface as a false STORE_CORRUPT on a healthy store.
  public getAggregateVersion(aggregateId: string): number {
    return this.readSnapshotOperation("read aggregate version", () => {
      this.assertCachedProjectBinding();
      return this.assertAggregateTail(requireIdentifier(aggregateId, "aggregateId"));
    });
  }

  public getCommandReceipt(commandId: string): CommandReceipt | null {
    return this.readSnapshotOperation("read command receipt", () => {
      this.assertReceiptReadBinding();
      const safeCommandId = requireIdentifier(commandId, "commandId");
      const receipt = this.loadReceipt(safeCommandId);
      if (receipt === null) {
        return null;
      }
      return Object.freeze({
        ...receipt,
        eventIds: Object.freeze([...receipt.eventIds]),
        outboxMessageIds: Object.freeze([...receipt.outboxMessageIds]),
      });
    });
  }

  public readEventHorizon(): bigint {
    return this.readSnapshotOperation("read event horizon", () => {
      this.assertCachedProjectBinding();
      const row = this.database.prepare(
        "SELECT CAST(COALESCE(MAX(global_position), 0) AS TEXT) AS event_horizon FROM domain_events",
      ).get() ?? {};
      return requireRowString(row, "event_horizon") === "0"
        ? 0n
        : requireStoredPositiveBigIntText(row, "event_horizon");
    });
  }

  /**
   * Payload-free discovery: every distinct aggregate id in the given id-prefix
   * range, sorted ascending. Whole by design rather than paged — distinct ids
   * are bounded by real aggregates, not by stored events — and never silently
   * truncated. See `aggregateIdPrefixEnumeration` for the range contract.
   */
  public enumerateAggregateIdsByPrefix(aggregateIdPrefix: string): readonly string[] {
    return this.aggregateIdPrefixEnumeration(aggregateIdPrefix);
  }

  public readEvents(aggregateId: string): readonly StoredEvent[] {
    const page = this.readAggregateEvents(aggregateId, 0, MAX_PAGE_SIZE);
    if (page.hasMore) {
      return limitExceeded(
        "aggregate exceeds a single bounded page; use readAggregateEvents with its cursor",
      );
    }
    return page.items;
  }

  public readAggregateEvents(
    aggregateId: string,
    afterAggregateSequence = 0,
    limit = 100,
    maxDecodedBytes = MAX_PAGE_DECODED_BYTES,
  ): CursorPage<StoredEvent, number> {
    return this.aggregateEventPage(
      aggregateId,
      afterAggregateSequence,
      limit,
      maxDecodedBytes,
    );
  }

  public readEventsAfter(
    afterGlobalPosition: bigint,
    limit = 100,
    maxDecodedBytes = MAX_PAGE_DECODED_BYTES,
  ): CursorPage<StoredEvent, bigint> {
    return this.globalEventPage(afterGlobalPosition, limit, maxDecodedBytes);
  }

  /**
   * Exact event-type matches over the same global cursor, so a caller selecting
   * one type no longer has to decode every event to find it. Deliberately adds
   * no validation of its own: `eventTypePage` already answers, and a second
   * layer here would change WHICH layer refuses a bad call.
   */
  public readEventsByTypeAfter(
    eventType: string,
    afterGlobalPosition: bigint,
    limit = 100,
    maxDecodedBytes = MAX_PAGE_DECODED_BYTES,
  ): CursorPage<StoredEvent, bigint> {
    return this.eventTypePage(eventType, afterGlobalPosition, limit, maxDecodedBytes);
  }

  public readPendingOutbox(limit = 100): readonly PendingOutboxMessage[] {
    const page = this.readPendingOutboxPage(0n, limit);
    if (page.hasMore) {
      return limitExceeded(
        "pending outbox exceeds a single bounded page; use readPendingOutboxPage with its cursor",
      );
    }
    return page.items;
  }

  public readPendingOutboxPage(
    afterOutboxPosition: bigint,
    limit = 100,
    maxDecodedBytes = MAX_PAGE_DECODED_BYTES,
  ): CursorPage<PendingOutboxMessage, bigint> {
    return this.pendingOutboxPage(afterOutboxPosition, limit, maxDecodedBytes);
  }
}
