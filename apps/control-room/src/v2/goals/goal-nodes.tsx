import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { readRuns } from "../../live/live-runs.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { MIDDOT } from "../glyphs.js";
import { GoalSection } from "../runs/runs-screen.js";

/**
 * THE WORK of an opened goal: its sealed nodes as the runs read states them - objective,
 * who holds it, the review rounds and findings, the verifier's receipt, the acceptance.
 * This is the same ladder Runs & leases shows for every goal, scoped to one, so a person
 * reading the goal sees the agents' work where they are, not on another screen.
 */

const POLL_MS = 5_000;
const FAILURE: RunsOutcome = Object.freeze({ code: "RUNS_READ_FAILED", layer: "CONTROL_ROOM_GOALS", status: "ERROR" as const });

export interface LiveGoalNodesProps {
  readonly goalId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly pollMs?: number | undefined;
  /** Injectable for tests; the default reads POST /runs/read with `{ goalRef }`. */
  readonly read?: ((goalId: string) => Promise<RunsOutcome>) | undefined;
}

export function GoalNodesPanel({ goalId, nowMs, outcome }: {
  readonly goalId: string; readonly nowMs: number; readonly outcome: RunsOutcome | null;
}): JSX.Element {
  const goal = outcome !== null && outcome.status === "RUNS" ? outcome.goals.find((row) => row.goalId === goalId) : undefined;
  return (
    <section className="cr2-ops-panel" data-testid="cr.goalnodes.root">
      <h3 className="cr2-approve-heading">{`THE WORK ${MIDDOT} WHAT THE AGENTS DELIVER`}</h3>
      {outcome === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.goalnodes.loading">Reading the nodes...</p>
      ) : outcome.status !== "RUNS" ? (
        <p className="cr2-approve-refusal" data-testid="cr.goalnodes.refusal" role="status">
          {`${outcome.status} ${MIDDOT} ${outcome.code} ${MIDDOT} ${outcome.layer}`}
        </p>
      ) : goal === undefined ? (
        <p className="cr2-needs-note" data-testid="cr.goalnodes.empty">
          No run is recorded for this goal yet. Nodes appear once a plan is approved and activated.
        </p>
      ) : (
        <GoalSection embedded goal={goal} nowMs={nowMs} onOpenBoard={(): void => undefined} />
      )}
    </section>
  );
}

export function LiveGoalNodes({ goalId, headers, pollMs, read }: LiveGoalNodesProps): JSX.Element {
  const [outcome, setOutcome] = useState<RunsOutcome | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reader] = useState(() => read ?? ((ref: string): Promise<RunsOutcome> => readRuns(headers, undefined, ref)));
  const generation = useRef(0);
  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setOutcome(null);
    let inFlight = false;
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void reader(goalId).then((next) => {
        inFlight = false;
        if (generation.current !== run) return;
        setOutcome(next);
        setNowMs(Date.now());
      }, () => {
        inFlight = false;
        if (generation.current === run) setOutcome(FAILURE);
      });
    };
    tick();
    const timer = setInterval(tick, pollMs ?? POLL_MS);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [goalId, pollMs, reader]);
  return <GoalNodesPanel goalId={goalId} nowMs={nowMs} outcome={outcome} />;
}
