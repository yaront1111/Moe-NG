/**
 * Enumerates the foundation dispatch attempts that were still in flight when the
 * process died, as `InFlightAttempt[]` for restart reconciliation.
 *
 * THE IN-FLIGHT RULE IS LIFTED FROM PRODUCTION, NOT INVENTED HERE.
 * `foundation-attempt-service.ts:218-224` already decides it for ONE attempt, in
 * the dispatch replay path:
 *
 *   "A REPLAYED reservation NEVER launches. It adopts the durable final record
 *    or says the dispatch is still in flight; a missing record is not an
 *    invitation to start a second process."
 *
 * and answers `FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS` exactly when
 * `readStoredFoundationAttempt` says `FOUNDATION_ATTEMPT_RECORD_ABSENT`.
 * Generalised over every aggregate, that is: A `FoundationDispatchReserved`
 * WITH NO `FoundationAttemptRecorded` ON THE SAME AGGREGATE IS STILL IN FLIGHT.
 * It is a decided property of the committed record, not an inference from
 * absence plus a clock, and no timeout is consulted anywhere below.
 *
 * A RECORDED WITH NO RESERVED IS NOT "FINISHED". `commitFoundationPhase` writes
 * the reservation at expectedVersion 0 and the record after it, so that shape
 * means the reservation was LOST. Absorbing it into the general not-in-flight
 * case would hide a broken durable chain, so it is refused.
 *
 * NOTHING IS SILENTLY OMITTED. An undecodable, drifted or duplicated attempt
 * refuses the whole sweep with the codes the single-attempt readers already fix
 * — an attempt dropped from this list is an attempt nobody will reconcile.
 *
 * `situation` CARRIES COMMITTED FIELDS ONLY. The dispatch aggregate holds no
 * lease epoch and no process observation, so `classifyCrash` refuses what is
 * built here and reconciliation records UNKNOWN. That is the honest answer:
 * manufacturing classifier-shaped fields would let the sweep decide a crash from
 * evidence the crash never produced.
 */

import type { CursorPage, SqliteEventStore, StoredEvent } from "@moe/store";

import { tracedProject } from "../activation/foundation-binding-predicates.js";
import type { InFlightAttempt } from "../recovery/restart-reconciliation.js";
import {
  FOUNDATION_DISPATCH_EVENT_TYPES, FOUNDATION_RESERVATION_VERSION, decodeFoundationPayload,
  encodeFoundationPayload, refuseLocal, sameBytes, textOf,
} from "./foundation-attempt-contracts.js";
import type { FoundationAttemptRefused } from "./foundation-attempt-contracts.js";

const SCAN_PAGE_SIZE = 100;

/** Exactly the reservation body `foundation-attempt-service.ts` commits. Copied
 *  by allow-list, never by spread, so a field this daemon has no business
 *  forwarding cannot arrive by accident. */
export const IN_FLIGHT_SITUATION_KEYS = Object.freeze([
  "activationDigest", "attemptAggregateId", "attemptId", "grantId", "nodeKey", "recordVersion",
  "requestDigest", "sessionId",
] as const);

export type InFlightAttemptSweep =
  | { readonly ok: true; readonly attempts: readonly InFlightAttempt[] }
  | FoundationAttemptRefused;

type DispatchWalk =
  | { readonly ok: true; readonly events: ReadonlyMap<string, StoredEvent> }
  | FoundationAttemptRefused;

type SituationResult =
  | { readonly ok: true; readonly situation: Record<string, unknown> }
  | FoundationAttemptRefused;

/** An unreadable store is the same condition `readStoredFoundationAttempt`
 *  answers when `readEvents` throws, and it keeps that code here. */
const unreadable = (): FoundationAttemptRefused =>
  refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS");

