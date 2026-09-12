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
 * ORDER: seats with a recorded exit first, latest exit first; then seats without one, in the
 * order the daemon listed them. A seat without an exit record has no exit instant to rank by,
 * and ranking it by its expiry would place it at a moment nothing observed.
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

/** An unparseable instant ranks last among the recorded, rather than poisoning the sort with NaN. */
const exitInstant = (seat: SessionView): number => {
  const ms = Date.parse(seat.exit?.at ?? "");
  return Number.isNaN(ms) ? 0 : ms;
};

export function lastExits(seats: readonly SessionView[]): readonly SessionView[] {
  const exited = seats.filter(hasExited);
  const recorded = exited.filter((seat) => seat.exit !== null)
    .sort((left, right) => exitInstant(right) - exitInstant(left));
  const unrecorded = exited.filter((seat) => seat.exit === null);
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
