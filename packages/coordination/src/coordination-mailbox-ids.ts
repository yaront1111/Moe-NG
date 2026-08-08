import { decodeBoundedJsonBytes } from "@moe/contracts";

import { digestBytes } from "./coordination-codec.js";
import { refuse } from "./coordination-contracts.js";
import type { CoordinationAddress, CoordinationRefused } from "./coordination-contracts.js";
import { isPlainRecord, isSafeCount, readOwnDataProperty, textBytes } from "./coordination-shape.js";

export const MAILBOX_EVENT_TYPE = "coordination.mailbox.enqueued" as const;
export const MAILBOX_ACK_EVENT_TYPE = "coordination.mailbox.acknowledged" as const;
export const MAILBOX_TOPIC = "coordination.mailbox" as const;
export const MAILBOX_STAMP_VERSION = "moe-coordination-stamp/1" as const;
export const MAILBOX_ACK_VERSION = "moe-coordination-ack/1" as const;
/** ECMAScript's absolute Date bound. Beyond it `toISOString` throws instead of answering. */
const MAX_EPOCH_MILLISECONDS = 8_640_000_000_000_000;

/** One deterministic mailbox per exact address. The effect id participates, so a terminal
 *  wrapper and its bare session are never the same durable mailbox. */
export function mailboxAggregateId(address: CoordinationAddress): string {
  const digest = digestBytes(
    "moe-coordination-mailbox/1", textBytes(address.role), textBytes(address.sessionId),
    textBytes(address.effectId ?? ""),
  );
  return `moe-coordination-mailbox:${digest}`;
}

export function ackAggregateId(mailbox: string): string {
  return `moe-coordination-ack:${digestBytes("moe-coordination-ack/1", textBytes(mailbox))}`;
}

/** Derived from the mailbox and the bounded message id only, so a resend of the SAME message
 *  always addresses the same durable command slot no matter what bytes it carries. */
export function sendCommandId(mailbox: string, messageId: string): string {
  const digest = digestBytes(
    "moe-coordination-send/1", textBytes(mailbox), textBytes(messageId),
  );
  return `moe-coordination-send:${digest}`;
}

/** Derived from the mailbox, the message id AND the canonical bytes, so an identical resend
 *  yields the same event id while a same-id/different-bytes resend cannot collide with it. */
export function messageEventId(
  mailbox: string, messageId: string, canonicalBytes: Uint8Array,
): string {
  const digest = digestBytes(
    "moe-coordination-event/1", textBytes(mailbox), textBytes(messageId), canonicalBytes,
  );
  return `moe-coordination-event:${digest}`;
}

export function outboxMessageId(eventId: string): string {
  return `moe-coordination-outbox:${digestBytes("moe-coordination-outbox/1", textBytes(eventId))}`;
}

export function ackCommandId(ackAggregate: string, sequence: number): string {
  const digest = digestBytes(
    "moe-coordination-ack-command/1", textBytes(ackAggregate), textBytes(String(sequence)),
  );
  return `moe-coordination-ack-command:${digest}`;
}

export function ackEventId(ackAggregate: string, sequence: number): string {
  const digest = digestBytes(
    "moe-coordination-ack-event/1", textBytes(ackAggregate), textBytes(String(sequence)),
  );
  return `moe-coordination-ack-event:${digest}`;
}

export function toCommitTimestamp(now: number): string | null {
  if (!Number.isSafeInteger(now) || Math.abs(now) > MAX_EPOCH_MILLISECONDS) return null;
  try {
    return new Date(now).toISOString();
  } catch {
    return null;
  }
}

/** Server-owned stamps. Deliberately stored as event METADATA rather than inside the
 *  canonical envelope bytes, so the time a message arrived can never perturb its digest. */
export interface MessageStamp {
  readonly digest: string; readonly expiresAt: number; readonly messageId: string;
  readonly sentAt: number;
}

export function encodeStamp(stamp: MessageStamp): Uint8Array {
  return textBytes(JSON.stringify({
    digest: stamp.digest, expiresAt: stamp.expiresAt, messageId: stamp.messageId,
    sentAt: stamp.sentAt, version: MAILBOX_STAMP_VERSION,
  }));
}

export function decodeStamp(bytes: Uint8Array): MessageStamp | null {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || !isPlainRecord(decoded.value)) return null;
  const record = decoded.value;
  if (read(record, "version") !== MAILBOX_STAMP_VERSION) return null;
  const digest = read(record, "digest");
  const messageId = read(record, "messageId");
  const expiresAt = read(record, "expiresAt");
  const sentAt = read(record, "sentAt");
  if (typeof digest !== "string" || typeof messageId !== "string") return null;
  if (!isSafeCount(expiresAt) || !isSafeCount(sentAt)) return null;
  return Object.freeze({ digest, expiresAt, messageId, sentAt });
}

export interface AckRecord {
  readonly digest: string; readonly messageId: string; readonly sequence: number;
}

export function encodeAck(record: AckRecord): Uint8Array {
  return textBytes(JSON.stringify({
    digest: record.digest, messageId: record.messageId, sequence: record.sequence,
    version: MAILBOX_ACK_VERSION,
  }));
}

export function decodeAck(bytes: Uint8Array): AckRecord | null {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || !isPlainRecord(decoded.value)) return null;
  const record = decoded.value;
  if (read(record, "version") !== MAILBOX_ACK_VERSION) return null;
  const digest = read(record, "digest");
  const messageId = read(record, "messageId");
  const sequence = read(record, "sequence");
  if (typeof digest !== "string" || typeof messageId !== "string") return null;
  if (!isSafeCount(sequence) || sequence === 0) return null;
  return Object.freeze({ digest, messageId, sequence });
}

function read(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const property = readOwnDataProperty(record, key);
  return property.ok && property.present ? property.value : undefined;
}

export function storeErrorCode(error: unknown): string {
  if (error === null || typeof error !== "object") return "";
  const code = readOwnDataProperty(error, "code");
  return code.ok && code.present && typeof code.value === "string" ? code.value : "";
}

/**
 * Maps a durable-store failure onto a coordination refusal. An ambiguous commit stays
 * ambiguous: OUTCOME_UNKNOWN never becomes success and never becomes a plain failure.
 */
export function mapStoreError(error: unknown): CoordinationRefused {
  const code = storeErrorCode(error);
  if (code === "OUTCOME_UNKNOWN") {
    return refuse(
      "COORDINATION_OUTCOME_UNKNOWN", "STORE",
      "the durable commit outcome is unknown; delivery is not claimed",
    );
  }
  if (code === "STORE_BUSY") {
    return refuse("COORDINATION_STORE_BUSY", "STORE", "the durable store is busy");
  }
  if (code === "COMMAND_ID_CONFLICT" || code === "DURABLE_ID_CONFLICT"
    || code === "IDEMPOTENCY_CONFLICT") {
    return refuse(
      "COORDINATION_IDEMPOTENCY_CONFLICT", "STORE",
      "the message id was reused for different canonical bytes",
    );
  }
  return refuse("COORDINATION_STORE_UNAVAILABLE", "STORE", "the durable store refused the write");
}
