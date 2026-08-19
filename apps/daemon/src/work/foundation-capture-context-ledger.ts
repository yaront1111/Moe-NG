/**
 * The durable seam for one sealed Foundation capture context, and the identity
 * authority that names it.
 *
 * ONE THING CROSSES THE GAP, AND IT IS NOT A MAP. Prepare derives a `captureRef`
 * from the attempt's durable identities and commits under an aggregate derived
 * FROM THAT REF. Capture is handed the ref and nothing else: it re-derives the
 * aggregate, reads the record, and re-derives the ref from what it read. The only
 * state connecting the two moments is one immutable string — what "no
 * process-local context map" has to mean in code rather than in a comment.
 *
 * A SEPARATE AGGREGATE, DELIBERATELY. This never lands on the Foundation
 * RESERVED/RECORDED aggregate, whose version arithmetic IS the release protocol.
 *
 * NEW NAMESPACES THROUGHOUT. None reuses `moe-foundation-context/1:` or its
 * siblings, whose bytes are pinned by hand-transcribed goldens; a shared
 * namespace would let a capture record and a context manifest collide on one
 * aggregate in one store.
 *
 * NO IDENTIFIER IS ACCEPTED, ONLY DERIVED — aggregate, command, principal,
 * correlation, event and request bytes are unrepresentable in the commit input.
 * The record digest is unkeyed and proves nothing about authenticity; what fences
 * a foreign project is the STORE, where `key.projectId` is the record's own.
 *
 * THE REPLAY IS READ, NEVER ECHOED. The store's replay identity hashes
 * `requestBytes`, not the proposed events, so a second caller can replay holding
 * a different record; returning theirs would grant authority for bytes nobody
 * committed.
 */

import { createHash } from "node:crypto";

import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey, CommandDecisionResponse, CommitExpectedVersionDecisionInput,
  DurableStoreErrorCode, StoredEvent,
} from "@moe/store";

import {
  FOUNDATION_CAPTURE_CONTEXT_VERSION, decodeFoundationCaptureContext,
  encodeFoundationCaptureContext,
} from "./foundation-capture-context-contract.js";
import type {
  FoundationCaptureContextCode, FoundationCaptureContextRecord,
  FoundationCaptureContextRefusal,
} from "./foundation-capture-context-contract.js";

export const FOUNDATION_CAPTURE_CONTEXT_COMMAND_KIND = "foundation.capture-context.seal" as const;
export const FOUNDATION_CAPTURE_CONTEXT_EVENT_TYPE =
  "foundation.capture-context.sealed.v1" as const;

/** The writer's stamp and the durable reader's, kept apart so `layer` is an
 *  answer rather than a constant. Neither is `_LAYER`-suffixed: that suffix is
 *  what the daemon security scanner reads as a public boundary owing a roster. */
export const DAEMON_FOUNDATION_CAPTURE_LEDGER = "DAEMON_FOUNDATION_CAPTURE_LEDGER" as const;
export const DAEMON_FOUNDATION_CAPTURE_READER = "DAEMON_FOUNDATION_CAPTURE_READER" as const;

const WRITER_CODES = Object.freeze([
  "FOUNDATION_CAPTURE_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT",
  "FOUNDATION_CAPTURE_CONTEXT_LEDGER_REPLAY_DIVERGED",
  "FOUNDATION_CAPTURE_CONTEXT_LEDGER_STORE_UNAVAILABLE",
] as const);

/**
 * Six reader answers, none standing in for another: nothing there, two things
 * there, another producer owns this stream, the bytes are corrupt, this record
 * describes a different attempt, this event is not where it claims to be.
 */
const READER_CODES = Object.freeze([
  "FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT",
  "FOUNDATION_CAPTURE_CONTEXT_READER_AMBIGUOUS",
  "FOUNDATION_CAPTURE_CONTEXT_READER_EVENT_TYPE_UNEXPECTED",
  "FOUNDATION_CAPTURE_CONTEXT_READER_UNREADABLE",
  "FOUNDATION_CAPTURE_CONTEXT_READER_REF_MISMATCH",
  "FOUNDATION_CAPTURE_CONTEXT_READER_BINDING_MISMATCH",
] as const);

export const FOUNDATION_CAPTURE_CONTEXT_LEDGER_CODES = Object.freeze([
  ...WRITER_CODES, ...READER_CODES,
] as const);
export type FoundationCaptureContextLedgerCode =
  (typeof FOUNDATION_CAPTURE_CONTEXT_LEDGER_CODES)[number];
