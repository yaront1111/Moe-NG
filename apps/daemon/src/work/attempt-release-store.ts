/**
 * The durable half of the attempt-level release record: its frozen vocabulary,
 * its aggregate derivation, the two store reads it depends on, and the single
 * append that lands one row.
 *
 * SPLIT OUT OF `./attempt-release-disposition.ts`, which keeps the composition.
 * The vocabulary travelled WITH the storage rather than staying behind, because
 * every function here refuses through `refuse` and every one of them is called
 * by the composer: leaving the codes on the other side would make the two
 * modules import each other, and a const-initialised `refuse` reached through an
 * import cycle is a temporal-dead-zone crash, not a type error. The composer
 * re-exports every public name, so `./attempt-release-disposition.js` remains
 * the one import site for consumers.
 *
 * NOTHING HERE GRANTS AUTHORITY. It creates no hold, no PlanningRun and no
 * terminal decision; it writes one advisory row saying what happened to ONE
 * attempt at release. The lease and provider-slot facts are RE-READ from the
 * committed activation, never taken from a caller's copy.
 */

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  decodeFoundationPayload, encodeFoundationPayload, sameBytes, sha256Hex,
} from "./foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";

export const ATTEMPT_RELEASE_RECORD_VERSION = "moe-attempt-release-record/1" as const;
export const ATTEMPT_RELEASE_EVENT_TYPE = "AttemptReleaseRecorded" as const;
export const ATTEMPT_RELEASE_COMMAND_KIND = "work.attempt_release" as const;

/** This module's own layer. A refusal raised by the activation reader keeps ITS
 *  code; only decisions made here are reported under this name. */
export const DAEMON_ATTEMPT_RELEASE = "DAEMON_ATTEMPT_RELEASE" as const;

/** Closed, and every member names a DIFFERENT repair. Zero rows, two rows and
 *  bytes that no longer re-encode stay three codes for the reason the sibling
 *  dispatch reader keeps them apart. DOWNGRADED and TARGET_MISMATCH are likewise
 *  two and not one: a retargeted boundary and a downgraded set fail oppositely. */
export const ATTEMPT_RELEASE_CODES = Object.freeze([
  "ATTEMPT_RELEASE_REASON_UNKNOWN", "ATTEMPT_RELEASE_REASON_NOT_UNIONED",
  "ATTEMPT_RELEASE_DISPOSITION_MALFORMED", "ATTEMPT_RELEASE_DISPOSITION_DOWNGRADED",
  "ATTEMPT_RELEASE_TARGET_MISMATCH", "ATTEMPT_RELEASE_BINDING_MISMATCH",
  "ATTEMPT_RELEASE_ACTIVATION_UNREADABLE", "ATTEMPT_RELEASE_COMMIT_UNAVAILABLE",
  "ATTEMPT_RELEASE_RECORD_ABSENT", "ATTEMPT_RELEASE_RECORD_AMBIGUOUS",
  "ATTEMPT_RELEASE_RECORD_DRIFT", "ATTEMPT_RELEASE_RECORD_UNREADABLE",
] as const);
export type AttemptReleaseCode = (typeof ATTEMPT_RELEASE_CODES)[number];

export interface AttemptReleaseRefused {
  readonly advisoryOnly: true; readonly authority: "NONE"; readonly code: AttemptReleaseCode;
  readonly ok: false; readonly refusedBy: typeof DAEMON_ATTEMPT_RELEASE;
}
export interface AttemptReleaseAnswer {
  readonly advisoryOnly: true; readonly authority: "ADVISORY_RECORD"; readonly digest: string;
  readonly ok: true; readonly record: Record<string, unknown>;
}
export type AttemptReleaseOutcome = AttemptReleaseAnswer | AttemptReleaseRefused;

const encoder = new TextEncoder();

