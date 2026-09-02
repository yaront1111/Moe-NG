import { useEffect, useState } from "react";

import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";

/**
 * One coverage read per catalog goal, all in flight together, re-read on a slow cadence.
 * Shared by the goals list and the Needs-you queue so both draw the same daemon answer.
 * A failed read leaves that goal absent from the map: the caller renders "coming online",
 * never a guessed value. Absent reader = no reads at all (fixtures, unattached, tests).
 */
export const COVERAGE_POLL_MS = 10_000;

export type CoverageReader = (goalId: string) => Promise<DocumentCoverageOutcome>;

export function useGoalCoverage(
  catalog: GoalCatalogFrame | null,
  readCoverage: CoverageReader | undefined,
): ReadonlyMap<string, DocumentCoverageOutcome> {
  const [coverage, setCoverage] = useState<ReadonlyMap<string, DocumentCoverageOutcome>>(new Map());
  const goalIds = catalog !== null && catalog.outcome === "GOALS"
    ? catalog.goals.map((goal) => goal.goalId).join("\n") : "";
  useEffect(() => {
    if (readCoverage === undefined || goalIds === "") return undefined;
    let live = true;
    const ids = goalIds.split("\n");
    const tick = (): void => {
      void Promise.all(ids.map(async (goalId) => {
        try { return [goalId, await readCoverage(goalId)] as const; } catch { return null; }
      })).then((rows) => {
        if (!live) return;
        setCoverage(new Map(rows.flatMap((row) => (row === null ? [] : [row]))));
      });
    };
    tick();
    const timer = setInterval(tick, COVERAGE_POLL_MS);
    return (): void => { live = false; clearInterval(timer); };
  }, [goalIds, readCoverage]);
  return coverage;
}
