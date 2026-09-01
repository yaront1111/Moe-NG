import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import { boundGoalOf, createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
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
 * THE SUBJECT IS DAEMON-STATED, AND IT IS PER RUN. The daemon answers a planning
 * offer for EVERY durable goal it holds and states the run -> goal bindings in
 * `SurfaceFrame.planningGoalRefs`; this board repeats the binding for the run it was
 * OPENED on and never the surface-wide singular compatibility binding, which names
 * the seed's goal under every goal a caller opens. When the daemon bound this run to
 * no goal — or bound it to a DIFFERENT goal than the one opened — the board says so
 * in the shell's own language for unavailability rather than inventing a subject.
 *
 * THE BOARD IS SCOPED THE SAME WAY. The daemon's seed-compat planning rows name its
 * default run, so rendering them under an opened goal showed that goal the SEED's
 * plan. They are dropped, and the planning work of THIS goal is projected from the
 * daemon's own offers for THIS target - never invented, never a fabricated
 * BLOCKED/COMMITTED lifecycle, and only while the map binds this run to this goal.
 */

const POLL_INTERVAL_MS = 2_000;

/** The kinds the daemon offers once per durable goal; everything else is goal-agnostic. */
const PLANNING_KINDS: readonly string[] =
  Object.freeze(["approval.decide", "goal.close", "plan.propose"]);

const NO_MISSING: readonly string[] = Object.freeze([]);

/** Shown when the daemon answered but bound no durable goal to this run. */
export const BOARD_SUBJECT_ABSENT_NOTE =
  "The daemon has not bound a durable goal to this board yet.";

export interface LiveWorkBoardProps {
  /** The durable goal the operator opened; the board renders nothing of any other. */
  readonly goalId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined;
  /**
   * Every frame this board receives, handed on VERBATIM and UNSCOPED. The board already
   * owns the one poll of the affordance surface; a second reader opening its own poll for
   * the same bytes would be a second source of truth for what the daemon is offering, and
   * the approval gate must read the daemon's exact offer roster, not this board's view.
   */
  readonly onFrame?: ((frame: SurfaceFrame) => void) | undefined;
  /** That goal's own planning run, as the goal catalog card carried it. */
  readonly runId: string;
}

/** The daemon's binding for the opened run, and only when it names the opened goal. */
function subjectOf(frame: SurfaceFrame, goalId: string, runId: string): string | null {
  return boundGoalOf(frame.planningGoalRefs, runId) === goalId ? goalId : null;
}

/**
 * The planning steps for THIS open target, projected from the daemon's own offers:
 * one READY row per offer it minted, carrying the offer's own target and version.
 * Nothing else is admitted - an offer for another run, another goal, or a version
 * this reader cannot vouch for is simply not this board's work.
 */
function plannedSteps(
  frame: SurfaceFrame, goalId: string, runId: string,
): readonly SurfaceStep[] {
  if (subjectOf(frame, goalId, runId) === null) return [];
  const projected: SurfaceStep[] = [];
  for (const offer of frame.offers) {
    const kind = offer["commandKind"];
    const target = offer["targetAggregateId"];
    const version = offer["expectedVersion"];
    if (typeof kind !== "string" || !PLANNING_KINDS.includes(kind)) continue;
    if (target !== (kind === "goal.close" ? goalId : runId)) continue;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) continue;
    projected.push(Object.freeze({
      aggregateId: target, claim: null, kind, missing: NO_MISSING, status: "READY", version,
    }));
  }
  return projected;
}

/** The frame the WORK BOARD renders: this goal's planning work, and no sibling's. */
function scopedFrame(frame: SurfaceFrame, goalId: string, runId: string): SurfaceFrame {
  return Object.freeze({
    ...frame,
    steps: Object.freeze([
      ...frame.steps.filter((step) => !PLANNING_KINDS.includes(step.kind)),
      ...plannedSteps(frame, goalId, runId),
    ]),
  });
}

/**
 * The durable subject line. Rendered only once a frame has arrived: before that
 * there is nothing DAEMON-STATED to report, and an "absent" claim would be the
 * board's own guess rather than the daemon's answer.
 */
function BoardSubject(
  { frame, goalId, runId }: {
    readonly frame: SurfaceFrame | null; readonly goalId: string; readonly runId: string;
  },
): JSX.Element | null {
  if (frame === null) return null;
  const goalRef = subjectOf(frame, goalId, runId);
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

export function LiveWorkBoard(
  { goalId, headers, onConnection, onFrame, runId }: LiveWorkBoardProps,
): JSX.Element {
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
      <BoardSubject frame={frame} goalId={goalId} runId={runId} />
      <WorkBoard frame={frame === null ? null : scopedFrame(frame, goalId, runId)} />
    </>
  );
}
