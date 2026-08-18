/**
 * What the durable events under one context-manifest aggregate actually say.
 *
 * FOUR STATES, FOUR ANSWERS. "Nothing is there", "two things are there", "the
 * wrong thing is there" and "it cannot be read" are four different operator
 * problems: the first says the commit never landed, the second says two writers
 * reached the same aggregate, the third says another producer owns this stream,
 * and the fourth says the bytes are corrupt. Collapsing any pair would report a
 * corruption as an absence, which reads as "retry" when the truth is "stop".
 *
 * NO AUTHORITY IS MINTED HERE. The record comes back only from the codec's own
 * decode of the durable payload, and the bytes returned are the durable bytes.
 * A refusal carries the codec's verbatim code in `codecCode` and never restamps
 * it as a diagnosis of this layer's own.
 *
 * This module reads; it never commits, and it holds no store handle — its input
 * is the event list a caller already read.
 */

import type { StoredEvent } from "@moe/store";

import { decodeFoundationContextManifestRecord } from "./foundation-context-manifest-codec.js";
import type {
  FoundationContextManifestCode,
  FoundationContextManifestRecord,
} from "./foundation-context-manifest-codec.js";

/** Names the layer that answered; the durable read is the only member. */
export const FOUNDATION_CONTEXT_READER = "FOUNDATION_CONTEXT_READER" as const;

/** The versioned event type a sealed context manifest is written under. */
export const FOUNDATION_CONTEXT_EVENT_TYPE = "foundation.context-manifest.sealed.v1" as const;

export const FOUNDATION_CONTEXT_READER_CODES = Object.freeze([
  "FOUNDATION_CONTEXT_READER_ABSENT",
  "FOUNDATION_CONTEXT_READER_AMBIGUOUS",
  "FOUNDATION_CONTEXT_READER_EVENT_TYPE_UNEXPECTED",
  "FOUNDATION_CONTEXT_READER_UNREADABLE",
] as const);

export type FoundationContextReaderCode = (typeof FOUNDATION_CONTEXT_READER_CODES)[number];

/** No record and no bytes: partial authority is unrepresentable, not merely unset. */
export interface FoundationContextReaderRefusal {
  readonly code: FoundationContextReaderCode;
  readonly codecCode: FoundationContextManifestCode | null;
  readonly layer: typeof FOUNDATION_CONTEXT_READER;
  readonly ok: false;
  readonly storeCode: null;
}

export interface FoundationContextReadRecord {
  readonly bytes: Uint8Array;
  readonly ok: true;
  readonly record: FoundationContextManifestRecord;
}

export type FoundationContextReadResult =
  | FoundationContextReadRecord
  | FoundationContextReaderRefusal;

function refuse(
  code: FoundationContextReaderCode,
  codecCode: FoundationContextManifestCode | null,
): FoundationContextReaderRefusal {
  return Object.freeze({
    code, codecCode, layer: FOUNDATION_CONTEXT_READER, ok: false as const, storeCode: null,
  });
}

/**
 * EXACTLY ONE event of this module's own type, decoded, or a refusal.
 *
 * The events are not filtered by type first: this aggregate is derived for one
 * sealed manifest and nothing else writes to it, so a foreign event there is a
 * fact worth refusing rather than one worth skipping. Filtering would turn a
 * lone wrong-typed event into an ABSENT and lose the difference.
 */
export function readFoundationContextManifestEvent(
  events: readonly StoredEvent[],
): FoundationContextReadResult {
  if (events.length === 0) return refuse("FOUNDATION_CONTEXT_READER_ABSENT", null);
  if (events.length > 1) return refuse("FOUNDATION_CONTEXT_READER_AMBIGUOUS", null);
  const event = events[0];
  if (event === undefined || event.eventType !== FOUNDATION_CONTEXT_EVENT_TYPE) {
    return refuse("FOUNDATION_CONTEXT_READER_EVENT_TYPE_UNEXPECTED", null);
  }
  const decoded = decodeFoundationContextManifestRecord(event.payload);
  if (!decoded.ok) return refuse("FOUNDATION_CONTEXT_READER_UNREADABLE", decoded.code);
  return Object.freeze({ bytes: event.payload, ok: true as const, record: decoded.record });
}
