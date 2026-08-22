import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import { resolveLiveSetupFromHandshake } from "../live/live-handshake.js";
import type { LiveSetupResult } from "../live/live-config.js";
import { MIDDOT } from "./glyphs.js";
import { BoardStub } from "./goals/board-stub.js";
import type { GoalDraft, GoalsData } from "./goals/goal-model.js";
import { FIXTURE_GOALS_DATA } from "./goals/goals-fixtures.js";
import { GoalsHome } from "./goals/goals-home.js";
import { LiveGoalsHome } from "./goals/live-goals.js";
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
 * Google Fonts via <link>, injected here because this app cannot edit index.html.
 * On the Vite dev path this loads; on the daemon-hosted path the default-src self
 * CSP blocks it (a leftover: the faces need self-hosting or a CSP allowance). The
 * token stacks fall back to Segoe UI / system fonts, so the shell stays legible
 * either way.
 */
function ensureCordumFonts(): void {
  if (typeof document === "undefined") return;
  const head = document.head;
  if (head === null || document.getElementById("cr2-fonts") !== null) return;
  const preconnect = document.createElement("link");
  preconnect.rel = "preconnect";
  preconnect.href = "https://fonts.gstatic.com";
  preconnect.crossOrigin = "anonymous";
  const sheet = document.createElement("link");
  sheet.id = "cr2-fonts";
  sheet.rel = "stylesheet";
  sheet.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600"
    + "&family=IBM+Plex+Sans:wght@400;500;600;700"
    + "&family=Space+Grotesk:wght@400;500;600;700&display=swap";
  head.append(preconnect, sheet);
}

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
  useEffect(() => { ensureCordumFonts(); }, []);
  const fixtures = new URLSearchParams(search).get("fixtures") === "1";
  // The live path acquires its credential at RUNTIME through the daemon handshake;
  // in fixtures mode the handshake is disabled and nothing reads its result.
  const live = useLiveHandshake(!fixtures);
  const [open, setOpen] = useState<OpenBoard | null>(null);
  const openBoard = useCallback((goalId: string, title: string) => { setOpen({ goalId, title }); }, []);
  const back = useCallback(() => { setOpen(null); }, []);

  const title = open === null ? "Goals" : open.title;
  const eyebrow = open === null ? `PROJECT ${MIDDOT} MOE-NG` : `${MIDDOT} ${open.goalId}`;

  let body: JSX.Element;
  if (open !== null) {
    body = <BoardStub goalId={open.goalId} onBack={back} title={open.title} />;
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
