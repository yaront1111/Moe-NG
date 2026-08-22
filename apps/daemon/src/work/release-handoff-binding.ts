import { DAEMON_JOURNAL_APPEND } from "../journal/journal-contracts.js";
import { readStoredReceipt } from "../evidence/foundation-verification-store.js";
import { readCurrentAttemptJournal } from "../journal/journal-reader.js";
import { resolveAttemptReceipt } from "./release-receipt-scan.js";
import type { ReleaseHandoffReceipt } from "./release-receipt-scan.js";
import {
  decodeFoundationPayload, encodeFoundationPayload, sameBytes,
} from "./foundation-attempt-codec.js";

import type { JournalCode } from "../journal/journal-contracts.js";
import type { CommandDecisionKey, SqliteEventStore, StoredEvent } from "@moe/store";

/**
 * THE DURABLE WORKER-HANDOFF BINDING AND RECEIPT REF of a released attempt — the
 * last two `ExpansionReleaseEvidence` facts (`expansion-planning-hold.ts:26/:33`)
 * with no production producer.
 *
 * TWO HANDOFFS EXIST AND THEY ARE NOT THE SAME OBJECT. The kernel takes a NINE-key
 * `ReleaseHandoff` (`lease-drain.ts:41`) that arrives on the request and is
 * shape-validated only — a relay. Core's `ExpansionHandoffBinding` is TWO keys,
 * `{digest, ref}`, value-compared by `safeRelease` (`expansion-planning-hold.ts:214`).
 * Deriving one from the other would launder caller bytes into durable authority,
 * so this module never reads the request: the digest comes from the journal
 * `journal.append` folded, the ref is the activation digest the ingress derived.
 *
 * THE TWO ANCHORS. HANDOFF -> `readCurrentAttemptJournal` (`journal-reader.ts:132`),
 * which re-derives the digest from the durable entries and refuses
 * JOURNAL_DIGEST_MISMATCH on drift; its refusals ride out under ITS layer.
 * RECEIPT -> the scan-then-re-read discipline `indexDurableReceipts`
 * (`goal-qualification-reads.ts:108`) already runs in production: the scanned
 * bytes name a `verificationId` and NOTHING else, and the answer comes from
 * `readStoredReceipt`, the one path that re-decodes, re-encodes and byte-compares.
 * This module pins the result durably so the consumer (task-e62e3828) never scans.
 *
 * A RECEIPT IS A FACT, NOT A REQUIREMENT: `receipt: null` is a measured absence
 * (`./release-receipt-scan.js` owns that question), and only an AMBIGUOUS one
 * refuses — absent and ambiguous demand opposite repairs.
 */

const LAYER = "DAEMON_RELEASE_HANDOFF";
/** MODULE-PRIVATE: a runtime column-zero `*_LAYER` export is a declared
 *  boundary the security roster then polices. Only the TYPE escapes. */
export type HandoffBindingLayer =
  typeof LAYER | typeof DAEMON_JOURNAL_APPEND | "DAEMON_VERIFICATION_RECEIPT";

export const RELEASE_HANDOFF_BINDING_CODES = Object.freeze([
  "RELEASE_HANDOFF_BINDING_ABSENT", "RELEASE_HANDOFF_BINDING_AMBIGUOUS",
  "RELEASE_HANDOFF_BINDING_COMMIT_UNAVAILABLE", "RELEASE_HANDOFF_BINDING_DIGEST_MISMATCH",
  "RELEASE_HANDOFF_BINDING_PROJECT_MISMATCH", "RELEASE_HANDOFF_BINDING_RECEIPT_AMBIGUOUS",
  "RELEASE_HANDOFF_BINDING_RECEIPT_DRIFT", "RELEASE_HANDOFF_BINDING_UNREADABLE",
] as const);
export type HandoffBindingCode = (typeof RELEASE_HANDOFF_BINDING_CODES)[number];

export const RELEASE_HANDOFF_BINDING_EVENT_TYPE = "ReleaseHandoffBindingRecorded";
export const RELEASE_HANDOFF_BINDING_RECORD_VERSION = "moe-release-handoff-binding/1";
const COMMAND_KIND = "attempt.release";

/** Exactly the keys the durable body carries; the reader pins this set. */
export interface ReleaseHandoffBinding {
  readonly attemptAggregateId: string; readonly attemptRef: string;
  readonly derivedAt: string;
  readonly handoff: { readonly digest: string; readonly ref: string };
  readonly projectId: string; readonly receipt: ReleaseHandoffReceipt | null;
  readonly recordVersion: typeof RELEASE_HANDOFF_BINDING_RECORD_VERSION;
  readonly releaseCommandId: string;
}