type WriterCode = (typeof WRITER_CODES)[number];
type ReaderCode = (typeof READER_CODES)[number];

// --- identity ----------------------------------------------------------------

/** The narrowest identity a capture slot is allowed to see. No digest, no
 *  content: a re-prepared attempt must land on the SAME slot, not a new one. */
export interface FoundationCaptureSlotIdentity {
  readonly attemptAggregateId: string;
  readonly attemptId: string;
  readonly nodeKey: string;
  readonly projectId: string;
  readonly sessionId: string;
}

/** The slot plus the two upstream digests the sealing command is issued under. */
export interface FoundationCaptureCommandIdentity extends FoundationCaptureSlotIdentity {
  readonly recordDigest: string;
  readonly requestDigest: string;
  readonly reservationDigest: string;
}

type Parts = readonly (string | number)[];

const AGGREGATE_NAMESPACE = "moe-foundation-capture-context/1:";
const CAPTURE_REF_NAMESPACE = "moe-foundation-capture-context-ref/1:";
const COMMAND_NAMESPACE = "moe-foundation-capture-context-command/1:";
const CORRELATION_NAMESPACE = "moe-foundation-capture-context-correlation/1:";
const EVENT_NAMESPACE = "moe-foundation-capture-context-event/1:";
const PRINCIPAL_NAMESPACE = "moe-foundation-capture-context-principal/1:";
const REQUEST_NAMESPACE = "moe-foundation-capture-context-request/1:";
const encoder = new TextEncoder();

/** Length-prefixed: `"ab" + "c"` and `"a" + "bc"` must not hash alike. */
function frame(parts: Parts): string {
  return parts.map((part) => `${String(part).length}:${String(part)}`).join("|");
}

function identifier(namespace: string, parts: Parts): string {
  const hashed = createHash("sha256").update(`${namespace}${frame(parts)}`, "utf8").digest("hex");
  return `${namespace}sha256:${hashed}`;
}

function slotParts(slot: FoundationCaptureSlotIdentity): Parts {
  return [FOUNDATION_CAPTURE_CONTEXT_VERSION, slot.projectId, slot.sessionId,
    slot.attemptAggregateId, slot.attemptId, slot.nodeKey];
}

/**
 * The one value that crosses from prepare to capture. Derived from the slot
 * alone, so re-preparing the SAME attempt answers the same ref and lands on the
 * same durable slot instead of quietly opening a second one.
 */
export function deriveFoundationCaptureRef(slot: FoundationCaptureSlotIdentity): string {
  return identifier(CAPTURE_REF_NAMESPACE, slotParts(slot));
}

/**
 * FROM THE REF, not from the slot: capture holds only the ref, so deriving from
 * the slot would force it to carry the slot too, and a second carried value is a
 * second thing that can disagree.
 */
export function deriveFoundationCaptureAggregateId(captureRef: string): string {
  return identifier(AGGREGATE_NAMESPACE, [captureRef]);
}

export function deriveFoundationCaptureDecisionKey(
  identity: FoundationCaptureCommandIdentity,
): CommandDecisionKey {
  return Object.freeze({
    commandId: identifier(COMMAND_NAMESPACE, [...slotParts(identity),
      identity.reservationDigest, identity.requestDigest]),
    principalId: identifier(PRINCIPAL_NAMESPACE, [identity.projectId, identity.sessionId]),
    // The store scopes every decision by project; this is the record's OWN
    // project, already bound by its digest, so it cannot name a foreign one.
    projectId: identity.projectId,
  });
}

/**
 * The record digest IS in the request preimage and is NOT in the command
 * preimage. That asymmetry is the conflict protocol: re-sealing the same attempt
 * with a CHANGED field reuses the command id under a different request, which the
 * store answers IDEMPOTENCY_CONFLICT, while an identical re-seal replays.
 */
export function deriveFoundationCaptureRequestBytes(
  identity: FoundationCaptureCommandIdentity,
): Uint8Array {
  return encoder.encode(`${REQUEST_NAMESPACE}${frame([...slotParts(identity),
    identity.reservationDigest, identity.requestDigest, identity.recordDigest])}`);
}

/**
 * DELIBERATELY NOT THE COMMAND ID, though both hash the same parts: the command
 * id fences idempotent redelivery, the event id names one appended fact. Sharing
 * one derivation typechecks and makes two distinct durable identities equal.
 */
