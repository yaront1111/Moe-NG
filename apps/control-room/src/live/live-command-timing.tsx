import { memo, useMemo } from "react";
import type { JSX } from "react";

import { CommandLatency, useClock } from "../performance/command-latency.js";
import { buildLiveTimingReceipt, readClientClock } from "../performance/wire-timing.js";
import type { SurfaceTimingReceipt } from "../performance/timing.js";
import type { LiveEventRow, LiveFrame } from "./live-event-feed.js";

/**
 * The live path's OWN timing receipt: the production consumer of the four-phase
 * evaluator.
 *
 * Every value that reaches the evaluator here was OBSERVED, not supplied. The two daemon
 * readings arrive on the row the daemon actually sent; the client-received reading was
 * taken by the feed the instant its answer landed; and the render reading is taken from
 * the injected clock as the frame paints. Nothing is a fixture and nothing is a prop a
 * caller chose — which is the distinction that makes this an edge rather than a demo.
 *
 * A receipt is rendered only for a row carrying a command identity, and it is built from
 * THAT row's readings, so a receipt is attributable to exactly one command. A row the
 * daemon sent without an identity gets no receipt rather than one attached to a guess.
 *
 * The receipt is addressed by command id AND event id, because one command emits many
 * events: two rows of the same command carry two different sets of readings, and a
 * command-only identifier would paint both under one id, leaving two distinct receipts
 * that nothing could tell apart. The command id is what attributes; the event id is what
 * disambiguates.
 *
 * WHAT THE PRODUCTION RECEIPT HONESTLY SAYS, measured rather than hoped for: `render` is
 * the one phase both of whose readings come from this application's single injected
 * clock, so it is the one that measures. `server` spans the store's commit clock and the
 * daemon's wall clock, and `stream` spans the daemon's wall clock and this browser's
 * monotonic clock — both are cross-clock, so both refuse with a code instead of
 * publishing a plausible wrong number. `human` stays absent until an operator acts. That
 * is not a gap in the wiring; it is the wiring reporting what is actually comparable.
 *
 * THE RENDER READING BELONGS TO THE FRAME, not to the render. The arrival reading is
 * stamped once per poll, but the application around this surface repaints far more often
 * than it polls: the board and document feeds re-render the whole live surface every
 * interval with the SAME frame. A reading re-taken on each of those repaints would move
 * the render phase forward with every unrelated paint and publish time-since-arrival at
 * the latest repaint under the name of paint latency, which is exactly the plausible wrong
 * number the rest of this receipt refuses to show. So the reading is taken once per frame
 * (frames are frozen and replaced per poll), and the surface is memoised on its frame so
 * a repaint that changed nothing it reads does not reach it at all.
 */

/** Namespace for the live timeline's latency receipts; one receipt per command. */
export const LIVE_TIMING_PREFIX = "cr.live.timing";

export interface LiveCommandTimingProps {
  readonly frame: LiveFrame;
}

interface RowReceipt {
  readonly receipt: SurfaceTimingReceipt;
  readonly row: LiveEventRow;
}

function identified(row: LiveEventRow): boolean {
  return row.identity !== null;
}

function LiveCommandTimingSurface({ frame }: LiveCommandTimingProps): JSX.Element {
  const clock = useClock();
  // One render reading per frame, taken during the render that first paints it and
  // reused by every later repaint of the same frame; a new frame is a new arrival and
  // gets a new reading. Under StrictMode's double invocation the factory re-reads the
  // same injected clock within the one render pass: nothing is sampled into state and
  // replayed across a remount, which is what would silently report the wrong span in
  // development.
  const receipts = useMemo((): readonly RowReceipt[] => {
    const rendered = readClientClock(clock);
    return frame.events.filter(identified).map((row) => ({
      receipt: buildLiveTimingReceipt({
        ledger: row.ledgerObservation,
        received: frame.receivedAt,
        rendered,
        seam: row.seamObservation,
      }),
      row,
    }));
  }, [clock, frame]);
  if (receipts.length === 0) return <></>;
  return (
    <div data-testid={`${LIVE_TIMING_PREFIX}.receipts`}>
      {receipts.map(({ receipt, row }) => {
        const commandId = row.identity?.commandId ?? "";
        return (
          <CommandLatency
            feedback={{
              commandId,
              message: row.eventType,
              state: "CONFIRMED",
            }}
            key={row.eventId}
            receipt={receipt}
            testIdPrefix={`${LIVE_TIMING_PREFIX}.${commandId}.${row.eventId}`}
          />
        );
      })}
    </div>
  );
}

/**
 * Memoised on its only prop. The parent timeline re-renders on every board and document
 * poll with the frame it already had; those repaints carry nothing this surface reads,
 * so they stop here. A clock change still reaches it through context, as it must: a new
 * clock is a new scale, and a reading on the old one would no longer be comparable.
 */
export const LiveCommandTiming = memo(LiveCommandTimingSurface);
