import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { MAX_PAGE_DECODED_BYTES, MAX_PAGE_SIZE } from "../store-contracts.js";
import { corrupt } from "./subscription-internals.js";
import { parsePosition } from "./subscription-contracts.js";

/** The durable promise made by one page read. It exists until its exact cursor is acked. */
export interface PendingSubscriptionOffer {
  readonly checkpoint: bigint;
  readonly eventCount: number;
  readonly from: bigint;
  readonly generation: number;
  readonly hasMore: boolean;
  readonly issued: bigint;
  readonly limit: number;
  readonly maxDecodedBytes: number | null;
  readonly subscriberId: string;
}

const OFFER_IDENTITY_VERSION = "moe-subscription-offer/1";
const MAX_POSITION_TEXT_LENGTH = 19;

function offerDigest(offer: PendingSubscriptionOffer): string {
  const hash = createHash("sha256");
  for (const field of [
    OFFER_IDENTITY_VERSION,
    offer.subscriberId,
    String(offer.generation),
    offer.from.toString(),
    offer.issued.toString(),
    offer.checkpoint.toString(),
    String(offer.limit),
    offer.maxDecodedBytes === null ? "ABSENT" : String(offer.maxDecodedBytes),
    String(offer.eventCount),
    offer.hasMore ? "1" : "0",
  ]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function positiveSafeInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    corrupt(`the pending offer ${field} is invalid`);
  }
  return value;
}

function position(value: unknown, field: string): bigint {
  if (typeof value !== "string" || value.length > MAX_POSITION_TEXT_LENGTH) {
    corrupt(`the pending offer ${field} is not a bounded position`);
  }
  const parsed = parsePosition(value);
  if (parsed === null) corrupt(`the pending offer ${field} is not a canonical position`);
  return parsed;
}

export function loadPendingOffer(
  database: DatabaseSync, subscriberId: string,
): PendingSubscriptionOffer | null {
  const row = database.prepare(`
    SELECT subscriber_id, generation, from_position, issued_position, checkpoint,
      page_limit, max_decoded_bytes, event_count, has_more, offer_digest
    FROM subscription_pending_offers
    WHERE subscriber_id = ?
  `).get(subscriberId);
  if (row === undefined) return null;

  const generation = positiveSafeInteger(row["generation"], "generation", Number.MAX_SAFE_INTEGER);
  const from = position(row["from_position"], "from_position");
  const issued = position(row["issued_position"], "issued_position");
  const checkpoint = position(row["checkpoint"], "checkpoint");
  const limit = positiveSafeInteger(row["page_limit"], "page_limit", MAX_PAGE_SIZE);
  const eventCount = positiveSafeInteger(row["event_count"], "event_count", MAX_PAGE_SIZE);
  const maxValue = row["max_decoded_bytes"];
  const maxDecodedBytes = maxValue === null
    ? null
    : positiveSafeInteger(maxValue, "max_decoded_bytes", MAX_PAGE_DECODED_BYTES);
  const hasMoreValue = row["has_more"];
  if (hasMoreValue !== 0 && hasMoreValue !== 1) corrupt("the pending offer has_more is invalid");
  if (issued <= from || issued > checkpoint) {
    corrupt("the pending offer cursor bounds are inconsistent");
  }
  const offer = Object.freeze({
    checkpoint, eventCount, from, generation, hasMore: hasMoreValue === 1, issued, limit,
    maxDecodedBytes, subscriberId,
  });
  if (row["offer_digest"] !== offerDigest(offer)) {
    corrupt("the pending offer identity does not match its durable fields");
  }
  return offer;
}

export function issuePendingOffer(
  database: DatabaseSync, offer: PendingSubscriptionOffer,
): void {
  const result = database.prepare(`
    INSERT INTO subscription_pending_offers (
      subscriber_id, generation, from_position, issued_position, checkpoint,
      page_limit, max_decoded_bytes, event_count, has_more, offer_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    offer.subscriberId,
    offer.generation,
    offer.from.toString(),
    offer.issued.toString(),
    offer.checkpoint.toString(),
    offer.limit,
    offer.maxDecodedBytes,
    offer.eventCount,
    offer.hasMore ? 1 : 0,
    offerDigest(offer),
  );
  if (Number(result.changes) !== 1) corrupt("SQLite did not persist the pending page offer");
}

export function consumePendingOffer(
  database: DatabaseSync, offer: PendingSubscriptionOffer,
): void {
  const result = database.prepare(`
    DELETE FROM subscription_pending_offers
    WHERE subscriber_id = ? AND generation = ? AND from_position = ?
      AND issued_position = ? AND checkpoint = ? AND page_limit = ?
      AND max_decoded_bytes IS ? AND event_count = ? AND has_more = ? AND offer_digest = ?
  `).run(
    offer.subscriberId,
    offer.generation,
    offer.from.toString(),
    offer.issued.toString(),
    offer.checkpoint.toString(),
    offer.limit,
    offer.maxDecodedBytes,
    offer.eventCount,
    offer.hasMore ? 1 : 0,
    offerDigest(offer),
  );
  if (Number(result.changes) !== 1) corrupt("the pending page offer changed under acknowledgement");
}

export function clearPendingOffer(database: DatabaseSync, subscriberId: string): void {
  database.prepare("DELETE FROM subscription_pending_offers WHERE subscriber_id = ?")
    .run(subscriberId);
}

export function clearAllPendingOffers(database: DatabaseSync): void {
  database.prepare("DELETE FROM subscription_pending_offers").run();
}
