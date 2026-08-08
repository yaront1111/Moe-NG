import { useState } from "react";
import type { FormEvent, JSX } from "react";

import type { FixtureFact } from "../fixtures.js";
import { FactWithProvenance } from "../shell/provenance-panel.js";

/**
 * J1 goal creation (spec §4.2). Minimal by intent: the goals surface task builds the
 * rest of the home over this slice in place.
 *
 * The form is local state that hands a draft to its caller. It reaches no transport
 * and constructs no command, so nothing here can create a goal on its own — the
 * daemon remains the only thing that can accept one.
 */
export interface GoalDraft {
  readonly acceptance: string;
  readonly budget: string;
  readonly outcome: string;
  readonly risk: string;
}

export const GOAL_RISK_CLASSES = ["low", "normal", "high"] as const;
export type GoalRiskClass = (typeof GOAL_RISK_CLASSES)[number];

const EMPTY_DRAFT: GoalDraft = { acceptance: "", budget: "50", outcome: "", risk: "normal" };

export interface GoalsJ1Props {
  readonly facts: readonly FixtureFact[];
  readonly onCreate?: (draft: GoalDraft) => void;
}

export function GoalsJ1({ facts, onCreate }: GoalsJ1Props): JSX.Element {
  const [draft, setDraft] = useState<GoalDraft>(EMPTY_DRAFT);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onCreate?.(draft);
  };
  return (
    <section aria-label="Goals" data-testid="cr.surface.goals">
      {facts.map((fact) => (
        <FactWithProvenance fact={fact} key={fact.factId} />
      ))}
      <form data-testid="cr.goals.form" onSubmit={submit}>
        <label htmlFor="cr-goal-outcome">Outcome (one sentence is enough)</label>
        <input
          data-testid="cr.goals.field.outcome"
          id="cr-goal-outcome"
          onChange={(event) => {
            setDraft({ ...draft, outcome: event.target.value });
          }}
          value={draft.outcome}
        />
        <label htmlFor="cr-goal-acceptance">Acceptance criteria (optional, one per line)</label>
        <textarea
          data-testid="cr.goals.field.acceptance"
          id="cr-goal-acceptance"
          onChange={(event) => {
            setDraft({ ...draft, acceptance: event.target.value });
          }}
          value={draft.acceptance}
        />
        <label htmlFor="cr-goal-budget">Budget envelope</label>
        <input
          data-testid="cr.goals.field.budget"
          id="cr-goal-budget"
          onChange={(event) => {
            setDraft({ ...draft, budget: event.target.value });
          }}
          value={draft.budget}
        />
        <label htmlFor="cr-goal-risk">Risk class</label>
        <select
          data-testid="cr.goals.field.risk"
          id="cr-goal-risk"
          onChange={(event) => {
            setDraft({ ...draft, risk: event.target.value });
          }}
          value={draft.risk}
        >
          {GOAL_RISK_CLASSES.map((risk) => (
            <option key={risk} value={risk}>{risk}</option>
          ))}
        </select>
        <button data-testid="cr.goals.cancel" type="button">Cancel</button>
        <button data-testid="cr.goals.create" type="submit">Create goal</button>
      </form>
    </section>
  );
}
