/** The durable half of goal-closure qualification: every fact re-read from committed bytes. */

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { ACTIVATION_LEDGER_EVENT_TYPE } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { FOUNDATION_VERIFICATION_EVENT_TYPES } from "../evidence/foundation-verification-contracts.js";
import { readStoredReceipt } from "../evidence/foundation-verification-store.js";
import { decodeFoundationPayload, isRecord } from "../work/foundation-attempt-codec.js";
import { readFoundationAttemptRecord } from "../work/foundation-attempt-store.js";
import {
  GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS,
  GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE,
} from "./goal-close-prerequisite.js";
import type { GoalPrerequisiteRefusalCode } from "./goal-close-prerequisite.js";

const SCAN_PAGE_SIZE = 100;

/** One durable receipt, taken WHOLE from `readStoredReceipt` — never from the scanned bytes. */
export interface DurableReceipt {
  readonly attemptAggregateId: string;
  readonly effectIdentity: string;
  readonly graphIdentity: string;
  readonly leaseIdentity: string;
  readonly obligations: string;
  readonly receiptSha256: string;
  readonly recordDigest: string;
  readonly verdict: string;
}

export interface ReadRefusal {
  readonly code: GoalPrerequisiteRefusalCode;
  readonly message: string;
  readonly ok: false;
}

export type ReceiptIndex =
  | { readonly index: ReadonlyMap<string, DurableReceipt>; readonly ok: true }
  | ReadRefusal;

const refuse = (code: GoalPrerequisiteRefusalCode, message: string): ReadRefusal =>
  Object.freeze({ code, message, ok: false as const });

const textOf = (value: Record<string, unknown>, key: string): string => {
  const found = value[key];
  return typeof found === "string" ? found : "";
};

/**
 * EVERY bound field must be present. `textOf` answers "" for anything missing, and an empty
 * string would be hashed into a closure ref exactly like a real value — so a row that lost a
 * field would produce a witness that looks derived and attests nothing. `obligations` is
 * coerced through `?? null` because `JSON.stringify(undefined)` is not a string at all and
 * would throw one frame later, under a code that names the wrong cause.
 */
function receiptFrom(row: Record<string, unknown>): DurableReceipt | null {
  const receipt = row["receipt"];
  if (!isRecord(receipt)) return null;
  const bound = Object.freeze({
    attemptAggregateId: textOf(row, "attemptAggregateId"),
    effectIdentity: textOf(receipt, "effectIdentity"),
    graphIdentity: textOf(receipt, "graphIdentity"),
    leaseIdentity: textOf(receipt, "leaseIdentity"),
    obligations: JSON.stringify(receipt["obligations"] ?? null),
    receiptSha256: textOf(row, "receiptSha256"),
    recordDigest: textOf(row, "recordDigest"),
    verdict: textOf(row, "verdict"),
  });
  return Object.values(bound).some((value) => value.length === 0) ? null : bound;
}

/**
 * The cursor must STRICTLY ADVANCE. A page that reports `hasMore` without moving the cursor —
 * an empty page, or a pager regression — would otherwise be walked forever, and a qualification
 * that hangs is worse than one that refuses: it never answers at all. A non-advancing page ends
 * the scan as unreadable rather than as a complete answer, so the caller still fails closed.
 */
function scan(store: SqliteEventStore, eventType: string): readonly StoredEvent[] | null {
  const found: StoredEvent[] = [];
  let cursor = 0n;
  try {
    for (;;) {
      const page = store.readEventsByTypeAfter(eventType, cursor, SCAN_PAGE_SIZE);
      found.push(...page.items);
      if (!page.hasMore || page.nextCursor === null) break;
      if (page.nextCursor <= cursor) return null;
      cursor = page.nextCursor;
    }
  } catch {
    return null;
  }
  return found;
}

