import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { readHealth, readPolicy } from "../../live/live-ops.js";
import type { HealthOutcome, PolicyOutcome } from "../../live/live-ops.js";
import { HealthScreen, PolicyScreen } from "./ops-screens.js";

/**
 * The LIVE policy and health screens: one read on mount and every few seconds after, each
 * rendered through its pure screen. `read` is injectable so a test drives the screen
 * without a fetch stub; the default carries the attached session's headers.
 */

const POLL_MS = 5_000;

function useOpsRead<T>(read: () => Promise<T>, failure: T, pollMs: number): { readonly nowMs: number; readonly outcome: T | null } {
  const [outcome, setOutcome] = useState<T | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const generation = useRef(0);
  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    let inFlight = false;
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void read().then((next) => {
        inFlight = false;
        if (generation.current !== run) return;
        setOutcome(next);
        setNowMs(Date.now());
      }, () => {
        inFlight = false;
        if (generation.current === run) setOutcome(failure);
      });
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [failure, pollMs, read]);
  return { nowMs, outcome };
}

const POLICY_FAILURE: PolicyOutcome = Object.freeze({ code: "POLICY_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });
const HEALTH_FAILURE: HealthOutcome = Object.freeze({ code: "HEALTH_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });

export interface LiveOpsProps<T> {
  readonly headers: Readonly<Record<string, string>>;
  readonly pollMs?: number | undefined;
  readonly read?: (() => Promise<T>) | undefined;
}

export function LivePolicy({ headers, pollMs, read }: LiveOpsProps<PolicyOutcome>): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<PolicyOutcome> => readPolicy(headers)));
  const { nowMs, outcome } = useOpsRead(reader, POLICY_FAILURE, pollMs ?? POLL_MS);
  return <PolicyScreen nowMs={nowMs} outcome={outcome} />;
}

export function LiveHealth({ headers, pollMs, read }: LiveOpsProps<HealthOutcome>): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<HealthOutcome> => readHealth(headers)));
  const { nowMs, outcome } = useOpsRead(reader, HEALTH_FAILURE, pollMs ?? POLL_MS);
  return <HealthScreen nowMs={nowMs} outcome={outcome} />;
}
