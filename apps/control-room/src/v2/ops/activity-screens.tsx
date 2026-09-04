import type { JSX } from "react";

import type { ActivityOutcome } from "../../live/live-activity.js";
import type { SessionsOutcome, SessionView } from "../../live/live-sessions.js";
import { ARROW_RIGHT, MIDDOT } from "../glyphs.js";
import { untilWords } from "../board/board-columns.js";
import { agoWords, decisionWords, isSeatRecord, kindWords, principalWords, seatWords } from "./activity-words.js";

/** Who or what a project-wide decision landed on, without a goal's objectives to name nodes by. */
function targetWords(targetAggregateId: string): string {
  if (targetAggregateId.startsWith("goal-")) return `goal ${targetAggregateId.slice(5, 13)}`;
  if (targetAggregateId.startsWith("run-")) return `the plan of goal ${targetAggregateId.slice(4, 12)}`;
  if (targetAggregateId.startsWith("work/")) return `the work item ${targetAggregateId.slice(5)}`;
  if (targetAggregateId.startsWith("landing:")) return `the landing of ${targetAggregateId.slice(8)}`;
  if (targetAggregateId.startsWith("publish:")) return `the publish of goal ${targetAggregateId.slice(13, 21)}`;
  return targetAggregateId;
}
import { refusalWords } from "../components/refusal-words.js";

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
      {refusalWords(outcome)}
    </p>
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
      <h3 className="cr2-approve-heading">{`ACTIVITY ${MIDDOT} ${scopeLabel}`}</h3>
      {outcome === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.activity.loading">Reading the ledger...</p>
      ) : outcome.status !== "ACTIVITY" ? (
        <Refusal outcome={outcome} testId="cr.activity.refusal" />
      ) : outcome.entries.length === 0 ? (
        <p className="cr2-needs-note" data-testid="cr.activity.empty">Nothing has been decided here yet.</p>
      ) : (
        <>
          <p className="cr2-needs-note" data-testid="cr.activity.count" title="Refused commands are not recorded, so they do not appear here.">
            {`${String(outcome.entries.length - seatsOf(outcome.entries).length)} work decisions of ${String(outcome.totalDecisions)} recorded, latest first.`}
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
                title={`${entry.commandKind} ${MIDDOT} ${entry.targetAggregateId}${entry.version === null ? "" : ` ${MIDDOT} v${String(entry.version)}`}`}
              >
                <span className="cr2-activity-when">{agoWords(entry.decidedAt, nowMs)}</span>
                <span className="cr2-activity-what">
                  {`${principalWords(entry.principalId)} ${decisionWords(entry.commandKind, entry.verdict)}`}
                  {entry.disposition === "VERSION_CONFLICT" ? " (version conflict, nothing changed)" : ""}
                </span>
                <span className="cr2-activity-target">{`${ARROW_RIGHT} ${targetWords(entry.targetAggregateId)}`}</span>
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
          ) : (() => {
            const agentSeats = outcome.sessions.filter((session) => seatWords(session.sessionId) !== "a paired browser");
            const agents = agentSeats.filter((session) => session.liveness === "LIVE");
            const past = agentSeats.filter((session) => session.liveness !== "LIVE");
            const browsers = outcome.sessions.filter((session) => seatWords(session.sessionId) === "a paired browser");
            const row = (session: SessionView): JSX.Element => (
              <li className="cr2-activity-row" data-liveness={session.liveness} data-testid={`cr.sessions.row.${session.sessionId}`} key={session.sessionId}>
                <span className="cr2-activity-when" title={session.expiresAt}>{session.liveness === "LIVE"
                  ? `live ${MIDDOT} lease ends ${untilWords(session.expiresAt, nowMs) ?? "now"}`
                  : session.liveness === "EXPIRED" ? `expired ${agoWords(session.expiresAt, nowMs)}` : "closed"}</span>
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
