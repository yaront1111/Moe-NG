import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import "./cordum-fonts.js";
import type { SurfaceFrame } from "../live/live-board-feed.js";
import { readPlanningRun } from "../live/live-planning-run.js";
import { resolveLiveSetupFromHandshake } from "../live/live-handshake.js";
import type {
  LiveHandshakeResult, LiveOperatorChannelUnavailable, LivePairingPending,
} from "../live/live-handshake.js";
import type { LiveSetupResult } from "../live/live-config.js";
import { MIDDOT } from "./glyphs.js";
import { ApprovePlan } from "./goals/approve-plan.js";
import { BoardStub } from "./goals/board-stub.js";
import type { GoalDraft, GoalsData } from "./goals/goal-model.js";
import { FIXTURE_GOALS_DATA } from "./goals/goals-fixtures.js";
import { GoalsHome } from "./goals/goals-home.js";
import { LiveGoalsHome } from "./goals/live-goals.js";
import { LiveWorkBoard } from "./goals/live-work-board.js";
import { PairingConfirmation } from "./live/pairing-confirmation.js";
import { ProjectBoundary } from "./projects/project-boundary.js";
import { CordumShell } from "./shell/cordum-shell.js";
import type { NavBadge } from "./shell/nav-rail.js";
import type { ConnectionState, NavId } from "./shell/shell-model.js";

/**
 * The v2 entry, reached at `?v2=1`. It mounts the Cordum shell over the goals home
 * (UI-3): the live path derives the one real goal from the daemon's affordance
 * surface, and fixtures mode (`?v2=1&fixtures=1`) renders the frozen three-goal
 * design view plus the SIMULATE relay control and the designed attention badges.
 *
 * "Open board" routes to a per-goal board stub (the real board is UI-5), with the
 * shell's breadcrumb wired back to the goals list.
 */

const FIXTURE_BADGES: Partial<Record<NavId, NavBadge>> = Object.freeze({
  approvals: { count: "2", tone: "info" },
  health: { count: "1", tone: "danger" },
});

/**
 * The dev subject the daemon composes a live plan-review run under. It MUST match
 * DEFAULT_RUN_SUBJECT in affordance-read.ts (live-dispatch.ts spells it RUN_ID);
 * this is the one run POST /planning/run/read can answer for in the dev lane.
 */
const LIVE_RUN_SUBJECT = "run-live-1" as const;

/**
 * The create action in fixtures mode: no daemon is attached, so it authors
 * nothing and says so plainly rather than pretending to have created a goal.
 */
function fixturesCreateGoal(_draft: GoalDraft): Promise<string> {
  return Promise.resolve(
    `goal.create is not dispatched in fixtures mode ${MIDDOT} attach the daemon to author a goal.`,
  );
}

/** The create action while the handshake is still in flight: nothing is attached yet. */
function connectingCreateGoal(_draft: GoalDraft): Promise<string> {
  return Promise.resolve(`Connecting to the daemon ${MIDDOT} try again once the board attaches.`);
}

/** The honest empty home shown while the runtime handshake is still resolving. */
const HANDSHAKE_PENDING_DATA: GoalsData = Object.freeze({
  source: "live",
  goals: Object.freeze([]),
  triage: Object.freeze([]),
  goalCountLabel: "CONNECTING",
  comingOnlineNote: "Pairing with the daemon over the runtime handshake. Nothing is shown until it answers.",
});

type LiveResolution =
  | { readonly status: "OPERATOR_CHANNEL_UNAVAILABLE" }
  | { readonly status: "PENDING" }
  | { readonly busy: boolean; readonly pairing: LivePairingPending; readonly status: "PAIRING" }
  | { readonly status: "READY"; readonly setup: LiveSetupResult };

