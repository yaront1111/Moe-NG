import { MAX_PAGE_SIZE } from "@moe/store";

/**
 * Wire vocabulary for the resumable event stream.
 *
 * The port types below are a STRUCTURAL view of the committed subscription surface in
 * `packages/store/src/subscriptions`, deliberately not an import of it: that surface is
 * not re-exported from `@moe/store`'s entry point and this task does not own that package.
 * The store set the same precedent for itself with `SubscriptionEventSource` — depend on
 * the page shape, not on the store class — and a real `SubscriptionPageResult` is
 * assignable to `StreamReadResult` unchanged.
 *
 * Refusal codes and layers raised by the port cross this seam VERBATIM. There is no
 * translation table, so a store code cannot be flattened into a generic transport code on
 * the way out and a reviewer can still see which layer refused.
 */

export interface StreamCursor {
  readonly generation: number;
  readonly position: string;
}

export interface StreamSnapshot {
  readonly checkpoint: string;
  readonly generation: number;
  readonly projection: string;
  readonly stateDigest: string;
}

export interface StreamEvent {
  readonly aggregateId: string;
  readonly committedAt: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly globalPosition: bigint;
}

export interface StreamPage {
  readonly checkpoint: bigint;
  readonly events: readonly StreamEvent[];
  readonly hasMore: boolean;
  readonly nextCursor: StreamCursor | null;
  readonly outcome: "PAGE";
}

export interface StreamGap {
  readonly cause: string;
  readonly lastGoodCursor: StreamCursor | null;
  readonly outcome: "CURSOR_GAP";
  readonly snapshot: StreamSnapshot;
}

export interface StreamRefused {
  readonly code: string;
  readonly detail: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}

export interface StreamSeated {
  readonly cursor: StreamCursor;
  readonly outcome: "REGISTERED" | "RESEATED";
  readonly snapshot: StreamSnapshot;
}

export type StreamReadResult = StreamGap | StreamPage | StreamRefused;
export type StreamSeatResult = StreamRefused | StreamSeated;

export interface StreamPageRequest {
  readonly limit?: number;
  readonly projection: string;
  readonly subscriberId: string;
}

export interface StreamReseatRequest {
  readonly projection: string;
  readonly subscriberId: string;
}

export interface SubscriptionPort {
  readPage(request: StreamPageRequest): StreamReadResult;
  reseat(request: StreamReseatRequest): StreamSeatResult;
}

/** Page size is bounded by the store's own limit rather than a second number. */
export const MAX_EVENT_PAGE_SIZE = MAX_PAGE_SIZE;

/**
 * Refusals this seam raises on its own behalf, as opposed to the ones it forwards. Kept
 * closed and separate from the port's vocabulary, and every frame names the layer, so a
 * seam refusal is never mistaken for a store refusal.
 */
export const EVENT_STREAM_REFUSAL_CODES = Object.freeze([
  "EVENT_STREAM_CURSOR_NOT_ISSUED",
  "EVENT_STREAM_GENERATION_SUPERSEDED",
  "EVENT_STREAM_LIMIT_INVALID",
] as const);

export type EventStreamRefusalCode = (typeof EVENT_STREAM_REFUSAL_CODES)[number];

export const EVENT_STREAM_LAYER = "SEAM" as const;

/** The wire cursor. `position` is the store's own opaque string; the seam never parses it. */
export interface WireCursor {
  readonly generation: number;
  readonly position: string;
}

export interface WireEvent {
  readonly aggregateId: string;
  readonly committedAt: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly globalPosition: string;
}

export interface WireSnapshot {
  readonly checkpoint: string;
  readonly generation: number;
  readonly projection: string;
  readonly stateDigest: string;
}

/**
 * The three read frames stay a DISCRIMINATED UNION with payload on the owning arm only:
 * `nextCursor` exists solely on PAGE and `snapshot` solely on CURSOR_GAP. Flattening these
 * into one object with optional fields would let a client read a cursor off a gap response
 * and resume from a position that was never delivered — which is the exact failure the
 * store's arm discipline was built to prevent.
 */
export interface EventPageFrame {
  readonly checkpoint: string;
  readonly events: readonly WireEvent[];
  readonly hasMore: boolean;
  readonly nextCursor: WireCursor | null;
  readonly outcome: "PAGE";
}

export interface EventGapFrame {
  readonly cause: string;
  readonly lastGoodCursor: WireCursor | null;
  readonly outcome: "CURSOR_GAP";
  readonly snapshot: WireSnapshot;
}

export interface EventRefusedFrame {
  readonly code: string;
  readonly detail: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}

export interface EventReseatedFrame {
  readonly cursor: WireCursor;
  readonly outcome: "RESEATED";
  readonly snapshot: WireSnapshot;
}

export type EventReadFrame = EventGapFrame | EventPageFrame | EventRefusedFrame;
export type EventResumeFrame = EventRefusedFrame | EventReseatedFrame;

export interface EventReadRequest {
  readonly limit?: number;
  readonly projection: string;
  readonly subscriberId: string;
}

/**
 * `presentedCursor` is what the client believes it holds. It is compared, never trusted:
 * the durable cursor stays server-side, so a client cannot resume from a position it was
 * never handed.
 */
export interface EventResumeRequest {
  readonly presentedCursor: WireCursor;
  readonly projection: string;
  readonly subscriberId: string;
}
