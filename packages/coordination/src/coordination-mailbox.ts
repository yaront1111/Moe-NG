import type { CommandReceipt, CommitInput, CommitResult } from "@moe/store";

import { COORDINATION_LIMITS, refuse } from "./coordination-contracts.js";
import type {
  CoordinationAckResult, CoordinationAddress, CoordinationDelivery, CoordinationEnvelope,
  CoordinationReadResult, CoordinationRefused, CoordinationSendResult,
} from "./coordination-contracts.js";
import {
  MAILBOX_ACK_EVENT_TYPE, MAILBOX_EVENT_TYPE, MAILBOX_TOPIC, ackAggregateId, ackCommandId,
  ackEventId, encodeAck, encodeStamp, mailboxAggregateId, mapStoreError, messageEventId,
  outboxMessageId, sendCommandId, storeErrorCode, toCommitTimestamp,
} from "./coordination-mailbox-ids.js";
import type { MessageStamp } from "./coordination-mailbox-ids.js";
import { corruptRecord, createMailboxReader } from "./coordination-mailbox-reads.js";
import type { CoordinationEventStore, MailboxReader } from "./coordination-mailbox-reads.js";

export type { CoordinationEventStore } from "./coordination-mailbox-reads.js";

export interface MailboxSendInput {
  readonly canonicalBytes: Uint8Array; readonly digest: string;
  readonly envelope: CoordinationEnvelope; readonly now: number;
}
export interface MailboxReadInput {
  readonly limit: number; readonly mailbox: CoordinationAddress; readonly now: number;
}
export interface MailboxReplayInput extends MailboxReadInput { readonly fromSequence: number }
export interface MailboxAckInput {
  readonly digest: string; readonly mailbox: CoordinationAddress; readonly messageId: string;
  readonly now: number; readonly sequence: number;
}
export interface MailboxLookupInput {
  readonly mailbox: CoordinationAddress; readonly messageId: string; readonly now: number;
}

export interface DurableMailbox {
  acknowledge(input: MailboxAckInput): CoordinationAckResult;
  /** Resolves one durable message by its bounded id through the deterministic command slot. */
  lookup(input: MailboxLookupInput): CoordinationDelivery | null;
  read(input: MailboxReadInput): CoordinationReadResult;
  replay(input: MailboxReplayInput): CoordinationReadResult;
  send(input: MailboxSendInput): CoordinationSendResult;
}

const CONTENDED = Symbol("coordination-expected-version-contended");

function guard<Result>(run: () => Result | CoordinationRefused): Result | CoordinationRefused {
  try {
    return run();
  } catch (error) {
    return mapStoreError(error);
  }
}

