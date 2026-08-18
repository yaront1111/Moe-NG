/**
 * The durable seam for one sealed Foundation context manifest.
 *
 * A SEPARATE AGGREGATE, DELIBERATELY. This record never lands on the Foundation
 * RESERVED/RECORDED aggregate: that aggregate's version arithmetic IS the
 * release protocol, and inserting a context manifest into it would silently
 * shift every expectedVersion the protocol depends on.
 *
 * NO IDENTIFIER IS ACCEPTED, ONLY DERIVED. Aggregate, event, command,
 * principal, correlation and request bytes are unrepresentable in the input
 * type; all are derived from the CODEC-ADMITTED record. That digest is NOT an
 * authenticity proof — it is unkeyed and an editor can recompute it. What
 * fences a foreign project is the STORE: `key.projectId` is the record's own,
 * and naming a project the handle is not bound to is PROJECT_SCOPE_MISMATCH.
 *
 * THREE NESTED PREIMAGES, one per question the store can be asked:
 *   aggregate = project + session + attempt          "whose context slot is this"
 *   command   = aggregate + node + revision + epoch  "which sealing command"
 *   request   = command + configuration + inputs + graph content
 * so a drifted configuration reuses the command id for a different request
 * (IDEMPOTENCY_CONFLICT -> REPLAY_DIVERGED), a drifted epoch is a different
 * command against an aggregate already at version 1 (EXPECTED_VERSION_CONFLICT),
 * and a re-render of the SAME command replays.
 *
 * THE REPLAY IS READ, NEVER ECHOED. The store's replay identity hashes
 * `requestBytes` and NOT the proposed events, so a second caller can replay
 * holding a different manifest; returning it would grant authority for bytes
 * nobody committed.
 *
 * No outbox, no apply callback, no schema change, no provider effect: the port
 * below names the only two store methods this module may reach.
 */

import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionResponse, CommitExpectedVersionDecisionInput,
  DurableStoreErrorCode, StoredEvent,
} from "@moe/store";

import {
  FOUNDATION_CONTEXT_RECORD_VERSION, encodeFoundationContextManifestRecord,
} from "./foundation-context-manifest-codec.js";
import type {
  FoundationContextManifestRecord, FoundationContextRefusal,
} from "./foundation-context-manifest-codec.js";
import {
  FOUNDATION_CONTEXT_COMMAND_KIND, deriveFoundationContextAggregateId,
  deriveFoundationContextCorrelationId, deriveFoundationContextDecisionKey,
  deriveFoundationContextEventId, deriveFoundationContextRequestBytes,
} from "./foundation-context-manifest-identity.js";
import {
  FOUNDATION_CONTEXT_EVENT_TYPE, FOUNDATION_CONTEXT_READER, FOUNDATION_CONTEXT_READER_CODES,
  readFoundationContextManifestEvent,
} from "./foundation-context-manifest-reader.js";
import type { FoundationContextReaderRefusal } from "./foundation-context-manifest-reader.js";

export { FOUNDATION_CONTEXT_EVENT_TYPE, FOUNDATION_CONTEXT_READER };
/**
 * The identity surface is re-exported, not redefined: one authority derives
 * these, and the strict reader imports it WITHOUT importing this writer.
 */
export {
  FOUNDATION_CONTEXT_COMMAND_KIND, deriveFoundationContextAggregateId,
  deriveFoundationContextCorrelationId, deriveFoundationContextDecisionKey,
  deriveFoundationContextEventId, deriveFoundationContextRequestBytes,
};
export type {
  FoundationContextSelectionIdentity, FoundationContextSlotIdentity,
} from "./foundation-context-manifest-identity.js";
/** The writer's layer; the durable read answers under the reader's own. */
export const FOUNDATION_CONTEXT_LEDGER = "FOUNDATION_CONTEXT_LEDGER" as const;

/**
 * `REPLAY_DIVERGED` is this module's own name for the store's
 * IDEMPOTENCY_CONFLICT — the store has no code by that name. A THROWN fault
 * stays apart from a RETURNED no-business-effect: one means the store never
 * answered, the other means it answered "no".
 */
const WRITER_CODES = Object.freeze([
  "FOUNDATION_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT",
  "FOUNDATION_CONTEXT_LEDGER_REPLAY_DIVERGED",
  "FOUNDATION_CONTEXT_LEDGER_STORE_UNAVAILABLE",
] as const);

/** Everything this module can answer with, its own three and the reader's four. */
export const FOUNDATION_CONTEXT_LEDGER_CODES = Object.freeze([
  ...WRITER_CODES, ...FOUNDATION_CONTEXT_READER_CODES,
] as const);

export type FoundationContextLedgerCode = (typeof FOUNDATION_CONTEXT_LEDGER_CODES)[number];
type WriterCode = (typeof WRITER_CODES)[number];
type Sealed = FoundationContextManifestRecord;

/**
 * The store seam, declared STRUCTURALLY rather than as `SqliteEventStore`, so
 * this module cannot reach a raw `DatabaseSync`, an outbox or a `WithApply`
 * variant even by accident.
 */
