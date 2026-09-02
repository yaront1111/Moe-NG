import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { readRuns } from "../../live/live-runs.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { RunsScreen } from "./runs-screen.js";

/**
 * The LIVE runs screen: one read of POST /runs/read on mount and every few seconds after,
 * rendered through the pure screen. `read` is injectable so a test drives it without a
 * fetch stub; the default carries the attached session's headers.
 */

const POLL_MS = 5_000;

export interface LiveRunsProps {
  readonly headers: Readonly<Record<string, string>>;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
  readonly pollMs?: number | undefined;
  readonly read?: (() => Promise<RunsOutcome>) | undefined;
}

export function LiveRuns({ headers, onOpenBoard, pollMs, read }: LiveRunsProps): JSX.Element {
  const [outcome, setOutcome] = useState<RunsOutcome | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const generation = useRef(0);

  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    const reader = read ?? ((): Promise<RunsOutcome> => readRuns(headers));
    let inFlight = false;
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void reader().then((next) => {
        inFlight = false;
        if (generation.current !== run) return;
        setOutcome(next);
        setNowMs(Date.now());
      }, () => {
        inFlight = false;
        if (generation.current === run) {
          setOutcome({ code: "RUNS_READ_FAILED", layer: "CONTROL_ROOM_RUNS", status: "ERROR" });
        }
      });
    };
    tick();
    const timer = setInterval(tick, pollMs ?? POLL_MS);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [headers, pollMs, read]);

  return <RunsScreen nowMs={nowMs} onOpenBoard={onOpenBoard} outcome={outcome} />;
}