export function createDurableMailbox(store: CoordinationEventStore): DurableMailbox {
  const reader: MailboxReader = createMailboxReader(store);

  function commitOnce(input: CommitInput): CommitResult | CoordinationRefused | typeof CONTENDED {
    try {
      return store.commit(input);
    } catch (error) {
      return storeErrorCode(error) === "EXPECTED_VERSION_CONFLICT"
        ? CONTENDED : mapStoreError(error);
    }
  }

  /** A durable receipt for this command slot means the SAME message id already landed. Only
   *  an event id match proves the bytes were identical; anything else is a real conflict. */
  function replayed(
    mailbox: string, receipt: CommandReceipt, eventId: string, digest: string,
  ): CoordinationSendResult {
    if (!receipt.eventIds.includes(eventId)) {
      return refuse(
        "COORDINATION_IDEMPOTENCY_CONFLICT", "STORE",
        "the message id was reused for different canonical bytes",
      );
    }
    const entry = reader.entryAt(mailbox, receipt.currentVersion);
    if (entry === null || entry.stamp.digest !== digest) return corruptRecord();
    return Object.freeze({
      digest, expiresAt: entry.stamp.expiresAt, messageId: entry.stamp.messageId,
      outcome: "DEDUPLICATED" as const, sentAt: entry.stamp.sentAt,
      sequence: entry.event.aggregateSequence,
    });
  }

  function overloaded(mailbox: string, version: number): CoordinationRefused | null {
    const durable = reader.ackCursor(mailbox);
    if (durable === null) return corruptRecord();
    return version - durable >= COORDINATION_LIMITS.maxOutstandingMessages
      ? refuse(
        "COORDINATION_MAILBOX_FULL", "MAILBOX", "the mailbox holds its maximum outstanding depth",
      )
      : null;
  }

  function enqueue(
    mailbox: string, commandId: string, eventId: string, committedAt: string,
    input: MailboxSendInput, stamp: MessageStamp,
  ): CoordinationSendResult {
    for (let attempt = 0; attempt < COORDINATION_LIMITS.maxSendAttempts; attempt += 1) {
      const expectedVersion = store.getAggregateVersion(mailbox);
      const full = overloaded(mailbox, expectedVersion);
      if (full !== null) return full;
      const outcome = commitOnce({
        aggregateId: mailbox, commandBytes: input.canonicalBytes, commandId, committedAt,
        events: [{
          eventId, eventType: MAILBOX_EVENT_TYPE, metadata: encodeStamp(stamp),
          outbox: [{
            messageId: outboxMessageId(eventId), payload: input.canonicalBytes,
            topic: MAILBOX_TOPIC,
          }],
          payload: input.canonicalBytes,
        }],
        expectedVersion,
      });
      if (outcome === CONTENDED) continue;
      if ("outcome" in outcome) {
        if (outcome.code !== "COORDINATION_IDEMPOTENCY_CONFLICT") return outcome;
        const receipt = store.getCommandReceipt(commandId);
        return receipt === null ? outcome : replayed(mailbox, receipt, eventId, input.digest);
      }
      return Object.freeze({
        digest: stamp.digest, expiresAt: stamp.expiresAt, messageId: stamp.messageId,
        outcome: outcome.disposition === "REPLAYED"
          ? ("DEDUPLICATED" as const) : ("ACCEPTED" as const),
        sentAt: stamp.sentAt, sequence: outcome.currentVersion,
      });
    }
    return refuse(
      "COORDINATION_STORE_BUSY", "STORE", "the mailbox stayed contended across every attempt",
    );
  }

  function send(input: MailboxSendInput): CoordinationSendResult {
    const mailbox = mailboxAggregateId(input.envelope.recipient);
    const commandId = sendCommandId(mailbox, input.envelope.messageId);
    const eventId = messageEventId(mailbox, input.envelope.messageId, input.canonicalBytes);
    const receipt = store.getCommandReceipt(commandId);
    if (receipt !== null) return replayed(mailbox, receipt, eventId, input.digest);
    const committedAt = toCommitTimestamp(input.now);
    if (committedAt === null) {
      return refuse("COORDINATION_INPUT_INVALID", "MAILBOX", "the server clock is not usable");
    }
    const expiresAt = input.now + input.envelope.ttlMilliseconds;
    if (expiresAt <= input.now) {
      return refuse(
        "COORDINATION_MESSAGE_EXPIRED", "MAILBOX", "the message expires at or before its send",
      );
    }
    return enqueue(mailbox, commandId, eventId, committedAt, input, {
      digest: input.digest, expiresAt, messageId: input.envelope.messageId, sentAt: input.now,
    });
  }

  function acknowledge(input: MailboxAckInput): CoordinationAckResult {
    const mailbox = mailboxAggregateId(input.mailbox);
    const entry = reader.entryAt(mailbox, input.sequence);
    if (entry === null || entry.stamp.messageId !== input.messageId
      || entry.stamp.digest !== input.digest) {
      return refuse(
        "COORDINATION_ACK_UNKNOWN_MESSAGE", "MAILBOX",
        "no durable message matches that sequence, id, and digest",
      );
    }
    const committedAt = toCommitTimestamp(input.now);
    if (committedAt === null) {
      return refuse("COORDINATION_INPUT_INVALID", "MAILBOX", "the server clock is not usable");
    }
    return persistAck(mailbox, input, committedAt);
  }

  function regressed(): CoordinationAckResult {
    return refuse(
      "COORDINATION_ACK_REGRESSION", "MAILBOX",
      "the acknowledged sequence is not ahead of the durable cursor",
    );
  }

  /**
   * The monotonicity check is re-read on EVERY attempt, not once before the loop. A second
   * writer that lands a higher ack while this one is retrying must not be walked backwards.
   */
  function persistAck(
    mailbox: string, input: MailboxAckInput, committedAt: string,
  ): CoordinationAckResult {
    const aggregate = ackAggregateId(mailbox);
    const payload = encodeAck({
      digest: input.digest, messageId: input.messageId, sequence: input.sequence,
    });
    for (let attempt = 0; attempt < COORDINATION_LIMITS.maxSendAttempts; attempt += 1) {
      const cursor = reader.ackCursor(mailbox);
      if (cursor === null) return corruptRecord();
      if (input.sequence <= cursor) return regressed();
      const outcome = commitOnce({
        aggregateId: aggregate, commandBytes: payload,
        commandId: ackCommandId(aggregate, input.sequence), committedAt,
        events: [{
          eventId: ackEventId(aggregate, input.sequence), eventType: MAILBOX_ACK_EVENT_TYPE,
          payload,
        }],
        expectedVersion: store.getAggregateVersion(aggregate),
      });
      if (outcome === CONTENDED) continue;
      if ("outcome" in outcome) return outcome;
      return Object.freeze({ outcome: "ACKNOWLEDGED" as const, sequence: input.sequence });
    }
    return refuse(
      "COORDINATION_STORE_BUSY", "STORE", "the ack record stayed contended across every attempt",
    );
  }

  function lookup(input: MailboxLookupInput): CoordinationDelivery | null {
    try {
      const mailbox = mailboxAggregateId(input.mailbox);
      const receipt = store.getCommandReceipt(sendCommandId(mailbox, input.messageId));
      if (receipt === null) return null;
      const entry = reader.entryAt(mailbox, receipt.currentVersion);
      if (entry === null || entry.stamp.messageId !== input.messageId) return null;
      return reader.delivery(entry, input.now);
    } catch {
      return null;
    }
  }

  function read(input: MailboxReadInput): CoordinationReadResult {
    const mailbox = mailboxAggregateId(input.mailbox);
    const cursor = reader.ackCursor(mailbox);
    return cursor === null
      ? corruptRecord() : reader.page(mailbox, cursor, input.limit, input.now);
  }

  /** Replay reads an explicit historical cursor and never touches the durable ack record. */
  function replay(input: MailboxReplayInput): CoordinationReadResult {
    return reader.page(
      mailboxAggregateId(input.mailbox), input.fromSequence, input.limit, input.now,
    );
  }

  const mailbox: DurableMailbox = {
    acknowledge: (input: MailboxAckInput) => guard(() => acknowledge(input)),
    lookup,
    read: (input: MailboxReadInput) => guard(() => read(input)),
    replay: (input: MailboxReplayInput) => guard(() => replay(input)),
    send: (input: MailboxSendInput) => guard(() => send(input)),
  };
  return Object.freeze(mailbox);
}
