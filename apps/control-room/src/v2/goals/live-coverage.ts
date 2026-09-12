import { useEffect, useRef, useState } from "react";

import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";

/**
 * THE COVERAGE READ ON A GOAL, POLLED, AS STATE THAT ONLY MOVES WHEN THE DOSSIER WOULD.
 *
 * Every poll decodes a FRESH frame object. Before this hook LiveContractDossier set that
 * object as state on every tick, so React reconciled the whole contract tree every
 * DEFAULT_POLL_MS (10 s) for an answer that had not changed - with the measured 128 + 150
 * statement contract, a periodic repeat of the first-paint cost. A poll that renders the
 * same dossier keeps the state it has; React then skips the subtree instead of walking it.
 */

/** Only `contracts` render and feed the gate reads; two answers that agree on them are one. */
export function sameDossier(previous: DocumentCoverageOutcome, next: DocumentCoverageOutcome): boolean {
  const shown = (outcome: DocumentCoverageOutcome): string =>
    JSON.stringify(outcome.status === "COVERAGE" ? outcome.contracts : outcome);
  return shown(previous) === shown(next);
}

/**
 * Null until the first answer; then the latest answer whose dossier differs from the one
 * before. A read that throws becomes a visible ERROR outcome, never a silent empty dossier.
 */
export function useLiveCoverage(
  goalId: string,
  readCoverage: (goalId: string) => Promise<DocumentCoverageOutcome>,
  pollMs: number,
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
        previous !== null && sameDossier(previous, outcome) ? previous : outcome
      ));
    };
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void readCoverage(goalId).then(settle, () => {
        settle({
          code: "CONTRACT_DOSSIER_COVERAGE_READ_FAILED",
          layer: "CONTROL_ROOM_GOALS",
          status: "ERROR",
        });
      });
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [goalId, pollMs, readCoverage]);
  return coverage;
}
