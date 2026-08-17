/**
 * The attempt-level release disposition, recorded durably and nowhere else.
 *
 * THIS MODULE PRODUCES FACTS AND GRANTS NO AUTHORITY. It creates no hold, no
 * PlanningRun and no terminal decision; it writes one advisory row saying what
 * happened to ONE attempt at release: the drain disposition, the attempt's own
 * state, and the lease and provider-slot refs with the states the COMMITTED
 * ACTIVATION gives them.
 *
 * THE AUTHORITY RULE, and it is the whole point of the module. A caller may
 * identify WHICH attempt; it may never supply WHAT happened to it.
 *   - The drain disposition is validated through `parseDrainDisposition` and
 *     `isMonotonicDisposition` from the `@moe/runner` ROOT and is REFUSED rather
 *     than repaired. Nothing here re-derives a rank or a terminal target, and
 *     nothing retypes `WORK_RELEASE_OR_PAUSE` as a local string: two definitions
 *     would drift and core's release predicate would start refusing silently.
 *   - The lease and provider-slot facts are RE-READ from the committed
 *     activation. The `record` argument is used for identity agreement only; a
 *     caller-claimed lease or slot state is never consulted, so it cannot win.
 *   - `resumable` is DERIVED, never accepted. Design 765: only an unchanged
 *     strongest `WORK_RELEASE_OR_PAUSE` result makes the run resumable.
 *
 * FAIL CLOSED. An unreadable activation, an incoherent disposition or a row that
 * no longer re-encodes stays UNKNOWN under an exact code and this layer.
 */

import {
  DRAIN_REASONS, DRAIN_TERMINAL_TARGETS, isMonotonicDisposition, parseDrainDisposition,
} from "@moe/runner";
import type { DrainDisposition } from "@moe/runner";
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

/** What THIS release carried. `reason` is this request's own drain reason;
 *  `disposition` is the accumulated one it was unioned into. */
export interface AttemptReleaseRequest {
  readonly disposition: unknown; readonly reason: string;
}