export function deriveFoundationCaptureEventId(
  identity: FoundationCaptureCommandIdentity,
): string {
  return identifier(EVENT_NAMESPACE, [...slotParts(identity), identity.reservationDigest,
    identity.requestDigest]);
}

/** Over the SEALED CONTENT digest: correlation groups the record written. */
export function deriveFoundationCaptureCorrelationId(recordDigest: string): string {
  return identifier(CORRELATION_NAMESPACE, [recordDigest]);
}

// --- durable seam ------------------------------------------------------------

/**
 * Declared STRUCTURALLY rather than as `SqliteEventStore`, so this module cannot
 * reach a raw handle, an outbox or a `WithApply` variant even by accident.
 */
export interface FoundationCaptureContextStore {
  commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput): CommandDecisionResponse;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

/** No record and no bytes: partial authority is unrepresentable, not merely unset. */
export interface FoundationCaptureContextLedgerRefusal {
  readonly code: WriterCode;
  readonly codecCode: null;
  readonly layer: typeof DAEMON_FOUNDATION_CAPTURE_LEDGER;
  readonly ok: false;
  readonly storeCode: DurableStoreErrorCode | null;
}

export interface FoundationCaptureContextReaderRefusal {
  readonly code: ReaderCode;
  readonly codecCode: FoundationCaptureContextCode | null;
  readonly layer: typeof DAEMON_FOUNDATION_CAPTURE_READER;
  readonly ok: false;
  readonly storeCode: null;
}

export interface FoundationCaptureContextSealed {
  readonly aggregateId: string;
  readonly bytes: Uint8Array;
  readonly captureRef: string;
  readonly disposition: "COMMITTED" | "REPLAYED";
  readonly ok: true;
  readonly record: FoundationCaptureContextRecord;
}

export type FoundationCaptureContextCommitResult =
  | FoundationCaptureContextSealed | FoundationCaptureContextLedgerRefusal
  | FoundationCaptureContextReaderRefusal | FoundationCaptureContextRefusal;

export type FoundationCaptureContextReadResult =
  | FoundationCaptureContextSealed | FoundationCaptureContextReaderRefusal;

/** Two fields. Every identifier the store sees is derived, never supplied. */
export interface FoundationCaptureContextCommitInput {
  readonly candidate: unknown;
  readonly decidedAt: string;
}

/** Every capture context is the FIRST event on its own derived aggregate. */
const EXPECTED_VERSION = 0;
const FIRST_SEQUENCE = 1;

function refuseWriter(
  code: WriterCode, storeCode: DurableStoreErrorCode | null,
): FoundationCaptureContextLedgerRefusal {
  return Object.freeze({
    code, codecCode: null, layer: DAEMON_FOUNDATION_CAPTURE_LEDGER, ok: false as const, storeCode,
  });
}

function refuseReader(
  code: ReaderCode, codecCode: FoundationCaptureContextCode | null,
): FoundationCaptureContextReaderRefusal {
  return Object.freeze({
    code, codecCode, layer: DAEMON_FOUNDATION_CAPTURE_READER, ok: false as const, storeCode: null,
  });
}

/** A THROWN fault is not a durable state: "empty" would libel a silent store. */
function refuseThrown(error: unknown): FoundationCaptureContextLedgerRefusal {
  if (!(error instanceof DurableStoreError)) {
    return refuseWriter("FOUNDATION_CAPTURE_CONTEXT_LEDGER_STORE_UNAVAILABLE", null);
  }
  if (error.code === "IDEMPOTENCY_CONFLICT") {
    return refuseWriter("FOUNDATION_CAPTURE_CONTEXT_LEDGER_REPLAY_DIVERGED", error.code);
  }
  return refuseWriter("FOUNDATION_CAPTURE_CONTEXT_LEDGER_STORE_UNAVAILABLE", error.code);
}

/**
 * The full verification the durable read owes, in order, one code per failure.
 * The codec's RE-ENCODE separates "these bytes parse to a valid record" from
 * "these bytes ARE the record": a decode-only reader cannot see a stored-byte
 * edit that still parses.
 */
