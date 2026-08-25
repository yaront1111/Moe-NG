import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import { createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { WorkBoard } from "./work-board.js";

/**
 * The LIVE work board: owns a kept board feed over the daemon's affordance surface
 * and renders the pure <WorkBoard> over each frame it delivers. This mirrors how
 * LiveGoalsHome owns the feed while GoalsHome stays pure - the presentation never
 * touches the transport.
 *
 * READ-ONLY: it imports only the surface reader (createBoardFeed), never a
 * dispatch. Latest-wins: onFrame simply replaces the held frame; stop() runs on
 * unmount (and on a headers change) so no orphaned poll survives.
 */

const POLL_INTERVAL_MS = 2_000;

export interface LiveWorkBoardProps {
  readonly headers: Readonly<Record<string, string>>;
  readonly onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined;
}

export function LiveWorkBoard({ headers, onConnection }: LiveWorkBoardProps): JSX.Element {
  const [frame, setFrame] = useState<SurfaceFrame | null>(null);

  const feed = useMemo(() => createBoardFeed({
    headers,
    intervalMs: POLL_INTERVAL_MS,
    onFrame: (next) => {
      setFrame(next);
      onConnection?.(next.connection);
    },
  }), [headers, onConnection]);

  useEffect(() => {
    feed.start();
    return (): void => { feed.stop(); };
  }, [feed]);

  return <WorkBoard frame={frame} />;
}
