import { createDeadEndJournal } from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import { IdempotencyConflictError } from "@moe/store";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readCurrentEffectSessionBinding } from "../activation/activation-ledger-reader.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { FOUNDATION_DISPATCH_EVENT_TYPES } from "../work/foundation-attempt-contracts.js";
import {
  decodeFoundationPayload, deriveDispatchAggregateId, encodeFoundationPayload, exactKeys,
  sameBytes, textOf,
} from "../work/foundation-attempt-codec.js";
import {
  JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_EVENT_TYPE, JOURNAL_APPEND_PAYLOAD_KEYS,
  JOURNAL_APPEND_SCHEMA_VERSION, JOURNAL_RECORD_VERSION, deriveAttemptJournalAggregateId,
  journalRefusal,
} from "./journal-contracts.js";
import type { JournalAppendOutcome, JournalAppendRefused } from "./journal-contracts.js";
import { decodeJournalEntries } from "./journal-entry-codec.js";
import { readCurrentAttemptJournal } from "./journal-reader.js";

/**
 * The one writer for the durable per-attempt dead-end journal.
 *
 * A CALLER IDENTIFIES AN ATTEMPT; IT NEVER SUPPLIES AUTHORITY. The payload admits
 * exactly `attemptAggregateId`, `effectId` and `entries` — so project, session,
 * lease, graph, digest, truth class and a whole replacement journal have no wire
 * channel at all and are refused STRUCTURALLY by the seam's allow-list at stage
 * PAYLOAD_SHAPE, one layer above this module. Everything persisted here is
 * re-derived from committed evidence:
 *   - `readCurrentEffectSessionBinding` IS the attempt/session/lease fence. It
 *     requires intent ACTIVE, attempt RUNNING, the lease parsed, ACTIVE, equal to
 *     the intent's own lease binding and not past its wall deadline, and the
 *     activation commit coherent — all from committed rows, with the caller's
 *     values used for equality and nothing else. Its refusals are carried under
 *     ITS code and ITS layer: a stale lease must stay distinguishable from an
 *     absent attempt, and restamping would destroy exactly that difference.
 *   - the journal aggregate is derived from the BINDING's activationDigest, a
 *     server-derived value, so no caller can name a journal stream into being.
 *     `attemptAggregateId` only LOCATES the activation record; the digest
 *     equality below is what forbids pointing at another attempt.
 *   - `nodeKey` comes from the durable `FoundationDispatchReserved` event.
 *   - the entries are admitted by `createDeadEndJournal`, whose own
 *     `JOURNAL_LIMIT_REACHED` / `DEAD_END_JOURNAL` refusal is carried verbatim.
 *
 * APPEND-ONLY. Each append commits ONE new event at `expectedVersion` = the
 * current event count, and no branch rewrites a prior one. A byte-identical
 * replay returns the store's REPLAYED without a second row; the same command
 * identity with different bytes raises the store's own idempotency conflict,
 * which is deliberately rethrown so the seam reports it under DURABLE_STORE.
 */

const REQUEST_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "expectedVersion", "kind", "payload",
  "principalId", "projectId", "schemaVersion",
] as const);

interface JournalAppendRequest {
  readonly attemptAggregateId: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly effectId: string;
  readonly entries: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Envelope and payload shape only. `projectId`, `principalId` and `decidedAt` are
 * SERVER facts the registry's `requestOf` stamped; they are read from the
 * envelope and never from the payload, which cannot carry them.
 */
function decodeRequest(input: unknown): JournalAppendRequest | JournalAppendRefused {
  const malformed = journalRefusal("JOURNAL_REQUEST_MALFORMED");
  if (!(input instanceof Uint8Array)) return malformed;
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok) return malformed;
  const record = exactKeys(decoded.value, REQUEST_KEYS);
  if (record === null) return malformed;
  if (record["kind"] !== JOURNAL_APPEND_COMMAND_KIND
    || record["schemaVersion"] !== JOURNAL_APPEND_SCHEMA_VERSION
    || !nonEmpty(record["commandId"]) || !nonEmpty(record["correlationId"])
    || !nonEmpty(record["principalId"]) || !nonEmpty(record["projectId"])
    || !nonEmpty(record["decidedAt"]) || Number.isNaN(Date.parse(record["decidedAt"]))) {
    return malformed;
  }
  const payload = exactKeys(record["payload"], JOURNAL_APPEND_PAYLOAD_KEYS);
  if (payload === null || !nonEmpty(payload["attemptAggregateId"])
    || !nonEmpty(payload["effectId"])) {
    return malformed;
  }
  return Object.freeze({
    attemptAggregateId: payload["attemptAggregateId"], commandId: record["commandId"],
    correlationId: record["correlationId"], decidedAt: record["decidedAt"],
    effectId: payload["effectId"], entries: payload["entries"],
    principalId: record["principalId"], projectId: record["projectId"],
  });
}

/** The node this attempt was dispatched onto, from the RESERVED event the
 *  production dispatch commits. RECORDED is written only at settlement, so a live
 *  attempt has exactly one RESERVED row and never a RECORDED one. */
function durableNodeKey(
  store: SqliteEventStore, attemptAggregateId: string,
): string | JournalAppendRefused {
  const unreadable = journalRefusal("JOURNAL_NODE_UNREADABLE");
  let events: readonly StoredEvent[];
  try { events = store.readEvents(deriveDispatchAggregateId(attemptAggregateId)); }
  catch { return unreadable; }
  const found = events.filter(
    (event) => event.eventType === FOUNDATION_DISPATCH_EVENT_TYPES.RESERVED);
  const event = found[0];
  if (found.length !== 1 || event === undefined) return unreadable;
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return unreadable;
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) return unreadable;
  return textOf(decoded.value, "nodeKey") ?? unreadable;
}

