import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { readActivity } from "../../live/live-activity.js";
import type { ActivityOutcome } from "../../live/live-activity.js";
import { readHealth, readPolicy } from "../../live/live-ops.js";
import type { HealthOutcome, PolicyOutcome } from "../../live/live-ops.js";
import type { LiveSetup } from "../../live/live-config.js";
import { readRepositoryRemote } from "../../live/live-repository-remote.js";
import type { RepositoryRemoteOutcome } from "../../live/live-repository-remote.js";
import { readSessions } from "../../live/live-sessions.js";
import type { SessionsOutcome } from "../../live/live-sessions.js";
import { useProviderPause } from "../shell/pause-context.js";
import { ActivityPanel, SessionsPanel } from "./activity-screens.js";
import { HealthScreen, PolicyScreen } from "./ops-screens.js";
import type { PolicyInstallState } from "./ops-screens.js";
import { createPolicyInstallPort, installStandardPolicy, readSurfaceOnce } from "./policy-install-port.js";
import type { PolicyInstallPort } from "./policy-install-port.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { LiveRepositoryRecovery } from "./live-repository-recovery.js";

/**
 * The LIVE policy and health screens: one read on mount and every few seconds after, each
 * rendered through its pure screen. `read` is injectable so a test drives the screen
 * without a fetch stub; the default carries the attached session's headers.
 */

const POLL_MS = 5_000;

type Connection = "CONNECTED" | "DISCONNECTED";

export function useOpsRead<T extends { readonly status: string; readonly code?: string }>(
  read: () => Promise<T>, failure: T, pollMs: number, onConnection: ((connection: Connection) => void) | undefined,
): { readonly nowMs: number; readonly outcome: T | null; readonly refresh: () => void } {
  const [outcome, setOutcome] = useState<T | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const generation = useRef(0);
  const tickRef = useRef<() => void>(() => undefined);
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
    tickRef.current = tick;
    tick();
    const timer = setInterval(tick, pollMs);
    return (): void => { generation.current += 1; tickRef.current = () => undefined; clearInterval(timer); };
  }, [failure, onConnection, pollMs, read]);
  const refresh = useCallback((): void => { tickRef.current(); }, []);
  return { nowMs, outcome, refresh };
}

const POLICY_FAILURE: PolicyOutcome = Object.freeze({ code: "POLICY_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });
export const HEALTH_FAILURE: HealthOutcome = Object.freeze({ code: "HEALTH_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });
const ACTIVITY_FAILURE: ActivityOutcome = Object.freeze({ code: "ACTIVITY_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });
const SESSIONS_FAILURE: SessionsOutcome = Object.freeze({ code: "SESSIONS_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });
export const REPOSITORY_REMOTE_FAILURE: RepositoryRemoteOutcome = Object.freeze({ code: "REPOSITORY_REMOTE_READ_FAILED", layer: "CONTROL_ROOM_OPS", status: "ERROR" as const });

/**
 * THE PROJECT'S BOUND REMOTE, on the same poller as every other ops read. It joins the poll
 * rather than fetching once on mount, because a remote bound from a goal Publish card has to
 * appear on Health without a reload; a one-shot read here would look like a stale daemon.
 */
export function useRepositoryRemote(
  headers: Readonly<Record<string, string>>, pollMs?: number | undefined,
  read?: (() => Promise<RepositoryRemoteOutcome>) | undefined,
): RepositoryRemoteOutcome | null {
  const [reader] = useState(() => read ?? ((): Promise<RepositoryRemoteOutcome> => readRepositoryRemote(headers)));
  return useOpsRead(reader, REPOSITORY_REMOTE_FAILURE, pollMs ?? POLL_MS, undefined).outcome;
}

export interface LiveOpsProps<T> {
  readonly headers: Readonly<Record<string, string>>;
  readonly onConnection?: ((connection: Connection) => void) | undefined;
  readonly pollMs?: number | undefined;
  readonly read?: (() => Promise<T>) | undefined;
}

export interface LivePolicyProps extends LiveOpsProps<PolicyOutcome> {
  /** Injectable for tests; the default spends the attached session's own wire. */
  readonly installPort?: PolicyInstallPort | undefined;
  /** Injectable for tests; the default reads POST /affordances/read with the session's headers. */
  readonly readSurface?: (() => Promise<SurfaceFrame>) | undefined;
  /** The attached session; absent (fixtures, tests) means the screen can read but not install. */
  readonly setup?: LiveSetup | undefined;
}

export function LivePolicy({ headers, installPort, onConnection, pollMs, read, readSurface, setup }: LivePolicyProps): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<PolicyOutcome> => readPolicy(headers)));
  const { nowMs, outcome, refresh } = useOpsRead(reader, POLICY_FAILURE, pollMs ?? POLL_MS, onConnection);
  const [port] = useState<PolicyInstallPort | null>(() => installPort ?? (setup === undefined ? null : createPolicyInstallPort(setup)));
  const [surfaceReader] = useState(() => readSurface ?? ((): Promise<SurfaceFrame> => readSurfaceOnce(headers)));
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<PolicyInstallState["steps"]>([]);
  const onInstall = useCallback((): void => {
    if (port === null || outcome === null || outcome.status !== "POLICY" || busy) return;
    const missing = outcome.standard.filter((row) => !row.installed);
    setBusy(true);
    setSteps([]);
    void installStandardPolicy(port, surfaceReader, missing).then((done) => {
      setSteps(done);
      setBusy(false);
      refresh();
    }, () => { setBusy(false); });
  }, [busy, outcome, port, refresh, surfaceReader]);
  const install: PolicyInstallState = { busy, onInstall: port === null ? null : onInstall, steps };
  return <PolicyScreen install={install} nowMs={nowMs} outcome={outcome} />;
}

export interface LiveHealthProps extends LiveOpsProps<HealthOutcome> {
  readonly setup?: LiveSetup | undefined;
  /** Injectable for tests; the default reads POST /repository/remote/read with the same headers. */
  readonly readRemote?: (() => Promise<RepositoryRemoteOutcome>) | undefined;
}

export function LiveHealth({ headers, onConnection, pollMs, read, readRemote, setup }: LiveHealthProps): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<HealthOutcome> => readHealth(headers)));
  const { nowMs, outcome } = useOpsRead(reader, HEALTH_FAILURE, pollMs ?? POLL_MS, onConnection);
  const remote = useRepositoryRemote(headers, pollMs, readRemote);
  return (
    <>
      <HealthScreen nowMs={nowMs} outcome={outcome} remote={remote} />
      {setup !== undefined && <LiveRepositoryRecovery setup={setup} />}
      <LiveSessions headers={headers} pollMs={pollMs} />
      <LiveActivity goalRef={null} headers={headers} pollMs={pollMs} scopeLabel="THIS PROJECT" />
    </>
  );
}

export function LiveSessions({ headers, pollMs, read }: LiveOpsProps<SessionsOutcome>): JSX.Element {
  const [reader] = useState(() => read ?? ((): Promise<SessionsOutcome> => readSessions(headers)));
  const { nowMs, outcome } = useOpsRead(reader, SESSIONS_FAILURE, pollMs ?? POLL_MS, undefined);
  // The pause comes from the shell's one health poll, never a second one of this screen's own.
  const paused = useProviderPause();
  return <SessionsPanel nowMs={nowMs} outcome={outcome} paused={paused} />;
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