export interface FoundationContextLedgerStore {
  commitExpectedVersionDecision(i: CommitExpectedVersionDecisionInput): CommandDecisionResponse;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

/**
 * No record and no bytes: partial authority is unrepresentable. `storeCode` is
 * the store's own code verbatim, null when no store call refused.
 */
export interface FoundationContextLedgerRefusal {
  readonly code: WriterCode;
  readonly codecCode: null;
  readonly layer: typeof FOUNDATION_CONTEXT_LEDGER;
  readonly ok: false;
  readonly storeCode: DurableStoreErrorCode | null;
}

export interface FoundationContextLedgerCommitted {
  readonly aggregateId: string;
  readonly bytes: Uint8Array;
  readonly disposition: "COMMITTED" | "REPLAYED";
  readonly ok: true;
  /** The codec-admitted record on a commit; the DECODED durable one on a replay. */
  readonly record: Sealed;
}

export type FoundationContextLedgerResult =
  | FoundationContextLedgerCommitted | FoundationContextLedgerRefusal
  | FoundationContextReaderRefusal | FoundationContextRefusal;

/** Two fields. Every identifier the store sees is derived, never supplied. */
export interface FoundationContextCommitInput {
  readonly candidate: unknown;
  readonly decidedAt: string;
}

/** Every context manifest is the FIRST event on its own derived aggregate. */
const EXPECTED_VERSION = 0;
const UNAVAILABLE = "FOUNDATION_CONTEXT_LEDGER_STORE_UNAVAILABLE" as const;
const DIVERGED = "FOUNDATION_CONTEXT_LEDGER_REPLAY_DIVERGED" as const;
const STALE = "FOUNDATION_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT" as const;
function refuse(
  code: WriterCode, storeCode: DurableStoreErrorCode | null,
): FoundationContextLedgerRefusal {
  return Object.freeze({
    code, codecCode: null, layer: FOUNDATION_CONTEXT_LEDGER, ok: false as const, storeCode,
  });
}

/** A THROWN fault is not a durable state: "empty" would libel a silent store. */
function refuseThrown(error: unknown): FoundationContextLedgerRefusal {
  if (!(error instanceof DurableStoreError)) return refuse(UNAVAILABLE, null);
  if (error.code === "IDEMPOTENCY_CONFLICT") return refuse(DIVERGED, error.code);
  return refuse(UNAVAILABLE, error.code);
}

/** The DURABLE bytes. The candidate is not in scope, so an echo is unwritable. */
function answerReplayed(
  store: FoundationContextLedgerStore, aggregateId: string,
): FoundationContextLedgerResult {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(aggregateId); } catch (error) { return refuseThrown(error); }
  const durable = readFoundationContextManifestEvent(events);
  if (!durable.ok) return durable;
  return Object.freeze({
    aggregateId, bytes: durable.bytes, disposition: "REPLAYED" as const,
    ok: true as const, record: durable.record,
  });
}

/** Encode, derive, commit once, and answer a replay from the durable event. */
export function commitFoundationContextManifest(
  store: FoundationContextLedgerStore,
  input: FoundationContextCommitInput,
): FoundationContextLedgerResult {
  // The codec owns the candidate's diagnosis; restamping it here would hide
  // WHICH layer refused behind a code that says only "the ledger said no".
  const encoded = encodeFoundationContextManifestRecord(input.candidate);
  if (!encoded.ok) return encoded;
  const { bytes, record } = encoded;
  const aggregateId = deriveFoundationContextAggregateId(record);
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecision({
      commandKind: FOUNDATION_CONTEXT_COMMAND_KIND,
      committedResultBytes: bytes,
      correlationId: deriveFoundationContextCorrelationId(record.recordDigest),
      decidedAt: input.decidedAt,
      events: [{
        // Stamped explicitly: an omitted version persists the store's generic
        // default, a schema these bytes do not speak.
        domainSchemaVersion: FOUNDATION_CONTEXT_RECORD_VERSION,
        eventId: deriveFoundationContextEventId(record),
        eventType: FOUNDATION_CONTEXT_EVENT_TYPE,
        payload: bytes,
      }],
      expectedVersion: EXPECTED_VERSION,
      key: deriveFoundationContextDecisionKey(record),
      requestBytes: deriveFoundationContextRequestBytes(record),
      targetAggregateId: aggregateId,
    });
  } catch (error) {
    return refuseThrown(error);
  }
  // A version conflict is RETURNED, not thrown: the store writes a
  // NO_BUSINESS_EFFECT audit decision and appends no domain event. Reading "it
  // did not throw" as success would claim authority for a record never written.
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuse(STALE, response.decision.resultCode);
  }
  if (response.disposition === "REPLAYED") return answerReplayed(store, aggregateId);
  // COMMITTED: the store just wrote these exact bytes, so re-reading them would
  // prove nothing the append did not already prove.
  return Object.freeze({
    aggregateId, bytes, disposition: "COMMITTED" as const, ok: true as const, record,
  });
}
