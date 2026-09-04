import type { JSX } from "react";

import type { ActivityEntryView, ActivityOutcome } from "../../live/live-activity.js";
import { ARROW_RIGHT, MIDDOT } from "../glyphs.js";
import { GOAL_SECTION_IDS } from "../goals/goal-status-strip.js";
import { agoWords, decisionWords, isSeatRecord, principalWords } from "../ops/activity-words.js";

/**
 * THE DECISION FEED: one line per decision the daemon recorded for this goal, latest first,
 * in three fields - WHEN, WHO DID WHAT, ON WHAT. The target is resolved to a name a person
 * knows: "this goal", "the plan", or the node's own objective; an id is shown only when the
 * runs read does not know it. Seat and pairing records never reach the feed. Pure.
 */

export interface BoardFeedProps {
  readonly goalId: string;
  readonly nowMs: number;
  /** The objective behind a node key, from the runs read; null when the node is unknown. */
  readonly objectiveOf: (nodeKey: string) => string | null;
  readonly outcome: ActivityOutcome | null;
  readonly runId: string;
}

const GOOD_KINDS: ReadonlySet<string> = new Set([
  "approval.decide", "approval.decide_intent", "goal.close", "integration.accept_output",
  "product_contract.approve_gate_1", "internal.repository.landing_receipt",
]);
const BAD_KINDS: ReadonlySet<string> = new Set(["qualification.replan"]);

/** The tint a line carries, from its kind and its verdict alone: good, bad, or none. */
export function toneOf(entry: ActivityEntryView): "bad" | "good" | "none" {
  if (entry.disposition === "VERSION_CONFLICT") return "none";
  if (entry.commandKind === "review.submit") {
    if (entry.verdict === "ACCEPT") return "good";
    return entry.verdict === null ? "none" : "bad";
  }
  if (entry.commandKind === "escalation.decide") return entry.verdict === "REPLAN" ? "bad" : "none";
  if (GOOD_KINDS.has(entry.commandKind)) return "good";
  return BAD_KINDS.has(entry.commandKind) ? "bad" : "none";
}

function targetWords(entry: ActivityEntryView, props: BoardFeedProps): string {
  if (entry.targetAggregateId === props.goalId) return "this goal";
  if (entry.targetAggregateId === props.runId) return "the plan";
  const objective = props.objectiveOf(entry.targetAggregateId);
  return objective === null ? entry.targetAggregateId : objective;
}

export function BoardFeed(props: BoardFeedProps): JSX.Element {
  const { nowMs, outcome } = props;
  return (
    <aside aria-label="Decisions" className="cr2-kanban-feed" data-testid="cr.kanban.feed" id={GOAL_SECTION_IDS.activity}>
      <h3 className="cr2-kanban-feed-head">
        Decisions
        <span className="cr2-kanban-feed-help" title="Every command the daemon committed for this goal, latest first. A refused command is not a decision and is not listed.">?</span>
      </h3>
      {outcome === null ? (
        <p className="cr2-kanban-note" data-testid="cr.kanban.feed.loading">Reading the decisions...</p>
      ) : outcome.status !== "ACTIVITY" ? (
        <p className="cr2-kanban-note" data-testid="cr.kanban.feed.refusal" title={`${outcome.code} ${MIDDOT} ${outcome.layer}`}>
          The decisions could not be read right now; the board above still holds.
        </p>
      ) : (() => {
        const rows = outcome.entries.filter((entry) => !isSeatRecord(entry.commandKind, entry.targetAggregateId));
        return rows.length === 0 ? (
          <p className="cr2-kanban-note" data-testid="cr.kanban.feed.empty">Nothing has been decided here yet.</p>
        ) : (
          <ol className="cr2-kanban-feed-list" data-testid="cr.kanban.feed.list">
            {rows.map((entry, index) => (
              <li
                className="cr2-kanban-feed-row"
                data-tone={toneOf(entry)}
                data-testid={`cr.kanban.feed.entry.${String(index)}`}
                key={`${entry.decidedAt}:${entry.targetAggregateId}:${String(index)}`}
                title={`${entry.commandKind} ${MIDDOT} ${entry.targetAggregateId}${entry.version === null ? "" : ` ${MIDDOT} v${String(entry.version)}`}`}
              >
                <span className="cr2-kanban-feed-when">{agoWords(entry.decidedAt, nowMs)}</span>
                <span className="cr2-kanban-feed-what">
                  {`${principalWords(entry.principalId)} ${decisionWords(entry.commandKind, entry.verdict)}`}
                  {entry.disposition === "VERSION_CONFLICT" ? " (version conflict, nothing changed)" : ""}
                </span>
                <span className="cr2-kanban-feed-target">{`${ARROW_RIGHT} ${targetWords(entry, props)}`}</span>
              </li>
            ))}
          </ol>
        );
      })()}
    </aside>
  );
}
