import { useMemo, useState } from "react";
import type { JSX } from "react";

import "../styles/cordum-goals.css";
import { ActionButton } from "../components/primitives.js";
import { EMDASH } from "../glyphs.js";
import { GoalCard } from "./goal-card.js";
import { NewGoalForm } from "./new-goal-form.js";
import { TriageStrips } from "./triage-strips.js";
import type {
  GoalCardModel, GoalCreateResult, GoalDraft, GoalsData, TriageStrip,
} from "./goal-model.js";

/**
 * The goals home (UI-3): triage strips, the filter row, the new-goal form, and
 * the goal cards - the shell's main slot, matching the owner's shot-1 / shot-2.
 *
 * This component is pure presentation over a `GoalsData` model. The live wiring
 * (deriving the one real goal from the affordance surface, dispatching
 * goal.create) lives in `live-goals.tsx`; the frozen three-goal design view lives
 * in `goals-fixtures.ts`. Which one is shown is the caller's decision, so the two
 * paths never blur here.
 */

const FILTERS = Object.freeze(["All", "Needs you", "Active", "Blocked"] as const);
type Filter = (typeof FILTERS)[number];

function matchesFilter(goal: GoalCardModel, filter: Filter): boolean {
  switch (filter) {
    case "Needs you": return goal.needsYou;
    case "Active": return goal.state === "ACTIVE";
    case "Blocked": return goal.state === "BLOCKED";
    default: return true;
  }
}

function matchesSearch(goal: GoalCardModel, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  return goal.title.toLowerCase().includes(needle)
    || goal.goalId.toLowerCase().includes(needle)
    || goal.headline.toLowerCase().includes(needle);
}

export interface GoalsHomeProps {
  readonly catalogNavigation?: GoalCatalogNavigation | undefined;
  readonly data: GoalsData;
  readonly onOpenBoard: (goalId: string, title: string, planningRunRef?: string) => void;
  /** Dispatches goal.create; only a proven durable creation may close the draft. */
  readonly onCreateGoal: (draft: GoalDraft) => Promise<GoalCreateResult>;
  readonly initialCreating?: boolean;
  /** Honest refusal shown while live goal prose has no durable backend contract. */
  readonly createDisabledReason?: string | undefined;
}

export interface GoalCatalogNavigation {
  readonly currentPage: number;
  readonly hasEarlier: boolean;
  readonly hasMore: boolean;
  readonly onFirst: () => void;
  readonly onNext: () => void;
}

