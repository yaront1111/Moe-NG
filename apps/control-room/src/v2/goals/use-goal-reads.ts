import { useEffect, useMemo, useState } from "react";

import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";

/**
 * ONE READ PER CATALOG GOAL, all in flight together, re-read on a slow cadence. This is the
 * shape `useGoalCoverage` has always had; it is stated once here so a second per-goal read
 * (the preview receipt) does not become a second copy of the same polling loop, drifting in
 * its cadence, its cleanup or its failure rule.
 *
 * A FAILED READ LEAVES THAT GOAL ABSENT FROM THE MAP rather than storing a value for it. The
 * caller renders "not answered yet" for an absent goal and never a guessed one; folding a
 * failure into a value here would make every consumer unable to tell the two apart.
 *
 * ABSENT READER = NO READS AT ALL (fixtures, unattached, tests). The goal list is serialized
 * so equivalent catalog objects do not restart polling. Reader identity binds the answers to
 * the attached session; a changed scope hides previous answers before its next read finishes.
 */
export const GOAL_READ_POLL_MS = 10_000;
const EMPTY_ANSWERS: ReadonlyMap<string, never> = new Map<string, never>();

export function useGoalReads<T>(
  catalog: GoalCatalogFrame | null,
  read: ((goalId: string) => Promise<T>) | undefined,
  intervalMs: number = GOAL_READ_POLL_MS,
): ReadonlyMap<string, T> {
  const goalIds = JSON.stringify(catalog !== null && catalog.outcome === "GOALS"
    ? catalog.goals.map((goal) => goal.goalId) : []);
  // A token, not just matching fields: A -> B -> A must not revive A's earlier observation.
  const scope = useMemo(() => ({ goalIds, read }), [goalIds, read]);
  const [snapshot, setSnapshot] = useState<{
    readonly answers: ReadonlyMap<string, T>;
    readonly scope: typeof scope;
  } | null>(null);
  useEffect(() => {
    const reader = scope.read;
    const ids = JSON.parse(scope.goalIds) as readonly string[];
    if (reader === undefined || ids.length === 0) return undefined;
    let live = true;
    let inFlight = false;
    const tick = (): void => {
      if (!live || inFlight) return;
      inFlight = true;
      void Promise.all(ids.map(async (goalId) => {
        try { return [goalId, await reader(goalId)] as const; } catch { return null; }
      })).then((rows) => {
        inFlight = false;
        if (!live) return;
        setSnapshot({ scope, answers: new Map(rows.flatMap((row) => (row === null ? [] : [row]))) });
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return (): void => { live = false; clearInterval(timer); };
  }, [intervalMs, scope]);
  return snapshot?.scope === scope ? snapshot.answers : EMPTY_ANSWERS;
}
