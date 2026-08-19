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

import type {
  CommandDecisionKey, CommandDecisionRecord, CommandReceipt, StoredEvent,
} from "@moe/store";

import { decodeFoundationContextManifestRecord } from "./foundation-context-manifest-codec.js";
import {
  deriveFoundationContextAggregateId,
  deriveFoundationContextDecisionKey,
} from "./foundation-context-manifest-identity.js";
import type { FoundationContextSlotIdentity } from "./foundation-context-manifest-identity.js";
import {
  FOUNDATION_CONTEXT_PROOF_CODES, compareBinding, proveDecision, proveReceipt, selectionOf,
} from "./foundation-context-manifest-proofs.js";
import type { FoundationContextExpectedBinding } from "./foundation-context-manifest-proofs.js";
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

// ============================================================================
// THE STRICT READ (task-225d25f7). Everything above is the minimal event-level
// reader task-22fa35a5 landed and the ledger re-exports; it is unchanged.
// ============================================================================

/**
 * The strict reader's own roster. It is a SEPARATE constant rather than an
 * extension of `FOUNDATION_CONTEXT_READER_CODES` on purpose: the ledger spreads
 * that array into its own roster and documents it as "everything this module
 * can answer with", and the ledger can only ever produce the minimal four. A
 * kind it cannot answer must not appear on its advertised surface.
 */
export const FOUNDATION_CONTEXT_STRICT_CODES = Object.freeze([
  ...FOUNDATION_CONTEXT_READER_CODES,
  "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH",
  "FOUNDATION_CONTEXT_READER_STALE",
  ...FOUNDATION_CONTEXT_PROOF_CODES,
] as const);

export type FoundationContextStrictCode = (typeof FOUNDATION_CONTEXT_STRICT_CODES)[number];

/**
 * Like the landed refusal, but it CARRIES the store's own code. The minimal
 * shape pins `storeCode: null` because it never touches a store; this one does,
 * and flattening a store failure to null would lose the only evidence of why
 * the read could not be answered.
 */
export interface FoundationContextStrictRefusal {
  readonly code: FoundationContextStrictCode;
  readonly codecCode: FoundationContextManifestCode | null;
  readonly layer: typeof FOUNDATION_CONTEXT_READER;
  readonly ok: false;
  readonly storeCode: string | null;
}

export type FoundationContextStrictResult =
  | FoundationContextReadRecord
  | FoundationContextStrictRefusal;

/**
 * Three methods, none of which can write. Declared structurally so this module
 * cannot reach a raw `DatabaseSync`, a commit, or an outbox even by accident —
 * and so a caller cannot hand it a store handle and call that a read port.
 */
export interface FoundationContextReadPort {
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  getCommandReceipt(commandId: string): CommandReceipt | null;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

function strictRefuse(
  code: FoundationContextStrictCode,
  codecCode: FoundationContextManifestCode | null = null,
  storeCode: string | null = null,
): FoundationContextStrictRefusal {
  return Object.freeze({
    code, codecCode, layer: FOUNDATION_CONTEXT_READER, ok: false as const, storeCode,
  });
}

/** A thrown store keeps its own code; anything else is an opaque failure. */
function storeCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * The sealed context manifest for one server-derived slot, or a refusal.
 *
 * THE ORDER IS THE POINT. Existence and type, then the codec's decode — which
 * is also where canonical form is settled — then the durable proofs, then the
 * binding. Each stage assumes only what the ones before it established, and no
 * stage returns bytes: the single success return sits after every check.
 *
 * The stored `recordDigest` is never trusted, because it is a field IN the
 * bytes being judged and a forged record would otherwise certify itself. The
 * recomputation lives in the codec's decode (see the note below), not here.
 *
 * The aggregate id and the decision key are DERIVED from server identity via
 * the shared identity module — never re-derived locally, never taken from the
 * payload. Two derivations that agree today drift tomorrow. The decision key
 * comes from the DURABLE record's own selection, never from the caller's
 * expectation, or a binding disagreement would surface as a missing decision
 * and the comparison at the end would be unreachable.
 */
export function readFoundationContextManifest(
  port: FoundationContextReadPort,
  identity: FoundationContextSlotIdentity,
  expectedBinding: FoundationContextExpectedBinding,
): FoundationContextStrictResult {
  const aggregateId = deriveFoundationContextAggregateId(identity);
  let events: readonly StoredEvent[];
  try {
    events = port.readEvents(aggregateId);
  } catch (error) {
    return strictRefuse("FOUNDATION_CONTEXT_READER_UNREADABLE", null, storeCodeOf(error));
  }

  // Existence and type are the landed reader's job, composed rather than
  // restated so the two entries cannot disagree about what "one event" means.
  const durable = readFoundationContextManifestEvent(events);
  if (!durable.ok) return strictRefuse(durable.code, durable.codecCode);
  const event = events[0];
  if (event === undefined) return strictRefuse("FOUNDATION_CONTEXT_READER_ABSENT");

  // NO SECOND RE-ENCODE HERE, and that is deliberate. `decodeFoundationContext
  // ManifestRecord` (codec :242-246) already re-encodes what it decoded and
  // byte-compares it against the stored payload, answering its own
  // FOUNDATION_CONTEXT_NONCANONICAL when they differ — so the stored digest is
  // never trusted, it is just not trusted HERE. Repeating the comparison in this
  // module would be unreachable by construction: no input exists that the codec
  // admits and a second re-encode would reject. That refusal reaches a caller
  // through the landed reader above with the CODEC's code intact in `codecCode`,
  // which is what tells a reader that the bytes, not the binding, were wrong.

  const selection = selectionOf(durable.record);
  let decision: CommandDecisionRecord | null;
  let receipt: CommandReceipt | null;
  try {
    decision = port.getCommandDecision(deriveFoundationContextDecisionKey(selection));
    // The receipt is keyed by the command the EVENT records, which is the
    // durable link between the append and the command that made it.
    receipt = decision === null ? null : port.getCommandReceipt(event.commandId);
  } catch (error) {
    return strictRefuse("FOUNDATION_CONTEXT_READER_UNREADABLE", null, storeCodeOf(error));
  }
  const decisionFault = proveDecision(decision, event);
  if (decisionFault !== null || decision === null) {
    return strictRefuse(decisionFault ?? "FOUNDATION_CONTEXT_READER_DECISION_MISSING");
  }
  const receiptFault = proveReceipt(receipt, decision, event);
  if (receiptFault !== null) return strictRefuse(receiptFault);

  const disagreement = compareBinding(durable.record, identity, expectedBinding);
  if (disagreement !== null) return strictRefuse(disagreement);
  return durable;
}
