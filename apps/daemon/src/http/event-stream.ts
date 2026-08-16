import {
  EVENT_STREAM_LAYER,
  MAX_EVENT_PAGE_SIZE,
} from "./event-stream-contract.js";
import type {
  EventGapFrame,
  EventAcknowledgeFrame,
  EventAcknowledgeRequest,
  EventPageFrame,
  EventReadFrame,
  EventReadRequest,
  EventRefusedFrame,
  EventResumeFrame,
  EventResumeRequest,
  EventStreamRefusalCode,
  SeamObserver,
  StreamCursor,
  StreamEvent,
  StreamGap,
  StreamPage,
  StreamRefused,
  StreamSnapshot,
  SubscriptionPort,
  WireCursor,
  WireEvent,
  WireSnapshot,
} from "./event-stream-contract.js";
import {
  DEFAULT_SEAM_OBSERVER,
  identityOf,
  observation,
} from "./event-stream-observation.js";

/**
 * Transport, bounds and shape for the committed subscription surface. This module adds NO
 * gap semantics of its own: the port decides PAGE versus CURSOR_GAP versus REFUSED, and
 * everything here either encodes that answer for the wire or refuses on a bound the port
 * does not own.
 *
 * The store's arm discipline is carried through unchanged — `nextCursor` is emitted only on
 * PAGE and `snapshot` only on CURSOR_GAP — so a client cannot read a cursor off a gap
 * response and resume from a position that was never delivered.
 */

function seamRefusal(code: EventStreamRefusalCode, detail: string): EventRefusedFrame {
  return Object.freeze({ code, detail, layer: EVENT_STREAM_LAYER, outcome: "REFUSED" as const });
}

/** A port refusal crosses verbatim: same code, same layer, no translation table. */
function forward(refused: StreamRefused): EventRefusedFrame {
  return Object.freeze({
    code: refused.code,
    detail: refused.detail,
    layer: refused.layer,
    outcome: "REFUSED" as const,
  });
}

function wireCursor(cursor: StreamCursor): WireCursor {
  return Object.freeze({ generation: cursor.generation, position: cursor.position });
}

function wireSnapshot(snapshot: StreamSnapshot): WireSnapshot {
  return Object.freeze({
    checkpoint: snapshot.checkpoint,
    generation: snapshot.generation,
    projection: snapshot.projection,
    stateDigest: snapshot.stateDigest,
  });
}

/** Ledger positions are bigint in the store and must not reach JSON as one. */
function wireEvent(event: StreamEvent, seamReading: string): WireEvent {
  return Object.freeze({
    aggregateId: event.aggregateId,
    committedAt: event.committedAt,
    eventId: event.eventId,
    eventType: event.eventType,
    globalPosition: String(event.globalPosition),
    identity: identityOf(event),
    ledgerObservation: observation("STORE_LEDGER", "STORE_COMMIT_CLOCK", event.committedAt),
    seamObservation: observation("DAEMON_SEAM", "DAEMON_WALL_CLOCK", seamReading),
  });
}

function pageFrame(page: StreamPage, observer: SeamObserver): EventPageFrame {
  // ONE reading per frame, not one per event. Ten readings off a single clock would
  // manufacture precision this seam does not have and invite a consumer to diff two of them.
  const seamReading = observer.now();
  return Object.freeze({
    checkpoint: String(page.checkpoint),
    events: Object.freeze(page.events.map((event) => wireEvent(event, seamReading))),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor === null ? null : wireCursor(page.nextCursor),
    outcome: "PAGE" as const,
  });
}

function gapFrame(gap: StreamGap): EventGapFrame {
  return Object.freeze({
    cause: gap.cause,
    lastGoodCursor: gap.lastGoodCursor === null ? null : wireCursor(gap.lastGoodCursor),
    outcome: "CURSOR_GAP" as const,
    snapshot: wireSnapshot(gap.snapshot),
  });
}

