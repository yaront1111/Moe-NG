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

function glanceRank(goal: GoalCardModel): number {
  if (goal.needsYou) return 0;
  if (goal.state === "BLOCKED" || goal.headlineTone === "danger") return 1;
  if (goal.state === "ACTIVE") return 2;
  if (goal.state === "DONE") return 4;
  return 3;
}

export interface GoalsHomeProps {
  readonly data: GoalsData;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
  /**
   * Dispatches goal.create. A `GoalCreateResult` says whether the write actually
   * committed; a bare string is accepted for callers that only ever report (the
   * fixtures and connecting paths) and is treated as NOT committed, because
   * nothing was created.
   */
  readonly onCreateGoal: (draft: GoalDraft) => Promise<GoalCreateResult | string>;
  readonly initialCreating?: boolean;
  /** Honest refusal shown while live goal prose has no durable backend contract. */
  readonly createDisabledReason?: string | undefined;
}

export function GoalsHome({
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
  // Advanced ONLY by a committed create. The form reads it to clear its fields,
  // so no refusal path can discard what the operator typed.
  const [resetToken, setResetToken] = useState(0);

  const visible = useMemo(
    () => data.goals
      .filter((goal) => matchesFilter(goal, filter) && matchesSearch(goal, search))
      .slice()
      .sort((left, right) => glanceRank(left) - glanceRank(right)
        || left.title.localeCompare(right.title)),
    [data.goals, filter, search],
  );

  /**
   * The goal a board can actually be opened for, or `null`. `planningRunRef` is
   * OPTIONAL on the model and the type admits `""`, a value no board can be opened
   * for - so absence is "not a non-blank string", never merely `!== undefined`.
   *
   * This mirrors the rule GoalCard applies at goal-card.tsx:46. The duplication is
   * deliberate and recorded: taskRail 3 puts goal-card.tsx off-limits to this row, so
   * its module-private predicate cannot be exported here. It is not a second DECISION
   * either - for a card, GoalCard still decides and this is a fail-closed backstop;
   * for the TRIAGE strip, which does not render through GoalCard, this file is the
   * only decider and needs the rule in its own right.
   */
  const openableGoal = (goalId: string | undefined): GoalCardModel | null => {
    if (goalId === undefined) return null;
    const goal = data.goals.find((candidate) => candidate.goalId === goalId);
    if (goal === undefined) return null;
    const planningRunRef = goal.planningRunRef;
    return typeof planningRunRef === "string" && planningRunRef.trim().length > 0 ? goal : null;
  };

  /**
   * The one place a board-open is composed, so the run and the title always come from
   * the SAME card rather than from two lookups that can disagree. A goal with no
   * durable run is not opened at all - nothing empty, placeholder or synthesised is
   * ever substituted to make the arity line up.
   */
  const openBoard = (goalId: string | undefined): void => {
    const goal = openableGoal(goalId);
    if (goal?.planningRunRef === undefined) return;
    onOpenBoard(goal.goalId, goal.planningRunRef, goal.title);
  };

  const onTriage = (strip: TriageStrip): void => {
    openBoard(strip.openGoalId);
  };

  const toggleExpand = (goalId: string): void => {
    setExpanded((prior) => {
      const next = new Set(prior);
      if (next.has(goalId)) next.delete(goalId); else next.add(goalId);
      return next;
    });
  };

  /**
   * The form closes on exactly one condition: the create committed. Every other
   * outcome - a contract refusal, an undelivered round trip, an authorization or
   * durable-store refusal, or a thrown error - leaves the draft on screen with
   * the reason beside it, so the operator can correct and resend rather than
   * retype from memory.
   */
  const create = (draft: GoalDraft): void => {
    setBusy(true);
    onCreateGoal(draft)
      .then((answer) => {
        const result: GoalCreateResult = typeof answer === "string"
          ? { ok: false, report: answer }
          : answer;
        setCreateReport(result.report);
        if (!result.ok) return;
        setResetToken((token) => token + 1);
        setCreating(false);
      })
      .catch((error: unknown) => { setCreateReport(`UNDELIVERED: ${String(error)}`); })
      .finally(() => { setBusy(false); });
  };

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
          type="search"
          value={search}
        />
        <span className="cr2-goals-count" data-testid="cr.goals.count">{data.goalCountLabel}</span>
        <div className="cr2-goals-new">
          <ActionButton
            ariaPressed={creating && createDisabledReason === undefined}
            disabled={createDisabledReason !== undefined}
            onClick={createDisabledReason === undefined
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
        <p aria-live="polite" className="cr2-goals-createreport" data-testid="cr.goals.newgoal.report" role="status">
          {createReport}
        </p>
      )}

      {creating && createDisabledReason === undefined ? (
        <NewGoalForm
          busy={busy}
          onCancel={() => setCreating(false)}
          onCreate={create}
          resetToken={resetToken}
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
              onOpenBoard={() => openBoard(goal.goalId)}
              onToggleExpand={() => toggleExpand(goal.goalId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
