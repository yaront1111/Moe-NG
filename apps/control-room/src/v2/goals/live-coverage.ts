import { useEffect, useRef, useState } from "react";

import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";

/**
 * THE COVERAGE READ ON A GOAL, POLLED, AS STATE THAT ONLY MOVES WHEN ITS SURFACE WOULD.
 *
 * Every poll decodes a FRESH frame object. Before this hook LiveContractDossier (every 10 s)
 * and PrdCoverage (every 5 s) each set that object as state on every tick, so React
 * reconciled their whole contract trees for an answer that had not changed - with the
 * measured 128 + 150 statement contract, a periodic repeat of the first-paint cost. A poll
 * that renders the same surface keeps the state it has; React then skips the subtree
 * instead of walking it.
 */

/** What one surface renders of the answer, and how it names a read that threw. */
export interface CoverageSurface {
  /** The ERROR outcome a throwing read becomes: visible under the surface's own layer. */
  readonly readFailed: Readonly<{ code: string; layer: string }>;
  /** Two answers this surface renders alike; a poll answering the second keeps the first. */
  readonly same: (previous: DocumentCoverageOutcome, next: DocumentCoverageOutcome) => boolean;
}

/** Only `contracts` render in the dossier and feed the gate reads; two answers that agree on them are one. */
export function sameDossier(previous: DocumentCoverageOutcome, next: DocumentCoverageOutcome): boolean {
  const shown = (outcome: DocumentCoverageOutcome): string =>
    JSON.stringify(outcome.status === "COVERAGE" ? outcome.contracts : outcome);
  return shown(previous) === shown(next);
}

/** PrdCoverage renders the totals, the document line, every contract and the section map: only a whole answer is the same. */
export function sameAnswer(previous: DocumentCoverageOutcome, next: DocumentCoverageOutcome): boolean {
  return JSON.stringify(previous) === JSON.stringify(next);
}

/**
 * Null until the first answer; then the latest answer the surface would render differently
 * from the one before. A read that throws becomes a visible ERROR outcome, never a silent
 * empty dossier. `surface` is an effect dependency: pass a module-level constant, as both
 * callers do, or every render restarts the poll.
 */
export function useLiveCoverage(
  goalId: string,
  readCoverage: (goalId: string) => Promise<DocumentCoverageOutcome>,
  pollMs: number,
  surface: CoverageSurface,
): DocumentCoverageOutcome | null {
  const [coverage, setCoverage] = useState<DocumentCoverageOutcome | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setCoverage(null);
    let inFlight = false;
    const settle = (outcome: DocumentCoverageOutcome): void => {
      inFlight = false;
      if (generation.current !== run) return;
      setCoverage((previous) => (
        previous !== null && surface.same(previous, outcome) ? previous : outcome
      ));
    };
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void readCoverage(goalId).then(settle, () => {
        settle({ ...surface.readFailed, status: "ERROR" });
      });
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [goalId, pollMs, readCoverage, surface]);
  return coverage;
}
