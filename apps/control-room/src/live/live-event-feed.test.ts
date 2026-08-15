import { describe, expect, it } from "vitest";

import { createLiveEventFeed } from "./live-event-feed.js";
import type { LiveFrame } from "./live-event-feed.js";
import { resolveLiveSetup } from "./live-config.js";
import type { Clock } from "../performance/timing.js";

function immediateOnce(): (run: () => void, delayMs: number) => () => void {
  // Never re-schedules: each test drives exactly one poll.
  return () => () => undefined;
}

async function oneFrame(
  response: unknown, delivered = true, clock?: Clock | null,
): Promise<LiveFrame> {
  const frames: LiveFrame[] = [];
  const feed = createLiveEventFeed({
    clock,
    intervalMs: 1,
    onFrame: (frame) => frames.push(frame),
    projection: "moe.board",
    schedule: immediateOnce(),
    subscriberId: "control-room-1",
    transport: {
      readEventPage: () => Promise.resolve(delivered
        ? { delivered: true as const, response, status: 200 }
        : {
          code: "TRANSPORT_REQUEST_FAILED" as const,
          delivered: false as const,
          layer: "CONTROL_ROOM_TRANSPORT" as const,
        }),
    },
  });
  feed.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  feed.stop();
  const frame = frames[0];
  if (frame === undefined) throw new Error("no frame delivered");
  return frame;
}

