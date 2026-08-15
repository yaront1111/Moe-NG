import type { CommandDecisionResponse, SqliteEventStore, StoredEvent } from "@moe/store";

import {
  FOUNDATION_DISPATCH_COMMAND_KIND, FOUNDATION_DISPATCH_EVENT_TYPES,
  decodeFoundationPayload, deriveDispatchAggregateId, encodeFoundationPayload,
  refuseLocal, sameBytes, textOf,
} from "./foundation-attempt-contracts.js";
import type {
  FoundationAttemptBound, FoundationAttemptRefused,
} from "./foundation-attempt-contracts.js";

export interface FoundationAttemptRecordAnswer {
  readonly advisoryOnly: true; readonly authority: "ADVISORY_RECORD"; readonly digest: string;
  readonly ok: true; readonly record: Record<string, unknown>;
}
export type FoundationAttemptOutcome = FoundationAttemptRecordAnswer | FoundationAttemptRefused;

export function commitFoundationPhase(
  store: SqliteEventStore, bound: FoundationAttemptBound, tag: "RECORDED" | "RESERVED",
  bytes: Uint8Array, expectedVersion: number, eventId: string,
): CommandDecisionResponse | null {
  const { commandId, principalId, projectId } = bound;
  try {
    return store.commitExpectedVersionDecision({
      commandKind: FOUNDATION_DISPATCH_COMMAND_KIND, committedResultBytes: bytes,
      correlationId: `${bound.correlationId}:${tag}`, decidedAt: new Date().toISOString(),
      events: [{ eventId, eventType: FOUNDATION_DISPATCH_EVENT_TYPES[tag], payload: bytes }],
      expectedVersion, key: { commandId: `${commandId}:${tag}`, principalId, projectId },
      requestBytes: bytes, targetAggregateId: bound.target,
    });
  } catch { return null; }
}

export function readFoundationReservationDigest(
  store: SqliteEventStore, target: string,
): string | null {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(target); } catch { return null; }
  const found = events.filter((event) =>
    event.eventType === FOUNDATION_DISPATCH_EVENT_TYPES.RESERVED);
  if (found.length !== 1) return null;
  const decoded = decodeFoundationPayload(found[0]?.payload);
  return decoded.ok ? textOf(decoded.value, "requestDigest") : null;
}

/** The final answer always comes from re-decoded durable bytes. */
export function readStoredFoundationAttempt(
  store: SqliteEventStore, target: string,
): FoundationAttemptOutcome {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(target); }
  catch { return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS"); }
  const found = events.filter((event) =>
    event.eventType === FOUNDATION_DISPATCH_EVENT_TYPES.RECORDED);
  if (found.length > 1) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS");
  const event = found[0];
  if (event === undefined) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_ABSENT");
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return decoded;
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) {
    return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  }
  return Object.freeze({ advisoryOnly: true as const, authority: "ADVISORY_RECORD" as const,
    digest: again.digest, ok: true as const, record: Object.freeze(decoded.value) });
}

export function readFoundationAttemptRecord(
  store: SqliteEventStore, attemptAggregateId: string,
): FoundationAttemptOutcome {
  return typeof attemptAggregateId === "string" && attemptAggregateId.length > 0
    ? readStoredFoundationAttempt(store, deriveDispatchAggregateId(attemptAggregateId))
    : refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
}
