import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { GOAL_READ_POLL_MS, useGoalReads } from "./use-goal-reads.js";

/**
 * One coverage read per catalog goal, all in flight together, re-read on a slow cadence.
 * Shared by the goals list and the Needs-you queue so both draw the same daemon answer.
 * A failed read leaves that goal absent from the map: the caller renders "coming online",
 * never a guessed value. Absent reader = no reads at all (fixtures, unattached, tests).
 *
 * The loop itself lives in `use-goal-reads.ts` so the preview receipt read shares it rather
 * than copying it; this module keeps the coverage-shaped names its callers already import.
 */
export const COVERAGE_POLL_MS = GOAL_READ_POLL_MS;

export type CoverageReader = (goalId: string) => Promise<DocumentCoverageOutcome>;

export function useGoalCoverage(
  catalog: GoalCatalogFrame | null,
  readCoverage: CoverageReader | undefined,
): ReadonlyMap<string, DocumentCoverageOutcome> {
  return useGoalReads(catalog, readCoverage, COVERAGE_POLL_MS);
}
