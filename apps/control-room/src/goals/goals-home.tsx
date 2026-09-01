import type { NextAllowedCommand } from "@moe/contracts";
import { useState } from "react";
import type { JSX, KeyboardEvent } from "react";

import { FactRow } from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";
import { SuppliedActions } from "./supplied-actions.js";

/**
 * Goals home (spec §2.1, §4.1, §11.3).
 *
 * Every value on this surface arrives already projected and already truth-classified.
 * The module counts no phases, sums no budget, ranks no truth, sorts no rows, and
 * filters nothing: filter and search are the caller's state, so what the daemon
 * returned is exactly what is shown. These are presentation contracts, not wire DTOs —
 * nothing here parses a daemon response.
 */
export interface GoalRowProjection {
  readonly approvals: SuppliedFact;
  readonly budgetBasis: SuppliedFact;
  readonly budgetQuarantined: SuppliedFact;
  readonly budgetReserved: SuppliedFact;
  readonly budgetSpent: SuppliedFact;
  readonly budgetUnknown: SuppliedFact;
  readonly completion: SuppliedFact;
  readonly frontierStatus: SuppliedFact;
  readonly goalId: string;
  readonly held: SuppliedFact;
  readonly lastEventAge: SuppliedFact;
  readonly phaseDistribution: SuppliedFact;
  readonly providerCapacity: SuppliedFact;
  readonly readyWidth: SuppliedFact;
  readonly reconciliation: SuppliedFact;
  readonly state: SuppliedFact;
  readonly suspect: SuppliedFact;
  readonly title: string;
}

/** Creation prefill as policy supplied it; this module authors no default of its own. */
export interface GoalCreationDefaults {
  readonly budget: string;
  readonly policyNote: string;
  readonly risk: string;
  readonly riskOptions: readonly string[];
}

export interface GoalDraftValues {
  readonly acceptance: string;
  readonly budget: string;
  readonly outcome: string;
  readonly risk: string;
}

export interface GoalsHomeProps {
  readonly appliedCursorLabel?: string | undefined;
  readonly creation: GoalCreationDefaults;
  readonly degraded?: boolean | undefined;
  readonly filterOptions: readonly string[];
  readonly filterValue: string;
  readonly loading?: boolean | undefined;
  readonly onCreate?: ((command: NextAllowedCommand, draft: GoalDraftValues) => void) | undefined;
  readonly onFilterChange?: ((value: string) => void) | undefined;
  readonly onFocusRow?: ((goalId: string) => void) | undefined;
  readonly onOpenGoal?: ((goalId: string) => void) | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly onSearchChange?: ((value: string) => void) | undefined;
  readonly projectAggregateId: string;
  readonly rows: readonly GoalRowProjection[];
  readonly searchValue: string;
}

type RowFactSpec = readonly [
  suffix: string, label: string, pick: (row: GoalRowProjection) => SuppliedFact,
];

/** The declared fact kinds of §2.1, in rendered order. Each one carries its own chip. */
const ROW_FACTS: readonly RowFactSpec[] = [
  ["state", "Goal state", (row) => row.state],
  ["phasedistribution", "Phase distribution", (row) => row.phaseDistribution],
  ["providercapacity", "Provider capacity", (row) => row.providerCapacity],
  ["readywidth", "Ready width", (row) => row.readyWidth],
  ["frontier", "Frontier status", (row) => row.frontierStatus],
  ["budget.spent", "Budget spent", (row) => row.budgetSpent],
  ["budget.reserved", "Budget reserved", (row) => row.budgetReserved],
  ["budget.quarantined", "Budget quarantined", (row) => row.budgetQuarantined],
  ["budget.unknown", "Budget unknown", (row) => row.budgetUnknown],
  ["budget.basis", "Budget basis", (row) => row.budgetBasis],
  ["approvals", "Pending approvals", (row) => row.approvals],
  ["held", "Held", (row) => row.held],
  ["suspect", "SUSPECT leases", (row) => row.suspect],
  ["reconciliation", "Reconciliation", (row) => row.reconciliation],
  ["lasteventage", "Last event age", (row) => row.lastEventAge],
  ["completion", "Completion", (row) => row.completion],
];

const EMPTY_COPY = "No goals yet. [New goal] — one sentence is enough to start.";

function GoalRow(props: {
  readonly onProvenance?: ProvenanceHandler | undefined;
  readonly row: GoalRowProjection;
}): JSX.Element {
  const { onProvenance, row } = props;
  return (
    <li data-goal-row={row.goalId} data-testid={`cr.goals.row.${row.goalId}`} tabIndex={-1}>
      <a data-testid={`cr.goals.link.${row.goalId}`}
        href={`/goal/${encodeURIComponent(row.goalId)}/board`}>{row.title}</a>
      {ROW_FACTS.map(([suffix, label, pick]) => (
        <FactRow
          fact={pick(row)}
          factId={`goal.${row.goalId}.${suffix}`}
          key={suffix}
          label={label}
          onProvenance={onProvenance}
        />
      ))}
    </li>
  );
}

/**
 * The form holds only the draft. It reaches no transport and builds no envelope: the
 * only thing that can start a goal is the daemon-supplied `goal.create` command for
 * this exact project, handed back to the caller untouched.
 */
