import type { SqliteEventStore } from "@moe/store";

import {
  AGENT_WRAPPER_PRINCIPAL_ID, SEAT_EXIT_COMMAND_KIND, decodeSeatExitBytes, seatExitAggregateId,
} from "./provider-pause-contracts.js";
import type { SeatExitRecordV1 } from "./provider-pause-contracts.js";
import { decisionsOf } from "../decision-ledger-memo.js";

/**
 * THE READ HALF OF THE SEAT-EXIT LEDGER: how each seat ended, folded by session for `/sessions/read`.
 *
 * `recordSeatExit` (provider-pause-ledger.ts) has written one record per seat exit — kind, exit
 * code, last output line — since the pause gate landed, but only the PAUSE was ever read back. The
 * Health screen listed past seats as a bare count, so a seat that hung for seven minutes and was
 * killed looked exactly like one that completed. This fold quotes the wrapper's note per seat.
 *
 * WHAT IS READ. The decision's committed RESULT bytes, through the same exact-key decoder the writer
 * verified them with before committing — never the event payload, which `commit` writes as
 * `{commandId, kind}` and which carries no reason. A payload or record that later grows (a signal,
 * say) is the decoder's concern; this fold picks the four members it publishes and is unchanged.
 *
 * Reads the way `readSeatStartLedger` does: latest row per session wins, an undecodable row is
 * skipped rather than escalated, and a row whose stream does not match its own sessionId was not
 * written by `recordSeatExit` and does not speak for that seat.
 */

const LEDGER_PAGE_SIZE = 200;

/** How one seat ended, as the read half publishes it. Every member is the record's own. */
export interface SeatExitFacts {
  /** The wrapper's clock when it observed the exit. */
  readonly at: string;
  /** Null when the seat died on a signal rather than an exit code (provider-pause-contracts.ts). */
  readonly exitCode: number | null;
  readonly kind: SeatExitRecordV1["kind"];
  /** The last non-empty line the seat printed, clipped at the record's bound, or null. */
  readonly lastLine: string | null;
}

export type SeatExitLedger = ReadonlyMap<string, SeatExitFacts>;

export function readSeatExitLedger(store: SqliteEventStore, projectId: string): SeatExitLedger {
  const seats = new Map<string, SeatExitFacts>();
  for (const decision of decisionsOf(store, LEDGER_PAGE_SIZE)) {
    if (decision.key.projectId !== projectId
      || decision.effectDisposition !== "EFFECTS_COMMITTED"
      || decision.commandKind !== SEAT_EXIT_COMMAND_KIND
      || decision.key.principalId !== AGENT_WRAPPER_PRINCIPAL_ID) {
      continue;
    }
    const decoded = decodeSeatExitBytes(decision.resultBytes);
    if (!decoded.ok || decoded.record.projectId !== projectId) continue;
    if (decision.targetAggregateId !== seatExitAggregateId(projectId, decoded.record.sessionId)) {
      continue;
    }
    seats.set(decoded.record.sessionId, Object.freeze({
      at: decoded.record.decidedAt,
      exitCode: decoded.record.exitCode,
      kind: decoded.record.kind,
      lastLine: decoded.record.lastLine,
    }));
  }
  return seats;
}
