import { describe, expect, it } from "vitest";

import {
  CONTROL_ROOM_CLOCK,
  READING_ABSENT,
  buildLiveTimingReceipt,
  readClientClock,
  readWireObservation,
  shapeWireObservation,
} from "./wire-timing.js";
import type { WireObservationRow } from "./wire-timing.js";
import type { Clock, SurfaceTimingReceipt, TimingPhaseName } from "./timing.js";

/** Supplies input only; it reimplements no production logic (project rail 1). */
function fixedClock(at: number): Clock {
  return { now: () => at };
}

function wire(clock: string, value: string): WireObservationRow {
  return { clock, observer: "DAEMON_SEAM", reading: { known: true, value } };
}

function refusedWire(clock: string, code: string): WireObservationRow {
  return { clock, observer: "DAEMON_SEAM", reading: { code, known: false, layer: "SEAM" } };
}

const LEDGER_CLOCK = "STORE_COMMIT_CLOCK";
const WALL_CLOCK = "DAEMON_WALL_CLOCK";

function codeOf(receipt: SurfaceTimingReceipt, phase: TimingPhaseName): string | null {
  const resolved = receipt[phase];
  return resolved.known ? null : resolved.reasonCode;
}

function durationOf(receipt: SurfaceTimingReceipt, phase: TimingPhaseName): number | null {
  const resolved = receipt[phase];
  return resolved.known ? resolved.durationMs : null;
}

function upstreamOf(
  receipt: SurfaceTimingReceipt, phase: TimingPhaseName,
): { code: string; layer: string } | undefined {
  const resolved = receipt[phase];
  return resolved.known ? undefined : resolved.upstream;
}

describe("a reading the seam refused never becomes a number", () => {
  it("yields TIMING_UPSTREAM_UNKNOWN carrying the seam's own code and layer", () => {
    const reading = readWireObservation(
      refusedWire(WALL_CLOCK, "EVENT_STREAM_READING_NOT_PROVIDED"),
    );
    expect(reading.known).toBe(false);
    expect(reading.known ? null : reading.code).toBe("TIMING_UPSTREAM_UNKNOWN");
    expect(reading.known ? null : reading.upstream).toEqual({
      code: "EVENT_STREAM_READING_NOT_PROVIDED", layer: "SEAM",
    });
  });

  /**
   * The distinction this asserts is the whole reason the code exists: "the daemon states
   * it has no reading" and "we never received a reading" are different facts owned by
   * different layers. Collapsing them would blame the control room for the seam's gap.
   */
  it("is NOT TIMING_SOURCE_ABSENT, which means something the seam did not say", () => {
    const refused = readWireObservation(refusedWire(WALL_CLOCK, "EVENT_STREAM_READING_NOT_PROVIDED"));
    const missing = readWireObservation(null);
    expect(refused.known ? null : refused.code).not.toBe(missing.known ? null : missing.code);
    expect(missing.known ? null : missing.code).toBe("TIMING_SOURCE_ABSENT");
    expect(missing.known ? null : missing.upstream).toBeUndefined();
  });
});

describe("a known reading is parsed explicitly, never left to flow on as NaN", () => {
  it("parses an ISO reading to a finite number on the observation's declared clock", () => {
    const reading = readWireObservation(wire(WALL_CLOCK, "2026-08-09T12:00:00.000Z"));
    expect(reading.known).toBe(true);
    expect(reading.known ? reading.clock : null).toBe(WALL_CLOCK);
    expect(reading.known ? Number.isFinite(reading.value) : false).toBe(true);
  });

  it("refuses an unparseable reading with TIMING_SOURCE_UNPARSEABLE", () => {
    for (const value of ["", "not-a-timestamp", "2026-13-45T99:99:99Z"]) {
      const reading = readWireObservation(wire(WALL_CLOCK, value));
      expect(reading.known, `${value} parsed`).toBe(false);
      expect(reading.known ? null : reading.code).toBe("TIMING_SOURCE_UNPARSEABLE");
    }
  });
});

describe("two readings on different clocks are never subtracted", () => {
  /**
   * THE LOAD-BEARING CASE. The skew here runs FORWARD: the seam reading is five seconds
   * after the ledger reading, so `end < start` is false and the evaluator's negative
   * interval guard would never fire. Subtracting anyway would publish a confident
   * "5000 ms" that is a real interval plus an unknown offset between two machines'
   * clocks. Only comparing the declared clock identities catches this direction.
   */
  it("refuses a forward-skewed cross-clock pair, which the skew guard cannot catch", () => {
    const receipt = buildLiveTimingReceipt({
      ledger: wire(LEDGER_CLOCK, "2026-08-09T12:00:00.000Z"),
      received: readClientClock(fixedClock(1_000)),
      rendered: readClientClock(fixedClock(1_030)),
      seam: wire(WALL_CLOCK, "2026-08-09T12:00:05.000Z"),
    });
    expect(codeOf(receipt, "server")).toBe("TIMING_CLOCK_MISMATCH");
    expect(durationOf(receipt, "server")).toBeNull();
    expect(Object.hasOwn(receipt.server, "durationMs")).toBe(false);
  });

  it("refuses the backward-skewed direction with the same code, not as an interval", () => {
    const receipt = buildLiveTimingReceipt({
      ledger: wire(LEDGER_CLOCK, "2026-08-09T12:00:05.000Z"),
      received: READING_ABSENT,
      rendered: READING_ABSENT,
      seam: wire(WALL_CLOCK, "2026-08-09T12:00:00.000Z"),
    });
    expect(codeOf(receipt, "server")).toBe("TIMING_CLOCK_MISMATCH");
  });

  it("refuses the daemon-to-client stream phase, which spans two machines' clocks", () => {
    const receipt = buildLiveTimingReceipt({
      ledger: wire(LEDGER_CLOCK, "2026-08-09T12:00:00.000Z"),
      received: readClientClock(fixedClock(1_000)),
      rendered: readClientClock(fixedClock(1_030)),
      seam: wire(WALL_CLOCK, "2026-08-09T12:00:01.000Z"),
    });
    expect(codeOf(receipt, "stream")).toBe("TIMING_CLOCK_MISMATCH");
  });

  it("measures a pair whose two readings declare the SAME clock", () => {
    const receipt = buildLiveTimingReceipt({
      ledger: null,
      received: readClientClock(fixedClock(1_000)),
      rendered: readClientClock(fixedClock(1_030)),
      seam: null,
    });
    expect(codeOf(receipt, "render")).toBeNull();
    expect(durationOf(receipt, "render")).toBe(30);
    expect(readClientClock(fixedClock(1_000)).known
      ? CONTROL_ROOM_CLOCK : null).toBe(CONTROL_ROOM_CLOCK);
  });
});

