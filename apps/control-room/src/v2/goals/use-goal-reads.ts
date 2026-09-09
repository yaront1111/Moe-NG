import { useEffect, useState } from "react";

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
 * ABSENT READER = NO READS AT ALL (fixtures, unattached, tests). The goal list is joined into
 * one string on purpose: it is the effect's dependency, and an array identity would re-arm the
 * interval on every render.
 */
export const GOAL_READ_POLL_MS = 10_000;

export function useGoalReads<T>(
  catalog: GoalCatalogFrame | null,
  read: ((goalId: string) => Promise<T>) | undefined,
  intervalMs: number = GOAL_READ_POLL_MS,
): ReadonlyMap<string, T> {
  const [answers, setAnswers] = useState<ReadonlyMap<string, T>>(new Map());
  const goalIds = catalog !== null && catalog.outcome === "GOALS"
    ? catalog.goals.map((goal) => goal.goalId).join("\n") : "";
  useEffect(() => {
    if (read === undefined || goalIds === "") return undefined;
    let live = true;
    const ids = goalIds.split("\n");
    const tick = (): void => {
      void Promise.all(ids.map(async (goalId) => {
        try { return [goalId, await read(goalId)] as const; } catch { return null; }
      })).then((rows) => {
        if (!live) return;
        setAnswers(new Map(rows.flatMap((row) => (row === null ? [] : [row]))));
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return (): void => { live = false; clearInterval(timer); };
  }, [goalIds, intervalMs, read]);
  return answers;
}
