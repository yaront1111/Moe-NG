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

/**
 * The refusal already in hand, said in one sentence.
 *
 * Both refused surfaces - the coming-online note and the disabled create
 * control - read it from here, so this page speaks ONE refusal vocabulary and
 * the two cannot drift apart. Nothing is added to the daemon's truth:
 * `LiveRefused` is `{code, detail, ok}` and has no layer (live-config.ts:49-53).
 */
function refusalSentence(setup: LiveRefused): string {
  return `${setup.code}: ${setup.detail}`;
}

function notAttached(setup: LiveRefused): GoalsData {
  return {
    source: "live",
    goals: [],
    triage: [],
    goalCountLabel: "NOT ATTACHED",
    comingOnlineNote: refusalSentence(setup),
  };
}

export interface LiveGoalsHomeProps {
  readonly setup: LiveSetupResult;
  /** The shell's measured connection refusal; absent only while mutations are safe to offer. */
  readonly createDisabledReason?: string | undefined;
  readonly onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
}

export function LiveGoalsHome({
  setup,
  createDisabledReason,
  onConnection,
  onOpenBoard,
}: LiveGoalsHomeProps): JSX.Element {
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

  // A refused bootstrap closes goal creation on THIS component's own authority,
  // never on its caller's memory to pass a reason. On refusal the derived
  // sentence SUPERSEDES the prop: the shell's string is generic prose and does
  // not name the code the operator needs. On an attached session nothing is
  // derived and the caller's connection banner flows through untouched.
  const createDisabled = setup.ok ? createDisabledReason : refusalSentence(setup);

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
        createDisabledReason={createDisabled}
        data={data}
        onCreateGoal={onCreateGoal}
        onOpenBoard={onOpenBoard}
      />
    </>
  );
}
