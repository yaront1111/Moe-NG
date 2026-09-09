import { useEffect, useMemo, useState } from "react";

import type { ControlRoomTransport } from "@moe/control-room-client";

import { createLiveEventFeed } from "../../live/live-event-feed.js";
import type { LiveFrame } from "../../live/live-event-feed.js";
import { readGraphGet } from "../../live/live-graph-get.js";
import type { GraphGetOutcome } from "../../live/live-graph-get.js";
import { useOpsRead } from "../ops/live-ops.js";
import type { AdvancedEvents } from "./advanced-view.js";

/**
 * THE CALL SITES for the two raw reads the Advanced panel renders. This module is
 * what makes those reads REACHABLE: a decoder nothing calls is dead code, and a
 * route whose only referent is an erased `import type` is served to nobody.
 *
 * Both reads go through their PRODUCTION decoders - readGraphGet for /graph/get and
 * createLiveEventFeed for /events/read plus /events/ack - so a daemon that adds a
 * frame member this browser does not name refuses at the decode instead of
 * rendering a quietly truncated frame.
 *
 * THE EVENT FEED SHARES THE ONE DURABLE SUBSCRIBER ID the handshake minted, and it
 * acknowledges the pages it reads, which advances that cursor. That is the feed's
 * designed behaviour rather than a choice made here; a rival consumer of the same
 * subscriber shows up as the feed's own ACK_REFUSED frame, which this module passes
 * through verbatim rather than swallowing.
 */

const ADVANCED_FRAMES_LAYER = "CONTROL_ROOM_ADVANCED_FRAMES";

/** A read that never answered is an ERROR at THIS layer, never an empty graph. */
const GRAPH_FAILURE: GraphGetOutcome = Object.freeze({
  code: "GRAPH_GET_READ_FAILED", layer: ADVANCED_FRAMES_LAYER, status: "ERROR" as const,
});

/**
 * The shell's cadence, not a screen's 5 s one: these are forensic frames, and the
 * panel is closed most of the time.
 */
export const ADVANCED_POLL_MS = 15_000;

/** Exactly what the two reads need, so a test can drive this with no handshake. */
export interface AdvancedSource {
  readonly headers: Readonly<Record<string, string>>;
  readonly projection: string;
  readonly subscriberId: string;
  readonly transport: Pick<ControlRoomTransport, "acknowledgeEventPage" | "readEventPage">;
}

export interface AdvancedFrames {
  readonly events: AdvancedEvents | null;
  readonly graph: GraphGetOutcome | null;
}

/**
 * The feed states its own outcome per frame; this maps that vocabulary onto the
 * panel's three cases WITHOUT inventing a verdict. Only PAGE is a set of rows. A
 * daemon refusal and a refused acknowledgement carry the daemon's code verbatim;
 * everything else is an error at this layer with the feed's detail as its code, so
 * an unreadable frame is never rendered as "no events".
 */
export function advancedEventsOf(frame: LiveFrame): AdvancedEvents {
  if (frame.outcome === "PAGE") {
    return Object.freeze({ rows: frame.events, status: "EVENTS" as const });
  }
  const code = frame.detail === "" ? frame.outcome : frame.detail;
  if (frame.outcome === "REFUSED" || frame.outcome === "ACK_REFUSED") {
    return Object.freeze({ code, layer: ADVANCED_FRAMES_LAYER, status: "REFUSED" as const });
  }
  return Object.freeze({ code, layer: ADVANCED_FRAMES_LAYER, status: "ERROR" as const });
}

/**
 * Unattached (fixtures, pairing, a refused handshake) there is no credential to read
 * with, so both frames stay null and the panel says it is still reading rather than
 * claiming an empty graph.
 */
export function useAdvancedFrames(source: AdvancedSource | null): AdvancedFrames {
  const read = useMemo(
    () => (source === null
      ? (): Promise<GraphGetOutcome> => Promise.resolve(GRAPH_FAILURE)
      : (): Promise<GraphGetOutcome> => readGraphGet(source.headers)),
    [source],
  );
  const graph = useOpsRead(read, GRAPH_FAILURE, ADVANCED_POLL_MS, undefined);

  const [events, setEvents] = useState<AdvancedEvents | null>(null);
  useEffect(() => {
    if (source === null) {
      setEvents(null);
      return undefined;
    }
    let live = true;
    const feed = createLiveEventFeed({
      intervalMs: ADVANCED_POLL_MS,
      onFrame: (frame: LiveFrame): void => {
        if (live) setEvents(advancedEventsOf(frame));
      },
      projection: source.projection,
      subscriberId: source.subscriberId,
      transport: source.transport,
    });
    feed.start();
    return (): void => {
      live = false;
      feed.stop();
    };
  }, [source]);

  return { events, graph: source === null ? null : graph.outcome };
}
