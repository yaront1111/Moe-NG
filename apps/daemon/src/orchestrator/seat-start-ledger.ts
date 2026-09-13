import type { SqliteEventStore } from "@moe/store";

import {
  AGENT_WRAPPER_PRINCIPAL_ID,
} from "./provider-pause-contracts.js";
import { commit, existing } from "./provider-pause-ledger.js";
import {
  SEAT_FACT_UNMEASURED, SEAT_START_COMMAND_KIND, SEAT_START_VERSION, decodeSeatStartBytes,
  seatStartAggregateId, seatStartRecordId,
} from "./seat-start-contracts.js";
import type { SeatStartRecordV1 } from "./seat-start-contracts.js";
import { decisionsOf } from "../decision-ledger-memo.js";

/**
 * THE SEAT-START LEDGER: what the wrapper measured about a seat at the moment it spawned it.
 *
 * The write half runs in the WRAPPER process, once per admitted child. The read half runs in
 * the DAEMON process, folding those records so `/sessions/read` can state, per seat, which
 * provider it was actually started with and what that provider's CLI reported. Two processes,
 * one durable record between them — which is precisely why the published members are named for
 * the START, not for now: see `SessionView` in `http/sessions-read-contracts.ts`.
 *
 * The commit path is `recordSeatExit`'s, not a second one: `commit` and `existing` are imported
 * from the pause ledger rather than copied, so a replay rule that changes changes for both.
 */

export interface RecordSeatStartInput {
  /** Already SHAPED by `shapeAgentVersion`, or `SEAT_FACT_UNMEASURED`. Never raw stdout. */
  readonly agentVersion: string;
  readonly projectId: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly startedAt: string;
}

export type SeatStartRecordResult =
  | Readonly<{ ok: true; record: SeatStartRecordV1; replayed: boolean }>
  | Readonly<{ code: "EXPECTED_VERSION_CONFLICT" | "SEAT_START_RECORD_INVALID"; ok: false }>;

/** One durable record per seat start: which provider ran, and what version it answered. */
export function recordSeatStart(
  store: SqliteEventStore, input: RecordSeatStartInput,
): SeatStartRecordResult {
  const commandId = seatStartRecordId(input.projectId, input.sessionId, input.startedAt);
  const replay = existing(store, input.projectId, commandId);
  if (replay !== null) {
    const decoded = decodeSeatStartBytes(replay);
    return decoded.ok
      ? { ok: true, record: decoded.record, replayed: true }
      : { code: "SEAT_START_RECORD_INVALID", ok: false };
  }
  const resultBytes = new TextEncoder().encode(JSON.stringify({
    agentVersion: input.agentVersion,
    projectId: input.projectId,
    provider: input.provider,
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    version: SEAT_START_VERSION,
  }));
  // Decode BEFORE committing: a record this module could not read back is never written.
  const decoded = decodeSeatStartBytes(resultBytes);
  if (!decoded.ok) return { code: "SEAT_START_RECORD_INVALID", ok: false };
  const committed = commit(store, {
    aggregateId: seatStartAggregateId(input.projectId, input.sessionId),
    commandId,
    commandKind: SEAT_START_COMMAND_KIND,
    correlationId: "agent-wrapper-seat-start",
    decidedAt: input.startedAt,
    eventType: "SeatStartRecorded",
    projectId: input.projectId,
    resultBytes,
  });
  return committed
    ? { ok: true, record: decoded.record, replayed: false }
    : { code: "EXPECTED_VERSION_CONFLICT", ok: false };
}

const LEDGER_PAGE_SIZE = 200;

/** What one seat was started with, as the READ half publishes it. */
export interface SeatStartFacts {
  readonly agentVersion: string;
  readonly provider: string;
  /**
   * The wrapper's clock when it spawned the seat — the record's own `startedAt`, which the read
   * never surfaced before: the Health screen said "live until" and nothing about how long a seat had
   * been sitting there. Null for a seat with no readable record, because no word means "unknown"
   * and is also an instant.
   */
  readonly startedAt: string | null;
}

export type SeatStartLedger = ReadonlyMap<string, SeatStartFacts>;

/**
 * Every seat-start record this project committed, folded by sessionId, latest wins.
 *
 * AN UNDECODABLE ROW IS SKIPPED, NOT ESCALATED. A session whose record cannot be read reports
 * the SAME stated unknown as a session that has no record at all and as a probe that failed —
 * one token, one meaning — rather than marking the whole Seats read `unreadable`. A corrupt
 * note about which version a seat started with is not a reason to tell an operator the session
 * ledger is broken; the pause ledger skips the same way, for the same reason.
 */
export function readSeatStartLedger(store: SqliteEventStore, projectId: string): SeatStartLedger {
  const seats = new Map<string, SeatStartFacts>();
  for (const decision of decisionsOf(store, LEDGER_PAGE_SIZE)) {
    if (decision.key.projectId !== projectId
      || decision.effectDisposition !== "EFFECTS_COMMITTED"
      || decision.commandKind !== SEAT_START_COMMAND_KIND
      || decision.key.principalId !== AGENT_WRAPPER_PRINCIPAL_ID) {
      continue;
    }
    const decoded = decodeSeatStartBytes(decision.resultBytes);
    if (!decoded.ok || decoded.record.projectId !== projectId) continue;
    // The aggregate id is derived from the pair, so a row whose stream does not match its own
    // sessionId was not written by `recordSeatStart` and does not speak for that seat.
    if (decision.targetAggregateId !== seatStartAggregateId(projectId, decoded.record.sessionId)) {
      continue;
    }
    seats.set(decoded.record.sessionId, Object.freeze({
      agentVersion: decoded.record.agentVersion, provider: decoded.record.provider,
      startedAt: decoded.record.startedAt,
    }));
  }
  return seats;
}

/** What a seat with no readable start record publishes: the one stated unknown, on both members. */
export const SEAT_START_UNKNOWN: SeatStartFacts = Object.freeze({
  agentVersion: SEAT_FACT_UNMEASURED, provider: SEAT_FACT_UNMEASURED, startedAt: null,
});