function encode(
  result: StreamGap | StreamPage | StreamRefused,
  observer: SeamObserver,
): EventReadFrame {
  if (result.outcome === "REFUSED") return forward(result);
  if (result.outcome === "CURSOR_GAP") return gapFrame(result);
  return pageFrame(result, observer);
}

function limitRefusal(limit: number | undefined): EventRefusedFrame | null {
  if (limit === undefined) return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_SIZE) {
    return seamRefusal(
      "EVENT_STREAM_LIMIT_INVALID",
      `page limit must be between 1 and ${String(MAX_EVENT_PAGE_SIZE)}`,
    );
  }
  return null;
}

/**
 * Reads one page. The bound is checked before the port is touched at all.
 *
 * `observer` is optional and LAST on purpose: http-listener.ts calls this with two
 * arguments, so a required parameter would ripple into the listener options type and every
 * listener fixture. The blast radius of injecting a clock stays inside this seam.
 */
export function readEventPage(
  port: SubscriptionPort,
  request: EventReadRequest,
  observer: SeamObserver = DEFAULT_SEAM_OBSERVER,
): EventReadFrame {
  const refusal = limitRefusal(request.limit);
  if (refusal !== null) return refusal;

  return encode(port.readPage(
    request.limit === undefined
      ? { projection: request.projection, subscriberId: request.subscriberId }
      : {
        limit: request.limit,
        projection: request.projection,
        subscriberId: request.subscriberId,
      },
  ), observer);
}

/** Advances only the exact durable page offer the subscriber has already received. */
export function acknowledgeEventPage(
  port: SubscriptionPort,
  request: EventAcknowledgeRequest,
): EventAcknowledgeFrame {
  const result = port.acknowledge({
    cursor: request.presentedCursor,
    subscriberId: request.subscriberId,
  });
  if (result.outcome === "REFUSED") return forward(result);
  return Object.freeze({ cursor: wireCursor(result.cursor), outcome: "ACKNOWLEDGED" as const });
}

/**
 * Resumes from a verified snapshot.
 *
 * The seam PROBES with the non-mutating read first and only calls `reseat` once the
 * presented cursor is confirmed to be the one the gap actually issued. Reseating is a
 * compare-and-set on the durable cursor, so checking afterwards would mean the cursor had
 * already moved — "refused rather than silently reseated" only holds if nothing was
 * reseated at all.
 *
 * The presented cursor is compared, never trusted. The durable cursor stays server-side,
 * so a client cannot resume from a position it was never handed.
 */
export function resumeFromSnapshot(
  port: SubscriptionPort,
  request: EventResumeRequest,
): EventResumeFrame {
  const probe = port.readPage({
    projection: request.projection,
    subscriberId: request.subscriberId,
  });
  if (probe.outcome === "REFUSED") return forward(probe);
  if (probe.outcome !== "CURSOR_GAP") {
    return seamRefusal(
      "EVENT_STREAM_CURSOR_NOT_ISSUED",
      "no cursor gap is open, so no snapshot cursor was issued to resume from",
    );
  }

  const { snapshot } = probe;
  if (request.presentedCursor.generation !== snapshot.generation) {
    return seamRefusal(
      "EVENT_STREAM_GENERATION_SUPERSEDED",
      "the presented cursor belongs to a generation that is no longer current",
    );
  }
  if (request.presentedCursor.position !== snapshot.checkpoint) {
    return seamRefusal(
      "EVENT_STREAM_CURSOR_NOT_ISSUED",
      "the presented cursor is not the snapshot checkpoint this seam issued",
    );
  }

  const seated = port.reseat({
    projection: request.projection,
    subscriberId: request.subscriberId,
  });
  if (seated.outcome === "REFUSED") return forward(seated);
  return Object.freeze({
    cursor: wireCursor(seated.cursor),
    outcome: "RESEATED" as const,
    snapshot: wireSnapshot(seated.snapshot),
  });
}