/**
 * Every durable verification receipt for an in-scope node, keyed by the node its own receipt
 * names.
 *
 * THE SCANNED BYTES ARE NEVER THE ANSWER. Only the `verificationId` is taken from them, and
 * only to name the row that is then RE-READ through `readStoredReceipt` — the one path that
 * re-decodes, re-encodes and byte-compares against what the store holds. Two objects can be
 * deep-equal while their canonical bytes differ, and it is the bytes closure hashes.
 *
 * A row whose scanned bytes will not decode is UNREADABLE rather than skipped: it cannot be
 * attributed to a node, so it cannot be shown to be out of scope either, and evidence that
 * cannot be placed never becomes an absence.
 */
export function indexDurableReceipts(
  store: SqliteEventStore, scope: ReadonlySet<string>,
): ReceiptIndex {
  const events = scan(store, FOUNDATION_VERIFICATION_EVENT_TYPES.RECEIPTED);
  if (events === null) {
    return refuse(GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE, "the receipt stream is unreadable");
  }
  const index = new Map<string, DurableReceipt>();
  for (const event of events) {
    const scanned = decodeFoundationPayload(event.payload);
    if (!scanned.ok) {
      return refuse(
        GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE, "a durable receipt row does not decode");
    }
    const verificationId = textOf(scanned.value, "verificationId");
    const claimed = scanned.value["receipt"];
    // Scope is decided on the CLAIMED node only to skip rows this closure is not about; nothing
    // below this line ever reads the scanned bytes again.
    if (!isRecord(claimed) || !scope.has(textOf(claimed, "graphIdentity"))) continue;
    const stored = readStoredReceipt(store, verificationId);
    if (!stored.ok) {
      return stored.code === "FOUNDATION_VERIFICATION_RECEIPT_AMBIGUOUS"
        ? refuse(GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS,
          "a verification aggregate carries more than one receipt")
        : refuse(GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE,
          "a durable receipt does not read back from its own aggregate");
    }
    const receipt = receiptFrom(stored.row);
    if (receipt === null) {
      return refuse(
        GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE, "a durable receipt names no graph identity");
    }
    if (!scope.has(receipt.graphIdentity)) continue;
    if (index.has(receipt.graphIdentity)) {
      return refuse(
        GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS, "two durable receipts name one node");
    }
    index.set(receipt.graphIdentity, receipt);
  }
  return Object.freeze({ index, ok: true as const });
}

/** The durable attempt record still reads back as the exact one the receipt verified. */
export function verifiedResultHolds(
  store: SqliteEventStore, receipt: DurableReceipt,
): boolean {
  const stored = readFoundationAttemptRecord(store, receipt.attemptAggregateId);
  return stored.ok && stored.digest === receipt.recordDigest;
}

export interface ActivationAccount {
  readonly aggregateId: string;
  readonly nodeKey: string | null;
  readonly readsBackAs: Readonly<{ effectIdentity: string; leaseIdentity: string }> | null;
}

/**
 * Every durable activation, with the node it belongs to and the identities it still reads back
 * as. `nodeKey` is null when the attempt record cannot be read at all — an activation nothing
 * can attribute is not an activation that has been accounted for, and the caller fails closed
 * on it rather than treating unattributable authority as absent authority.
 */
export function accountDurableActivations(
  store: SqliteEventStore, projectId: string,
): readonly ActivationAccount[] | null {
  const events = scan(store, ACTIVATION_LEDGER_EVENT_TYPE);
  if (events === null) return null;
  return events.map((event) => {
    const { aggregateId } = event;
    const stored = readFoundationAttemptRecord(store, aggregateId);
    const nodeKey = stored.ok ? textOf(stored.record, "nodeKey") : "";
    let events_: readonly StoredEvent[];
    try {
      events_ = store.readEvents(aggregateId);
    } catch {
      return { aggregateId, nodeKey: nodeKey.length === 0 ? null : nodeKey, readsBackAs: null };
    }
    const history = readFoundationActivationHistory(aggregateId, events_, projectId);
    return {
      aggregateId,
      nodeKey: nodeKey.length === 0 ? null : nodeKey,
      readsBackAs: history.ok
        ? Object.freeze({
          effectIdentity: history.history.record.effectIntent.intentId,
          leaseIdentity: history.history.record.lease.leaseId,
        })
        : null,
    };
  });
}
