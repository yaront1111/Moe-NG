import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import "./cordum-fonts.js";
import type { SurfaceFrame } from "../live/live-board-feed.js";
import { readPlanningRun } from "../live/live-planning-run.js";
import {
  LiveRefusalNotice, NoOperatorChannel, useLiveHandshake,
} from "./cordum-handshake.js";
import type { PreparedHandshake } from "./cordum-handshake.js";
import { MIDDOT } from "./glyphs.js";
import { ApprovePlan } from "./goals/approve-plan.js";
import type { PlanApprovalSurface } from "./goals/approve-plan-gate.js";
import { createGate1ApprovalPort, readPendingContract } from "./goals/gate1-approval.js";
import { Gate1Card } from "./goals/gate1-card.js";
import { BoardStub } from "./goals/board-stub.js";
import type { GoalDraft, GoalsData } from "./goals/goal-model.js";
import { FIXTURE_GOALS_DATA } from "./goals/goals-fixtures.js";
import { GoalsHome } from "./goals/goals-home.js";
import { LiveGoalsHome } from "./goals/live-goals.js";
import { LiveWorkBoard } from "./goals/live-work-board.js";
import { authorizeApproval, createPlanApprovalPort } from "./goals/plan-approval.js";
import { PairingConfirmation } from "./live/pairing-confirmation.js";
import { ProjectBoundary } from "./projects/project-boundary.js";
import { CordumShell } from "./shell/cordum-shell.js";
import { boardRoute } from "./shell/shell-routes.js";
import type { BoardRoute, CordumRoute } from "./shell/shell-routes.js";
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


/** Re-exported so `main.tsx` keeps importing it from the entry it composes. */
export type { LiveAttempts } from "./cordum-handshake.js";

export interface CordumAppProps {
  /** The raw location.search; fixtures mode is `?...&fixtures=1`. */
  readonly search?: string;
  /** One replay-safe initial handshake, optionally with a fresh bounded retry factory. */
  readonly liveSetup?: PreparedHandshake;
}

export function CordumApp({ liveSetup, search = "" }: CordumAppProps): JSX.Element {
  const fixtures = new URLSearchParams(search).get("fixtures") === "1";
  // The live path acquires its credential at RUNTIME through the daemon handshake;
  // in fixtures mode the handshake is disabled and nothing reads its result.
  const handshake = useLiveHandshake(!fixtures, liveSetup);
  const live = handshake.resolution;
  // The opened board IS a route from the shell's typed source of truth, so the nav
  // rail and "Open board" cannot disagree about what a board route carries. The
  // DURABLE planning run rides on it: there is no build-time run constant any more,
  // and a second goal opens its own plan.
  const [open, setOpen] = useState<BoardRoute | null>(null);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  // The board's own affordance frame, held here because the approval gate and the
  // board read the SAME daemon answer. A second poll for the same bytes would be a
  // second source of truth for what this session is offered.
  const [boardFrame, setBoardFrame] = useState<SurfaceFrame | null>(null);
  const openBoard = useCallback((goalId: string, planningRunRef: string, title: string) => {
    setConnection(null);
    setBoardFrame(null);
    setOpen(boardRoute(goalId, planningRunRef, title));
  }, []);
  const back = useCallback(() => {
    setConnection(null);
    setBoardFrame(null);
    setOpen(null);
  }, []);
  const reportConnection = useCallback((next: SurfaceFrame["connection"]) => {
    setConnection(next);
  }, []);
  const reportFrame = useCallback((next: SurfaceFrame) => {
    setBoardFrame(next);
  }, []);
  /**
   * The nav rail hands back the ROUTE its source of truth stated, never a nav id
   * this entry would have to re-map. The rail decides WHICH destinations exist and
   * which are reachable; this only says what arriving at one means.
   */
  const navigate = useCallback((route: CordumRoute) => {
    setConnection(null);
    setBoardFrame(null);
    setOpen(route.kind === "board" ? route : null);
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
  /**
   * The GATE 1 surface: pending-contract read + the approval dispatch. Both are
   * daemon-authored — the read answers the minted affordance and subject digest
   * the dispatch presents, so the browser composes no approval identity.
   */
  const gate1Read = useMemo<((goalId: string) => ReturnType<typeof readPendingContract>) | null>(
    () => (attached === null
      ? null : (goalId: string) => readPendingContract(attached.headers, goalId)),
    [attached],
  );
  const gate1Port = useMemo(
    () => (attached === null ? null : createGate1ApprovalPort(attached)),
    [attached],
  );
  /**
   * The approval surface handed to the plan-review screen: the daemon's OWN verdict
   * on whether this run may be approved, plus the wire to spend that grant. Nothing
   * here decides authorization - `authorizeApproval` reads the daemon's offer roster
   * off the frame, and with no offer the screen renders the control disabled with the
   * measured reason rather than lighting it up on the strength of being attached.
   */
  const approval = useMemo<PlanApprovalSurface | undefined>(() => {
    if (attached === null || open === null) return undefined;
    return {
      authorization: authorizeApproval(boardFrame, open.planningRunRef),
      submit: createPlanApprovalPort(attached).submit,
    };
  }, [attached, boardFrame, open]);

  let body: JSX.Element;
  if (open !== null) {
    body = readRun === null || attached === null
      ? <BoardStub goalId={open.goalId} onBack={back} title={open.title} />
      : (
        // The opened goal shows the plan to APPROVE (UI-6) stacked over the live
        // WORK BOARD (UI-5) so the operator sees the plan and the current work
        // steps in one body. Both are read-only over the same attached session.
        <>
          {gate1Read === null || gate1Port === null ? null : (
            <Gate1Card goalId={open.goalId} port={gate1Port} read={gate1Read} />
          )}
          <ApprovePlan
            approval={approval}
            goalId={open.goalId}
            onBack={back}
            read={readRun}
            runId={open.planningRunRef}
            title={open.title}
          />
          <LiveWorkBoard
            goalId={open.goalId}
            headers={attached.headers}
            onConnection={reportConnection}
            onFrame={reportFrame}
            runId={open.planningRunRef}
          />
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
      onNavigate={navigate}
      simulatable={fixtures}
      title={title}
    >
      {content}
    </CordumShell>
  );
}
