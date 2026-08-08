import type {
  CommandReceipt, CommitInput, CommitResult, CursorPage, StoredEvent,
} from "@moe/store";

import { decodeStoredEnvelope } from "./coordination-codec.js";
import {
  COORDINATION_ENVELOPE_VERSION, COORDINATION_LIMITS, refuse,
} from "./coordination-contracts.js";
import type {
  CoordinationDelivery, CoordinationReadResult, CoordinationRefused,
} from "./coordination-contracts.js";
import {
  MAILBOX_EVENT_TYPE, ackAggregateId, decodeAck, decodeStamp,
} from "./coordination-mailbox-ids.js";
import type { MessageStamp } from "./coordination-mailbox-ids.js";

/** Structural view of the public durable-store seam. The mailbox depends on this shape, not
 *  on the store class, and never reaches into a package-internal projection or relay module. */
export interface CoordinationEventStore {
  commit(input: CommitInput): CommitResult;
  getAggregateVersion(aggregateId: string): number;
  getCommandReceipt(commandId: string): CommandReceipt | null;
  readAggregateEvents(
    aggregateId: string, afterAggregateSequence?: number, limit?: number,
    maxDecodedBytes?: number,
  ): CursorPage<StoredEvent, number>;
}

export interface MailboxEntry { readonly event: StoredEvent; readonly stamp: MessageStamp }

export interface MailboxReader {
  /** Last durably acknowledged sequence, or null when the ack record is unreadable. */
  ackCursor(mailbox: string): number | null;
  delivery(entry: MailboxEntry, now: number): CoordinationDelivery | null;
  entryAt(mailbox: string, sequence: number): MailboxEntry | null;
  page(mailbox: string, cursor: number, limit: number, now: number): CoordinationReadResult;
}

export function corruptRecord(): CoordinationRefused {
  return refuse(
    "COORDINATION_STORE_UNAVAILABLE", "STORE", "a durable mailbox record is unreadable",
  );
}

export function createMailboxReader(store: CoordinationEventStore): MailboxReader {
  /** Recovers ONLY the last durable ack event; the ack aggregate is never replayed in full. */
  function ackCursor(mailbox: string): number | null {
    const aggregate = ackAggregateId(mailbox);
    const version = store.getAggregateVersion(aggregate);
    if (version === 0) return 0;
    const last = store.readAggregateEvents(aggregate, version - 1, 1).items[0];
    if (last === undefined) return null;
    const record = decodeAck(last.payload);
    return record === null ? null : record.sequence;
  }

  function entryAt(mailbox: string, sequence: number): MailboxEntry | null {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
    const event = store.readAggregateEvents(mailbox, sequence - 1, 1).items[0];
    if (event === undefined || event.aggregateSequence !== sequence) return null;
    if (event.eventType !== MAILBOX_EVENT_TYPE) return null;
    const stamp = decodeStamp(event.metadata);
    return stamp === null ? null : { event, stamp };
  }

  /** An expired entry is reported, not filtered: it keeps its sequence so the consumer can
   *  acknowledge it explicitly instead of having the cursor silently skip a hole. */
  function delivery(entry: MailboxEntry, now: number): CoordinationDelivery | null {
    const envelope = decodeStoredEnvelope(entry.event.payload);
    if (envelope === null || envelope.messageId !== entry.stamp.messageId) return null;
    return Object.freeze({
      digest: entry.stamp.digest, envelope, envelopeVersion: COORDINATION_ENVELOPE_VERSION,
      expiresAt: entry.stamp.expiresAt, sentAt: entry.stamp.sentAt,
      sequence: entry.event.aggregateSequence,
      state: now >= entry.stamp.expiresAt ? ("EXPIRED" as const) : ("DELIVERABLE" as const),
    });
  }

  function gap(mailbox: string, version: number): CoordinationReadResult {
    const durable = ackCursor(mailbox);
    return durable === null ? corruptRecord() : Object.freeze({
      durableCursor: durable, mailboxSequence: version, outcome: "CURSOR_GAP" as const,
    });
  }

  function page(
    mailbox: string, cursor: number, limit: number, now: number,
  ): CoordinationReadResult {
    const version = store.getAggregateVersion(mailbox);
    if (cursor > version) return gap(mailbox, version);
    const raw = store.readAggregateEvents(mailbox, cursor, limit, COORDINATION_LIMITS.maxPageBytes);
    const items: CoordinationDelivery[] = [];
    let expected = cursor + 1;
    for (const event of raw.items) {
      if (event.aggregateSequence !== expected) return gap(mailbox, version);
      const stamp = decodeStamp(event.metadata);
      if (stamp === null || event.eventType !== MAILBOX_EVENT_TYPE) return corruptRecord();
      const built = delivery({ event, stamp }, now);
      if (built === null) return corruptRecord();
      items.push(built);
      expected += 1;
    }
    const last = items[items.length - 1];
    return Object.freeze({
      hasMore: raw.hasMore, items: Object.freeze(items),
      nextCursor: last === undefined ? null : last.sequence, outcome: "PAGE" as const,
    });
  }

  return Object.freeze({ ackCursor, delivery, entryAt, page });
}