export interface HandoffBindingRefused {
  /** This module's own code, or an upstream one carried VERBATIM with its layer. */
  readonly code: HandoffBindingCode | JournalCode | string;
  readonly layer: HandoffBindingLayer;
  readonly ok: false;
}
export interface HandoffBindingAnswer {
  readonly binding: ReleaseHandoffBinding; readonly ok: true;
}
/**
 * NO JOURNAL, SO NO BINDING — neither a refusal nor a binding. Refusing on
 * `JOURNAL_RECORD_ABSENT` would make every release depend on `journal.append`,
 * which NO production caller sends today; an empty digest would manufacture
 * evidence. The release stands, no row is composed, the reader answers ABSENT.
 */
export interface HandoffBindingUnwritten {
  readonly ok: true; readonly written: false;
}
/** What the READER answers: a binding, or a refusal naming why there is none. */
export type HandoffBindingOutcome = HandoffBindingAnswer | HandoffBindingRefused;
/** What the WRITER answers, with the third arm the reader can never produce. */
export type HandoffWriteOutcome = HandoffBindingOutcome | HandoffBindingUnwritten;
export type { ReleaseHandoffReceipt };

export interface HandoffBindingInput {
  readonly activationDigest: string; readonly attemptAggregateId: string;
  readonly attemptRef: string; readonly correlationId: string;
  readonly key: CommandDecisionKey;
  readonly projectId: string; readonly releaseCommandId: string;
  readonly requestBytes: Uint8Array;
}

export interface HandoffBindingQuery {
  readonly attemptAggregateId: string; readonly projectId: string;
}

const refuse = (
  code: HandoffBindingRefused["code"], layer: HandoffBindingLayer = LAYER,
): HandoffBindingRefused => Object.freeze({ code, layer, ok: false as const });

/**
 * Per ATTEMPT and NOT content-addressed, so a re-release APPENDS rather than
 * colliding. The PROJECT IS NOT IN THE KEY: keying by it would answer ABSENT —
 * "this attempt never bound a handoff" — where the truth is that the row belongs
 * to another project, which the body carries and the reader refuses on.
 */
export const deriveReleaseHandoffAggregateId = (
  attemptAggregateId: string,
): string => `release-handoff:${attemptAggregateId}`;

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** The scan answers in this vocabulary but names no layer, so its refusal is
 *  re-raised here rather than carried from another authority. */
const isScanRefusal = (value: unknown): value is { readonly code: HandoffBindingCode } =>
  typeof value === "object" && value !== null && "ok" in value;

/** Derive both facts from durable authority and commit ONE event. The journal's
 *  refusals travel out under DAEMON_JOURNAL_APPEND with their own codes: handoff
 *  evidence that cannot be READ is UNKNOWN, and unknown is not empty. */
export function recordReleaseHandoffBinding(
  store: SqliteEventStore, input: HandoffBindingInput,
): HandoffWriteOutcome {
  const journal = readCurrentAttemptJournal(store, input.activationDigest, input.projectId);
  if (!journal.ok) {
    // ABSENT is the empty journal and ONLY that; every other answer is a durable
    // inconsistency and refuses under the journal's own layer.
    return journal.code === "JOURNAL_RECORD_ABSENT"
      ? Object.freeze({ ok: true as const, written: false as const })
      : refuse(journal.code, journal.layer);
  }
  const receipt = resolveAttemptReceipt(store, input.attemptAggregateId);
  if (isScanRefusal(receipt)) return refuse(receipt.code);
  // A DURABLE INSTANT, never a clock read: a wall-clock stamp would make the
  // bytes differ on every re-derivation, so a replay would compose a second truth.
  const newest = journal.entries[journal.entries.length - 1];
  if (newest === undefined) return refuse("RELEASE_HANDOFF_BINDING_UNREADABLE");
  const binding: ReleaseHandoffBinding = Object.freeze({
    attemptAggregateId: input.attemptAggregateId, attemptRef: input.attemptRef,
    derivedAt: newest.occurredAt,
    handoff: Object.freeze({ digest: journal.journalDigest, ref: input.activationDigest }),
    projectId: input.projectId, receipt,
    recordVersion: RELEASE_HANDOFF_BINDING_RECORD_VERSION,
    releaseCommandId: input.releaseCommandId,
  });
  const encoded = encodeFoundationPayload(binding as unknown as Record<string, unknown>);
  if (!encoded.ok) return refuse("RELEASE_HANDOFF_BINDING_UNREADABLE");
  const aggregateId = deriveReleaseHandoffAggregateId(input.attemptAggregateId);
  let committed = false;
  try {
    const response = store.commitExpectedVersionDecision({
      commandKind: COMMAND_KIND, committedResultBytes: encoded.bytes,
      correlationId: input.correlationId, decidedAt: newest.occurredAt,
      events: [{
        eventId: `${encoded.digest}:HANDOFF`,
        eventType: RELEASE_HANDOFF_BINDING_EVENT_TYPE, payload: encoded.bytes,
      }],
      expectedVersion: store.readEvents(aggregateId).length,
      key: input.key, requestBytes: input.requestBytes, targetAggregateId: aggregateId,
    });
    committed = response.decision.effectDisposition === "EFFECTS_COMMITTED";
  } catch { committed = false; }
  // REPLAY-IDEMPOTENT ON IDENTICAL BYTES. The same release re-derived answers the
  // same body; the store then declines the write — by conflict or by throw — and
  // the row already standing IS the answer. A body that DIFFERS is a real
  // conflict, and a second truth about one release is never composed here.
  if (!committed && !alreadyRecorded(store, aggregateId, encoded.bytes)) {
    return refuse("RELEASE_HANDOFF_BINDING_COMMIT_UNAVAILABLE");
  }
  return Object.freeze({ binding, ok: true as const });
}