export function GoalsHome({
  catalogNavigation,
  data,
  onOpenBoard,
  onCreateGoal,
  initialCreating = false,
  createDisabledReason,
}: GoalsHomeProps): JSX.Element {
  const [filter, setFilter] = useState<Filter>("All");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(initialCreating);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [createReport, setCreateReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryUnchanged, setRetryUnchanged] = useState(false);

  const visible = useMemo(
    () => data.goals.filter((goal) => matchesFilter(goal, filter) && matchesSearch(goal, search)),
    [data.goals, filter, search],
  );

  const openGoal = (goalId: string): void => {
    const goal = data.goals.find((candidate) => candidate.goalId === goalId);
    const title = goal?.title ?? goalId;
    if (goal?.planningRunRef === undefined) onOpenBoard(goalId, title);
    else onOpenBoard(goalId, title, goal.planningRunRef);
  };

  const onTriage = (strip: TriageStrip): void => {
    if (strip.openGoalId !== undefined) openGoal(strip.openGoalId);
  };

  const toggleExpand = (goalId: string): void => {
    setExpanded((prior) => {
      const next = new Set(prior);
      if (next.has(goalId)) next.delete(goalId); else next.add(goalId);
      return next;
    });
  };

  const create = (draft: GoalDraft): void => {
    setBusy(true);
    onCreateGoal(draft)
      .then((result) => {
        setCreateReport(result.report);
        setRetryUnchanged(result.retryUnchanged === true);
        if (result.created) setCreating(false);
      })
      .catch((error: unknown) => {
        setCreateReport(`UNDELIVERED: ${String(error)}`);
        setRetryUnchanged(true);
      })
      .finally(() => { setBusy(false); });
  };

  const creationLocked = busy || retryUnchanged;
  // A bound slot can be the result of this send. Keep its draft mounted until
  // the answer is definitive so an ambiguous attempt can replay unchanged.
  const showCreateForm = creating && (createDisabledReason === undefined || creationLocked);

  return (
    <section aria-label="Goals" className="cr2-goals" data-source={data.source} data-testid="cr.goals.home">
      <TriageStrips onSelect={onTriage} strips={data.triage} />

      <div className="cr2-goals-filter" data-testid="cr.goals.filterbar">
        <div aria-label="Filter goals" className="cr2-pillgroup" role="group">
          {FILTERS.map((option) => {
            const active = option === filter;
            return (
              <button
                aria-pressed={active}
                className="cr2-pill"
                data-active={active ? "true" : undefined}
                data-testid={`cr.goals.filter.${option.toLowerCase().replace(/ /gu, "")}`}
                key={option}
                onClick={() => setFilter(option)}
                type="button"
              >
                {option}
              </button>
            );
          })}
        </div>
        <input
          aria-label="Search goals"
          className="cr2-goals-search"
          data-testid="cr.goals.search"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search goals"
          value={search}
        />
        <span className="cr2-goals-count" data-testid="cr.goals.count">{data.goalCountLabel}</span>
        {catalogNavigation === undefined ? null : (
          <div aria-label="Catalog pages" className="cr2-goals-catalog-pages" role="group">
            <ActionButton
              disabled={!catalogNavigation.hasEarlier}
              onClick={catalogNavigation.onFirst}
              testId="cr.goals.catalog.first"
              variant="secondary"
            >
              First
            </ActionButton>
            <span className="cr2-goals-count" data-testid="cr.goals.catalog.page">
              PAGE {String(catalogNavigation.currentPage)}
            </span>
            <ActionButton
              disabled={!catalogNavigation.hasMore}
              onClick={catalogNavigation.onNext}
              testId="cr.goals.catalog.next"
              variant="secondary"
            >
              Next
            </ActionButton>
          </div>
        )}
        <div className="cr2-goals-new">
          <ActionButton
            ariaPressed={showCreateForm}
            disabled={createDisabledReason !== undefined || creationLocked}
            onClick={createDisabledReason === undefined && !creationLocked
              ? () => setCreating((open) => !open)
              : undefined}
            testId="cr.goals.new"
            title={createDisabledReason}
            variant="primary"
          >
            New goal
          </ActionButton>
        </div>
      </div>

      {createReport === null ? null : (
        <p aria-live="polite" className="cr2-goals-createreport" data-testid="cr.goals.createreport" role="status">
          {createReport}
        </p>
      )}

      {showCreateForm ? (
        <NewGoalForm
          busy={busy}
          onCancel={() => { if (!creationLocked) setCreating(false); }}
          onCreate={create}
          retryUnchanged={retryUnchanged}
        />
      ) : null}

      {data.goals.length === 0 ? (
        <div className="cr2-goals-empty" data-testid="cr.goals.empty">
          <p className="cr2-goals-empty-title">
            {data.comingOnlineNote ?? "No goals yet."}
          </p>
          <p className="cr2-goals-empty-body">
            {createDisabledReason === undefined
              ? `New goal ${EMDASH} one sentence is enough to start.`
              : `New goal unavailable ${EMDASH} ${createDisabledReason}`}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="cr2-goals-empty" data-testid="cr.goals.nomatch">
          <p className="cr2-goals-empty-title">No goals match this filter.</p>
        </div>
      ) : (
        <ul className="cr2-goals-list" data-testid="cr.goals.list">
          {visible.map((goal) => (
            <GoalCard
              expanded={expanded.has(goal.goalId)}
              goal={goal}
              key={goal.goalId}
              onOpenBoard={() => openGoal(goal.goalId)}
              onToggleExpand={() => toggleExpand(goal.goalId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