interface AttemptFacts {
  readonly attemptRef: string;
  readonly leaseRef: string;
}

/** The caller's aggregate id LOCATES; these three equalities AUTHORISE. A record
 *  that disagrees with the binding on any of them is evidence about a different
 *  attempt, and no field of it may reach durable bytes. */
function agreeingAttempt(
  store: SqliteEventStore, request: JournalAppendRequest, activationDigest: string,
  sessionId: string,
): AttemptFacts | JournalAppendRefused {
  const mismatch = journalRefusal("JOURNAL_BINDING_MISMATCH");
  let events: readonly StoredEvent[];
  try { events = store.readEvents(request.attemptAggregateId); } catch { return mismatch; }
  const history = readFoundationActivationHistory(
    request.attemptAggregateId, events, request.projectId);
  if (!history.ok) return mismatch;
  const { record } = history.history;
  if (record.activationDigest !== activationDigest
    || record.effectIntent.intentId !== request.effectId
    || record.lease.ownerSessionRef !== sessionId) {
    return mismatch;
  }
  return Object.freeze({ attemptRef: record.attempt.attemptId, leaseRef: record.lease.leaseId });
}

const isRefusal = (value: unknown): value is JournalAppendRefused =>
  typeof value === "object" && value !== null && "ok" in value;

/**
 * Decode -> bind -> agree -> locate the node -> admit the entries -> fold onto the
 * durable journal -> commit ONE event -> answer FROM THE READER. Every stage
 * keeps the refusing layer's own code, and no branch answers from the value just
 * written.
 */
export function runJournalAppendCommand(
  store: SqliteEventStore, input: unknown,
): JournalAppendOutcome {
  const request = decodeRequest(input);
  if (isRefusal(request)) return request;
  const binding = readCurrentEffectSessionBinding(
    store, request.projectId, request.effectId, request.principalId,
    Date.parse(request.decidedAt));
  if (binding.status !== "BOUND") return journalRefusal(binding.code, binding.layer);
  const { activationDigest, sessionId } = binding;
  const facts = agreeingAttempt(store, request, activationDigest, sessionId);
  if (isRefusal(facts)) return facts;
  const nodeKey = durableNodeKey(store, request.attemptAggregateId);
  if (typeof nodeKey !== "string") return nodeKey;
  const admittedEntries = decodeJournalEntries(request.entries);
  if (!admittedEntries.ok) return journalRefusal(admittedEntries.code);
  // ABSENT is the empty journal HERE and only here — the first append on an
  // attempt that has none. Every other refusal propagates unchanged, because an
  // unreadable history must never be folded onto as if it were empty.
  const current = readCurrentAttemptJournal(store, activationDigest, request.projectId);
  if (!current.ok && current.code !== "JOURNAL_RECORD_ABSENT") {
    return journalRefusal(current.code, current.layer);
  }
  const prior: readonly DeadEndJournalEntry[] = current.ok ? current.entries : [];
  const journal = createDeadEndJournal([...prior, ...admittedEntries.entries]);
  // The limit refusal is the CONTEXT package's own judgement, carried verbatim:
  // never restamped, never truncated, never retried with fewer entries.
  if (journal.kind !== "ADMITTED") return journalRefusal(journal.code, journal.layer);
  const encoded = encodeFoundationPayload({
    activationDigest, attemptRef: facts.attemptRef, effectId: request.effectId,
    entries: journal.journal.entries, journalDigest: journal.journal.digest,
    leaseRef: facts.leaseRef, nodeKey, projectId: request.projectId,
    recordVersion: JOURNAL_RECORD_VERSION, sessionId, truthClass: "DAEMON_VERIFIED",
  });
  if (!encoded.ok) return journalRefusal("JOURNAL_RECORD_MALFORMED");
  return commitAppend(store, request, activationDigest, encoded.bytes, input);
}

function commitAppend(
  store: SqliteEventStore, request: JournalAppendRequest, activationDigest: string,
  payload: Uint8Array, requestBytes: Uint8Array,
): JournalAppendOutcome {
  const unavailable = journalRefusal("JOURNAL_COMMIT_UNAVAILABLE");
  const targetAggregateId = deriveAttemptJournalAggregateId(activationDigest);
  let existing: readonly StoredEvent[];
  try { existing = store.readEvents(targetAggregateId); } catch { return unavailable; }
  const { commandId, correlationId, decidedAt, principalId, projectId } = request;
  try {
    const written = store.commitExpectedVersionDecision({
      commandKind: JOURNAL_APPEND_COMMAND_KIND, committedResultBytes: payload, correlationId,
      decidedAt,
      events: [{
        eventId: `${commandId}:${JOURNAL_APPEND_EVENT_TYPE}`,
        eventType: JOURNAL_APPEND_EVENT_TYPE, payload,
      }],
      // APPEND-ONLY: the tail as it stands now, so a racing second append loses
      // its version check rather than both landing.
      expectedVersion: existing.length,
      key: { commandId, principalId, projectId }, requestBytes, targetAggregateId,
    });
    if (written.decision.effectDisposition !== "EFFECTS_COMMITTED") return unavailable;
    return Object.freeze({
      advisoryOnly: false as const, authority: "DURABLE_DECISION" as const,
      decision: written.decision, disposition: written.disposition,
      kind: JOURNAL_APPEND_COMMAND_KIND, ok: true as const,
    });
  } catch (error) {
    // The store's idempotency conflict keeps its OWN code and DURABLE_STORE
    // layer: flattening it into a journal code would hide that the caller reused
    // one command identity for two different sets of bytes.
    if (error instanceof IdempotencyConflictError) throw error;
    return unavailable;
  }
}
