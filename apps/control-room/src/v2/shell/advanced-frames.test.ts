import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  EventAcknowledgeRequest, EventPageRequest, SendResult,
} from "@moe/control-room-client";

import type { LiveEventRow, LiveFrame } from "../../live/live-event-feed.js";
import { ADVANCED_POLL_MS, advancedEventsOf, useAdvancedFrames } from "./advanced-frames.js";
import type { AdvancedSource } from "./advanced-frames.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HEADERS = Object.freeze({
  "content-type": "application/json", "x-moe-csrf": "csrf-1",
  "x-moe-protocol-version": "1.0.0", "x-moe-session-credential": "cred-1",
});

const EVENT_ROW = Object.freeze({
  aggregateId: "goal-1", committedAt: "2026-09-05T12:00:00.000Z", eventId: "evt-1",
  eventType: "GoalCreated", identity: null, ledgerObservation: null, position: "7",
  seamObservation: null,
});

const GRAPH_BODY = Object.freeze({
  graphContentHash: "aa".repeat(32), graphEpoch: 4, ok: true, planHash: "bb".repeat(32),
  provenance: Object.freeze({ aggregateId: "agg-1", goalRef: "goal-1" }),
  revisionId: "graph-revision-1",
  snapshot: Object.freeze({ completionNodeKey: "n1", edges: [], nodes: [
    Object.freeze({ executionBearing: true, nodeKey: "n1" }),
  ] }),
  snapshotIdentity: "cc".repeat(32),
});

const EVENT_PAGE = Object.freeze({
  checkpoint: "checkpoint-1",
  events: [{
    aggregateId: "goal-1", committedAt: "2026-09-05T12:00:00.000Z", eventId: "evt-1",
    eventType: "GoalCreated", globalPosition: "7",
  }],
  nextCursor: Object.freeze({ generation: 1, position: "7" }),
  outcome: "PAGE",
});

function frameOf(overrides: Partial<LiveFrame>): LiveFrame {
  return Object.freeze({
    checkpoint: null, connection: "CONNECTED", detail: "", events: [], outcome: "PAGE",
    receivedAt: Object.freeze({ code: "TIMING_CLOCK_UNAVAILABLE", ok: false as const }),
    ...overrides,
  } as LiveFrame);
}

/**
 * A transport that answers one page and records what it was asked. It returns the
 * REAL SendResult shape (delivered + response + status) with no cast, so a
 * producer-side change to that contract reds here instead of being cast away.
 */
type FakeTransport = AdvancedSource["transport"] & { readonly asked: readonly string[] };

function fakeTransport(): FakeTransport {
  const asked: string[] = [];
  return {
    acknowledgeEventPage: (request: EventAcknowledgeRequest): Promise<SendResult> => {
      asked.push(`ack:${request.subscriberId}`);
      return Promise.resolve({
        delivered: true, response: { outcome: "ACKNOWLEDGED" }, status: 200,
      });
    },
    asked,
    readEventPage: (request: EventPageRequest): Promise<SendResult> => {
      asked.push(`read:${request.projection}`);
      return Promise.resolve({ delivered: true, response: EVENT_PAGE, status: 200 });
    },
  };
}

function sourceWith(transport: AdvancedSource["transport"]): AdvancedSource {
  return { headers: HEADERS, projection: "control-room", subscriberId: "sub-1", transport };
}

