import type { CSSProperties, JSX } from "react";

import { ActionButton, FactRow, StatusChip } from "../components/primitives.js";
import { TruthChip } from "../components/truth-chip.js";
import { ARROW_RIGHT } from "../glyphs.js";
import type { ProofPayload } from "../shell/proof-context.js";
import type { GoalCardModel, GoalFact, HeadlineTone } from "./goal-model.js";

/**
 * One goal card (UI-3): the plain headline, a state label, a one-line human
 * status, an acceptance-progress bar, time and budget labels, a row of truth
 * chips, a "Show all N supplied facts" expander, and "Open board".
 *
 * Fields the surface cannot source (time, budget, acceptance progress) render as
 * an honest "coming online" chip rather than a fabricated number - the card is
 * dumb, and reads exactly what its model carries.
 */

const TONE_VAR: Readonly<Record<HeadlineTone, string>> = Object.freeze({
  accent: "--cr-accent-text",
  agent: "--cr-truth-agent",
  danger: "--cr-danger",
  verified: "--cr-truth-verified",
});

const OFFLINE_TONE = "--cr-conn-offline";

function payloadOf(goalId: string, fact: GoalFact): ProofPayload {
  return {
    factId: `${goalId}.${fact.factId}`,
    label: fact.label,
    value: fact.value,
    truthClass: fact.truthClass,
    note: fact.note,
    rows: fact.rows,
  };
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

export interface GoalCardProps {
  readonly goal: GoalCardModel;
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
  readonly onOpenBoard: () => void;
}

export function GoalCard({ goal, expanded, onToggleExpand, onOpenBoard }: GoalCardProps): JSX.Element {
  const dotStyle = { "--dot-tone": `var(${TONE_VAR[goal.headlineTone]})` } as CSSProperties;
  const progressPct = goal.progress === undefined || goal.progress.total === 0
    ? 0
    : Math.round((goal.progress.done / goal.progress.total) * 100);

  return (
    <li className="cr2-goal" data-state={goal.state} data-testid={`cr.goals.card.${goal.goalId}`}>
      <div className="cr2-goal-head">
        <div className="cr2-goal-lead">
          <div className="cr2-goal-titlerow">
            <button
              className="cr2-goal-title"
              data-identifier={goal.titleIsIdentifier ? "true" : undefined}
              data-testid={`cr.goals.card.${goal.goalId}.title`}
              onClick={onOpenBoard}
              type="button"
            >
              {goal.title}
            </button>
            <span className="cr2-goal-state" data-state={goal.state}>{goal.state}</span>
          </div>
          <div className="cr2-goal-headline">
            <span aria-hidden="true" className="cr2-goal-dot" style={dotStyle} />
            <span className="cr2-goal-headline-text">{goal.headline}</span>
          </div>
        </div>

        <div className="cr2-goal-progress">
          <div className="cr2-goal-progress-top">
            <span className="cr2-goal-progress-label" data-testid={`cr.goals.card.${goal.goalId}.progress`}>
              {goal.progress === undefined
                ? "Progress coming online"
                : `${String(goal.progress.done)} of ${String(goal.progress.total)} ${goal.progress.noun}`}
            </span>
            {goal.lastEventLabel === undefined ? (
              <StatusChip
                label="LAST EVENT COMING ONLINE"
                testId={`cr.goals.card.${goal.goalId}.lastevent.comingonline`}
                title="The event relay is not attached to this surface yet."
                toneVar={OFFLINE_TONE}
              />
            ) : (
              <span className="cr2-goal-lastevent">{goal.lastEventLabel}</span>
            )}
          </div>
          <div className="cr2-goal-bar" title={goal.progressComingOnline}>
            <div className="cr2-goal-bar-fill" style={{ width: `${String(progressPct)}%` } as CSSProperties} />
          </div>
          <div className="cr2-goal-budget">
            {goal.budgetLabel === undefined ? (
              <StatusChip
                label="BUDGET COMING ONLINE"
                testId={`cr.goals.card.${goal.goalId}.budget.comingonline`}
                title={goal.budgetComingOnline}
                toneVar={OFFLINE_TONE}
              />
            ) : (
              <>
                <span className="cr2-goal-budget-label">{goal.budgetLabel}</span>
                <TruthChip compact interactive={false} truthClass={goal.budgetTruthClass} />
              </>
            )}
          </div>
        </div>

        <div className="cr2-goal-open">
          <ActionButton
            ariaLabel={`Open the board for ${goal.title}`}
            onClick={onOpenBoard}
            testId={`cr.goals.card.${goal.goalId}.open`}
            variant="secondary"
          >
            {`Open board ${ARROW_RIGHT}`}
          </ActionButton>
        </div>
      </div>

      <div className="cr2-goal-chips">
        {goal.headlineFacts.map((fact) => (
          <span className="cr2-goal-pill" data-testid={`cr.goals.pill.${goal.goalId}.${slug(fact.label)}`} key={fact.factId}>
            <span className="cr2-goal-pill-label">{fact.label}</span>
            <span className="cr2-goal-pill-value">{fact.value}</span>
            <TruthChip compact contextLabel={fact.label} proof={payloadOf(goal.goalId, fact)} truthClass={fact.truthClass} />
          </span>
        ))}
        <button
          aria-expanded={expanded}
          className="cr2-goal-expand"
          data-testid={`cr.goals.card.${goal.goalId}.expand`}
          onClick={onToggleExpand}
          type="button"
        >
          {expanded
            ? `Hide all ${String(goal.facts.length)} supplied facts`
            : `Show all ${String(goal.facts.length)} supplied facts`}
        </button>
      </div>

      {expanded ? (
        <div className="cr2-goal-facts" data-testid={`cr.goals.card.${goal.goalId}.facts`}>
          {goal.facts.map((fact) => (
            <div className="cr2-goal-facts-cell" key={fact.factId}>
              <FactRow
                compact
                factId={`${goal.goalId}.${fact.factId}`}
                label={fact.label}
                proof={payloadOf(goal.goalId, fact)}
                truthClass={fact.truthClass}
                value={fact.value}
              />
            </div>
          ))}
          {goal.comingOnlineFacts.map((fact) => (
            <div className="cr2-goal-facts-cell" key={`co.${slug(fact.label)}`}>
              <div className="cr2-goal-comingonline" data-testid={`cr.goals.comingonline.${slug(fact.label)}`}>
                <span className="cr2-factrow-label">{fact.label}</span>
                <StatusChip label="COMING ONLINE" title={fact.reason} toneVar={OFFLINE_TONE} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}
