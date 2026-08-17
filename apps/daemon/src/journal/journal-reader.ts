import { createDeadEndJournal } from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import type { StoredEvent } from "@moe/store";

import {
  decodeFoundationPayload, encodeFoundationPayload, exactKeys, sameBytes,
} from "../work/foundation-attempt-codec.js";
import {
  DAEMON_JOURNAL_APPEND, JOURNAL_APPEND_EVENT_TYPE, JOURNAL_RECORD_VERSION,
  deriveAttemptJournalAggregateId,
} from "./journal-contracts.js";
import type { JournalCode } from "./journal-contracts.js";
import { decodeJournalEntries } from "./journal-entry-codec.js";

/**
 * The strict CURRENT reader for the durable per-attempt journal.
 *
 * SPLIT OUT OF `./journal-append.ts`, which measured 235 physical lines with the
 * writer alone; the reader would have carried it past the 250-line target. The
 * per-FILE cap is hard and the per-task file count is not a reason to breach it.
 *
 * THE READER NEVER RECONSTRUCTS. Every disagreement returns authority "NONE"
 * with an exact code and this layer's name, and no branch answers from the fields
 * that happened to parse. An unverifiable journal never becomes a handoff input,
 * which matters because `journalDigest` is a REQUIRED 64-hex reference in both
 * @moe/context's `createReleaseHandoff` and @moe/scheduler's `ReleaseHandoff`.
 *
 * THE DIGEST IS RE-DERIVED, NOT TRUSTED. `createDeadEndJournal` is run again over
 * the stored entries and its answer must equal the stored `journalDigest` AND
 * reproduce the stored ORDER. A stored digest that has quietly stopped covering
 * its entries is therefore unusable rather than merely wrong. The entries are put
 * through the strict decoder FIRST, because `createDeadEndJournal` throws rather
 * than refuses on a malformed predicate and a crash is not a refusal.
 */

/** The exact store surface this reader needs. Every commit method is absent BY
 *  CONSTRUCTION: a reader that cannot name a write cannot perform one. */
export interface JournalEventSource {
  readEvents(aggregateId: string): readonly StoredEvent[];
}

export interface AttemptJournalAnswer {
  readonly activationDigest: string;
  readonly attemptRef: string;
  readonly authority: "DURABLE_JOURNAL";
  readonly effectId: string;
  readonly entries: readonly DeadEndJournalEntry[];
  readonly journalDigest: string;
  readonly leaseRef: string;
  readonly nodeKey: string;
  readonly ok: true;
  readonly sessionId: string;
}

export interface AttemptJournalRefused {
  readonly authority: "NONE";
  readonly code: JournalCode;
  readonly layer: typeof DAEMON_JOURNAL_APPEND;
  readonly ok: false;
}

export type AttemptJournalResult = AttemptJournalAnswer | AttemptJournalRefused;

const refuse = (code: JournalCode): AttemptJournalRefused => Object.freeze({
  authority: "NONE" as const, code, layer: DAEMON_JOURNAL_APPEND, ok: false as const,
});

const BODY_KEYS = Object.freeze([
  "activationDigest", "attemptRef", "effectId", "entries", "journalDigest", "leaseRef",
  "nodeKey", "projectId", "recordVersion", "sessionId", "truthClass",
] as const);

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Zero rows is ABSENT and a throw is UNREADABLE: they demand opposite repairs, so
 * they never collapse into one code. A sequence hole is MALFORMED while two rows
 * claiming one sequence is AMBIGUOUS, for the same reason.
 */
function currentEvent(
  store: JournalEventSource, activationDigest: string,
): StoredEvent | AttemptJournalRefused {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(deriveAttemptJournalAggregateId(activationDigest)); }
  catch { return refuse("JOURNAL_RECORD_UNREADABLE"); }
  if (events.length === 0) return refuse("JOURNAL_RECORD_ABSENT");
  const seen = new Set<number>();
  for (const event of events) {
    if (seen.has(event.aggregateSequence)) return refuse("JOURNAL_RECORD_AMBIGUOUS");
    seen.add(event.aggregateSequence);
  }
  for (const [index, event] of events.entries()) {
    if (event.eventType !== JOURNAL_APPEND_EVENT_TYPE
      || event.aggregateSequence !== index + 1) {
      return refuse("JOURNAL_RECORD_MALFORMED");
    }
  }
  // The CURRENT journal is the LAST event: every append persists the whole
  // admitted journal, so the head row is the journal and the tail is history.
  return events[events.length - 1] as StoredEvent;
}

/**
 * The stored entries, re-admitted through the PRODUCTION surface. Both halves are
 * load-bearing: the digest equality catches a body whose digest stopped covering
 * its entries, and the order equality catches a body whose entries were reordered
 * under a digest that — because `createDeadEndJournal` sorts its input — would
 * otherwise still match.
 */
function verifiedEntries(
  body: Record<string, unknown>,
): readonly DeadEndJournalEntry[] | AttemptJournalRefused {
  const decoded = decodeJournalEntries(body["entries"]);
  if (!decoded.ok) return refuse("JOURNAL_RECORD_MALFORMED");
  const derived = createDeadEndJournal(decoded.entries);
  if (derived.kind !== "ADMITTED") return refuse("JOURNAL_RECORD_MALFORMED");
  const stored = encodeFoundationPayload(decoded.entries);
  const canonical = encodeFoundationPayload(derived.journal.entries);
  if (!stored.ok || !canonical.ok || stored.digest !== canonical.digest) {
    return refuse("JOURNAL_RECORD_MALFORMED");
  }
  if (derived.journal.digest !== body["journalDigest"]) return refuse("JOURNAL_DIGEST_MISMATCH");
  return derived.journal.entries;
}

/**
 * The attempt-bound journal as the STORE holds it. `expectedProjectId` is checked
 * against the body's own recorded project, so a row read out of a store bound to
 * another project can never be handed on as this project's authority.
 */
export function readCurrentAttemptJournal(
  store: JournalEventSource, activationDigest: string, expectedProjectId: string,
): AttemptJournalResult {
  if (!text(activationDigest) || !text(expectedProjectId)) {
    return refuse("JOURNAL_RECORD_UNREADABLE");
  }
  const event = currentEvent(store, activationDigest);
  if ("ok" in event) return event;
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return refuse("JOURNAL_RECORD_MALFORMED");
  // Canonical bytes need BOTH the decode and the re-encode: a row whose keys were
  // stored out of canonical order decodes cleanly and only fails the byte compare.
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) {
    return refuse("JOURNAL_RECORD_MALFORMED");
  }
  const body = exactKeys(decoded.value, BODY_KEYS);
  if (body === null || body["recordVersion"] !== JOURNAL_RECORD_VERSION
    || body["truthClass"] !== "DAEMON_VERIFIED" || body["activationDigest"] !== activationDigest
    || !text(body["attemptRef"]) || !text(body["effectId"]) || !text(body["leaseRef"])
    || !text(body["nodeKey"]) || !text(body["sessionId"]) || !text(body["journalDigest"])) {
    return refuse("JOURNAL_RECORD_MALFORMED");
  }
  if (body["projectId"] !== expectedProjectId) return refuse("JOURNAL_PROJECT_MISMATCH");
  const entries = verifiedEntries(body);
  if ("ok" in entries) return entries;
  return Object.freeze({
    activationDigest, attemptRef: body["attemptRef"], authority: "DURABLE_JOURNAL" as const,
    effectId: body["effectId"], entries, journalDigest: body["journalDigest"],
    leaseRef: body["leaseRef"], nodeKey: body["nodeKey"], ok: true as const,
    sessionId: body["sessionId"],
  });
}
