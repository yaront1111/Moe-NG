import type { JSX } from "react";

import { CommandLatency, useClock } from "../performance/command-latency.js";
import { buildLiveTimingReceipt, readClientClock } from "../performance/wire-timing.js";
import type { LiveEventRow, LiveFrame } from "./live-event-feed.js";

/**
 * The live path's OWN timing receipt: the production consumer of the four-phase
 * evaluator.
 *
 * Every value that reaches the evaluator here was OBSERVED, not supplied. The two daemon
 * readings arrive on the row the daemon actually sent; the client-received reading was
 * taken by the feed the instant its answer landed; and the render reading is taken from
 * the injected clock during this render. Nothing is a fixture and nothing is a prop a
 * caller chose — which is the distinction that makes this an edge rather than a demo.
 *
 * A receipt is rendered only for a row carrying a command identity, and it is built from
 * THAT row's readings, so a receipt is attributable to exactly one command. A row the
 * daemon sent without an identity gets no receipt rather than one attached to a guess.
 *
 * WHAT THE PRODUCTION RECEIPT HONESTLY SAYS, measured rather than hoped for: `render` is
 * the one phase both of whose readings come from this application's single injected
 * clock, so it is the one that measures. `server` spans the store's commit clock and the
 * daemon's wall clock, and `stream` spans the daemon's wall clock and this browser's
 * monotonic clock — both are cross-clock, so both refuse with a code instead of
 * publishing a plausible wrong number. `human` stays absent until an operator acts. That
 * is not a gap in the wiring; it is the wiring reporting what is actually comparable.
 */

/** Namespace for the live timeline's latency receipts; one receipt per command. */
export const LIVE_TIMING_PREFIX = "cr.live.timing";

export interface LiveCommandTimingProps {
  readonly frame: LiveFrame;
}

function identified(row: LiveEventRow): boolean {
  return row.identity !== null;
}

export function LiveCommandTiming({ frame }: LiveCommandTimingProps): JSX.Element {
  // Read during render and never stored. Under StrictMode's double invocation this
  // re-reads the same injected clock rather than replaying a start sampled into state,
  // which is what would silently report the wrong span in development.
  const rendered = readClientClock(useClock());
  const rows = frame.events.filter(identified);
  if (rows.length === 0) return <></>;
  return (
    <div data-testid={`${LIVE_TIMING_PREFIX}.receipts`}>
      {rows.map((row) => {
        const commandId = row.identity?.commandId ?? "";
        return (
          <CommandLatency
            feedback={{
              commandId,
              message: row.eventType,
              state: "CONFIRMED",
            }}
            key={row.eventId}
            receipt={buildLiveTimingReceipt({
              ledger: row.ledgerObservation,
              received: frame.receivedAt,
              rendered,
              seam: row.seamObservation,
            })}
            testIdPrefix={`${LIVE_TIMING_PREFIX}.${commandId}`}
          />
        );
      })}
    </div>
  );
}