const encoder = new TextEncoder();
const refuse = (code: AttemptReleaseCode): AttemptReleaseRefused => Object.freeze({
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

/**
 * Coherence, answered ONLY by the runner's own predicate.
 * `isMonotonicDisposition` folds two questions into one boolean: is the stored
 * strongest reason the highest-ranked member of its own set, and does the
 * terminal target match that reason's target. To report them separately without
 * re-deriving either, ask the SAME predicate whether any declared target would
 * make this disposition monotonic. If one would, the reason set is sound and
 * only the target is wrong; if none would, the set itself was downgraded.
 */
function coherenceRefusal(disposition: DrainDisposition): AttemptReleaseRefused | null {
  if (isMonotonicDisposition(disposition)) return null;
  const retargetable = DRAIN_TERMINAL_TARGETS.some(
    (terminalTarget) => isMonotonicDisposition({ ...disposition, terminalTarget }));
  return refuse(retargetable
    ? "ATTEMPT_RELEASE_TARGET_MISMATCH" : "ATTEMPT_RELEASE_DISPOSITION_DOWNGRADED");
}

/** `parseDrainDisposition` validates a COPY of `reasons` but hands back the
 *  caller's own array, whose `includes`/iterator are own-overridable. Re-read
 *  the set through the FROZEN vocabulary and a borrowed builtin instead, in the
 *  drain precedence order the runner's own union emits. */
const emittedReasons = (disposition: DrainDisposition): readonly string[] =>
  DRAIN_REASONS.filter((reason) => Array.prototype.includes.call(disposition.reasons, reason));

function admitRequest(request: AttemptReleaseRequest): DrainDisposition | AttemptReleaseRefused {
  if (!DRAIN_REASONS.some((reason) => reason === request.reason)) {
    return refuse("ATTEMPT_RELEASE_REASON_UNKNOWN");
  }
  const disposition = parseDrainDisposition(request.disposition);
  if (disposition === null) return refuse("ATTEMPT_RELEASE_DISPOSITION_MALFORMED");
  const incoherent = coherenceRefusal(disposition);
  if (incoherent !== null) return incoherent;
  // Design 348: each request UNIONS its reason into the disposition, so a reason
  // absent from that set describes a different release from the strongest one.
  return emittedReasons(disposition).includes(request.reason)
    ? disposition : refuse("ATTEMPT_RELEASE_REASON_NOT_UNIONED");
}

/** The activation as the STORE holds it, never as the caller describes it. */
function durableActivation(
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
function sameActivation(left: ActivationLedgerRecord, right: ActivationLedgerRecord): boolean {
  return left.activationDigest === right.activationDigest
    && left.grant.grantId === right.grant.grantId
    && left.grant.wrapperIdentity === right.grant.wrapperIdentity
    && left.effectIntent.intentId === right.effectIntent.intentId
    && left.attempt.attemptId === right.attempt.attemptId;
}

/**
 * Design 765, applied as a derivation and never as an input: "only an unchanged
 * strongest WORK_RELEASE_OR_PAUSE result makes the run resumable". Both halves
 * are read off the VALIDATED disposition, so a request cannot assert either.
 */
const isResumable = (disposition: DrainDisposition): boolean =>
  disposition.strongestReason === "WORK_RELEASE_OR_PAUSE"
  && disposition.terminalTarget === "RELEASED";

function releaseRecordBody(
  bound: FoundationAttemptBound, durable: ActivationLedgerRecord,
  disposition: DrainDisposition, reason: string,
): Record<string, unknown> {
  return {
    attemptAggregateId: bound.aggregateId,
    attemptRef: durable.attempt.attemptId, attemptState: durable.attempt.state,
    disposition: {
      resumable: isResumable(disposition), strongestReason: disposition.strongestReason,
      terminalTarget: disposition.terminalTarget,
    },
    leaseRef: durable.lease.leaseId, leaseState: durable.lease.state,
    nodeKey: bound.nodeKey,
    providerSlotRef: durable.providerSlot.slotRef,
    providerSlotState: durable.providerSlot.state,
    reason,
    reasons: emittedReasons(disposition),
    recordVersion: ATTEMPT_RELEASE_RECORD_VERSION,
    sessionId: bound.sessionId,
    truthClass: "DAEMON_VERIFIED",
  };
}

function commitRelease(
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

/**
 * The one writer. Validate the disposition through the runner -> re-read the
 * activation from the store -> agree on identity -> compose from DURABLE fields
 * -> commit ONE row -> answer from RE-DECODED durable bytes. The answer never
 * comes from the value just written.
 */
export function recordAttemptRelease(
  store: SqliteEventStore, bound: FoundationAttemptBound, record: ActivationLedgerRecord,
  request: AttemptReleaseRequest,
): AttemptReleaseOutcome {
  const admitted = admitRequest(request);
  if ("ok" in admitted) return admitted;
  const durable = durableActivation(store, bound);
  if ("ok" in durable) return durable;
  if (!sameActivation(durable, record)) return refuse("ATTEMPT_RELEASE_BINDING_MISMATCH");
  const encoded =
    encodeFoundationPayload(releaseRecordBody(bound, durable, admitted, request.reason));
  if (!encoded.ok) return refuse("ATTEMPT_RELEASE_RECORD_DRIFT");
  // The event id is COPIED from the grant, never minted: a second release on the
  // same activation collides on store-wide event-id uniqueness instead of
  // quietly landing a second row nobody can choose between.
  if (!commitRelease(store, bound, encoded.bytes, `${durable.grant.grantId}:RELEASED`)) {
    return refuse("ATTEMPT_RELEASE_COMMIT_UNAVAILABLE");
  }
  return readAttemptRelease(store, bound.aggregateId);
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
