import type { DatabaseSync } from "node:sqlite";

import { decodeSubscriberDoc, formatPosition, parsePosition } from "./subscription-contracts.js";
import type { AcknowledgeInput, SubscriptionAckResult } from "./subscription-contracts.js";
import {
  compareAndSet, corrupt, deny, docRow, encodedCursor, inTransaction, projectionCheckpoint,
  requireCurrentGeneration, requireDocText, requireSubscriberId,
} from "./subscription-internals.js";
import { consumePendingOffer, loadPendingOffer } from "./subscription-offers.js";

/** Advances and consumes only the exact page cursor durably offered to this subscriber. */
export function acknowledge(
  database: DatabaseSync, input: AcknowledgeInput,
): SubscriptionAckResult {
  return inTransaction(database, () => {
    const subscriberId = requireSubscriberId(input.subscriberId);
    const position = parsePosition(input.cursor?.position);
    if (position === null) {
      deny("SUBSCRIPTION_INPUT_INVALID", "INPUT", "cursor.position must be a decimal position");
    }
    const generation = requireCurrentGeneration(database, input.cursor.generation);
    const text = requireDocText(docRow(database, subscriberId), subscriberId);
    const doc = decodeSubscriberDoc(text);
    if (doc === null) corrupt(`the ${subscriberId} cursor doc is unparseable`);
    if (doc.cursor.generation !== generation) {
      corrupt(`the ${subscriberId} cursor doc is from generation ${doc.cursor.generation}`);
    }
    const durablePosition = parsePosition(doc.cursor.position) ?? 0n;
    if (position < durablePosition) {
      deny(
        "SUBSCRIPTION_CURSOR_REGRESSION", "STATE",
        `cursor ${formatPosition(position)} is behind the durable cursor ${doc.cursor.position}`,
      );
    }
    const pending = loadPendingOffer(database, subscriberId);
    if (pending === null || pending.generation !== generation || pending.issued !== position) {
      deny(
        "SUBSCRIPTION_CURSOR_NOT_ISSUED", "STATE",
        `cursor ${formatPosition(position)} is not the subscriber's pending page offer`,
      );
    }
    if (pending.from !== durablePosition
      || pending.issued > projectionCheckpoint(database, doc.projection)) {
      corrupt(`the ${subscriberId} pending page offer is inconsistent with durable state`);
    }
    const next = formatPosition(position);
    compareAndSet(database, subscriberId, text,
      encodedCursor(doc.filter, generation, next, doc.projection));
    consumePendingOffer(database, pending);
    return Object.freeze({
      cursor: Object.freeze({ generation, position: next }), outcome: "ACKNOWLEDGED" as const,
    });
  });
}
