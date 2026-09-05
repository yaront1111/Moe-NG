import type { JSX } from "react";

import type { ActivityOutcome } from "../../live/live-activity.js";
import type { SessionsOutcome, SessionView } from "../../live/live-sessions.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { MIDDOT } from "../glyphs.js";
import { readFailedSaid } from "../outcome-words.js";
import { pauseSeatWords } from "../shell/pause-context.js";
import type { ProviderPause } from "../shell/pause-context.js";
import { agoWords, isSeatRecord, kindWords, principalWords, seatLimitWords, seatWords } from "./activity-words.js";

/**
 * ACTIVITY and SESSIONS, the pure panels. Activity is the decision ledger in a person's
 * words: who did what to which aggregate, when, and whether it committed. Sessions is who
 * holds a seat and what each seat is working on. Both render only what the daemon stated;
 * codes and ids stay in mono beside the words.
 */

function Refusal({ outcome, testId, what }: {
  readonly outcome: { readonly code: string; readonly layer: string; readonly status: string };
  readonly testId: string;
  readonly what: string;
}): JSX.Element {
  return (
    <OutcomeNote
      code={outcome.code}
      layer={outcome.layer}
      said={readFailedSaid(what)}
      testId={testId}
    />
  );
}

type ActivityEntries = Extract<ActivityOutcome, { readonly entries: unknown }>["entries"];

function seatsOf(entries: ActivityEntries): ActivityEntries {
  return entries.filter((entry) => isSeatRecord(entry.commandKind, entry.targetAggregateId));
}

export interface ActivityPanelProps {
  readonly nowMs: number;
  readonly outcome: ActivityOutcome | null;
  /** Names the scope in the heading: a goal's title, or the project. */
  readonly scopeLabel: string;
}

export function ActivityPanel({ nowMs, outcome, scopeLabel }: ActivityPanelProps): JSX.Element {
  return (
    <section className="cr2-ops-panel" data-testid="cr.activity.root">
      <h3 className="cr2-approve-heading">{`Activity ${MIDDOT} ${scopeLabel}`}</h3>
      {outcome === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.activity.loading">Reading the ledger...</p>
      ) : outcome.status !== "ACTIVITY" ? (
        <Refusal outcome={outcome} testId="cr.activity.refusal" what="ledger" />
      ) : outcome.entries.length === 0 ? (
        <p className="cr2-needs-note" data-testid="cr.activity.empty">Nothing has been decided here yet.</p>
      ) : (
        <>
          <p className="cr2-needs-note" data-testid="cr.activity.count">
            {`${String(outcome.entries.length - seatsOf(outcome.entries).length)} work decisions of ${String(outcome.totalDecisions)} recorded, latest first.`
              + " Refused commands are not recorded, so they do not appear here."}
          </p>
          <ol className="cr2-activity-list" data-testid="cr.activity.list">
            {outcome.entries.map((entry, index) => ({ entry, index }))
              .filter(({ entry }) => !isSeatRecord(entry.commandKind, entry.targetAggregateId))
              .map(({ entry, index }) => (
              <li
                className="cr2-activity-row"
                data-disposition={entry.disposition}
                data-testid={`cr.activity.entry.${String(index)}`}
                key={`${entry.decidedAt}:${entry.targetAggregateId}:${String(index)}`}
              >
                <span className="cr2-activity-when">{agoWords(entry.decidedAt, nowMs)}</span>
                <span className="cr2-activity-what">
                  {`${principalWords(entry.principalId)} ${kindWords(entry.commandKind)}`}
                  {entry.disposition === "VERSION_CONFLICT" ? " (version conflict, nothing changed)" : ""}
                </span>
                <span className="cr2-approve-mono cr2-activity-target">
                  {`${entry.commandKind} ${MIDDOT} ${entry.targetAggregateId}${entry.version === null ? "" : ` ${MIDDOT} v${String(entry.version)}`}`}
                </span>
              </li>
            ))}
          </ol>
          {(() => {
            const seats = seatsOf(outcome.entries);
            return seats.length === 0 ? null : (
              <details className="cr2-approve-inspect" data-testid="cr.activity.seats">
                <summary className="cr2-approve-inspect-summary">
                  {`${String(seats.length)} seat and pairing records ${MIDDOT} sessions opened, renewed, closed`}
                </summary>
                <ol className="cr2-activity-list">
                  {seats.map((entry, index) => (
                    <li className="cr2-activity-row" key={`seat:${entry.decidedAt}:${String(index)}`}>
                      <span className="cr2-activity-when">{agoWords(entry.decidedAt, nowMs)}</span>
                      <span className="cr2-activity-what">{`${principalWords(entry.principalId)} ${kindWords(entry.commandKind)}`}</span>
                      <span className="cr2-approve-mono cr2-activity-target">{`${entry.commandKind} ${MIDDOT} ${entry.targetAggregateId}`}</span>
                    </li>
                  ))}
                </ol>
              </details>
            );
          })()}
        </>
      )}
    </section>
  );
}

