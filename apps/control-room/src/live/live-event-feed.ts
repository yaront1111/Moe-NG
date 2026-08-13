import type { ControlRoomTransport } from "@moe/control-room-client";

/**
 * Polls the daemon's committed event-page seam and reports what it actually said.
 *
 * Shaping only, never inference: a transport failure is DISCONNECTED with the
 * transport's own code; a daemon refusal is still CONNECTED (the daemon answered —
 * its refusal IS the answer) carrying the daemon's code verbatim; a malformed
 * body is LIVE_FRAME_UNREADABLE. Event rows copy the wire fields and add nothing;
 * in particular no truth class is invented — the wire frame does not carry one,
 * so the presentation kernel renders these rows UNKNOWN with an ABSENT note.
 */

export interface LiveEventRow {
  readonly aggregateId: string;
  readonly committedAt: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly position: string;
}

export interface LiveFrame {
  readonly checkpoint: string | null;
  readonly connection: "CONNECTED" | "DISCONNECTED";
  readonly detail: string;
  readonly events: readonly LiveEventRow[];
  readonly outcome: string;
}

export interface LiveFeedOptions {
  readonly intervalMs: number;
  readonly onFrame: (frame: LiveFrame) => void;
  readonly projection: string;
  /** Injectable for tests; production uses setTimeout. */
  readonly schedule?: ((run: () => void, delayMs: number) => () => void) | undefined;
  readonly subscriberId: string;
  readonly transport: Pick<ControlRoomTransport, "readEventPage">;
}

export interface LiveFeed {
  /** One immediate poll plus the recurring cadence; idempotent. */
  start(): void;
  stop(): void;
}

const MAX_ROWS = 250;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rowOf(value: unknown): LiveEventRow | null {
  if (!isRecord(value)) return null;
  const eventId = text(value["eventId"]);
  if (eventId === "") return null;
  return Object.freeze({
    aggregateId: text(value["aggregateId"]),
    committedAt: text(value["committedAt"]),
    eventId,
    eventType: text(value["eventType"]),
    position: text(value["globalPosition"]),
  });
}

function frame(
  connection: LiveFrame["connection"],
  outcome: string,
  detail: string,
  events: readonly LiveEventRow[] = [],
  checkpoint: string | null = null,
): LiveFrame {
  return Object.freeze({ checkpoint, connection, detail, events, outcome });
}

function frameOf(response: unknown): LiveFrame {
  if (!isRecord(response)) return frame("CONNECTED", "UNREADABLE", "LIVE_FRAME_UNREADABLE");
  const outcome = text(response["outcome"]);
  if (outcome === "PAGE") {
    const raw = Array.isArray(response["events"]) ? response["events"] : [];
    const events = raw.slice(0, MAX_ROWS).map(rowOf)
      .filter((row): row is LiveEventRow => row !== null);
    return frame("CONNECTED", outcome, "", events, text(response["checkpoint"]) || null);
  }
  if (outcome === "CURSOR_GAP") {
    return frame("CONNECTED", outcome, text(response["cause"]));
  }
  if (outcome === "REFUSED") {
    return frame("CONNECTED", outcome, text(response["code"]));
  }
  return frame("CONNECTED", "UNREADABLE", "LIVE_FRAME_UNREADABLE");
}

export function createLiveEventFeed(options: LiveFeedOptions): LiveFeed {
  const schedule = options.schedule
    ?? ((run: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(run, delayMs);
      return () => { clearTimeout(timer); };
    });
  let cancel: (() => void) | null = null;
  // Generation guard (same discipline as createLiveDocumentDossierFeed): stop()
  // cannot cancel an in-flight request, and a restart resets `running`, so the
  // boolean alone would let an orphaned poll revive as a second permanent loop.
  let generation = 0;
  let running = false;

  const poll = async (run: number): Promise<void> => {
    const result = await options.transport.readEventPage({
      projection: options.projection,
      subscriberId: options.subscriberId,
    });
    if (!running || run !== generation) return;
    options.onFrame(result.delivered
      ? frameOf(result.response)
      : frame("DISCONNECTED", "UNDELIVERED", result.code));
    if (run === generation) cancel = schedule(() => { void poll(run); }, options.intervalMs);
  };

  return Object.freeze({
    start: (): void => {
      if (running) return;
      running = true;
      generation += 1;
      void poll(generation);
    },
    stop: (): void => {
      running = false;
      generation += 1;
      cancel?.();
      cancel = null;
    },
  });
}
