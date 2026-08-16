import type { DatabaseSync } from "node:sqlite";

import { requirePageDecodedByteLimit } from "../read-page-budget.js";
import { requireIdentifier, requirePageLimit } from "../store-input-primitives.js";
import type { CursorPage, StoredEvent } from "../store-contracts.js";
import { decodeSubscriberDoc, formatPosition, parsePosition } from "./subscription-contracts.js";
import type {
  SnapshotDoc, SubscriptionCursor, SubscriptionEventSource, SubscriptionGap,
  SubscriptionGapCause, SubscriptionPage, SubscriptionPageRequest, SubscriptionPageResult,
} from "./subscription-contracts.js";
import {
  deny, docRow, inTransactionOrExisting, loadSnapshot, projectionCheckpoint, requireDocText,
  requireGeneration, requireInput, requireSubscriberId, retainedFloor,
} from "./subscription-internals.js";
import {
  issuePendingOffer, loadPendingOffer,
} from "./subscription-offers.js";
import type { PendingSubscriptionOffer } from "./subscription-offers.js";

/**
 * One bounded page of projection output, issued from a durable cursor. The first read records
 * an exact pending offer; retries replay that offer until its cursor is acknowledged. Nothing
 * here imports the relay or the fold. Any condition that makes incremental resumption
 * unsound is reported as CURSOR_GAP with the baseline snapshot attached, never as a silently
 * repositioned cursor and never as an unbounded replay; the cursor itself is left untouched,
 * because reseatToSnapshot is the only sanctioned repositioning. Every durable read that
 * feeds the decision is taken from one snapshot, so a concurrent generation advance cannot
 * be observed half-applied. Offer lookup/issuance and cursor inspection share one write
 * transaction. `database` and `eventSource` must address the same store.
 */

export const DEFAULT_SUBSCRIPTION_PAGE_LIMIT = 100;

function gap(
  cause: SubscriptionGapCause, lastGoodCursor: SubscriptionCursor | null, snapshot: SnapshotDoc,
): SubscriptionGap {
  return Object.freeze({ cause, lastGoodCursor, outcome: "CURSOR_GAP" as const, snapshot });
}

/**
 * Shallow by design: a StoredEvent owns `payload` and `metadata` Uint8Arrays, and
 * `Object.freeze` on a non-empty typed array throws TypeError. Freezing the wrapper is what
 * stops a consumer from reshaping the page; the bytes are already detached snapshots.
 */
function frozenEvent(event: StoredEvent): StoredEvent {
  return Object.isFrozen(event) ? event : Object.freeze(event);
}

/**
 * Clamps a source page to the projection checkpoint. The event exactly at the checkpoint is
 * delivered; the first one beyond it is not. `hasMore` is recomputed inside that bound —
 * the source sees the whole ledger, so passing its own flag through would promise events the
 * projection has not produced yet.
 */
function clampToCheckpoint(
  source: CursorPage<StoredEvent, bigint>, checkpoint: bigint, generation: number,
): SubscriptionPage {
  const kept = source.items.filter((event) => event.globalPosition <= checkpoint);
  const last = kept.at(-1);
  const withinBound = kept.length === source.items.length &&
    last !== undefined && last.globalPosition < checkpoint;
  return Object.freeze({
    checkpoint,
    events: Object.freeze(kept.map(frozenEvent)),
    hasMore: withinBound && source.hasMore,
    nextCursor: last === undefined
      ? null
      : Object.freeze({ generation, position: formatPosition(last.globalPosition) }),
    outcome: "PAGE" as const,
  });
}

interface PageBounds {
  readonly limit: number;
  readonly maxDecodedBytes: number | null;
}

function boundsOf(request: SubscriptionPageRequest): PageBounds {
  const limit = requireInput("limit", () =>
    requirePageLimit(request.limit ?? DEFAULT_SUBSCRIPTION_PAGE_LIMIT));
  const maxDecodedBytes = request.maxDecodedBytes === undefined
    ? null
    : requireInput("maxDecodedBytes", () =>
      requirePageDecodedByteLimit(request.maxDecodedBytes));
  return { limit, maxDecodedBytes };
}

function readClamped(
  eventSource: SubscriptionEventSource, bounds: PageBounds, after: bigint,
  checkpoint: bigint, generation: number,
): SubscriptionPage {
  if (bounds.maxDecodedBytes === null) {
    return clampToCheckpoint(
      eventSource.readEventsAfter(after, bounds.limit), checkpoint, generation,
    );
  }
  return clampToCheckpoint(
    eventSource.readEventsAfter(after, bounds.limit, bounds.maxDecodedBytes), checkpoint, generation,
  );
}