export const refuse = (code: AttemptReleaseCode): AttemptReleaseRefused => Object.freeze({
  advisoryOnly: true as const, authority: "NONE" as const, code, ok: false as const,
  refusedBy: DAEMON_ATTEMPT_RELEASE,
});

/** Framed by this record version, as the dispatch aggregate is framed by its
 *  own. The row may NOT share the activation aggregate: that stream is read by
 *  a strict exactly-one-plus-ordered-tail reader, and an event of an unexpected
 *  type there would make the activation itself unreadable. */
export function deriveAttemptReleaseAggregateId(attemptAggregateId: string): string {
  const framed =
    `${ATTEMPT_RELEASE_RECORD_VERSION}\n${attemptAggregateId.length}\n${attemptAggregateId}`;
  return `attempt-release-${sha256Hex(encoder.encode(framed))}`;
}

/** The activation as the STORE holds it, never as the caller describes it. */
export function durableActivation(
  store: SqliteEventStore, bound: FoundationAttemptBound,
): ActivationLedgerRecord | AttemptReleaseRefused {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(bound.aggregateId); }
  catch { return refuse("ATTEMPT_RELEASE_ACTIVATION_UNREADABLE"); }
  const history = readFoundationActivationHistory(bound.aggregateId, events, bound.projectId);
  return history.ok ? history.history.record : refuse("ATTEMPT_RELEASE_ACTIVATION_UNREADABLE");
}

/** Identity only. States are deliberately absent: a caller that could make its
 *  claimed lease state part of the agreement test could refuse the durable one. */
export function sameActivation(
  left: ActivationLedgerRecord, right: ActivationLedgerRecord,
): boolean {
  return left.activationDigest === right.activationDigest
    && left.grant.grantId === right.grant.grantId
    && left.grant.wrapperIdentity === right.grant.wrapperIdentity
    && left.effectIntent.intentId === right.effectIntent.intentId
    && left.attempt.attemptId === right.attempt.attemptId;
}

export function commitRelease(
  store: SqliteEventStore, bound: FoundationAttemptBound, bytes: Uint8Array, eventId: string,
): boolean {
  const { commandId, principalId, projectId } = bound;
  try { // expectedVersion 0: a second release on this aggregate cannot append.
    const written = store.commitExpectedVersionDecision({
      commandKind: ATTEMPT_RELEASE_COMMAND_KIND, committedResultBytes: bytes,
      correlationId: `${bound.correlationId}:RELEASED`, decidedAt: new Date().toISOString(),
      events: [{ eventId, eventType: ATTEMPT_RELEASE_EVENT_TYPE, payload: bytes }],
      expectedVersion: 0, key: { commandId: `${commandId}:RELEASED`, principalId, projectId },
      requestBytes: bytes, targetAggregateId: deriveAttemptReleaseAggregateId(bound.aggregateId),
    });
    return written.decision.effectDisposition === "EFFECTS_COMMITTED";
  } catch { return false; }
}

/** The durable answer, always from re-decoded bytes that still re-encode. */
export function readAttemptRelease(
  store: SqliteEventStore, attemptAggregateId: string,
): AttemptReleaseOutcome {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(deriveAttemptReleaseAggregateId(attemptAggregateId)); }
  catch { return refuse("ATTEMPT_RELEASE_RECORD_UNREADABLE"); }
  const found = events.filter((event) => event.eventType === ATTEMPT_RELEASE_EVENT_TYPE);
  if (found.length > 1) return refuse("ATTEMPT_RELEASE_RECORD_AMBIGUOUS");
  const event = found[0];
  if (event === undefined) return refuse("ATTEMPT_RELEASE_RECORD_ABSENT");
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return refuse("ATTEMPT_RELEASE_RECORD_DRIFT");
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) {
    return refuse("ATTEMPT_RELEASE_RECORD_DRIFT");
  }
  return Object.freeze({
    advisoryOnly: true as const, authority: "ADVISORY_RECORD" as const, digest: again.digest,
    ok: true as const, record: Object.freeze(decoded.value),
  });
}