/**
 * One INDEX-BACKED walk of one event type, bounded by the captured horizon.
 *
 * Two of these, set-differenced by `aggregateId`, answer the whole question, so
 * nothing here walks the global stream and nothing re-reads an aggregate per
 * reservation. Growth past the captured horizon is not this answer's business:
 * a match beyond H is neither returned nor counted.
 */
function walkDispatchType(
  store: SqliteEventStore, eventType: string, projectId: string, horizon: bigint,
): DispatchWalk {
  const events = new Map<string, StoredEvent>();
  let cursor = 0n;
  while (cursor < horizon) {
    let page: CursorPage<StoredEvent, bigint>;
    try { page = store.readEventsByTypeAfter(eventType, cursor, SCAN_PAGE_SIZE); }
    catch { return unreadable(); }
    let position = cursor;
    let beyondHorizon = false;
    for (const event of page.items) {
      if (event.globalPosition <= position) return unreadable();
      position = event.globalPosition;
      if (position > horizon) { beyondHorizon = true; break; }
      if (event.eventType !== eventType) return unreadable();
      // Evidence traced to another project speaks about another project's
      // dispatches, and reconciling one under this project is a wrong answer.
      if (!tracedProject(event, projectId)) {
        return refuseLocal("FOUNDATION_ATTEMPT_BINDING_MISMATCH");
      }
      // Two phases of one tag on one aggregate is the ambiguity the
      // single-attempt readers refuse; it is never resolved by picking one.
      if (events.has(event.aggregateId)) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS");
      events.set(event.aggregateId, event);
    }
    if (beyondHorizon) break;
    // A page that advanced nothing while claiming more is a never-ending walk,
    // and it is refused rather than spun on.
    if (position === cursor) {
      if (page.hasMore) return unreadable();
      break;
    }
    if (page.nextCursor !== position) return unreadable();
    if (!page.hasMore) break;
    cursor = position;
  }
  return Object.freeze({ events, ok: true as const });
}

/**
 * The decode discipline `readStoredFoundationAttempt` already fixes, and no
 * laxer: decode, RE-ENCODE, and byte-compare before trusting the payload.
 */
function situationOf(event: StoredEvent): SituationResult {
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return decoded;
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok) return again;
  if (!sameBytes(again.bytes, event.payload)) {
    return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  }
  if (textOf(decoded.value, "recordVersion") !== FOUNDATION_RESERVATION_VERSION) {
    return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  }
  const situation: Record<string, unknown> = {};
  for (const key of IN_FLIGHT_SITUATION_KEYS) {
    const value = textOf(decoded.value, key);
    if (value === null) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
    situation[key] = value;
  }
  return Object.freeze({ ok: true as const, situation: Object.freeze(situation) });
}

export function readInFlightFoundationAttempts(
  store: SqliteEventStore, projectId: string,
): InFlightAttemptSweep {
  let horizon: unknown;
  try { horizon = store.readEventHorizon(); } catch { return unreadable(); }
  if (typeof horizon !== "bigint" || horizon < 0n) return unreadable();
  const { RECORDED, RESERVED } = FOUNDATION_DISPATCH_EVENT_TYPES;
  const reserved = walkDispatchType(store, RESERVED, projectId, horizon);
  if (!reserved.ok) return reserved;
  const recorded = walkDispatchType(store, RECORDED, projectId, horizon);
  if (!recorded.ok) return recorded;
  for (const aggregateId of recorded.events.keys()) {
    if (!reserved.events.has(aggregateId)) {
      return refuseLocal("FOUNDATION_ATTEMPT_DISPATCH_SUSPECT");
    }
  }
  const attempts: InFlightAttempt[] = [];
  for (const [aggregateId, event] of reserved.events) {
    if (recorded.events.has(aggregateId)) continue;
    const built = situationOf(event);
    if (!built.ok) return built;
    attempts.push(Object.freeze({ attemptRef: aggregateId, situation: built.situation }));
  }
  return Object.freeze({ attempts: Object.freeze(attempts), ok: true as const });
}