/** Where an incremental resume may start, once the durable state has agreed to one. */
interface ResumePlan {
  readonly after: bigint;
  readonly checkpoint: bigint;
  readonly generation: number;
}

function decide(
  database: DatabaseSync, subscriberId: string, projection: string,
): ResumePlan | SubscriptionGap {
  const generation = requireGeneration(database);
  const text = requireDocText(docRow(database, subscriberId), subscriberId);
  const doc = decodeSubscriberDoc(text);
  if (doc !== null && doc.projection !== projection) {
    deny(
      "SUBSCRIPTION_INPUT_INVALID", "INPUT",
      `${subscriberId} follows ${doc.projection}, not ${projection}`,
    );
  }
  const { doc: snapshot } = loadSnapshot(database, projection, generation);
  if (doc === null) {
    return gap("CURSOR_CORRUPT", null, snapshot);
  }
  if (doc.cursor.generation !== generation) {
    return gap("GENERATION_CHANGED", doc.cursor, snapshot);
  }
  const position = parsePosition(doc.cursor.position) ?? 0n;
  const checkpoint = projectionCheckpoint(database, projection);
  const floor = retainedFloor(database);
  // An empty ledger makes MIN(global_position) NULL, which no comparison can answer; the
  // question there is whether anything the cursor still owes is gone, not where the floor is.
  const pruned = floor === null ? position < checkpoint : position + 1n < floor;
  if (pruned) {
    return gap("HISTORY_PRUNED", doc.cursor, snapshot);
  }
  if (position > checkpoint) {
    return gap("CURSOR_AHEAD", doc.cursor, snapshot);
  }
  return { after: position, checkpoint, generation };
}

function replay(
  eventSource: SubscriptionEventSource, plan: ResumePlan, offer: PendingSubscriptionOffer,
): SubscriptionPage {
  if (offer.generation !== plan.generation || offer.from !== plan.after) {
    return deny(
      "SUBSCRIPTION_STATE_CORRUPT", "STATE",
      "the pending page offer is not based on the durable subscriber cursor",
    );
  }
  if (offer.checkpoint > plan.checkpoint) {
    return deny(
      "SUBSCRIPTION_STATE_CORRUPT", "STATE",
      "the pending page offer is beyond the durable projection checkpoint",
    );
  }
  const page = readClamped(eventSource, {
    limit: offer.limit, maxDecodedBytes: offer.maxDecodedBytes,
  }, offer.from, offer.checkpoint, offer.generation);
  const issued = page.nextCursor === null ? null : parsePosition(page.nextCursor.position);
  if (
    issued !== offer.issued || page.events.length !== offer.eventCount
    || page.hasMore !== offer.hasMore || page.checkpoint !== offer.checkpoint
  ) {
    return deny(
      "SUBSCRIPTION_STATE_CORRUPT", "STATE",
      "the durable ledger can no longer reproduce the pending page offer",
    );
  }
  return page;
}

function issue(
  eventSource: SubscriptionEventSource, database: DatabaseSync, subscriberId: string,
  plan: ResumePlan, bounds: PageBounds,
): SubscriptionPage {
  const page = readClamped(
    eventSource, bounds, plan.after, plan.checkpoint, plan.generation,
  );
  if (page.nextCursor === null) return page;
  const issued = parsePosition(page.nextCursor.position);
  if (issued === null || issued <= plan.after || page.events.length === 0) {
    return deny("SUBSCRIPTION_STATE_CORRUPT", "STATE", "the issued page cursor is inconsistent");
  }
  issuePendingOffer(database, {
    checkpoint: plan.checkpoint,
    eventCount: page.events.length,
    from: plan.after,
    generation: plan.generation,
    hasMore: page.hasMore,
    issued,
    limit: bounds.limit,
    maxDecodedBytes: bounds.maxDecodedBytes,
    subscriberId,
  });
  return page;
}

export function readSubscriptionPage(
  eventSource: SubscriptionEventSource, database: DatabaseSync, request: SubscriptionPageRequest,
): SubscriptionPageResult {
  const result = inTransactionOrExisting(database, (): SubscriptionPageResult => {
    const subscriberId = requireSubscriberId(request.subscriberId);
    const projection = requireInput("projection", () =>
      requireIdentifier(request.projection, "projection"));
    const bounds = boundsOf(request);
    const decision = decide(database, subscriberId, projection);
    if ("outcome" in decision) {
      return decision;
    }
    const pending = loadPendingOffer(database, subscriberId);
    return pending === null
      ? issue(eventSource, database, subscriberId, decision, bounds)
      : replay(eventSource, decision, pending);
  });
  return result;
}
