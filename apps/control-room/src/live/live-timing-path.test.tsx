import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LIVE_TIMING_PREFIX } from "./live-command-timing.js";
import { LiveControlRoom } from "./live-app.js";
import type { LiveSetup } from "./live-config.js";
import { ClockProvider } from "../performance/command-latency.js";
import type { Clock } from "../performance/timing.js";

/**
 * DoD 5. This is the test the task exists for, and its SHAPE is the point.
 *
 * It does not call `evaluateTiming` and assert its return value — the existing
 * command-latency spec already does that, it passed for the whole time production had
 * ZERO callers, and that is exactly why the gap stayed invisible. Instead it renders the
 * live application, answers one poll through the feed's own transport seam, and reads
 * the phase lines the operator would see. Nothing below hands the surface a receipt, a
 * duration, or a reason code; every asserted value is one production computed.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COMMAND_ID = "cmd-open-1";
const LEDGER_CLOCK = "STORE_COMMIT_CLOCK";
const WALL_CLOCK = "DAEMON_WALL_CLOCK";

/**
 * The first reading is the feed's, taken when the poll's answer lands; every later
 * reading is a render's. The 30 ms gap is therefore a span production observed between
 * two moments, not a number this test handed it — which is what the step-7 drill checks.
 */
function scriptedClock(): Clock {
  let calls = 0;
  return {
    now: (): number => {
      calls += 1;
      return calls === 1 ? 1_000 : 1_030;
    },
  };
}

function observation(clock: string, observer: string, value: string): unknown {
  return { clock, observer, reading: { known: true, value } };
}

function eventRow(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    aggregateId: "session/sess-1",
    committedAt: "2026-08-09T12:00:00.000Z",
    eventId: "evt-1",
    eventType: "SessionOpened",
    globalPosition: "3",
    identity: { commandId: COMMAND_ID, principal: { known: true, value: "operator-1" } },
    ledgerObservation: observation(LEDGER_CLOCK, "STORE_LEDGER", "2026-08-09T12:00:00.000Z"),
    seamObservation: observation(WALL_CLOCK, "DAEMON_SEAM", "2026-08-09T12:00:00.200Z"),
    ...overrides,
  };
}

/**
 * Answers the FIRST poll and leaves every later one pending, so the surface under
 * assertion is the one built from exactly one observed frame.
 */
function setupWith(row: unknown): LiveSetup {
  let answered = false;
  return {
    client: { commands: {} } as never,
    headers: Object.freeze({}),
    ok: true,
    projection: "moe.board",
    sessionCredential: "live-session",
    subscriberId: "control-room-1",
    transport: {
      readDocumentDossier: async () => ({
        code: "TRANSPORT_REQUEST_FAILED",
        delivered: false,
        layer: "CONTROL_ROOM_TRANSPORT",
      }),
      readEventPage: async () => {
        if (answered) return new Promise(() => undefined);
        answered = true;
        return {
          delivered: true,
          response: { checkpoint: "9", events: [row], hasMore: false, outcome: "PAGE" },
          status: 200,
        };
      },
      sendCommand: async () => ({
        code: "TRANSPORT_REQUEST_FAILED",
        delivered: false,
        layer: "CONTROL_ROOM_TRANSPORT",
      }),
    },
  } as unknown as LiveSetup;
}

function stubBoardFetch(): void {
  vi.stubGlobal("fetch", async () => new Response(
    JSON.stringify({ code: "AFFORDANCE_TEST_EMPTY", outcome: "REFUSED" }),
    { status: 200 },
  ));
}

/** Command id attributes the receipt; event id disambiguates one command's many events. */
function phaseId(name: string): string {
  return `${LIVE_TIMING_PREFIX}.${COMMAND_ID}.evt-1.phase.${name}`;
}

/** Drives the real application through one poll and returns when the receipt is painted. */
async function liveReceipt(row: unknown, clock: Clock | null = scriptedClock()): Promise<void> {
  stubBoardFetch();
  const surface = <LiveControlRoom setup={setupWith(row)} />;
  render(clock === null ? surface : <ClockProvider clock={clock}>{surface}</ClockProvider>);
  await waitFor(() => {
    expect(screen.getByTestId(phaseId("render"))).toBeTruthy();
  });
}

function phase(name: string): HTMLElement {
  return screen.getByTestId(phaseId(name));
}

describe("the live application renders a receipt it computed itself", () => {
  it("paints all four phases by name, with no total collapsing them", async () => {
    await liveReceipt(eventRow());
    for (const name of ["server", "stream", "render", "human"]) {
      expect(phase(name).textContent, name).toBe(name);
    }
    expect(screen.getAllByTestId(
      new RegExp(`^${LIVE_TIMING_PREFIX}\\.${COMMAND_ID}\\.evt-1\\.phase\\.`, "u"),
    )).toHaveLength(4);
  });

  /**
   * The measured span. The feed read the clock when the poll landed and this surface read
   * it again when it painted; production subtracted those two readings. No literal 30
   * was supplied anywhere — drill 1 in step 7 replaces the render reading with a literal
   * and this assertion is the one that goes red.
   */
  it("measures the render phase from readings production took, not from a literal", async () => {
    await liveReceipt(eventRow());
    expect(phase("render").dataset["durationMs"]).toBe("30");
    expect(phase("render").dataset["observedBy"]).toBe("CONTROL_ROOM");
    expect(phase("render").dataset["unknownCode"]).toBeUndefined();
  });

  it("carries the daemon's command identity through to the rendered receipt", async () => {
    await liveReceipt(eventRow());
    expect(screen.getByTestId(
      `${LIVE_TIMING_PREFIX}.${COMMAND_ID}.evt-1.${COMMAND_ID}`,
    ).dataset["state"]).toBe("CONFIRMED");
  });
});

