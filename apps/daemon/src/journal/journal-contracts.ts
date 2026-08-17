import { createHash } from "node:crypto";

import type { RuntimeCommandKind, RuntimeError } from "@moe/contracts";
import type { CommandDecisionRecord } from "@moe/store";

/**
 * The `journal.append` vocabulary: the kind, the versions, the exact payload
 * allow-list, this layer's name, its closed code list and the aggregate
 * derivation. The strict entry decoder that keeps a malformed entry away from
 * `createDeadEndJournal` lives in `./journal-entry-codec.js`, which imports this
 * module's code type; splitting it out is what keeps both files inside the
 * per-file cap.
 *
 * NO WIRE KIND IS ADDED. `journal.append` is already a member of the frozen
 * `RuntimeCommandKind` union (packages/contracts/src/runtime/runtime-vocabulary.ts:96)
 * and the annotation below makes a typo a compile error rather than a dead kind.
 */

export const JOURNAL_APPEND_COMMAND_KIND = "journal.append" as const satisfies RuntimeCommandKind;
export const JOURNAL_APPEND_SCHEMA_VERSION = "moe-journal-append/1" as const;
export const JOURNAL_RECORD_VERSION = "moe-attempt-journal/1" as const;
export const JOURNAL_APPEND_EVENT_TYPE = "AttemptJournalAppended" as const;

/**
 * EXACTLY three, and the omissions are the point. projectId, sessionId, leaseRef,
 * graphRef, journalDigest, truthClass and a whole replacement `journal` are
 * absent, so the HTTP seam's `checkPayload` allow-list refuses each of them
 * STRUCTURALLY under its own `PAYLOAD_SHAPE` stage before dispatch — the caller
 * has no channel to name any of them, and nothing downstream has to defend one.
 * Sorted, because the seam compares the list ordered.
 */
export const JOURNAL_APPEND_PAYLOAD_KEYS = Object.freeze([
  "attemptAggregateId", "effectId", "entries",
] as const);

/** This module's own layer. A refusal raised by the binding reader, the store or
 *  `createDeadEndJournal` keeps ITS code and ITS layer; only decisions made in
 *  the journal writer or reader are reported under this name. */
export const DAEMON_JOURNAL_APPEND = "DAEMON_JOURNAL_APPEND" as const;

/** Closed, and every member names a DIFFERENT repair. ABSENT and UNREADABLE stay
 *  apart because one says "write the journal" and the other says the durable
 *  history cannot be consulted at all. */
export const JOURNAL_CODES = Object.freeze([
  "JOURNAL_REQUEST_MALFORMED", "JOURNAL_ENTRY_MALFORMED", "JOURNAL_ENTRY_LIST_EMPTY",
  "JOURNAL_BINDING_MISMATCH", "JOURNAL_NODE_UNREADABLE", "JOURNAL_COMMIT_UNAVAILABLE",
  "JOURNAL_RECORD_ABSENT", "JOURNAL_RECORD_UNREADABLE", "JOURNAL_RECORD_MALFORMED",
  "JOURNAL_RECORD_AMBIGUOUS", "JOURNAL_PROJECT_MISMATCH", "JOURNAL_DIGEST_MISMATCH",
] as const);
export type JournalCode = (typeof JOURNAL_CODES)[number];

const encoder = new TextEncoder();

/** Length-framed, exactly as `deriveAttemptReleaseAggregateId` frames its own
 *  input. Keyed on the ACTIVATION DIGEST because that value is server-derived and
 *  coherence-checked by the binding reader: no caller can name a journal stream
 *  into existence, and the caller's `attemptAggregateId` only LOCATES a record. */
export function deriveAttemptJournalAggregateId(activationDigest: string): string {
  const framed =
    `${JOURNAL_RECORD_VERSION}\n${activationDigest.length}\n${activationDigest}`;
  return `attempt-journal-${createHash("sha256").update(encoder.encode(framed)).digest("hex")}`;
}

export interface JournalAppendAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: typeof JOURNAL_APPEND_COMMAND_KIND;
  readonly ok: true;
}

/** Structurally what `decisionOf` already accepts, so the seam needs no widening
 *  of its own logic. `refusedBy` carries the layer that ACTUALLY answered. */
export interface JournalAppendRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  readonly error: RuntimeError | null;
  readonly kind: typeof JOURNAL_APPEND_COMMAND_KIND | null;
  readonly ok: false;
  readonly refusedBy: string;
}

export type JournalAppendOutcome = JournalAppendAccepted | JournalAppendRefused;

export function journalRefusal(
  code: string, refusedBy: string = DAEMON_JOURNAL_APPEND,
): JournalAppendRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code, error: null,
    kind: JOURNAL_APPEND_COMMAND_KIND, ok: false as const, refusedBy,
  });
}