describe("createLiveEventFeed", () => {
  it("shapes a PAGE verbatim, copying wire fields and inventing nothing", async () => {
    const frame = await oneFrame({
      checkpoint: "4",
      events: [{
        aggregateId: "session/sess-1", committedAt: "2026-08-09T12:00:00.000Z",
        eventId: "evt-1", eventType: "SessionOpened", globalPosition: "3",
      }],
      hasMore: false,
      nextCursor: { generation: 1, position: "3" },
      outcome: "PAGE",
    });
    expect(frame).toMatchObject({
      checkpoint: "4",
      connection: "CONNECTED",
      events: [{ eventId: "evt-1", eventType: "SessionOpened", position: "3" }],
      outcome: "PAGE",
    });
  });

  it("keeps a daemon refusal CONNECTED and carries the daemon's code", async () => {
    const frame = await oneFrame({
      code: "SUBSCRIPTION_NOT_REGISTERED", detail: "no doc", layer: "STATE",
      outcome: "REFUSED",
    });
    expect(frame).toMatchObject({
      connection: "CONNECTED",
      detail: "SUBSCRIPTION_NOT_REGISTERED",
      outcome: "REFUSED",
    });
  });

  it("marks an undelivered round trip DISCONNECTED with the transport's code", async () => {
    const frame = await oneFrame(null, false);
    expect(frame).toMatchObject({
      connection: "DISCONNECTED",
      detail: "TRANSPORT_REQUEST_FAILED",
      outcome: "UNDELIVERED",
    });
  });

  it("refuses an unreadable body with the stable frame code", async () => {
    const frame = await oneFrame("not-a-frame");
    expect(frame).toMatchObject({ detail: "LIVE_FRAME_UNREADABLE", outcome: "UNREADABLE" });
  });

  it("suppresses an in-flight poll across stop and restart instead of reviving it", async () => {
    type PageAnswer = { delivered: true; response: unknown; status: number };
    const answers: Array<(result: PageAnswer) => void> = [];
    const frames: LiveFrame[] = [];
    let scheduled = 0;
    const feed = createLiveEventFeed({
      intervalMs: 10_000,
      onFrame: (frame) => frames.push(frame),
      projection: "moe.board",
      schedule: () => { scheduled += 1; return () => undefined; },
      subscriberId: "control-room-1",
      transport: {
        readEventPage: () => new Promise((resolve) => { answers.push(resolve); }),
      },
    });

    // StrictMode's dev double-invoke: setup -> cleanup -> setup while poll A awaits.
    feed.start();
    feed.stop();
    feed.start();
    expect(answers).toHaveLength(2);

    // Poll A outlived its stop; it must neither deliver nor start a second loop.
    answers[0]?.({ delivered: true, response: { events: [], outcome: "PAGE" }, status: 200 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toHaveLength(0);
    expect(scheduled).toBe(0);

    // Poll B is the restart's own loop: exactly one frame, one reschedule.
    answers[1]?.({ delivered: true, response: { events: [], outcome: "PAGE" }, status: 200 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toHaveLength(1);
    expect(scheduled).toBe(1);
    feed.stop();
  });
});

describe("resolveLiveSetup", () => {
  it("refuses without credentials, naming the stable code", () => {
    expect(resolveLiveSetup({}, null)).toMatchObject({ code: "LIVE_CONFIG_MISSING", ok: false });
  });

  it("refuses a rejected compat report with the gate's decision named", () => {
    const result = resolveLiveSetup(
      { VITE_MOE_LIVE_CREDENTIAL: "cred", VITE_MOE_LIVE_CSRF: "csrf" },
      { not: "a report" },
    );
    expect(result).toMatchObject({ code: "LIVE_COMPAT_REFUSED", ok: false });
  });
});

/**
 * The identity and the two daemon observations are COPIED, never inferred. The feed's
 * header rule still binds: it shapes, so an absent field stays absent rather than
 * becoming a default that a later layer would read as evidence.
 */
const OBSERVED_PAGE = {
  checkpoint: "9",
  events: [{
    aggregateId: "session/sess-1",
    committedAt: "2026-08-09T12:00:00.000Z",
    eventId: "evt-1",
    eventType: "SessionOpened",
    globalPosition: "3",
    identity: {
      commandId: "cmd-open-1",
      principal: { known: true, value: "operator-1" },
      run: { code: "EVENT_STREAM_IDENTITY_NOT_PROVIDED", known: false, layer: "SEAM" },
      session: { code: "EVENT_STREAM_IDENTITY_NOT_PROVIDED", known: false, layer: "SEAM" },
    },
    ledgerObservation: {
      clock: "STORE_COMMIT_CLOCK", observer: "STORE_LEDGER",
      reading: { known: true, value: "2026-08-09T12:00:00.000Z" },
    },
    seamObservation: {
      clock: "DAEMON_WALL_CLOCK", observer: "DAEMON_SEAM",
      reading: { known: true, value: "2026-08-09T12:00:00.200Z" },
    },
  }],
  hasMore: false,
  outcome: "PAGE",
};

describe("the feed carries command identity and the daemon's own readings", () => {
  it("copies the identity and both observations verbatim onto the row", async () => {
    const frame = await oneFrame(OBSERVED_PAGE);
    const row = frame.events[0];
    expect(row?.identity?.commandId).toBe("cmd-open-1");
    expect(row?.identity?.principal).toEqual({ known: true, value: "operator-1" });
    expect(row?.identity?.run).toEqual({
      code: "EVENT_STREAM_IDENTITY_NOT_PROVIDED", known: false, layer: "SEAM",
    });
    expect(row?.ledgerObservation).toEqual({
      clock: "STORE_COMMIT_CLOCK", observer: "STORE_LEDGER",
      reading: { known: true, value: "2026-08-09T12:00:00.000Z" },
    });
    expect(row?.seamObservation?.clock).toBe("DAEMON_WALL_CLOCK");
    // The two daemon readings stay SEPARATE fields; nothing here subtracts them.
    expect(row?.ledgerObservation).not.toEqual(row?.seamObservation);
  });

  it("leaves an unstated identity and unstated readings absent, never defaulted", async () => {
    const frame = await oneFrame({
      events: [{
        aggregateId: "session/sess-2", committedAt: "2026-08-09T12:00:00.000Z",
        eventId: "evt-2", eventType: "SessionOpened", globalPosition: "4",
      }],
      outcome: "PAGE",
    });
    const row = frame.events[0];
    expect(row?.eventId).toBe("evt-2");
    expect(row?.identity).toBeNull();
    expect(row?.ledgerObservation).toBeNull();
    expect(row?.seamObservation).toBeNull();
  });

  it("drops an identity with no command id rather than minting one", async () => {
    const frame = await oneFrame({
      events: [{
        aggregateId: "session/sess-3", committedAt: "2026-08-09T12:00:00.000Z",
        eventId: "evt-3", eventType: "SessionOpened", globalPosition: "5",
        identity: { commandId: "", principal: { known: true, value: "operator-1" } },
      }],
      outcome: "PAGE",
    });
    expect(frame.events[0]?.identity).toBeNull();
  });
});

describe("the feed records when IT received the frame, on an injected clock", () => {
  it("stamps the arrival reading from the injected clock", async () => {
    const frame = await oneFrame(OBSERVED_PAGE, true, { now: () => 4_200 });
    expect(frame.receivedAt.known).toBe(true);
    expect(frame.receivedAt.known ? frame.receivedAt.value : null).toBe(4_200);
    expect(frame.receivedAt.known ? frame.receivedAt.clock : null).toBe("CONTROL_ROOM_CLOCK");
  });

  it("refuses TIMING_CLOCK_UNAVAILABLE with no clock, never reporting no time passed", async () => {
    const frame = await oneFrame(OBSERVED_PAGE);
    expect(frame.receivedAt.known).toBe(false);
    expect(frame.receivedAt.known ? null : frame.receivedAt.code)
      .toBe("TIMING_CLOCK_UNAVAILABLE");
  });

  it("stamps the arrival reading on an undelivered round trip too", async () => {
    const frame = await oneFrame(null, false, { now: () => 7_000 });
    expect(frame.connection).toBe("DISCONNECTED");
    expect(frame.detail).toBe("TRANSPORT_REQUEST_FAILED");
    expect(frame.receivedAt.known ? frame.receivedAt.value : null).toBe(7_000);
  });
});
