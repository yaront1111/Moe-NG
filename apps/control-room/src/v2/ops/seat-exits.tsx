import type { JSX } from "react";

import type { SessionView } from "../../live/live-sessions.js";
import { MIDDOT } from "../glyphs.js";
import { agoWords } from "./activity-words.js";
import { seatExitLineWords, seatExitReasonWords } from "./seat-lifetime-words.js";

/**
 * THE LAST FEW AGENT SEATS TO EXIT, AND WHY EACH ONE ENDED.
 *
 * Before this list the Seats panel folded every past seat into one count ("16 closed"): a seat
 * killed after hanging for seven minutes with zero network and a seat that completed were the
 * same number. This lists the last `SEAT_EXITS_SHOWN` agent seats to exit with the reason the
 * wrapper RECORDED - kind, exit code, last printed line - and says "reason not recorded" for a
 * seat no exit record speaks for. It never guesses a kind.
 *
 * ORDER: seats with a recorded exit first, latest exit first. Then seats without one: EXPIRED
 * seats by expiry, latest lapse first - the lapse is the instant their own row dates itself by -
 * and CLOSED seats after them, latest lease first. A closed seat with no record carries no close
 * instant (the daemon folds `session.close` to a status, session-read-model.ts), so it is not
 * interleaved with the expired seats by a moment nothing observed. This is the order the daemon
 * already lists past seats in (sessions-read.ts sorts EXPIRED before CLOSED, expiry descending),
 * ranked HERE because no daemon test pins that sort and the heading's "last N to exit" must not
 * rest on it.
 */
export const SEAT_EXITS_SHOWN = 5;

/**
 * A seat HAS EXITED when the wrapper recorded its exit, or when its lease is no longer live.
 * Both, because the daemon folds the two independently (`sessions-read.ts`: `liveness` from
 * the session ledger and its clock, `exit` from the exit ledger): a seat whose exit is on
 * record still reads LIVE until its lease lapses or the close lands, and a seat older than the
 * exit ledger has no record at all. A LIVE seat with no record is the one that has not exited.
 */
const hasExited = (seat: SessionView): boolean => seat.exit !== null || seat.liveness !== "LIVE";

/** An unparseable instant ranks last among its peers, rather than poisoning the sort with NaN. */
const instant = (iso: string | undefined): number => {
  const ms = Date.parse(iso ?? "");
  return Number.isNaN(ms) ? 0 : ms;
};

export function lastExits(seats: readonly SessionView[]): readonly SessionView[] {
  const exited = seats.filter(hasExited);
  const recorded = exited.filter((seat) => seat.exit !== null)
    .sort((left, right) => instant(right.exit?.at) - instant(left.exit?.at));
  // Every unrecorded seat here is EXPIRED or CLOSED: `hasExited` keeps no LIVE seat without a record.
  const unrecorded = exited.filter((seat) => seat.exit === null)
    .sort((left, right) => (left.liveness === right.liveness
      ? instant(right.expiresAt) - instant(left.expiresAt)
      : left.liveness === "EXPIRED" ? -1 : 1));
  return Object.freeze([...recorded, ...unrecorded].slice(0, SEAT_EXITS_SHOWN));
}

export interface SeatExitsProps {
  readonly nowMs: number;
  /** The agent seats, live or not: `lastExits` decides which of them have exited. */
  readonly seats: readonly SessionView[];
}

export function SeatExits({ nowMs, seats }: SeatExitsProps): JSX.Element | null {
  const shown = lastExits(seats);
  if (shown.length === 0) return null;
  const heading = shown.length === 1
    ? `The last agent seat to exit ${MIDDOT} why it ended`
    : `The last ${String(shown.length)} agent seats to exit ${MIDDOT} why each one ended`;
  return (
    <div data-testid="cr.sessions.exits">
      <p className="cr2-needs-note" data-testid="cr.sessions.exits.heading">{heading}</p>
      <ul className="cr2-activity-list">
        {shown.map((seat) => {
          const line = seatExitLineWords(seat.exit);
          return (
            <li className="cr2-activity-row" data-testid={`cr.sessions.exit.${seat.sessionId}`} key={seat.sessionId}>
              <span className="cr2-activity-when">{seat.exit === null
                ? (seat.liveness === "EXPIRED" ? `expired ${agoWords(seat.expiresAt, nowMs)}` : "closed")
                : `exited ${agoWords(seat.exit.at, nowMs)}`}</span>
              <span className="cr2-activity-what">{seatExitReasonWords(seat.exit)}</span>
              <span className="cr2-approve-mono cr2-activity-target">
                {`${seat.sessionId}${line === null ? "" : ` ${MIDDOT} last line: ${line}`}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
