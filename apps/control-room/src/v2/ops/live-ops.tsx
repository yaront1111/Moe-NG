import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { readActivity } from "../../live/live-activity.js";
import type { ActivityOutcome } from "../../live/live-activity.js";
import { readHealth, readPolicy } from "../../live/live-ops.js";
import type { HealthOutcome, PolicyOutcome } from "../../live/live-ops.js";
import { readSessions } from "../../live/live-sessions.js";
import type { SessionsOutcome } from "../../live/live-sessions.js";
import { ActivityPanel, SessionsPanel } from "./activity-screens.js";
import { HealthScreen, PolicyScreen } from "./ops-screens.js";

/**
 * The LIVE policy and health screens: one read on mount and every few seconds after, each
 * rendered through its pure screen. `read` is injectable so a test drives the screen
 * without a fetch stub; the default carries the attached session's headers.
 */

const POLL_MS = 5_000;

type Connection = "CONNECTED" | "DISCONNECTED";

function useOpsRead<T extends { readonly status: string; readonly code?: string }>(
  read: () => Promise<T>, failure: T, pollMs: number, onConnection: ((connection: Connection) => void) | undefined,
): { readonly nowMs: number; readonly outcome: T | null } {
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
        onConnection?.(next.status === "ERROR" && next.code === "TRANSPORT_REQUEST_FAILED" ? "DISCONNECTED" : "CONNECTED");
      }, () => {
        inFlight = false;
        if (generation.current === run) setOutcome(failure);
      });
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [failure, onConnection, pollMs, read]);
  return { nowMs, outcome };
}

const POLICY_FAILURE: PolicyOutcome = Object.freeze({ code: "POLICY_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });
const HEALTH_FAILURE: HealthOutcome = Object.freeze({ code: "HEALTH_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });
const ACTIVITY_FAILURE: ActivityOutcome = Object.freeze({ code: "ACTIVITY_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });
const SESSIONS_FAILURE: SessionsOutcome = Object.freeze({ code: "SESSIONS_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });

export interface LiveOpsProps<T> {
  readonly headers: Readonly<Record<string, string>>;
  readonly onConnection?: ((connection: Connection) => void) | undefined;
  readonly pollMs?: number | undefined;
  readonly read?: (() => Promise<T>) | undefined;
}

export function LivePolicy({ headers, onConnection, pollMs, read }: LiveOpsProps<PolicyOutcome>): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<PolicyOutcome> => readPolicy(headers)));
  const { nowMs, outcome } = useOpsRead(reader, POLICY_FAILURE, pollMs ?? POLL_MS, onConnection);
  return <PolicyScreen nowMs={nowMs} outcome={outcome} />;
}

export function LiveHealth({ headers, onConnection, pollMs, read }: LiveOpsProps<HealthOutcome>): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<HealthOutcome> => readHealth(headers)));
  const { nowMs, outcome } = useOpsRead(reader, HEALTH_FAILURE, pollMs ?? POLL_MS, onConnection);
  return (
    <>
      <HealthScreen nowMs={nowMs} outcome={outcome} />
      <LiveSessions headers={headers} pollMs={pollMs} />
      <LiveActivity goalRef={null} headers={headers} pollMs={pollMs} scopeLabel="THIS PROJECT" />
    </>
  );
}

export function LiveSessions({ headers, pollMs, read }: LiveOpsProps<SessionsOutcome>): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<SessionsOutcome> => readSessions(headers)));
  const { nowMs, outcome } = useOpsRead(reader, SESSIONS_FAILURE, pollMs ?? POLL_MS, undefined);
  return <SessionsPanel nowMs={nowMs} outcome={outcome} />;
}

export interface LiveActivityProps extends LiveOpsProps<ActivityOutcome> {
  /** The goal whose activity to list, or null for the whole project. */
  readonly goalRef: string | null;
  readonly scopeLabel: string;
}

export function LiveActivity({ goalRef, headers, pollMs, read, scopeLabel }: LiveActivityProps): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<ActivityOutcome> => readActivity(headers, goalRef)));
  const { nowMs, outcome } = useOpsRead(reader, ACTIVITY_FAILURE, pollMs ?? POLL_MS, undefined);
  return <ActivityPanel nowMs={nowMs} outcome={outcome} scopeLabel={scopeLabel} />;
}