describe("a missing clock is a measurable fact, never a zero", () => {
  it("reads TIMING_CLOCK_UNAVAILABLE with no clock, rather than reporting no time passed", () => {
    const reading = readClientClock(null);
    expect(reading.known).toBe(false);
    expect(reading.known ? null : reading.code).toBe("TIMING_CLOCK_UNAVAILABLE");

    const receipt = buildLiveTimingReceipt({
      ledger: null, received: readClientClock(undefined),
      rendered: readClientClock(undefined), seam: null,
    });
    expect(codeOf(receipt, "render")).toBe("TIMING_CLOCK_UNAVAILABLE");
    expect(durationOf(receipt, "render")).toBeNull();
  });

  it("refuses a non-finite clock reading rather than treating it as a timestamp", () => {
    const reading = readClientClock({ now: () => Number.NaN });
    expect(reading.known ? null : reading.code).toBe("TIMING_SOURCE_UNPARSEABLE");
  });
});

describe("every phase's refusal is attributed to that phase's own observer", () => {
  it("keeps a seam-caused stream refusal labelled CONTROL_ROOM while carrying SEAM", () => {
    const receipt = buildLiveTimingReceipt({
      ledger: refusedWire(LEDGER_CLOCK, "EVENT_STREAM_READING_NOT_PROVIDED"),
      received: readClientClock(fixedClock(1_000)),
      rendered: readClientClock(fixedClock(1_030)),
      seam: refusedWire(WALL_CLOCK, "EVENT_STREAM_READING_NOT_PROVIDED"),
    });
    // The daemon owns `server`; the control room owns `stream` even though the daemon's
    // refusal is what made it unmeasurable. The upstream carrier is what says who refused.
    expect(receipt.server.observedBy).toBe("DAEMON");
    expect(receipt.stream.observedBy).toBe("CONTROL_ROOM");
    expect(codeOf(receipt, "stream")).toBe("TIMING_UPSTREAM_UNKNOWN");
    expect(upstreamOf(receipt, "stream")).toEqual({
      code: "EVENT_STREAM_READING_NOT_PROVIDED", layer: "SEAM",
    });
  });

  it("reports human as absent until an operator action is observed, never as zero", () => {
    const receipt = buildLiveTimingReceipt({
      ledger: null, received: readClientClock(fixedClock(1_000)),
      rendered: readClientClock(fixedClock(1_030)), seam: null,
    });
    expect(codeOf(receipt, "human")).toBe("TIMING_SOURCE_ABSENT");
    expect(receipt.human.observedBy).toBe("CONTROL_ROOM");
    expect(Object.hasOwn(receipt.human, "durationMs")).toBe(false);

    const acted = buildLiveTimingReceipt({
      acted: readClientClock(fixedClock(1_500)), ledger: null,
      received: readClientClock(fixedClock(1_000)),
      rendered: readClientClock(fixedClock(1_030)), seam: null,
    });
    expect(durationOf(acted, "human")).toBe(470);
  });
});

describe("the wire shape is parsed structurally, inventing nothing", () => {
  it("shapes a known observation and a refused observation verbatim", () => {
    expect(shapeWireObservation({
      clock: WALL_CLOCK, observer: "DAEMON_SEAM",
      reading: { known: true, value: "2026-08-09T12:00:00.000Z" },
    })).toEqual(wire(WALL_CLOCK, "2026-08-09T12:00:00.000Z"));

    expect(shapeWireObservation({
      clock: WALL_CLOCK, observer: "DAEMON_SEAM",
      reading: { code: "EVENT_STREAM_READING_NOT_PROVIDED", known: false, layer: "SEAM" },
    })).toEqual(refusedWire(WALL_CLOCK, "EVENT_STREAM_READING_NOT_PROVIDED"));
  });

  it("returns null for anything that is not an observation, defaulting no field", () => {
    for (const value of [null, undefined, 7, "reading", {}, { clock: WALL_CLOCK },
      { clock: WALL_CLOCK, observer: "DAEMON_SEAM" },
      { clock: WALL_CLOCK, observer: "DAEMON_SEAM", reading: {} },
      { clock: "", observer: "DAEMON_SEAM", reading: { known: true, value: "x" } }]) {
      expect(shapeWireObservation(value), JSON.stringify(value) ?? "undefined").toBeNull();
    }
  });
});
