import type { CSSProperties, JSX } from "react";

import "./goal-card.css";
import { ActionButton, FactRow } from "../components/primitives.js";
import { TruthChip } from "../components/truth-chip.js";
import type { ProofPayload } from "../shell/proof-context.js";
import type { GoalCardModel, GoalFact, GoalStateLabel, HeadlineTone } from "./goal-model.js";

const STATE_WORDS: Readonly<Record<GoalStateLabel, string>> = Object.freeze({
  ACTIVE: "Active",
  BLOCKED: "Blocked",
  CANCELLED: "Abandoned",
  DONE: "Done",
  DRAFT: "Draft",
});

/** A project-local product entry. Execution counts remain inspectable facts. */

const TONE_VAR: Readonly<Record<HeadlineTone, string>> = Object.freeze({
  accent: "--cr-accent-text",
  agent: "--cr-truth-agent",
  danger: "--cr-danger",
  verified: "--cr-truth-verified",
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
  /** Opens the product's artifacts, including a PRD before a planning run exists. */
  readonly onOpenProduct?: (() => void) | undefined;
}

export function GoalCard({ goal, expanded, onToggleExpand, onOpenBoard, onOpenProduct }: GoalCardProps): JSX.Element {
  const canOpenBoard = onOpenProduct !== undefined || hasDurableRun(goal.planningRunRef);
  const open = onOpenProduct ?? onOpenBoard;
  const dotStyle = { "--dot-tone": `var(${TONE_VAR[goal.headlineTone]})` } as CSSProperties;

  return (
    <li className="cr2-goal cr2-product-card" data-state={goal.state} data-testid={`cr.goals.card.${goal.goalId}`}>
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
              onClick={canOpenBoard ? open : undefined}
              title={canOpenBoard ? undefined : NO_DURABLE_RUN_REASON}
              type="button"
            >
              {goal.title}
            </button>
            <span className="cr2-goal-state" data-state={goal.state}>
              {goal.needsYou ? "Needs you" : `Work: ${STATE_WORDS[goal.state].toLowerCase()}`}
            </span>
          </div>
          <div className="cr2-goal-headline">
            <span aria-hidden="true" className="cr2-goal-dot" style={dotStyle} />
            <span className="cr2-goal-headline-text">{goal.headline}</span>
          </div>
        </div>

        <div className="cr2-goal-open">
          {canOpenBoard ? (
            <ActionButton
              ariaLabel={`Open product ${goal.title}`}
              onClick={open}
              testId={`cr.goals.card.${goal.goalId}.open`}
              variant="secondary"
            >
              Open product
            </ActionButton>
          ) : (
            // No `onClick` at all, not a no-op: a handler on a disabled button is
            // the inert-enabled-button defect one refactor away from returning.
            <ActionButton
              ariaLabel={`Open product unavailable for ${goal.title}: ${NO_DURABLE_RUN_REASON}`}
              disabled
              testId={`cr.goals.card.${goal.goalId}.open-unavailable`}
              title={NO_DURABLE_RUN_REASON}
              variant="secondary"
            >
              Open product
            </ActionButton>
          )}
        </div>
      </div>

      <div className="cr2-product-card-footer">
        {goal.lastEventLabel === undefined ? null : <span className="cr2-goal-lastevent">{goal.lastEventLabel}</span>}
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
          <div className="cr2-goal-progress-top cr2-product-work-facts">
            <span className="cr2-goal-progress-label" data-testid={`cr.goals.card.${goal.goalId}.progress`}>
              {goal.progress === undefined ? goal.progressNote ?? "Progress unavailable"
                : `${String(goal.progress.done)} of ${String(goal.progress.total)} ${goal.progress.noun}`}
            </span>
          </div>
          {goal.headlineFacts.map((fact) => (
            <span className="cr2-goal-pill" data-testid={`cr.goals.pill.${goal.goalId}.${slug(fact.label)}`} key={`headline.${fact.factId}`}>
              <span className="cr2-goal-pill-label">{fact.label}</span>
              <span className="cr2-goal-pill-value">{fact.value}</span>
              <TruthChip compact contextLabel={fact.label} proof={payloadOf(goal.goalId, fact)} truthClass={fact.truthClass} />
            </span>
          ))}
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
