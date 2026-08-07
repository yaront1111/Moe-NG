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
import { EventReadQueryStore } from "./event-read-query.js";

export { RECEIPT_OUTBOX_QUERY } from "./event-read-materialization.js";

/**
 * Public bounded event read surface. It is a compatibility facade over the internal
 * decode, materialization, and query layers; it adds no query or decoding behavior.
 */
export class EventReadModelStore extends EventReadQueryStore {
  public getAggregateVersion(aggregateId: string): number {
    return this.readOperation("read aggregate version", () => {
      this.assertCachedProjectBinding();
      return this.assertAggregateTail(requireIdentifier(aggregateId, "aggregateId"));
    });
  }

  public getCommandReceipt(commandId: string): CommandReceipt | null {
    return this.readOperation("read command receipt", () => {
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