function answerFromEvents(
  events: readonly StoredEvent[], captureRef: string, aggregateId: string,
): FoundationCaptureContextReadResult {
  if (events.length === 0) return refuseReader("FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT", null);
  // COUNTED, NOT PICKED. Taking the first or the last would answer with one of
  // two records that disagree and call it authority.
  if (events.length > 1) {
    return refuseReader("FOUNDATION_CAPTURE_CONTEXT_READER_AMBIGUOUS", null);
  }
  const event = events[0];
  if (event === undefined || event.eventType !== FOUNDATION_CAPTURE_CONTEXT_EVENT_TYPE) {
    return refuseReader("FOUNDATION_CAPTURE_CONTEXT_READER_EVENT_TYPE_UNEXPECTED", null);
  }
  if (event.aggregateId !== aggregateId || event.aggregateSequence !== FIRST_SEQUENCE
    || event.domainSchemaVersion !== FOUNDATION_CAPTURE_CONTEXT_VERSION) {
    return refuseReader("FOUNDATION_CAPTURE_CONTEXT_READER_BINDING_MISMATCH", null);
  }
  const decoded = decodeFoundationCaptureContext(event.payload);
  if (!decoded.ok) {
    return refuseReader("FOUNDATION_CAPTURE_CONTEXT_READER_UNREADABLE", decoded.code);
  }
  if (deriveFoundationCaptureRef(decoded.record) !== captureRef) {
    return refuseReader("FOUNDATION_CAPTURE_CONTEXT_READER_REF_MISMATCH", null);
  }
  return Object.freeze({
    aggregateId, bytes: event.payload, captureRef, disposition: "REPLAYED" as const,
    ok: true as const, record: decoded.record,
  });
}

/**
 * Read one prepared capture context by the ref prepare derived. The record is
 * plain frozen data: it crosses the captureResult port, where an accessor would
 * be flattened and a throw would become an UNKNOWN capture.
 */
export function readFoundationCaptureContext(
  store: FoundationCaptureContextStore, captureRef: string,
): FoundationCaptureContextReadResult {
  const aggregateId = deriveFoundationCaptureAggregateId(captureRef);
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(aggregateId);
  } catch {
    return refuseReader("FOUNDATION_CAPTURE_CONTEXT_READER_UNREADABLE", null);
  }
  return answerFromEvents(events, captureRef, aggregateId);
}

/** Encode, derive, commit once, and answer a replay from the DURABLE event. */
export function commitFoundationCaptureContext(
  store: FoundationCaptureContextStore, input: FoundationCaptureContextCommitInput,
): FoundationCaptureContextCommitResult {
  // The codec owns the candidate's diagnosis; restamping it here would hide
  // WHICH layer refused behind a code that says only "the ledger said no".
  const encoded = encodeFoundationCaptureContext(input.candidate);
  if (!encoded.ok) return encoded;
  const { bytes, record } = encoded;
  const captureRef = deriveFoundationCaptureRef(record);
  const aggregateId = deriveFoundationCaptureAggregateId(captureRef);
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecision({
      commandKind: FOUNDATION_CAPTURE_CONTEXT_COMMAND_KIND,
      committedResultBytes: bytes,
      correlationId: deriveFoundationCaptureCorrelationId(record.recordDigest),
      decidedAt: input.decidedAt,
      events: [{
        // Stamped explicitly: an omitted version persists the store's generic
        // default, a schema these bytes do not speak.
        domainSchemaVersion: FOUNDATION_CAPTURE_CONTEXT_VERSION,
        eventId: deriveFoundationCaptureEventId(record),
        eventType: FOUNDATION_CAPTURE_CONTEXT_EVENT_TYPE,
        payload: bytes,
      }],
      expectedVersion: EXPECTED_VERSION,
      key: deriveFoundationCaptureDecisionKey(record),
      requestBytes: deriveFoundationCaptureRequestBytes(record),
      targetAggregateId: aggregateId,
    });
  } catch (error) {
    return refuseThrown(error);
  }
  // A version conflict is RETURNED, not thrown: the store writes a
  // NO_BUSINESS_EFFECT audit decision and appends no domain event. Reading "it
  // did not throw" as success would claim authority for a record never written.
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuseWriter("FOUNDATION_CAPTURE_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT",
      response.decision.resultCode);
  }
  if (response.disposition === "REPLAYED") return readFoundationCaptureContext(store, captureRef);
  // COMMITTED: the store just wrote these exact bytes, so re-reading them would
  // prove nothing the append did not already prove.
  return Object.freeze({
    aggregateId, bytes, captureRef, disposition: "COMMITTED" as const, ok: true as const, record,
  });
}