export interface LiveAttempts {
  readonly initial: Promise<LiveHandshakeResult>;
  retry(signal: AbortSignal): Promise<LiveHandshakeResult>;
}
interface NormalizedAttempts {
  readonly initial: Promise<LiveHandshakeResult>;
  readonly retry?: LiveAttempts["retry"] | undefined;
}
interface ActiveAttempt { readonly controller: AbortController }
function isPairingPending(result: LiveHandshakeResult): result is LivePairingPending {
  return "status" in result && result.status === "AWAITING_OPERATOR";
}
function isOperatorChannelUnavailable(
  result: LiveHandshakeResult,
): result is LiveOperatorChannelUnavailable {
  return "status" in result && result.status === "OPERATOR_CHANNEL_UNAVAILABLE";
}
// Exhaustive by construction: both guards run before the READY fallthrough, and
// TypeScript narrows the remainder to LiveSetupResult, so a daemon-stated
// no-terminal answer can never be miscast as an attached or refused session. Every
// settlement - the initial handshake AND a claim - lands here through `publish`.
function resolutionOf(result: LiveHandshakeResult): LiveResolution {
  if (isPairingPending(result)) return { busy: false, pairing: result, status: "PAIRING" };
  if (isOperatorChannelUnavailable(result)) return { status: "OPERATOR_CHANNEL_UNAVAILABLE" };
  return { setup: result, status: "READY" };
}
function unavailable(): LiveSetupResult {
  return { code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "daemon bootstrap unavailable", ok: false };
}

function normalizeAttempts(
  prepared: Promise<LiveHandshakeResult> | LiveAttempts | undefined,
): NormalizedAttempts {
  if (prepared === undefined) {
    return { initial: resolveLiveSetupFromHandshake({
      fetchImpl: () => Promise.reject(new Error("runtime handshake was not prepared")),
    }) };
  }
  return "initial" in prepared ? prepared : { initial: prepared };
}
interface AttemptLifecycle {
  readonly activeRef: { current: ActiveAttempt | null };
  readonly generationRef: { current: number };
  readonly stale: (generation: number) => boolean;
}
function useAttemptLifecycle(
  attempts: NormalizedAttempts | null,
  publish: (result: LiveHandshakeResult) => void,
  setResolution: (resolution: LiveResolution) => void,
): AttemptLifecycle {
  const generationRef = useRef(0);
  const activeRef = useRef<ActiveAttempt | null>(null);
  const mountedRef = useRef(false);
  const stale = useCallback(
    (generation: number): boolean => generation !== generationRef.current || !mountedRef.current,
    [],
  );
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeRef.current?.controller.abort();
      activeRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (attempts === null) { generationRef.current += 1; activeRef.current?.controller.abort(); activeRef.current = null; return; }
    activeRef.current?.controller.abort();
    const controller = new AbortController();
    const generation = ++generationRef.current;
    activeRef.current = { controller };
    setResolution({ status: "PENDING" });
    void attempts.initial.then((result) => {
      if (stale(generation)) return;
      activeRef.current = null;
      publish(result);
    }, () => {
      if (stale(generation)) return;
      activeRef.current = null;
      publish(unavailable());
    });
  }, [attempts, publish, stale]);
  return { activeRef, generationRef, stale };
}
function useLiveHandshake(enabled: boolean, prepared: CordumAppProps["liveSetup"]) {
  const attempts = useMemo(() => enabled ? normalizeAttempts(prepared) : null, [enabled, prepared]);
  const [resolution, setResolution] = useState<LiveResolution>({ status: "PENDING" });
  const publish = useCallback((result: LiveHandshakeResult): void => {
    setResolution(resolutionOf(result));
  }, []);
  const { activeRef, generationRef, stale } = useAttemptLifecycle(
    attempts, publish, setResolution,
  );
  const claim = useCallback((): void => {
    if (resolution.status !== "PAIRING" || resolution.busy || activeRef.current !== null) return;
    const pairing = resolution.pairing;
    const controller = new AbortController();
    const generation = generationRef.current;
    activeRef.current = { controller };
    setResolution({ busy: true, pairing, status: "PAIRING" });
    void pairing.claim().then((result) => {
      if (stale(generation)) return;
      activeRef.current = null;
      publish(result);
    }, () => {
      if (stale(generation)) return;
      activeRef.current = null;
      publish({ code: "LIVE_PAIRING_REFUSED", detail: "session pairing refused", ok: false });
    });
  }, [publish, resolution, stale]);
  const retry = useCallback((): void => {
    if (attempts?.retry === undefined || activeRef.current !== null) return;
    const controller = new AbortController();
    const generation = ++generationRef.current;
    activeRef.current = { controller };
    setResolution({ status: "PENDING" });
    void Promise.resolve().then(() => attempts.retry?.(controller.signal) ?? unavailable())
      .then((result) => {
        if (stale(generation)) return;
        activeRef.current = null;
        publish(result);
      }, () => {
        if (stale(generation)) return;
        activeRef.current = null;
        publish(unavailable());
      });
  }, [attempts, publish, stale]);
  return { busy: activeRef.current !== null, claim, resolution, retry: attempts?.retry ? retry : undefined };
}
function LiveRefusalNotice({ busy, onRetry, setup }: Readonly<{
  busy: boolean;
  onRetry: (() => void) | undefined;
  setup: Extract<LiveSetupResult, { readonly ok: false }>;
}>): JSX.Element {
  return <section aria-label="Live connection refusal"><p>{`${setup.code}: ${setup.detail}`}</p>
    {onRetry && <button disabled={busy} onClick={onRetry} type="button">Retry connection</button>}
  </section>;
}

