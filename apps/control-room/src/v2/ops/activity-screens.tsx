import type { JSX } from "react";

import type { ActivityOutcome } from "../../live/live-activity.js";
import type { SessionsOutcome } from "../../live/live-sessions.js";
import { MIDDOT } from "../glyphs.js";
import { agoWords, kindWords, principalWords } from "./activity-words.js";

/**
 * ACTIVITY and SESSIONS, the pure panels. Activity is the decision ledger in a person's
 * words: who did what to which aggregate, when, and whether it committed. Sessions is who
 * holds a seat and what each seat is working on. Both render only what the daemon stated;
 * codes and ids stay in mono beside the words.
 */

function Refusal({ outcome, testId }: {
  readonly outcome: { readonly code: string; readonly layer: string; readonly status: string }; readonly testId: string;
}): JSX.Element {
  return (
    <p className="cr2-approve-refusal" data-testid={testId} role="status">
      {`${outcome.status} ${MIDDOT} ${outcome.code} ${MIDDOT} ${outcome.layer}`}
    </p>
  );
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
      <h3 className="cr2-approve-heading">{`ACTIVITY ${MIDDOT} ${scopeLabel}`}</h3>
      {outcome === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.activity.loading">Reading the ledger...</p>
      ) : outcome.status !== "ACTIVITY" ? (
        <Refusal outcome={outcome} testId="cr.activity.refusal" />
      ) : outcome.entries.length === 0 ? (
        <p className="cr2-needs-note" data-testid="cr.activity.empty">Nothing has been decided here yet.</p>
      ) : (
        <>
          <p className="cr2-needs-note" data-testid="cr.activity.count">
            {`${String(outcome.entries.length)} of ${String(outcome.totalDecisions)} decisions, latest first.`
              + " Refused commands are not recorded, so they do not appear here."}
          </p>
          <ol className="cr2-activity-list" data-testid="cr.activity.list">
            {outcome.entries.map((entry, index) => (
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
        </>
      )}
    </section>
  );
}

export interface SessionsPanelProps {
  readonly nowMs: number;
  readonly outcome: SessionsOutcome | null;
}

export function SessionsPanel({ nowMs, outcome }: SessionsPanelProps): JSX.Element {
  return (
    <section className="cr2-ops-panel" data-testid="cr.sessions.root">
      <h3 className="cr2-approve-heading">{`SEATS ${MIDDOT} WHO IS WORKING`}</h3>
      {outcome === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.sessions.loading">Reading the seats...</p>
      ) : outcome.status !== "SESSIONS" ? (
        <Refusal outcome={outcome} testId="cr.sessions.refusal" />
      ) : (
        <>
          <p className="cr2-needs-note" data-testid="cr.sessions.count">
            {`${String(outcome.totals.live)} live ${MIDDOT} ${String(outcome.totals.expired)} expired ${MIDDOT} ${String(outcome.totals.closed)} closed`
              + (outcome.unreadable ? ` ${MIDDOT} some session records did not read` : "")}
          </p>
          {outcome.sessions.length === 0 ? (
            <p className="cr2-needs-note" data-testid="cr.sessions.empty">No seat has been opened on this daemon.</p>
          ) : (
            <ul className="cr2-activity-list" data-testid="cr.sessions.list">
              {outcome.sessions.map((session) => (
                <li className="cr2-activity-row" data-liveness={session.liveness} data-testid={`cr.sessions.row.${session.sessionId}`} key={session.sessionId}>
                  <span className="cr2-activity-when">{session.liveness === "LIVE"
                    ? `live until ${session.expiresAt}` : session.liveness === "EXPIRED" ? `expired ${agoWords(session.expiresAt, nowMs)}` : "closed"}</span>
                  <span className="cr2-activity-what">
                    {`${principalWords(session.principalId)}${session.holding.length === 0 ? "" : ` ${MIDDOT} working on ${session.holding.join(", ")}`}`}
                  </span>
                  <span className="cr2-approve-mono cr2-activity-target">{`${session.sessionId} ${MIDDOT} ${session.capabilities.join(" ")}`}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
