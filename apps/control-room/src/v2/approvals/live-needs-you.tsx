import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import { createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { createGoalCatalogFeed } from "../../live/live-goal-catalog.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { LiveSetup } from "../../live/live-config.js";
import { useGoalCoverage } from "../goals/use-goal-coverage.js";
import type { CoverageReader } from "../goals/use-goal-coverage.js";
import { NeedsYou } from "./needs-you.js";
import { deriveNeedsYou } from "./needs-you-model.js";

/**
 * The LIVE Needs-you queue. Three daemon reads feed it and each answers one question: the
 * affordance surface says what this session is OFFERED (plan approvals), the durable goal
 * catalog says which goals exist, and the coverage read says where each goal's contract
 * stands. The queue is derived from those answers and nothing else; `onCount` hands the
 * derived count to the shell for the nav badge so the badge and the list cannot disagree.
 */

const POLL_INTERVAL_MS = 2_000;

export interface LiveNeedsYouProps {
  readonly onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined;
  readonly onCount?: ((count: number) => void) | undefined;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
  readonly readCoverage?: CoverageReader | undefined;
  readonly setup: LiveSetup;
}

export function LiveNeedsYou({
  onConnection, onCount, onOpenBoard, readCoverage, setup,
}: LiveNeedsYouProps): JSX.Element {
  const [surface, setSurface] = useState<SurfaceFrame | null>(null);
  const [catalog, setCatalog] = useState<GoalCatalogFrame | null>(null);

  const feed = useMemo(() => createBoardFeed({
    headers: setup.headers,
    intervalMs: POLL_INTERVAL_MS,
    onFrame: (next) => {
      setSurface(next);
      onConnection?.(next.connection);
    },
  }), [onConnection, setup]);
  const catalogFeed = useMemo(() => createGoalCatalogFeed({
    headers: setup.headers, intervalMs: POLL_INTERVAL_MS, onFrame: setCatalog,
  }), [setup]);
  useEffect(() => {
    feed.start();
    catalogFeed.start();
    return (): void => { feed.stop(); catalogFeed.stop(); };
  }, [catalogFeed, feed]);

  const coverage = useGoalCoverage(catalog, readCoverage);
  const data = useMemo(
    () => deriveNeedsYou({ catalog, coverage, surface }), [catalog, coverage, surface],
  );
  useEffect(() => { onCount?.(data.items.length); }, [data.items.length, onCount]);

  return <NeedsYou data={data} onOpenBoard={onOpenBoard} />;
}
