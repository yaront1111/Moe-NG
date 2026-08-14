import type { StreamEvent } from "./event-stream-contract.js";

/**
 * Observation and identity vocabulary for the event stream wire, and the constructors that
 * build those values.
 *
 * Split out of `event-stream-contract.ts` to keep each source under the per-file line
 * target. This module owns `EVENT_STREAM_LAYER` so it needs nothing from the contract at
 * runtime; the contract re-exports it, and the only import back is TYPE-ONLY and erases.
 * The value edge therefore runs strictly one way, contract -> observation, with no cycle.
 */

/** Every refusal and every stated absence this seam emits names this layer. */
export const EVENT_STREAM_LAYER = "SEAM" as const;

/**
 * Who took a reading, and on which clock. Both vocabularies are closed, so a reading always
 * arrives with its provenance and can never be handed over anonymously.
 *
 * The two readings on a wire event are SEPARATE FIELDS and must never be collapsed into one
 * or subtracted from each other here. They come from different clocks in different
 * processes — the store's commit clock and the daemon's wall clock — so their difference is
 * not a duration; it is a real interval plus an unknown clock offset. This seam emits
 * readings with their observer attached and computes nothing. Any layer that wants a
 * duration must first establish that the two clocks are comparable, which is a question
 * this seam cannot answer and must not appear to have answered.
 */
export const EVENT_STREAM_OBSERVERS = Object.freeze([
  "DAEMON_SEAM",
  "STORE_LEDGER",
] as const);

export type EventStreamObserver = (typeof EVENT_STREAM_OBSERVERS)[number];

export const EVENT_STREAM_CLOCKS = Object.freeze([
  "DAEMON_WALL_CLOCK",
  "STORE_COMMIT_CLOCK",
] as const);

export type EventStreamClock = (typeof EVENT_STREAM_CLOCKS)[number];

/**
 * Facts the source did not provide. Kept closed and DISJOINT from
 * EVENT_STREAM_REFUSAL_CODES: an absent identity is not a refused frame, and sharing one
 * vocabulary would let a consumer read a missing fact as a rejection of the whole page.
 */
export const EVENT_STREAM_UNKNOWN_CODES = Object.freeze([
  "EVENT_STREAM_IDENTITY_NOT_PROVIDED",
  "EVENT_STREAM_READING_NOT_PROVIDED",
] as const);

export type EventStreamUnknownCode = (typeof EVENT_STREAM_UNKNOWN_CODES)[number];

/** An absent fact names its code AND its layer. It is never "", never 0, never dropped. */
export interface WireUnknownValue {
  readonly code: EventStreamUnknownCode;
  readonly known: false;
  readonly layer: typeof EVENT_STREAM_LAYER;
}

export interface WireKnownValue {
  readonly known: true;
  readonly value: string;
}

export type WireValue = WireKnownValue | WireUnknownValue;

/** One reading, bound to the observer and clock that produced it. */
export interface WireObservation {
  readonly clock: EventStreamClock;
  readonly observer: EventStreamObserver;
  readonly reading: WireValue;
}

/**
 * Identity COPIED from the source event, never minted. `commandId` is required on the page
 * shape and crosses verbatim. `principal` comes from the optional decision trace, genuinely
 * absent for non-decision events. `session` and `run` are the not-provided unknown on every
 * event today because the source carries neither — stating that explicitly is what stops a
 * later layer from inheriting a silent hole and calling it evidence.
 */
export interface WireEventIdentity {
  readonly commandId: string;
  readonly principal: WireValue;
  readonly run: WireValue;
  readonly session: WireValue;
}

/** The daemon's own clock, injected so a reading can be pinned and counted. */
export interface SeamObserver {
  now(): string;
}

/** The daemon's own clock. Injected everywhere else so a reading can be pinned and counted. */
export const DEFAULT_SEAM_OBSERVER: SeamObserver = Object.freeze({
  now: (): string => new Date().toISOString(),
});

function unknownValue(code: EventStreamUnknownCode): WireValue {
  return Object.freeze({ code, known: false as const, layer: EVENT_STREAM_LAYER });
}

function knownValue(value: string): WireValue {
  return Object.freeze({ known: true as const, value });
}

/**
 * A reading the source did not actually produce stays UNKNOWN. It never becomes `""`, never
 * a zero timestamp, and never the other clock's value — a borrowed reading would be a
 * fabricated observation wearing a real observer's name.
 */
function readingOf(value: unknown): WireValue {
  return typeof value === "string" && value !== ""
    ? knownValue(value)
    : unknownValue("EVENT_STREAM_READING_NOT_PROVIDED");
}

export function observation(
  observer: EventStreamObserver,
  clock: EventStreamClock,
  value: unknown,
): WireObservation {
  return Object.freeze({ clock, observer, reading: readingOf(value) });
}

/** Identity is COPIED from the source event. Nothing here synthesizes, defaults or derives. */
export function identityOf(event: StreamEvent): WireEventIdentity {
  const trace = event.decisionTrace;
  const notProvided = unknownValue("EVENT_STREAM_IDENTITY_NOT_PROVIDED");
  return Object.freeze({
    commandId: event.commandId,
    principal: trace === undefined ? notProvided : knownValue(trace.principalId),
    // The source carries no session and no run identity today. Emitting them as an explicit
    // not-provided unknown rather than omitting them keeps the gap visible, so a later layer
    // sees a stated absence instead of inheriting a silent hole.
    run: notProvided,
    session: notProvided,
  });
}