/** The bytes this call would have written, already on the aggregate. */
function alreadyRecorded(
  store: SqliteEventStore, aggregateId: string, bytes: Uint8Array,
): boolean {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(aggregateId); } catch { return false; }
  return events.some((event) => event.eventType === RELEASE_HANDOFF_BINDING_EVENT_TYPE
    && sameBytes(event.payload, bytes));
}

const BODY_KEYS: readonly string[] = Object.freeze([
  "attemptAggregateId", "attemptRef", "derivedAt", "handoff", "projectId", "receipt",
  "recordVersion", "releaseCommandId",
]);

/** Re-decoded AND re-encoded bytes, byte-compared: two objects can be
 *  deep-equal while their canonical bytes differ. */
function decodeBinding(event: StoredEvent): ReleaseHandoffBinding | null {
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return null;
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) return null;
  const keys = Object.keys(decoded.value).sort();
  if (keys.length !== BODY_KEYS.length || !keys.every((key) => BODY_KEYS.includes(key))) {
    return null;
  }
  const handoff = decoded.value["handoff"];
  if (decoded.value["recordVersion"] !== RELEASE_HANDOFF_BINDING_RECORD_VERSION) return null;
  if (typeof handoff !== "object" || handoff === null) return null;
  const { digest, ref } = handoff as Record<string, unknown>;
  if (!text(digest) || !text(ref)) return null;
  return Object.freeze(decoded.value as unknown as ReleaseHandoffBinding);
}

/** A stored sha that no longer matches the row it names is DRIFT: a binding
 *  pointing at bytes that changed under it is not evidence. Receipt layer kept. */
function reReadReceipt(
  store: SqliteEventStore, receipt: ReleaseHandoffReceipt,
): HandoffBindingRefused | null {
  const stored = readStoredReceipt(store, receipt.verificationId);
  if (!stored.ok) return refuse(stored.code, "DAEMON_VERIFICATION_RECEIPT");
  return stored.row["receiptSha256"] === receipt.receiptSha256
    ? null : refuse("RELEASE_HANDOFF_BINDING_RECEIPT_DRIFT");
}

/** Neither binding is trusted as stored: the journal digest is re-derived and the
 *  receipt is re-read, so a row that drifted from what it references refuses. */
function reverify(
  store: SqliteEventStore, binding: ReleaseHandoffBinding,
): HandoffBindingOutcome {
  const journal = readCurrentAttemptJournal(
    store, binding.handoff.ref, binding.projectId);
  if (!journal.ok) return refuse(journal.code, journal.layer);
  if (journal.journalDigest !== binding.handoff.digest) {
    return refuse("RELEASE_HANDOFF_BINDING_DIGEST_MISMATCH");
  }
  const { receipt } = binding;
  if (receipt !== null) {
    const stored = reReadReceipt(store, receipt);
    if (stored !== null) return stored;
  }
  return Object.freeze({ binding, ok: true as const });
}

export function readReleaseHandoffBinding(
  store: SqliteEventStore, query: HandoffBindingQuery,
): HandoffBindingOutcome {
  if (!text(query.attemptAggregateId) || !text(query.projectId)) {
    return refuse("RELEASE_HANDOFF_BINDING_UNREADABLE");
  }
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(deriveReleaseHandoffAggregateId(query.attemptAggregateId));
  } catch { return refuse("RELEASE_HANDOFF_BINDING_UNREADABLE"); }
  const rows = events.filter(
    (event) => event.eventType === RELEASE_HANDOFF_BINDING_EVENT_TYPE);
  if (rows.length === 0) return refuse("RELEASE_HANDOFF_BINDING_ABSENT");
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.aggregateSequence)) return refuse("RELEASE_HANDOFF_BINDING_AMBIGUOUS");
    seen.add(row.aggregateSequence);
  }
  // LATEST WINS: a re-release after a further journal append appends a second
  // binding, and the standing one is the newest.
  const binding = decodeBinding(rows[rows.length - 1] as StoredEvent);
  if (binding === null) return refuse("RELEASE_HANDOFF_BINDING_UNREADABLE");
  if (binding.projectId !== query.projectId) {
    return refuse("RELEASE_HANDOFF_BINDING_PROJECT_MISMATCH");
  }
  return reverify(store, binding);
}