/**
 * Every arm pins the EXACT code AND who produced it. At least three layers can refuse
 * here — the daemon seam, the bridge's parse, and this application's missing clock — so
 * an assertion that only said "unknown" would stay green the moment the wrong one
 * started answering first.
 */
describe("each refusal names its exact code and the layer that produced it", () => {
  it("surfaces a seam UNKNOWN as TIMING_UPSTREAM_UNKNOWN carrying the seam's own code", async () => {
    await liveReceipt(eventRow({
      seamObservation: {
        clock: WALL_CLOCK,
        observer: "DAEMON_SEAM",
        reading: {
          code: "EVENT_STREAM_READING_NOT_PROVIDED", known: false, layer: "SEAM",
        },
      },
    }));
    const stream = phase("stream");
    expect(stream.dataset["unknownCode"]).toBe("TIMING_UPSTREAM_UNKNOWN");
    expect(stream.dataset["upstreamCode"]).toBe("EVENT_STREAM_READING_NOT_PROVIDED");
    expect(stream.dataset["upstreamLayer"]).toBe("SEAM");
    // The control room owns the stream interval even when the daemon is why it failed.
    expect(stream.dataset["observedBy"]).toBe("CONTROL_ROOM");
    expect(stream.dataset["durationMs"]).toBeUndefined();
  });

  it("surfaces an unparseable daemon reading as TIMING_SOURCE_UNPARSEABLE", async () => {
    await liveReceipt(eventRow({
      seamObservation: observation(WALL_CLOCK, "DAEMON_SEAM", "not-a-timestamp"),
    }));
    expect(phase("server").dataset["unknownCode"]).toBe("TIMING_SOURCE_UNPARSEABLE");
    expect(phase("server").dataset["observedBy"]).toBe("DAEMON");
    // Nothing upstream refused: this layer failed to read what the daemon did send.
    expect(phase("server").dataset["upstreamCode"]).toBeUndefined();
    expect(phase("server").dataset["upstreamLayer"]).toBeUndefined();
  });

  it("surfaces an observation the frame never carried as TIMING_SOURCE_ABSENT", async () => {
    await liveReceipt(eventRow({ ledgerObservation: undefined }));
    const server = phase("server");
    expect(server.dataset["unknownCode"]).toBe("TIMING_SOURCE_ABSENT");
    expect(server.dataset["observedBy"]).toBe("DAEMON");
    // Absent is NOT the seam refusing; no upstream code may appear on this arm.
    expect(server.dataset["upstreamCode"]).toBeUndefined();
    expect(server.dataset["durationMs"]).toBeUndefined();
  });

  /**
   * Both readings are real and BOTH PARSE; the seam reading is 200 ms AFTER the ledger
   * reading, so the evaluator's `end < start` skew guard cannot fire. Only comparing the
   * declared clock identities refuses this, which is what drill 2 in step 7 proves.
   */
  it("surfaces a forward-skewed cross-clock pair as TIMING_CLOCK_MISMATCH", async () => {
    await liveReceipt(eventRow());
    expect(phase("server").dataset["unknownCode"]).toBe("TIMING_CLOCK_MISMATCH");
    expect(phase("server").dataset["observedBy"]).toBe("DAEMON");
    expect(phase("server").dataset["durationMs"]).toBeUndefined();
    expect(phase("stream").dataset["unknownCode"]).toBe("TIMING_CLOCK_MISMATCH");
    expect(phase("stream").dataset["observedBy"]).toBe("CONTROL_ROOM");
  });

  it("surfaces a live app with no clock as TIMING_CLOCK_UNAVAILABLE, never as zero", async () => {
    await liveReceipt(eventRow(), null);
    const rendered = phase("render");
    expect(rendered.dataset["unknownCode"]).toBe("TIMING_CLOCK_UNAVAILABLE");
    expect(rendered.dataset["durationMs"]).toBeUndefined();
    expect(rendered.dataset["observedBy"]).toBe("CONTROL_ROOM");
    expect(rendered.dataset["upstreamCode"]).toBeUndefined();
  });

  it("reports human as absent until an operator acts, never as a zero span", async () => {
    await liveReceipt(eventRow());
    expect(phase("human").dataset["unknownCode"]).toBe("TIMING_SOURCE_ABSENT");
    expect(phase("human").dataset["durationMs"]).toBeUndefined();
  });
});