export interface SessionsPanelProps {
  readonly nowMs: number;
  readonly outcome: SessionsOutcome | null;
  /** The shell-wide provider pause, or null/absent when none is known. */
  readonly paused?: ProviderPause | null | undefined;
}

export function SessionsPanel({ nowMs, outcome, paused }: SessionsPanelProps): JSX.Element {
  return (
    <section className="cr2-ops-panel" data-testid="cr.sessions.root">
      <h3 className="cr2-approve-heading">Seats</h3>
      {outcome === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.sessions.loading">Reading the seats...</p>
      ) : outcome.status !== "SESSIONS" ? (
        <Refusal outcome={outcome} testId="cr.sessions.refusal" what="seats" />
      ) : (
        <>
          {/* Above the list, and above the empty line: an empty Seats panel is exactly when a
              person needs to be told the wrapper is waiting rather than broken. */}
          {paused === undefined || paused === null ? null : (
            <p className="cr2-needs-note" data-testid="cr.sessions.paused">{pauseSeatWords(paused)}</p>
          )}
          {/* Above the seat list: the reason a person is looking at fewer moving nodes
              than they expected. Only what the daemon stated, both numbers. */}
          <p className="cr2-needs-note" data-testid="cr.sessions.limit">{seatLimitWords(outcome.concurrency)}</p>
          <p className="cr2-needs-note" data-testid="cr.sessions.count">
            {`${String(outcome.totals.live)} live ${MIDDOT} ${String(outcome.totals.expired)} expired ${MIDDOT} ${String(outcome.totals.closed)} closed`
              + (outcome.unreadable ? ` ${MIDDOT} some session records did not read` : "")}
          </p>
          {outcome.sessions.length === 0 ? (
            <p className="cr2-needs-note" data-testid="cr.sessions.empty">No seat has been opened on this daemon.</p>
          ) : (() => {
            const agentSeats = outcome.sessions.filter((session) => seatWords(session.sessionId) !== "a paired browser");
            const agents = agentSeats.filter((session) => session.liveness === "LIVE");
            const past = agentSeats.filter((session) => session.liveness !== "LIVE");
            const browsers = outcome.sessions.filter((session) => seatWords(session.sessionId) === "a paired browser");
            const row = (session: SessionView): JSX.Element => (
              <li className="cr2-activity-row" data-liveness={session.liveness} data-testid={`cr.sessions.row.${session.sessionId}`} key={session.sessionId}>
                <span className="cr2-activity-when">{session.liveness === "LIVE"
                  ? `live until ${session.expiresAt}` : session.liveness === "EXPIRED" ? `expired ${agoWords(session.expiresAt, nowMs)}` : "closed"}</span>
                <span className="cr2-activity-what">
                  {`${seatWords(session.sessionId)}${session.holding.length === 0 ? "" : ` ${MIDDOT} working on ${session.holding.join(", ")}`}`}
                </span>
                <span className="cr2-approve-mono cr2-activity-target">{`${session.sessionId} ${MIDDOT} ${session.capabilities.join(" ")}`}</span>
              </li>
            );
            return (
              <>
                {agents.length === 0 ? (
                  <p className="cr2-needs-note" data-testid="cr.sessions.noagents">No agent seat is open right now. Agents appear here while the wrapper is running.</p>
                ) : <ul className="cr2-activity-list" data-testid="cr.sessions.list">{agents.map(row)}</ul>}
                {past.length === 0 ? null : (
                  <details className="cr2-approve-inspect" data-testid="cr.sessions.past">
                    <summary className="cr2-approve-inspect-summary">{`${String(past.length)} past agent seats ${MIDDOT} expired or closed`}</summary>
                    <ul className="cr2-activity-list">{past.map(row)}</ul>
                  </details>
                )}
                {browsers.length === 0 ? null : (
                  <details className="cr2-approve-inspect" data-testid="cr.sessions.browsers">
                    <summary className="cr2-approve-inspect-summary">
                      {`${String(browsers.filter((session) => session.liveness === "LIVE").length)} paired browsers live ${MIDDOT} ${String(browsers.length)} in all`}
                    </summary>
                    <ul className="cr2-activity-list">{browsers.map(row)}</ul>
                  </details>
                )}
              </>
            );
          })()}
        </>
      )}
    </section>
  );
}
