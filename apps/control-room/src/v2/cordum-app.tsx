import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import "./cordum-fonts.js";
import { readPlanningRun } from "../live/live-planning-run.js";
import { resolveLiveSetupFromHandshake } from "../live/live-handshake.js";
import type { LiveSetupResult } from "../live/live-config.js";
import { MIDDOT } from "./glyphs.js";
import { ApprovePlan } from "./goals/approve-plan.js";
import { BoardStub } from "./goals/board-stub.js";
import type { GoalDraft, GoalsData } from "./goals/goal-model.js";
import { FIXTURE_GOALS_DATA } from "./goals/goals-fixtures.js";
import { GoalsHome } from "./goals/goals-home.js";
import { LiveGoalsHome } from "./goals/live-goals.js";
import { LiveWorkBoard } from "./goals/live-work-board.js";
import { CordumShell } from "./shell/cordum-shell.js";
import type { NavBadge } from "./shell/nav-rail.js";
import type { NavId } from "./shell/shell-model.js";

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
  | { readonly status: "PENDING" }
  | { readonly status: "READY"; readonly setup: LiveSetupResult };

/**
 * Runs the RUNTIME credential handshake ONCE on mount for the live path: GET
 * /bootstrap, pair from the URL fragment, and hold the resulting setup in memory.
 * This replaces the build-time baked-secret resolver, so no VITE_MOE_LIVE_* secret
 * is ever read into the page. On a successful pair the one-time token is stripped
 * from the address bar so it neither lingers in history nor survives a copied URL;
 * the path and query are left intact.
 */
function useLiveHandshake(enabled: boolean): LiveResolution {
  const [resolution, setResolution] = useState<LiveResolution>({ status: "PENDING" });
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const href = typeof window === "undefined" ? "" : window.location.href;
    void resolveLiveSetupFromHandshake({
      fetchImpl: (input, init) => fetch(input, init),
      locationHref: href,
    }).then((setup) => {
      if (cancelled) return;
      setResolution({ setup, status: "READY" });
      if (setup.ok && typeof window !== "undefined") {
        try {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        } catch {
          // A sandbox with no history API is not a reason to fail the attach.
        }
      }
    });
    return (): void => { cancelled = true; };
  }, [enabled]);
  return resolution;
}

export interface CordumAppProps {
  /** The raw location.search; fixtures mode is `?...&fixtures=1`. */
  readonly search?: string;
}

interface OpenBoard {
  readonly goalId: string;
  readonly title: string;
}

export function CordumApp({ search = "" }: CordumAppProps): JSX.Element {
  const fixtures = new URLSearchParams(search).get("fixtures") === "1";
  // The live path acquires its credential at RUNTIME through the daemon handshake;
  // in fixtures mode the handshake is disabled and nothing reads its result.
  const live = useLiveHandshake(!fixtures);
  const [open, setOpen] = useState<OpenBoard | null>(null);
  const openBoard = useCallback((goalId: string, title: string) => { setOpen({ goalId, title }); }, []);
  const back = useCallback(() => { setOpen(null); }, []);

  const title = open === null ? "Goals" : open.title;
  const eyebrow = open === null ? `PROJECT ${MIDDOT} MOE-NG` : `${MIDDOT} ${open.goalId}`;

  // Only an attached operator session carries the authenticated header set the
  // plan-review read requires; unattached (fixtures / pending / refused) the open
  // path keeps the daemon-free BoardStub placeholder.
  const attached = !fixtures && live.status === "READY" && live.setup.ok ? live.setup : null;
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
          <LiveWorkBoard headers={attached.headers} />
        </>
      );
  } else if (fixtures) {
    body = <GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={fixturesCreateGoal} onOpenBoard={openBoard} />;
  } else if (live.status === "PENDING") {
    body = (
      <GoalsHome data={HANDSHAKE_PENDING_DATA} onCreateGoal={connectingCreateGoal} onOpenBoard={openBoard} />
    );
  } else {
    body = <LiveGoalsHome onOpenBoard={openBoard} setup={live.setup} />;
  }

  return (
    <CordumShell
      activeNav="goals"
      backLabel="GOALS"
      eyebrow={eyebrow}
      initialConnection={fixtures ? "CONNECTED" : null}
      navBadges={fixtures ? FIXTURE_BADGES : undefined}
      onBack={open === null ? undefined : back}
      simulatable={fixtures}
      title={title}
    >
      {body}
    </CordumShell>
  );
}