/**
 * The daemon told us it has no terminal to read a pairing label from, so there is
 * nothing to type and no label worth showing. The only honest move left is a
 * restart instruction; this branch renders it and nothing else, deliberately
 * bypassing PairingConfirmation rather than showing an unusable pairing ritual.
 */
const NO_OPERATOR_CHANNEL_COPY = "Moe was started without a terminal it can listen on."
  + " Stop it and run pnpm start from a terminal window, then reload this page.";
function NoOperatorChannel(): JSX.Element {
  return <div className="cr2-pairing">
    <section aria-label="Pairing unavailable" className="cr2-pairing-card">
      <p className="cr2-pairing-note">{NO_OPERATOR_CHANNEL_COPY}</p>
    </section>
  </div>;
}

export interface CordumAppProps {
  /** The raw location.search; fixtures mode is `?...&fixtures=1`. */
  readonly search?: string;
  /** One replay-safe initial handshake, optionally with a fresh bounded retry factory. */
  readonly liveSetup?: Promise<LiveHandshakeResult> | LiveAttempts | undefined;
}

interface OpenBoard {
  readonly goalId: string;
  /**
   * The goal's DURABLE planning run, carried from the card that opened the board. It is
   * stored here and not yet rendered: widening BoardStub and the plan-review consumer to
   * read it is task-40017f79's work (it consumes this callback for its typed route), and
   * doing it here would pull two more files into this row.
   */
  readonly planningRunRef: string;
  readonly title: string;
}

