import type { CSSProperties, JSX } from "react";

import "./goal-card.css";
import { ActionButton, FactRow } from "../components/primitives.js";
import { TruthChip } from "../components/truth-chip.js";
import { ARROW_RIGHT } from "../glyphs.js";
import type { ProofPayload } from "../shell/proof-context.js";
import type { GoalCardModel, GoalFact, HeadlineTone } from "./goal-model.js";

/**
 * One goal card: the title, the state word, what needs you, the one sentence that says
 * where the goal stands, the acceptance-progress bar with the nodes line beneath it, and
 * "Open board". That is the whole face - the words a person reads on a task board.
 *
 * Everything that identifies the goal to a machine (the goal id, the planning run, the PRD
 * digest, each with its truth chip and proof drawer) is one click away under "Show details".
 * Nothing is dropped; it stops leading.
 *
 * Fields the surface cannot source render as a plain note, never as a fabricated number.
 */

const TONE_VAR: Readonly<Record<HeadlineTone, string>> = Object.freeze({
  accent: "--cr-accent-text",
  agent: "--cr-truth-agent",
  danger: "--cr-danger",
  verified: "--cr-truth-verified",
});

const STATE_WORDS: Readonly<Record<GoalCardModel["state"], string>> = Object.freeze({
  ACTIVE: "Active",
  BLOCKED: "Blocked",
  DONE: "Done",
  DRAFT: "Planning",
});

/**
 * Why a card with no durable planning run cannot open a board. Named once: the
 * card's arms assert this exact text, and a second spelling would drift from them.
 */
const NO_DURABLE_RUN_REASON = "No durable planning run is recorded for this goal.";

/**
 * `planningRunRef` is typed `string | undefined`, so the type admits `""` - a
 * value the surface cannot use. A `!== undefined` check would render an enabled
 * Open control that opens nothing, so absence is "not a non-blank string".
 */
function hasDurableRun(planningRunRef: string | undefined): boolean {
  return typeof planningRunRef === "string" && planningRunRef.trim().length > 0;
}

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
  // A card carries TWO doors to the board - the title button and the Open control.
  // Both are gated on the same fact, because disabling only one relabels the hole.
  const canOpenBoard = hasDurableRun(goal.planningRunRef);
  const dotStyle = { "--dot-tone": `var(${TONE_VAR[goal.headlineTone]})` } as CSSProperties;
  const progressPct = goal.progress === undefined || goal.progress.total === 0
    ? 0
    : Math.round((goal.progress.done / goal.progress.total) * 100);
  const needsYou = goal.needsYouLabels?.[0] ?? (goal.needsYou ? "Needs you" : null);

  return (
    <li className="cr2-goal" data-state={goal.state} data-testid={`cr.goals.card.${goal.goalId}`}>
      <div className="cr2-goal-head">
        <div className="cr2-goal-lead">
          <div className="cr2-goal-titlerow">
            <button
              // `title` alone is announced inconsistently, so the reason also rides
              // on the accessible name - prefixed with the goal title, which is the
              // name this button would otherwise carry from its own text.
              aria-label={canOpenBoard ? undefined : `${goal.title}: ${NO_DURABLE_RUN_REASON}`}
              className="cr2-goal-title"
              data-identifier={goal.titleIsIdentifier ? "true" : undefined}
              data-testid={`cr.goals.card.${goal.goalId}.title`}
              disabled={!canOpenBoard}
              onClick={canOpenBoard ? onOpenBoard : undefined}
              title={canOpenBoard ? undefined : NO_DURABLE_RUN_REASON}
              type="button"
            >
              {goal.title}
            </button>
            <span className="cr2-goal-state" data-state={goal.state} data-testid={`cr.goals.card.${goal.goalId}.state`}>
              {STATE_WORDS[goal.state]}
            </span>
            {needsYou === null ? null : (
              <span className="cr2-goal-needsyou" data-testid={`cr.goals.card.${goal.goalId}.needsyou`}>{needsYou}</span>
            )}
          </div>
          <div className="cr2-goal-headline">
            <span aria-hidden="true" className="cr2-goal-dot" style={dotStyle} />
            <span className="cr2-goal-headline-text" data-testid={`cr.goals.card.${goal.goalId}.headline`}>{goal.headline}</span>
          </div>
        </div>

        <div className="cr2-goal-progress">
          <div className="cr2-goal-progress-top">
            <span className="cr2-goal-progress-label" data-testid={`cr.goals.card.${goal.goalId}.progress`}>
              {goal.progress === undefined
                ? goal.progressNote ?? "Progress unavailable"
                : `${String(goal.progress.done)} of ${String(goal.progress.total)} ${goal.progress.noun}`}
            </span>
            {goal.lastEventLabel === undefined
              ? null
              : <span className="cr2-goal-lastevent">{goal.lastEventLabel}</span>}
          </div>
          <div className="cr2-goal-bar" title={goal.progressComingOnline}>
            <div className="cr2-goal-bar-fill" style={{ width: `${String(progressPct)}%` } as CSSProperties} />
          </div>
          {goal.nodesLine === undefined ? null : (
            <p className="cr2-goal-nodes" data-testid={`cr.goals.card.${goal.goalId}.nodes`}>{goal.nodesLine}</p>
          )}
        </div>

        <div className="cr2-goal-open">
          {canOpenBoard ? (
            <ActionButton
              ariaLabel={`Open the board for ${goal.title}`}
              onClick={onOpenBoard}
              testId={`cr.goals.card.${goal.goalId}.open`}
              variant="secondary"
            >
              {`Open board ${ARROW_RIGHT}`}
            </ActionButton>
          ) : (
            // No `onClick` at all, not a no-op: a handler on a disabled button is
            // the inert-enabled-button defect one refactor away from returning.
            <ActionButton
              ariaLabel={`Open board unavailable for ${goal.title}: ${NO_DURABLE_RUN_REASON}`}
              disabled
              testId={`cr.goals.card.${goal.goalId}.open-unavailable`}
              title={NO_DURABLE_RUN_REASON}
              variant="secondary"
            >
              {`Open board ${ARROW_RIGHT}`}
            </ActionButton>
          )}
        </div>
      </div>

      <div className="cr2-goal-chips">
        <button
          aria-expanded={expanded}
          className="cr2-goal-expand"
          data-testid={`cr.goals.card.${goal.goalId}.expand`}
          onClick={onToggleExpand}
          type="button"
        >
          {expanded
            ? `Hide details (${String(goal.facts.length)} supplied facts)`
            : `Show details (${String(goal.facts.length)} supplied facts)`}
        </button>
      </div>

      {expanded ? (
        <div className="cr2-goal-facts" data-testid={`cr.goals.card.${goal.goalId}.facts`}>
          <div className="cr2-goal-chips">
            {goal.headlineFacts.map((fact) => (
              <span className="cr2-goal-pill" data-testid={`cr.goals.pill.${goal.goalId}.${slug(fact.label)}`} key={fact.factId}>
                <span className="cr2-goal-pill-label">{fact.label}</span>
                <span className="cr2-goal-pill-value">{fact.value}</span>
                <TruthChip compact contextLabel={fact.label} proof={payloadOf(goal.goalId, fact)} truthClass={fact.truthClass} />
              </span>
            ))}
          </div>
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
        </div>
      ) : null}
    </li>
  );
}
