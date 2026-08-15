import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LIVE_TIMING_PREFIX, LiveCommandTiming } from "./live-command-timing.js";
import type { LiveEventRow, LiveFrame } from "./live-event-feed.js";
import { ClockProvider } from "../performance/command-latency.js";
import { readClientClock } from "../performance/wire-timing.js";
import type { Clock } from "../performance/timing.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const COMMAND_ID = "cmd-open-1";

function fixedClock(at: number): Clock {
  return { now: () => at };
}

function row(overrides: Partial<LiveEventRow> = {}): LiveEventRow {
  return {
    aggregateId: "session/sess-1",
    committedAt: "2026-08-09T12:00:00.000Z",
    eventId: "evt-1",
    eventType: "SessionOpened",
    identity: { commandId: COMMAND_ID, principal: null, run: null, session: null },
    ledgerObservation: {
      clock: "STORE_COMMIT_CLOCK", observer: "STORE_LEDGER",
      reading: { known: true, value: "2026-08-09T12:00:00.000Z" },
    },
    position: "3",
    seamObservation: {
      clock: "DAEMON_WALL_CLOCK", observer: "DAEMON_SEAM",
      reading: { known: true, value: "2026-08-09T12:00:00.200Z" },
    },
    ...overrides,
  };
}

function frameOf(events: readonly LiveEventRow[], receivedAtMs: number | null): LiveFrame {
  return {
    checkpoint: "9",
    connection: "CONNECTED",
    detail: "",
    events,
    outcome: "PAGE",
    receivedAt: readClientClock(receivedAtMs === null ? null : fixedClock(receivedAtMs)),
  };
}

function phase(commandId: string, name: string, eventId = "evt-1"): HTMLElement {
  return screen.getByTestId(`${LIVE_TIMING_PREFIX}.${commandId}.${eventId}.phase.${name}`);
}

describe("the live surface computes a receipt from what it observed", () => {
  it("renders all four phases, keeping them separate and never summed", () => {
    render(
      <ClockProvider clock={fixedClock(1_030)}>
        <LiveCommandTiming frame={frameOf([row()], 1_000)} />
      </ClockProvider>,
    );
    for (const name of ["server", "stream", "render", "human"]) {
      expect(phase(COMMAND_ID, name)).toBeTruthy();
    }
    expect(screen.getAllByTestId(
      new RegExp(`^${LIVE_TIMING_PREFIX}\\.${COMMAND_ID}\\.evt-1\\.phase\\.`, "u"),
    )).toHaveLength(4);
  });

  /**
   * The measured value is 30 because the feed observed arrival at 1_000 and this render
   * observed the clock at 1_030. Neither number was handed to the component as a
   * duration; both are readings it took or was given as readings.
   */
  it("measures the render phase from the observed arrival and render readings", () => {
    render(
      <ClockProvider clock={fixedClock(1_030)}>
        <LiveCommandTiming frame={frameOf([row()], 1_000)} />
      </ClockProvider>,
    );
    const render30 = phase(COMMAND_ID, "render");
    expect(render30.dataset["durationMs"]).toBe("30");
    expect(render30.dataset["observedBy"]).toBe("CONTROL_ROOM");
    expect(render30.dataset["unknownCode"]).toBeUndefined();
  });

  it("attributes the receipt to the row's own command identity", () => {
    render(
      <ClockProvider clock={fixedClock(1_030)}>
        <LiveCommandTiming frame={frameOf([
          row(), row({ eventId: "evt-2", identity: { commandId: "cmd-open-2", principal: null,
            run: null, session: null } }),
        ], 1_000)} />
      </ClockProvider>,
    );
    expect(phase(COMMAND_ID, "render").dataset["durationMs"]).toBe("30");
    expect(phase("cmd-open-2", "render", "evt-2").dataset["durationMs"]).toBe("30");
  });

  /**
   * ONE COMMAND EMITS MANY EVENTS, so the command id alone cannot address a receipt.
   * Two rows of one command paint two receipts built from two different sets of
   * readings; under a command-only identifier they would share one `data-testid` and
   * the DOM would hold two receipts nobody could tell apart — and `getByTestId` throws
   * on the collision, so the next test to look would break rather than report it. The
   * event id disambiguates; the command id still says which command each belongs to.
   */
  it("addresses each event's receipt separately when one command emitted several", () => {
    render(
      <ClockProvider clock={fixedClock(1_030)}>
        <LiveCommandTiming frame={frameOf([row(), row({ eventId: "evt-2" })], 1_000)} />
      </ClockProvider>,
    );
    expect(screen.getAllByTestId(
      new RegExp(`^${LIVE_TIMING_PREFIX}\\.${COMMAND_ID}\\..+\\.phase\\.render$`, "u"),
    )).toHaveLength(2);
    expect(phase(COMMAND_ID, "render").dataset["durationMs"]).toBe("30");
    expect(phase(COMMAND_ID, "render", "evt-2").dataset["durationMs"]).toBe("30");
  });

  it("renders no receipt for a row the daemon sent without a command identity", () => {
    render(
      <ClockProvider clock={fixedClock(1_030)}>
        <LiveCommandTiming frame={frameOf([row({ identity: null })], 1_000)} />
      </ClockProvider>,
    );
    expect(screen.queryByTestId(`${LIVE_TIMING_PREFIX}.receipts`)).toBeNull();
  });

  it("still renders with no clock, showing TIMING_CLOCK_UNAVAILABLE and no zero", () => {
    render(<LiveCommandTiming frame={frameOf([row()], null)} />);
    const rendered = phase(COMMAND_ID, "render");
    expect(rendered.dataset["unknownCode"]).toBe("TIMING_CLOCK_UNAVAILABLE");
    expect(rendered.dataset["durationMs"]).toBeUndefined();
    expect(rendered.dataset["observedBy"]).toBe("CONTROL_ROOM");
  });
});
