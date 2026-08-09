import { describe, expect, it } from "vitest";

import { createLiveEventFeed } from "./live-event-feed.js";
import type { LiveFrame } from "./live-event-feed.js";
import { resolveLiveSetup } from "./live-config.js";

function immediateOnce(): (run: () => void, delayMs: number) => () => void {
  // Never re-schedules: each test drives exactly one poll.
  return () => () => undefined;
}

async function oneFrame(response: unknown, delivered = true): Promise<LiveFrame> {
  const frames: LiveFrame[] = [];
  const feed = createLiveEventFeed({
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
