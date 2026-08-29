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
 *
 * THE SUBJECT IS DAEMON-STATED. `SurfaceFrame.planningGoalRef` is the daemon's own
 * durable goal binding for the planning run; the board repeats it verbatim and
 * never synthesises, formats or defaults one. When the daemon states none, the
 * board says so in the shell's own language for unavailability rather than
 * inventing a subject to fill the slot.
 */

const POLL_INTERVAL_MS = 2_000;

/** Shown when the daemon answered but bound no durable goal to this surface. */
export const BOARD_SUBJECT_ABSENT_NOTE =
  "The daemon has not bound a durable goal to this board yet.";

export interface LiveWorkBoardProps {
  readonly headers: Readonly<Record<string, string>>;
  readonly onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined;
  /**
   * Every frame this board receives, handed on VERBATIM. The board already owns the
   * one poll of the affordance surface; a second reader opening its own poll for the
   * same bytes would be a second source of truth for what the daemon is offering.
   */
  readonly onFrame?: ((frame: SurfaceFrame) => void) | undefined;
}

/**
 * The durable subject line. Rendered only once a frame has arrived: before that
 * there is nothing DAEMON-STATED to report, and an "absent" claim would be the
 * board's own guess rather than the daemon's answer.
 */
function BoardSubject({ frame }: { readonly frame: SurfaceFrame | null }): JSX.Element | null {
  if (frame === null) return null;
  const goalRef = frame.planningGoalRef ?? null;
  return (
    <p
      className="cr2-board-subject"
      data-goal={goalRef ?? undefined}
      data-testid="cr.board.subject"
    >
      {goalRef ?? BOARD_SUBJECT_ABSENT_NOTE}
    </p>
  );
}

export function LiveWorkBoard({ headers, onConnection, onFrame }: LiveWorkBoardProps): JSX.Element {
  const [frame, setFrame] = useState<SurfaceFrame | null>(null);

  const feed = useMemo(() => createBoardFeed({
    headers,
    intervalMs: POLL_INTERVAL_MS,
    onFrame: (next) => {
      setFrame(next);
      onConnection?.(next.connection);
      onFrame?.(next);
    },
  }), [headers, onConnection, onFrame]);

  useEffect(() => {
    feed.start();
    return (): void => { feed.stop(); };
  }, [feed]);

  return (
    <>
      <BoardSubject frame={frame} />
      <WorkBoard frame={frame} />
    </>
  );
}
