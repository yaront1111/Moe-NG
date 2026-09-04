import type { JSX } from "react";

import type { RunNodeView } from "../../live/live-runs.js";
import { MIDDOT } from "../glyphs.js";
import { agoWords } from "../ops/activity-words.js";
import { ROUTE_WORDS, STATUS_WORDS } from "../runs/runs-screen.js";
import { BOARD_COLUMNS, COLUMN_WORDS, untilWords } from "./board-columns.js";
import type { BoardCard, BoardFold } from "./board-columns.js";

/**
 * THE SIX COLUMNS. A column head is its word and its count; the count IS the progress
 * metaphor. A card is three lines at most: the node's objective in bold, the one fact its
 * column chose, and a finding only where "why" is the next question. Everything the card
 * dropped is one click away, as LABELLED fields rather than prose. Pure.
 */

export interface BoardLanesProps {
  /** The statement behind a criterion id, from the coverage read; null when unknown. */
  readonly criterionStatement: (criterionId: string) => string | null;
  readonly fold: BoardFold;
  readonly nowMs: number;
}

function Field({ label, value }: { readonly label: string; readonly value: string | null }): JSX.Element | null {
  if (value === null || value === "") return null;
  return (
    <div className="cr2-kanban-field">
      <dt className="cr2-kanban-field-label">{label}</dt>
      <dd className="cr2-kanban-field-value">{value}</dd>
    </div>
  );
}

function receiptWords(node: RunNodeView): string | null {
  if (node.receipt === null) return null;
  return `${node.receipt.test} in ${node.receipt.workspace} ${MIDDOT} exit ${String(node.receipt.exitCode)}`
    + ` ${MIDDOT} output ${node.receipt.outputSha256.slice(0, 12)} (${String(node.receipt.byteCount)} bytes)`;
}

function landingWords(node: RunNodeView): string | null {
  if (node.landing === null) return null;
  if (node.landing.outcome === "COMMITTED") {
    return `commit ${(node.landing.sha ?? "").slice(0, 10)} on ${node.landing.branch ?? "?"}`
      + ` ${MIDDOT} ${String(node.landing.files.length)} file${node.landing.files.length === 1 ? "" : "s"}, local only`;
  }
  return `not landed: ${node.landing.code ?? "REFUSED"}`;
}

function claimWords(node: RunNodeView, nowMs: number): string | null {
  if (node.claim === null) return null;
  return node.claim.active
    ? `${node.claim.claimedBy} ${MIDDOT} lease ends ${untilWords(node.claim.expiresAt, nowMs) ?? "now"}`
    : `${node.claim.claimedBy} ${MIDDOT} ${node.claim.status === "RELEASED" ? "released" : "expired"}`
      + (node.lastActivityAt === null ? "" : ` ${MIDDOT} last activity ${agoWords(node.lastActivityAt, nowMs)}`);
}

function reviewWords(node: RunNodeView): string | null {
  if (node.review.rounds === 0) return null;
  const route = node.review.latestRoute === null ? "" : ` ${MIDDOT} last ${ROUTE_WORDS[node.review.latestRoute] ?? node.review.latestRoute}`;
  return `${String(node.review.rounds)} round${node.review.rounds === 1 ? "" : "s"}`
    + `, ${String(node.review.unsuccessfulRounds)} unsuccessful${route}`;
}

function CardDetails({ card, criterionStatement, nowMs }: {
  readonly card: BoardCard; readonly criterionStatement: BoardLanesProps["criterionStatement"]; readonly nowMs: number;
}): JSX.Element {
  const { node } = card;
  const criteria = node.criterionIds.map((id) => {
    const statement = criterionStatement(id);
    return statement === null ? id : `${id}: ${statement}`;
  });
  return (
    <div className="cr2-kanban-card-body" data-testid={`cr.kanban.detail.${node.nodeKey}`}>
      <dl className="cr2-kanban-fields">
        <Field label="Node" value={node.nodeKey} />
        <Field label="Daemon status" value={STATUS_WORDS[node.status]} />
        <Field label="Depends on" value={node.dependsOn.length === 0 ? null : node.dependsOn.join(", ")} />
        <Field label="Seat" value={claimWords(node, nowMs)} />
        <Field label="Review" value={reviewWords(node)} />
        <Field label="Verifier" value={receiptWords(node)} />
        <Field label="Accepted" value={node.accepted === null ? null : `receipt ${node.accepted.verifierReceiptId.slice(0, 12)}`} />
        <Field label="Landing" value={landingWords(node)} />
        <Field label="Shared key" value={node.sharedKey ? "another activated plan carries this node key" : null} />
      </dl>
      {criteria.length === 0 ? null : (
        <div className="cr2-kanban-criteria">
          <p className="cr2-kanban-field-label">{`Criteria this node satisfies (${String(criteria.length)})`}</p>
          <ul className="cr2-kanban-criteria-list">
            {criteria.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}
      {node.review.findings.length === 0 ? null : (
        <div className="cr2-kanban-findings">
          <p className="cr2-kanban-field-label">{`Findings from the last round (${String(node.review.findings.length)})`}</p>
          <ul className="cr2-kanban-findings-list">
            {node.review.findings.map((finding, index) => (
              <li data-severity={finding.severity} key={`${finding.ruleId}:${String(index)}`}>
                <span className="cr2-kanban-finding-rule">{`${finding.severity} ${MIDDOT} ${finding.ruleId}`}</span>
                {` ${finding.detail}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Card({ card, criterionStatement, nowMs }: {
  readonly card: BoardCard; readonly criterionStatement: BoardLanesProps["criterionStatement"]; readonly nowMs: number;
}): JSX.Element {
  const { node } = card;
  return (
    <li className="cr2-kanban-card-slot">
      <details className="cr2-kanban-card" data-column={card.column} data-status={node.status} data-testid={`cr.kanban.card.${node.nodeKey}`}>
        <summary className="cr2-kanban-card-face">
          <span className="cr2-kanban-card-title" title={node.objective}>{node.objective === "" ? node.nodeKey : node.objective}</span>
          <span className="cr2-kanban-card-line" data-testid={`cr.kanban.line.${node.nodeKey}`}>{card.line}</span>
          {card.finding === null ? null : (
            <span className="cr2-kanban-card-finding" data-testid={`cr.kanban.finding.${node.nodeKey}`} title={card.finding}>{card.finding}</span>
          )}
        </summary>
        <CardDetails card={card} criterionStatement={criterionStatement} nowMs={nowMs} />
      </details>
    </li>
  );
}

export function BoardLanes({ criterionStatement, fold, nowMs }: BoardLanesProps): JSX.Element {
  return (
    <div className="cr2-kanban-lanes" data-testid="cr.kanban.lanes">
      {BOARD_COLUMNS.map((column) => (
        <section
          aria-label={COLUMN_WORDS[column]}
          className="cr2-kanban-lane"
          data-column={column}
          data-count={String(fold.counts[column])}
          data-testid={`cr.kanban.lane.${column}`}
          key={column}
        >
          <h3 className="cr2-kanban-lane-head">
            <span className="cr2-kanban-lane-word">{COLUMN_WORDS[column]}</span>
            <span className="cr2-kanban-lane-count" data-testid={`cr.kanban.count.${column}`}>{String(fold.counts[column])}</span>
          </h3>
          <ul className="cr2-kanban-cards">
            {fold.cards[column].map((card) => (
              <Card card={card} criterionStatement={criterionStatement} key={card.node.nodeKey} nowMs={nowMs} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
