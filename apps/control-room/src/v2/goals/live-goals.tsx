import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { createGoalCatalogFeed } from "../../live/live-goal-catalog.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { LiveRefused, LiveSetup, LiveSetupResult } from "../../live/live-config.js";
import { deriveGoalCatalog } from "./goal-catalog-model.js";
import type { GoalCreateResult, GoalDraft, GoalsData } from "./goal-model.js";
import { createGoalDispatcher } from "./live-goal-create.js";
import { GoalsHome } from "./goals-home.js";

/**
 * The LIVE goals home.
 *
 * Two daemon reads run side by side and answer different questions. The
 * AFFORDANCE surface says what this session may do right now - it supplies the
 * goal.create offer the dispatcher hands back, and the connection state. The
 * durable GOAL CATALOG (POST /goals/read) says what actually exists; it is the
 * only source of the goals on screen.
 *
 * That split is the honesty rule this component exists to keep. A create that
 * commits yields a commandId, and the daemon derives `goal-<commandId>` from it,
 * so this page could format that id locally - and never does. It holds the id
 * only as a LOOKUP KEY and shows the goal when the catalog carries it. Until
 * then it says the write is awaiting the catalog, which is exactly what is true.
 */

const POLL_INTERVAL_MS = 2_000;

function notAttached(setup: LiveRefused): GoalsData {
  return {
    source: "live",
    goals: [],
    triage: [],
    goalCountLabel: "NOT ATTACHED",
    comingOnlineNote: `${setup.code}: ${setup.detail}`,
  };
}

export interface LiveGoalsHomeProps {
  readonly setup: LiveSetupResult;
  readonly onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
}

export function LiveGoalsHome({ setup, onConnection, onOpenBoard }: LiveGoalsHomeProps): JSX.Element {
  const [catalog, setCatalog] = useState<GoalCatalogFrame | null>(null);
  const [pendingGoalId, setPendingGoalId] = useState<string | null>(null);
  const frameRef = useRef<SurfaceFrame | null>(null);

  const feed = useMemo(() => (setup.ok
    ? createBoardFeed({
      headers: setup.headers,
      intervalMs: POLL_INTERVAL_MS,
      onFrame: (next) => {
        frameRef.current = next;
        onConnection?.(next.connection);
      },
    })
    : null), [onConnection, setup]);

  const catalogFeed = useMemo(() => (setup.ok
    ? createGoalCatalogFeed({
      headers: setup.headers,
      intervalMs: POLL_INTERVAL_MS,
      onFrame: setCatalog,
    })
    : null), [setup]);

  useEffect(() => {
    feed?.start();
    catalogFeed?.start();
    return (): void => { feed?.stop(); catalogFeed?.stop(); };
  }, [catalogFeed, feed]);

  const data = setup.ok ? deriveGoalCatalog(catalog) : notAttached(setup);

  const dispatch = useMemo<(draft: GoalDraft) => Promise<GoalCreateResult>>(
    () => (setup.ok
      ? createGoalDispatcher(setup as LiveSetup, () => frameRef.current)
      : (): Promise<GoalCreateResult> => Promise.resolve({
        ok: false, report: `Not attached: ${setup.code} · ${setup.detail}`,
      })),
    [setup],
  );

  const onCreateGoal = useCallback(async (draft: GoalDraft): Promise<GoalCreateResult> => {
    const result = await dispatch(draft);
    // The commandId is a lookup key, never a rendered goal id: it decides which
    // catalog row to WATCH FOR, and the catalog decides whether it exists.
    if (result.ok && result.commandId !== undefined) {
      setPendingGoalId(`goal-${result.commandId}`);
      catalogFeed?.refresh();
    }
    return result;
  }, [catalogFeed, dispatch]);

  const awaitingCatalog = pendingGoalId !== null
    && !data.goals.some((goal) => goal.goalId === pendingGoalId);

  return (
    <>
      {awaitingCatalog ? (
        <p
          aria-live="polite"
          className="cr2-goals-createreport"
          data-testid="cr.goals.awaitingcatalog"
          role="status"
        >
          Created &middot; awaiting catalog. The daemon accepted the goal; it appears here once
          the durable catalog returns it.
        </p>
      ) : null}
      <GoalsHome
        data={data}
        onCreateGoal={onCreateGoal}
        onOpenBoard={onOpenBoard}
      />
    </>
  );
}