describe("advancedEventsOf maps the feed vocabulary without inventing a verdict", () => {
  it("carries the rows of a PAGE frame through unchanged", () => {
    const rows: readonly LiveEventRow[] = [EVENT_ROW];
    expect(advancedEventsOf(frameOf({ events: rows, outcome: "PAGE" })))
      .toStrictEqual({ rows, status: "EVENTS" });
  });

  it("reports a daemon refusal as REFUSED with the daemon code verbatim", () => {
    // The specific code, not merely that it did not succeed: the panel renders this
    // string, and a refusal rendered as "no events" is the failure this pins.
    expect(advancedEventsOf(frameOf({ detail: "EVENTS_READ_FORBIDDEN", outcome: "REFUSED" })))
      .toStrictEqual({
        code: "EVENTS_READ_FORBIDDEN", layer: "CONTROL_ROOM_ADVANCED_FRAMES", status: "REFUSED",
      });
  });

  it("reports a refused acknowledgement as REFUSED, not as a silent success", () => {
    expect(advancedEventsOf(frameOf({ detail: "ACK_CURSOR_STALE", outcome: "ACK_REFUSED" })))
      .toStrictEqual({
        code: "ACK_CURSOR_STALE", layer: "CONTROL_ROOM_ADVANCED_FRAMES", status: "REFUSED",
      });
  });

  it("reports an undelivered or unreadable frame as an ERROR at this layer", () => {
    expect(advancedEventsOf(frameOf({
      connection: "DISCONNECTED", detail: "TRANSPORT_REQUEST_FAILED", outcome: "UNDELIVERED",
    }))).toStrictEqual({
      code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_ADVANCED_FRAMES", status: "ERROR",
    });
    expect(advancedEventsOf(frameOf({
      detail: "LIVE_FRAME_UNREADABLE", outcome: "UNREADABLE",
    }))).toStrictEqual({
      code: "LIVE_FRAME_UNREADABLE", layer: "CONTROL_ROOM_ADVANCED_FRAMES", status: "ERROR",
    });
  });

  it("falls back to the outcome word when the frame states no detail", () => {
    // CURSOR_GAP with an empty cause would otherwise render an empty code, which
    // reads as "nothing is wrong" on a panel whose whole job is saying what happened.
    expect(advancedEventsOf(frameOf({ detail: "", outcome: "CURSOR_GAP" })))
      .toStrictEqual({
        code: "CURSOR_GAP", layer: "CONTROL_ROOM_ADVANCED_FRAMES", status: "ERROR",
      });
  });
});

describe("useAdvancedFrames is the production call site for both raw reads", () => {
  it("FETCHES /graph/get itself and hands back the decoded frame", async () => {
    // THE CONSUMER EDGE, asserted on the wire rather than on an import. The roster
    // test in apps/daemon calls /graph/get consumed because THIS runs; an `import
    // type` referent would be erased and fetch nothing.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify(GRAPH_BODY), { status: 200 })),
    );
    const { result } = renderHook(() => useAdvancedFrames(sourceWith(fakeTransport())));

    await waitFor(() => { expect(result.current.graph).not.toBeNull(); });
    expect(result.current.graph?.status).toBe("GRAPH");
    expect(result.current.graph).toMatchObject({
      graphEpoch: 4, revisionId: "graph-revision-1", status: "GRAPH",
    });

    const call = fetchSpy.mock.calls[0];
    if (call === undefined) throw new Error("readGraphGet must have called fetch");
    const [url, init] = call;
    expect(url).toBe("/graph/get");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    expect(init?.headers).toStrictEqual(HEADERS);
  });

  it("drives the production event feed and decodes its rows", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify(GRAPH_BODY), { status: 200 })),
    );
    const transport = fakeTransport();
    const { result } = renderHook(() => useAdvancedFrames(sourceWith(transport)));

    await waitFor(() => { expect(result.current.events).not.toBeNull(); });
    expect(result.current.events).toStrictEqual({
      rows: [EVENT_ROW], status: "EVENTS",
    });
    expect(transport.asked[0]).toBe("read:control-room");
  });

  it("reads NOTHING while unattached and claims no empty graph", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useAdvancedFrames(null));

    await waitFor(() => { expect(result.current.graph).toBeNull(); });
    expect(result.current.events).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("polls on the shell cadence, not a screen cadence", () => {
    expect(ADVANCED_POLL_MS).toBe(15_000);
  });
});