function CreateForm(props: {
  readonly creation: GoalCreationDefaults;
  readonly onCreate?: ((command: NextAllowedCommand, draft: GoalDraftValues) => void) | undefined;
  readonly projectAggregateId: string;
}): JSX.Element {
  const { creation, onCreate, projectAggregateId } = props;
  const [draft, setDraft] = useState<GoalDraftValues>({
    acceptance: "", budget: creation.budget, outcome: "", risk: creation.risk,
  });
  return (
    <form data-testid="cr.goals.form" onSubmit={(event) => { event.preventDefault(); }}>
      <label htmlFor="cr-goals-outcome">Outcome (one sentence is enough)</label>
      <input
        data-testid="cr.goals.field.outcome" id="cr-goals-outcome"
        onChange={(event) => { setDraft({ ...draft, outcome: event.target.value }); }}
        value={draft.outcome}
      />
      <label htmlFor="cr-goals-acceptance">Acceptance criteria (optional, one per line)</label>
      <textarea
        data-testid="cr.goals.field.acceptance" id="cr-goals-acceptance"
        onChange={(event) => { setDraft({ ...draft, acceptance: event.target.value }); }}
        value={draft.acceptance}
      />
      <label htmlFor="cr-goals-budget">Budget envelope</label>
      <input
        data-testid="cr.goals.field.budget" id="cr-goals-budget"
        onChange={(event) => { setDraft({ ...draft, budget: event.target.value }); }}
        value={draft.budget}
      />
      <label htmlFor="cr-goals-risk">Risk class</label>
      <select
        data-testid="cr.goals.field.risk" id="cr-goals-risk"
        onChange={(event) => { setDraft({ ...draft, risk: event.target.value }); }}
        value={draft.risk}
      >
        {creation.riskOptions.map((risk) => (
          <option key={risk} value={risk}>{risk}</option>
        ))}
      </select>
      <p data-testid="cr.goals.policynote">{creation.policyNote}</p>
      <SuppliedActions
        commandKind="goal.create"
        onActivate={(command) => { onCreate?.(command, draft); }}
        targetAggregateId={projectAggregateId}
        testId="cr.goals.create"
      />
    </form>
  );
}

function stepIndex(key: string, current: number): number {
  if (key === "j") return current + 1;
  if (key === "k") return current - 1;
  return current;
}

/**
 * The key's own target, only when it is the list or one of its rows. A key that reaches
 * a link, a chip, or a command button inside a row belongs to that control: the walk may
 * not swallow it, because cancelling Enter there cancels the control's own activation
 * and opens whichever row the cursor last rested on instead.
 */
function rowTarget(event: KeyboardEvent<HTMLUListElement>): HTMLElement | null {
  const { target } = event;
  if (!(target instanceof HTMLElement)) return null;
  if (target !== event.currentTarget && !target.hasAttribute("data-goal-row")) return null;
  return target;
}

export function GoalsHome(props: GoalsHomeProps): JSX.Element {
  const {
    appliedCursorLabel, creation, degraded, filterOptions, filterValue, loading, onCreate,
    onFilterChange, onFocusRow, onOpenGoal, onProvenance, onSearchChange, projectAggregateId,
    rows, searchValue,
  } = props;
  const [focusIndex, setFocusIndex] = useState(-1);

  const handleKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const { key } = event;
    if (key !== "j" && key !== "k" && key !== "Enter") return;
    const target = rowTarget(event);
    if (target === null) return;
    event.preventDefault();
    // A row reached by Tab or by pointer is the row the key is about, whatever the
    // cursor remembered; the cursor stands in only while the list itself holds focus.
    const rowNodes = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-goal-row]")];
    const origin = target === event.currentTarget ? focusIndex : rowNodes.indexOf(target);
    const index = Math.min(Math.max(stepIndex(key, origin), 0), rows.length - 1);
    const row = rows[index];
    if (row === undefined) return;
    setFocusIndex(index);
    rowNodes[index]?.focus();
    if (key === "Enter") onOpenGoal?.(row.goalId);
    else onFocusRow?.(row.goalId);
  };

  return (
    <section aria-label="Goals" data-testid="cr.surface.goals">
      {degraded === true ? (
        <p data-testid="cr.goals.asof" role="status">
          Showing last-known goals as of {appliedCursorLabel ?? "UNKNOWN"}
        </p>
      ) : null}
      <label htmlFor="cr-goals-filter">Filter</label>
      <select
        data-testid="cr.goals.filter" id="cr-goals-filter"
        onChange={(event) => { onFilterChange?.(event.target.value); }}
        value={filterValue}
      >
        {filterOptions.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      <label htmlFor="cr-goals-search">Search</label>
      <input
        data-testid="cr.goals.search" id="cr-goals-search"
        onChange={(event) => { onSearchChange?.(event.target.value); }}
        value={searchValue}
      />
      <CreateForm
        creation={creation}
        onCreate={onCreate}
        projectAggregateId={projectAggregateId}
      />
      {loading === true ? (
        <div data-testid="cr.goals.loading">
          {[0, 1, 2].map((slot) => (
            <div data-testid="cr.goals.skeleton" key={slot} />
          ))}
        </div>
      ) : (
        <ul data-testid="cr.goals.list" onKeyDown={handleKey} tabIndex={0}>
          {rows.map((row) => (
            <GoalRow key={row.goalId} onProvenance={onProvenance} row={row} />
          ))}
        </ul>
      )}
      {loading !== true && rows.length === 0 ? (
        <p data-testid="cr.goals.empty">{EMPTY_COPY}</p>
      ) : null}
    </section>
  );
}