export function CordumApp({ liveSetup, search = "" }: CordumAppProps): JSX.Element {
  const fixtures = new URLSearchParams(search).get("fixtures") === "1";
  // The live path acquires its credential at RUNTIME through the daemon handshake;
  // in fixtures mode the handshake is disabled and nothing reads its result.
  const handshake = useLiveHandshake(!fixtures, liveSetup);
  const live = handshake.resolution;
  const [open, setOpen] = useState<OpenBoard | null>(null);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const openBoard = useCallback((goalId: string, planningRunRef: string, title: string) => {
    setConnection(null);
    setOpen({ goalId, planningRunRef, title });
  }, []);
  const back = useCallback(() => {
    setConnection(null);
    setOpen(null);
  }, []);
  const reportConnection = useCallback((next: SurfaceFrame["connection"]) => {
    setConnection(next);
  }, []);

  const title = open === null ? "Goals" : open.title;

  // Only an attached operator session carries the authenticated header set the
  // plan-review read requires; unattached (fixtures / pending / refused) the open
  // path keeps the daemon-free BoardStub placeholder.
  const attached = !fixtures && live.status === "READY" && live.setup.ok ? live.setup : null;
  // The bound project is the RUNTIME bootstrap's, not a client-side choice. It is
  // null until the session attaches, and the chrome says PAIRING rather than
  // naming a project this tab is not yet bound to.
  const projectId = attached?.projectId ?? null;
  const eyebrow = open === null
    ? `PROJECT ${MIDDOT} ${projectId ?? "PAIRING"}`
    : `${MIDDOT} ${open.goalId}`;
  useEffect(() => {
    setConnection(null);
  }, [attached]);
  // Name the bound project in the window title so two project tabs are
  // distinguishable at the taskbar. Restored on unmount so a test or a remount
  // cannot leave a stale project name behind.
  useEffect(() => {
    if (projectId === null) return undefined;
    const previous = document.title;
    document.title = `Moe ${MIDDOT} ${projectId}`;
    return (): void => { document.title = previous; };
  }, [projectId]);
  const readRun = useMemo<((runId: string) => ReturnType<typeof readPlanningRun>) | null>(
    () => (attached === null ? null : (runId: string) => readPlanningRun(attached.headers, runId)),
    [attached],
  );

  let body: JSX.Element;
  if (open !== null) {
    body = readRun === null || attached === null
      ? <BoardStub goalId={open.goalId} onBack={back} title={open.title} />
      : (
        // The opened goal shows the plan to APPROVE (UI-6) stacked over the live
        // WORK BOARD (UI-5) so the operator sees the plan and the current work
        // steps in one body. Both are read-only over the same attached session.
        <>
          <ApprovePlan
            goalId={open.goalId}
            onBack={back}
            read={readRun}
            runId={LIVE_RUN_SUBJECT}
            title={open.title}
          />
          <LiveWorkBoard headers={attached.headers} onConnection={reportConnection} />
        </>
      );
  } else if (fixtures) {
    body = <GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={fixturesCreateGoal} onOpenBoard={openBoard} />;
  } else if (live.status === "PENDING") {
    body = (
      <GoalsHome data={HANDSHAKE_PENDING_DATA} onCreateGoal={connectingCreateGoal} onOpenBoard={openBoard} />
    );
  } else if (live.status === "OPERATOR_CHANNEL_UNAVAILABLE") {
    body = <NoOperatorChannel />;
  } else if (live.status === "PAIRING") {
    body = <PairingConfirmation
      busy={live.busy}
      confirmationLabel={live.pairing.confirmationLabel}
      onConfirm={handshake.claim}
    />;
  } else {
    body = (
      <>
        {!live.setup.ok && <LiveRefusalNotice
          busy={handshake.busy} onRetry={handshake.retry} setup={live.setup}
        />}
        <LiveGoalsHome onConnection={reportConnection} onOpenBoard={openBoard} setup={live.setup} />
      </>
    );
  }

  // Every live body names its hard project boundary. Fixtures mode is exempt:
  // nothing is attached there, so there is no boundary to state honestly.
  const content = fixtures ? body : (
    <>
      <ProjectBoundary projectId={projectId} />
      {body}
    </>
  );

  const shellConnection: ConnectionState | null | undefined = fixtures
    ? undefined
    : live.status !== "READY"
      ? null
      : live.setup.ok ? connection : "DISCONNECTED";

  return (
    <CordumShell
      activeNav="goals"
      backLabel="GOALS"
      connection={shellConnection}
      eyebrow={eyebrow}
      initialConnection={fixtures ? "CONNECTED" : null}
      navBadges={fixtures ? FIXTURE_BADGES : undefined}
      onBack={open === null ? undefined : back}
      simulatable={fixtures}
      title={title}
    >
      {content}
    </CordumShell>
  );
}
