import {
  FOUNDATION_VERIFICATION_EVENT_TYPES,
} from "../evidence/foundation-verification-contracts.js";
import { readStoredReceipt } from "../evidence/foundation-verification-store.js";
import { decodeFoundationPayload } from "./foundation-attempt-codec.js";

import type { SqliteEventStore, StoredEvent } from "@moe/store";

/**
 * WHICH DURABLE RECEIPT NAMES THIS ATTEMPT — the scan half of task-af9454f4's
 * binding, kept in its own module because "find the row" and "bind the fact" are
 * separable responsibilities and the producer is at its line target.
 *
 * THE SCANNED BYTES ARE NEVER THE ANSWER. Only `verificationId` is taken from
 * them, and only to name the row `readStoredReceipt` then re-reads, re-encodes
 * and byte-compares — the discipline `indexDurableReceipts`
 * (`goal-qualification-reads.ts:108`) already runs in production.
 *
 * ZERO ROWS IS A FACT, not a failure: an unverified release (WORK_CANCEL) is
 * legitimate. TWO rows is a durable inconsistency and refuses, because absent and
 * ambiguous demand opposite repairs.
 */

const SCAN_PAGE_SIZE = 200;

export interface ReleaseHandoffReceipt {
  readonly receiptSha256: string; readonly verificationId: string;
}

/** This module answers in the BINDING's vocabulary; its caller adds the layer. */
export type ReceiptScanCode =
  | "RELEASE_HANDOFF_BINDING_RECEIPT_AMBIGUOUS" | "RELEASE_HANDOFF_BINDING_UNREADABLE";
export interface ReceiptScanRefused { readonly code: ReceiptScanCode; readonly ok: false }

const refuseScan = (code: ReceiptScanCode): ReceiptScanRefused =>
  Object.freeze({ code, ok: false as const });

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** The receipt rows the store holds, paged. A cursor that fails to advance ends
 *  the scan as unreadable rather than as a complete answer. */
function scanReceipts(store: SqliteEventStore): readonly StoredEvent[] | null {
  const found: StoredEvent[] = [];
  let cursor = 0n;
  try {
    for (;;) {
      const page = store.readEventsByTypeAfter(
        FOUNDATION_VERIFICATION_EVENT_TYPES.RECEIPTED, cursor, SCAN_PAGE_SIZE);
      found.push(...page.items);
      if (!page.hasMore || page.nextCursor === null) break;
      if (page.nextCursor <= cursor) return null;
      cursor = page.nextCursor;
    }
  } catch { return null; }
  return found;
}

/**
 * The attempt's receipt, or the measured absence of one. THE SCANNED BYTES ARE
 * NEVER THE ANSWER: only `verificationId` is taken from them, and only to name
 * the row `readStoredReceipt` then re-reads.
 */
export function resolveAttemptReceipt(
  store: SqliteEventStore, attemptAggregateId: string,
): ReleaseHandoffReceipt | null | ReceiptScanRefused {
  const events = scanReceipts(store);
  if (events === null) return refuseScan("RELEASE_HANDOFF_BINDING_UNREADABLE");
  const named: string[] = [];
  for (const event of events) {
    const scanned = decodeFoundationPayload(event.payload);
    if (!scanned.ok) return refuseScan("RELEASE_HANDOFF_BINDING_UNREADABLE");
    if (scanned.value["attemptAggregateId"] !== attemptAggregateId) continue;
    const verificationId = scanned.value["verificationId"];
    if (!text(verificationId)) return refuseScan("RELEASE_HANDOFF_BINDING_UNREADABLE");
    named.push(verificationId);
  }
  if (named.length === 0) return null;
  if (named.length > 1) return refuseScan("RELEASE_HANDOFF_BINDING_RECEIPT_AMBIGUOUS");
  const verificationId = named[0] as string;
  const stored = readStoredReceipt(store, verificationId);
  if (!stored.ok) {
    return refuseScan(stored.code === "FOUNDATION_VERIFICATION_RECEIPT_AMBIGUOUS"
      ? "RELEASE_HANDOFF_BINDING_RECEIPT_AMBIGUOUS" : "RELEASE_HANDOFF_BINDING_UNREADABLE");
  }
  const sha = stored.row["receiptSha256"];
  if (!text(sha)) return refuseScan("RELEASE_HANDOFF_BINDING_UNREADABLE");
  return Object.freeze({ receiptSha256: sha, verificationId });
}

