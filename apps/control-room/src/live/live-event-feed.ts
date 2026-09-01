import type { ControlRoomTransport } from "@moe/control-room-client";

import { readClientClock, shapeWireObservation, shapeWireValue }
  from "../performance/wire-timing.js";
import type { TimingReading, WireObservationRow, WireReading }
  from "../performance/wire-timing.js";
import type { Clock } from "../performance/timing.js";

/**
 * Polls the daemon's committed event-page seam and reports what it actually said.
 *
 * Shaping only, never inference: a transport failure is DISCONNECTED with the
 * transport's own code; a daemon refusal is still CONNECTED (the daemon answered —
 * its refusal IS the answer) carrying the daemon's code verbatim; a malformed
 * body is LIVE_FRAME_UNREADABLE. Event rows copy the wire fields and add nothing;
 * in particular no truth class is invented — the wire frame does not carry one,
 * so the presentation kernel renders these rows UNKNOWN with an ABSENT note.
 *
 * The acknowledgement's answer follows the same rule. Every control room shares one
 * durable subscriber id, so a rival instance can consume this one's cursor, and the
 * only wire evidence is this feed's own ack bouncing. A refused ack is therefore
 * delivered as its own ACK_REFUSED frame carrying the daemon's code verbatim —
 * never discarded as if the acknowledgement had succeeded.
 *
 * That rule still holds for the identity and the two daemon observations added here.
 * They are COPIED: the two readings stay separate fields and are never subtracted, an
 * identity field the frame did not state stays null rather than becoming an empty
 * string, and nothing is derived from any of them.
 *
 * The ONE thing this module now adds is its own observation — when THIS client received
 * the frame — taken against an injected clock and labelled as the control room's own.
 * With no clock it records TIMING_CLOCK_UNAVAILABLE, because a feed that cannot measure
 * must say so rather than imply that no time passed.
 */

export interface LiveEventIdentity {
  readonly commandId: string;
  readonly principal: WireReading | null;
  readonly run: WireReading | null;
  readonly session: WireReading | null;
}

export interface LiveEventRow {
  readonly aggregateId: string;
  readonly committedAt: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly identity: LiveEventIdentity | null;
  readonly ledgerObservation: WireObservationRow | null;
  readonly position: string;
  readonly seamObservation: WireObservationRow | null;
}

export interface LiveFrame {
  readonly checkpoint: string | null;
  readonly connection: "CONNECTED" | "DISCONNECTED";
  readonly detail: string;
  readonly events: readonly LiveEventRow[];
  readonly outcome: string;
  /** When this client received the answer, on its own injected clock. */
  readonly receivedAt: TimingReading;
}

/** Everything a frame is except the arrival reading, which is stamped once on delivery. */
type ShapedFrame = Omit<LiveFrame, "receivedAt">;

export interface LiveFeedOptions {
  /** Injectable; absent means this feed cannot measure, not that no time passed. */
  readonly clock?: Clock | null | undefined;
  readonly intervalMs: number;
  readonly onFrame: (frame: LiveFrame) => void;
  readonly projection: string;
  /** Injectable for tests; production uses setTimeout. */
  readonly schedule?: ((run: () => void, delayMs: number) => () => void) | undefined;
  readonly subscriberId: string;
  readonly transport: Pick<ControlRoomTransport, "acknowledgeEventPage" | "readEventPage">;
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

/**
 * A command identity with no command id is not a weaker identity — it names nothing, so
 * no receipt could be attributed through it. It stays null rather than being minted.
 */
function identityOf(value: unknown): LiveEventIdentity | null {
  if (!isRecord(value)) return null;
  const commandId = text(value["commandId"]);
  if (commandId === "") return null;
  return Object.freeze({
    commandId,
    principal: shapeWireValue(value["principal"]),
    run: shapeWireValue(value["run"]),
    session: shapeWireValue(value["session"]),
  });
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
    identity: identityOf(value["identity"]),
    ledgerObservation: shapeWireObservation(value["ledgerObservation"]),
    position: text(value["globalPosition"]),
    seamObservation: shapeWireObservation(value["seamObservation"]),
  });
}

function frame(
  connection: LiveFrame["connection"],
  outcome: string,
  detail: string,
  events: readonly LiveEventRow[] = [],
  checkpoint: string | null = null,
): ShapedFrame {
  return Object.freeze({ checkpoint, connection, detail, events, outcome });
}

function frameOf(response: unknown): ShapedFrame {
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

interface ShapedDelivery {
  readonly cursor: { readonly generation: number; readonly position: string } | null;
  readonly value: ShapedFrame;
}

function cursorOf(response: unknown): ShapedDelivery {
  const value = frameOf(response);
  if (!isRecord(response) || response["outcome"] !== "PAGE") {
    return { cursor: null, value };
  }
  const candidate = response["nextCursor"];
  if (candidate === null || candidate === undefined) {
    const hasEvents = Array.isArray(response["events"]) && response["events"].length > 0;
    return hasEvents
      ? { cursor: null, value: frame("CONNECTED", "UNREADABLE", "LIVE_FRAME_UNREADABLE") }
      : { cursor: null, value };
  }
  if (!isRecord(candidate)) {
    return { cursor: null, value: frame("CONNECTED", "UNREADABLE", "LIVE_FRAME_UNREADABLE") };
  }
  const generation = candidate["generation"];
  const position = candidate["position"];
  if (!Number.isSafeInteger(generation) || (generation as number) < 1
    || typeof position !== "string" || !/^(0|[1-9]\d*)$/u.test(position)) {
    return { cursor: null, value: frame("CONNECTED", "UNREADABLE", "LIVE_FRAME_UNREADABLE") };
  }
  return { cursor: { generation: generation as number, position }, value };
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
    // Taken the instant the answer arrives, before any shaping work: this is the
    // control room's own observation of receipt, not a reading of the daemon's.
    const receivedAt = readClientClock(options.clock);
    if (!running || run !== generation) return;
    const shaped = result.delivered
      ? cursorOf(result.response)
      : { cursor: null, value: frame("DISCONNECTED", "UNDELIVERED", result.code) };
    options.onFrame(Object.freeze({
      ...shaped.value,
      receivedAt,
    }));
    if (shaped.cursor !== null) {
      const ack = await options.transport.acknowledgeEventPage({
        presentedCursor: shaped.cursor,
        subscriberId: options.subscriberId,
      });
      // Same instant-of-arrival rule as the read above, for the ack's own answer.
      const ackReceivedAt = readClientClock(options.clock);
      if (!running || run !== generation) return;
      // A refused acknowledgement is a daemon answer too, and the one wire signal
      // that a rival consumer of this shared subscriber is stealing pages. It is
      // reported under the feed's own ACK_REFUSED outcome with the daemon's code
      // verbatim; nothing about the rival is inferred, and every other ack answer
      // stays as silent as before.
      if (ack.delivered && isRecord(ack.response) && ack.response["outcome"] === "REFUSED") {
        options.onFrame(Object.freeze({
          ...frame("CONNECTED", "ACK_REFUSED", text(ack.response["code"])),
          receivedAt: ackReceivedAt,
        }));
      }
    }
    if (!running || run !== generation) return;
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
