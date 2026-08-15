import { describe, expect, it } from "vitest";

import {
  TIMING_PHASE_NAMES,
  TIMING_PHASE_OBSERVERS,
  TIMING_UNKNOWN_CODES,
} from "./timing.js";
import type { TimingPhaseName, TimingUpstreamRefusal } from "./timing.js";
import {
  CONTROL_ROOM_CLOCK,
  READING_ABSENT,
  buildLiveTimingReceipt,
  readClientClock,
  readWireObservation,
} from "./wire-timing.js";
import type { LiveTimingInput, WireObservationRow } from "./wire-timing.js";

/**
 * The phase/outcome sweep: every timing split crossed with every outcome it can resolve
 * to, driven through the production receipt builder.
 *
 * Two failure modes this file is shaped against.
 *
 * A SWEEP THAT GENERATES NOTHING PASSES. The cardinalities below are hand-written
 * literals asserted before a single case is driven. A count derived from the table
 * cannot police the table — it would agree with any size, including zero.
 *
 * AN UNREACHABLE PAIR IS NOT A COVERED PAIR. Five of the twenty-eight pairs cannot be
 * produced by `buildLiveTimingReceipt` at all, and driving them would mean handing the
 * builder a reading no producer in this module can mint — a transcript, not a proof. So
 * they are listed as EXCLUSIONS with the structural reason, the union of driven and
 * excluded is asserted to be exactly the cross product, and each exclusion's premise is
 * pinned by its own assertion below. A premise left as prose goes false in silence.
 */

const MEASURED = "MEASURED";

type Outcome = typeof MEASURED | (typeof TIMING_UNKNOWN_CODES)[number];

const OUTCOMES: readonly Outcome[] = Object.freeze([MEASURED, ...TIMING_UNKNOWN_CODES]);

const STORE_CLOCK = "STORE_COMMIT_CLOCK";
const WALL_CLOCK = "DAEMON_WALL_CLOCK";
const SEAM_CODE = "EVENT_STREAM_READING_NOT_PROVIDED";

/**
 * The two wire readings are ISO strings the builder parses; the client readings are
 * numbers an injected clock returned. They must sit on one timeline for a measured arm
 * to mean anything, so the ISO/epoch twins are pinned rather than assumed.
 */
const LEDGER_ISO = "2026-08-09T12:00:00.000Z";
const SEAM_ISO = "2026-08-09T12:00:00.250Z";
const LEDGER_AT = 1_786_276_800_000;
const SEAM_AT = 1_786_276_800_250;
const EARLY_AT = 1_786_276_800_100;
const RECEIVED_AT = 1_786_276_800_400;
const RENDERED_AT = 1_786_276_800_430;
const ACTED_AT = 1_786_276_800_900;

/** Supplies input only; it reimplements no production logic (project rail 1). */
function clientAt(value: number) {
  return readClientClock({ now: () => value });
}

function wire(clock: string, value: string): WireObservationRow {
  return { clock, observer: "DAEMON_SEAM", reading: { known: true, value } };
}

function refusedWire(clock: string): WireObservationRow {
  return { clock, observer: "DAEMON_SEAM", reading: { code: SEAM_CODE, known: false, layer: "SEAM" } };
}

/** Production-shaped: two daemon clocks, two client readings taken 30ms apart. */
function inputWith(overrides: Partial<LiveTimingInput>): LiveTimingInput {
  return {
    acted: clientAt(ACTED_AT),
    ledger: wire(STORE_CLOCK, LEDGER_ISO),
    received: clientAt(RECEIVED_AT),
    rendered: clientAt(RENDERED_AT),
    seam: wire(WALL_CLOCK, SEAM_ISO),
    ...overrides,
  };
}

interface PhaseCase {
  readonly durationMs?: number;
  readonly input: LiveTimingInput;
  readonly outcome: Outcome;
  readonly phase: TimingPhaseName;
  readonly upstream?: TimingUpstreamRefusal;
}

const UPSTREAM: TimingUpstreamRefusal = { code: SEAM_CODE, layer: "SEAM" };

/** `server` runs ledger -> seam, so both ends are daemon wire readings. */
const SERVER_CASES: readonly PhaseCase[] = Object.freeze([
  {
    durationMs: 250,
    input: inputWith({ ledger: wire(WALL_CLOCK, LEDGER_ISO) }),
    outcome: MEASURED,
    phase: "server",
  },
  { input: inputWith({ ledger: null }), outcome: "TIMING_SOURCE_ABSENT", phase: "server" },
  {
    input: inputWith({ ledger: wire(WALL_CLOCK, "not-a-timestamp") }),
    outcome: "TIMING_SOURCE_UNPARSEABLE",
    phase: "server",
  },
  {
    input: inputWith({ ledger: refusedWire(WALL_CLOCK) }),
    outcome: "TIMING_UPSTREAM_UNKNOWN",
    phase: "server",
    upstream: UPSTREAM,
  },
  // Forward skew: the seam reading is 250ms AFTER the ledger reading, so `end < start` is
  // false and the negative-interval guard cannot be what refused. Only clock identity can.
  { input: inputWith({}), outcome: "TIMING_CLOCK_MISMATCH", phase: "server" },
  {
    input: inputWith({ ledger: wire(WALL_CLOCK, SEAM_ISO), seam: wire(WALL_CLOCK, LEDGER_ISO) }),
    outcome: "TIMING_NEGATIVE_INTERVAL",
    phase: "server",
  },
]);

/** `stream` runs seam -> received: one daemon wire reading, one client reading. */
const STREAM_CASES: readonly PhaseCase[] = Object.freeze([
  {
    durationMs: 150,
    input: inputWith({ seam: wire(CONTROL_ROOM_CLOCK, SEAM_ISO) }),
    outcome: MEASURED,
    phase: "stream",
  },
  { input: inputWith({ seam: null }), outcome: "TIMING_SOURCE_ABSENT", phase: "stream" },
  {
    input: inputWith({ seam: wire(WALL_CLOCK, "not-a-timestamp") }),
    outcome: "TIMING_SOURCE_UNPARSEABLE",
    phase: "stream",
  },
  {
    input: inputWith({ seam: refusedWire(WALL_CLOCK) }),
    outcome: "TIMING_UPSTREAM_UNKNOWN",
    phase: "stream",
    upstream: UPSTREAM,
  },
  { input: inputWith({}), outcome: "TIMING_CLOCK_MISMATCH", phase: "stream" },
  {
    input: inputWith({ received: clientAt(EARLY_AT), seam: wire(CONTROL_ROOM_CLOCK, SEAM_ISO) }),
    outcome: "TIMING_NEGATIVE_INTERVAL",
    phase: "stream",
  },
  {
    input: inputWith({ received: readClientClock(null) }),
    outcome: "TIMING_CLOCK_UNAVAILABLE",
    phase: "stream",
  },
]);

/** `render` runs received -> rendered; `human` runs rendered -> acted. Both client-only. */
const RENDER_CASES: readonly PhaseCase[] = Object.freeze([
  { durationMs: 30, input: inputWith({}), outcome: MEASURED, phase: "render" },
  { input: inputWith({ received: READING_ABSENT }), outcome: "TIMING_SOURCE_ABSENT", phase: "render" },
  {
    input: inputWith({ rendered: clientAt(Number.NaN) }),
    outcome: "TIMING_SOURCE_UNPARSEABLE",
    phase: "render",
  },
  {
    input: inputWith({ rendered: clientAt(EARLY_AT) }),
    outcome: "TIMING_NEGATIVE_INTERVAL",
    phase: "render",
  },
  {
    input: inputWith({ rendered: readClientClock(null) }),
    outcome: "TIMING_CLOCK_UNAVAILABLE",
    phase: "render",
  },
]);

const HUMAN_CASES: readonly PhaseCase[] = Object.freeze([
  { durationMs: 470, input: inputWith({}), outcome: MEASURED, phase: "human" },
  { input: inputWith({ acted: undefined }), outcome: "TIMING_SOURCE_ABSENT", phase: "human" },
  {
    input: inputWith({ acted: clientAt(Number.NaN) }),
    outcome: "TIMING_SOURCE_UNPARSEABLE",
    phase: "human",
  },
  {
    input: inputWith({ acted: clientAt(EARLY_AT) }),
    outcome: "TIMING_NEGATIVE_INTERVAL",
    phase: "human",
  },
  {
    input: inputWith({ acted: readClientClock(null) }),
    outcome: "TIMING_CLOCK_UNAVAILABLE",
    phase: "human",
  },
]);

const CASES: readonly PhaseCase[] = Object.freeze([
  ...SERVER_CASES, ...STREAM_CASES, ...RENDER_CASES, ...HUMAN_CASES,
]);

interface Exclusion {
  readonly outcome: Outcome;
  readonly phase: TimingPhaseName;
  readonly reason: string;
}

const EXCLUSIONS: readonly Exclusion[] = Object.freeze([
  {
    outcome: "TIMING_CLOCK_UNAVAILABLE",
    phase: "server",
    reason: "server pairs two wire readings; no injected client clock feeds it",
  },
  {
    outcome: "TIMING_CLOCK_MISMATCH",
    phase: "render",
    reason: "both ends come from readClientClock, which stamps one clock identity",
  },
  {
    outcome: "TIMING_UPSTREAM_UNKNOWN",
    phase: "render",
    reason: "a client reading carries no upstream refusal; only a wire reading can",
  },
  {
    outcome: "TIMING_CLOCK_MISMATCH",
    phase: "human",
    reason: "both ends come from readClientClock, which stamps one clock identity",
  },
  {
    outcome: "TIMING_UPSTREAM_UNKNOWN",
    phase: "human",
    reason: "a client reading carries no upstream refusal; only a wire reading can",
  },
]);

function keyOf(pair: { readonly outcome: Outcome; readonly phase: TimingPhaseName }): string {
  return `${pair.phase}|${pair.outcome}`;
}

describe("the phase/outcome table covers the cross product and is not empty", () => {
  it("has the hand-written cardinalities, so a table that shrank cannot pass", () => {
    expect(TIMING_PHASE_NAMES).toHaveLength(4);
    expect(OUTCOMES).toHaveLength(7);
    expect(CASES).toHaveLength(23);
    expect(EXCLUSIONS).toHaveLength(5);
    expect(CASES.length + EXCLUSIONS.length).toBe(28);
  });

  it("accounts for every phase crossed with every outcome exactly once", () => {
    const product = TIMING_PHASE_NAMES.flatMap((phase) =>
      OUTCOMES.map((outcome) => keyOf({ outcome, phase })));
    const accounted = [...CASES, ...EXCLUSIONS].map(keyOf);
    expect(product).toHaveLength(28);
    expect(new Set(accounted).size).toBe(accounted.length);
    expect(accounted.toSorted()).toEqual(product.toSorted());
  });

  /**
   * The wire arms carry ISO strings and the client arms carry epoch numbers, and a
   * measured `server` or `stream` only means something if both sit on ONE timeline. This
   * pins that: an edit to either constant that moved them apart would otherwise change
   * what every measured arm below is measuring while the sweep stayed green.
   */
  it("pins the ISO/epoch twins the measured arms are built from", () => {
    expect(Date.parse(LEDGER_ISO)).toBe(LEDGER_AT);
    expect(Date.parse(SEAM_ISO)).toBe(SEAM_AT);
    expect(SEAM_AT - LEDGER_AT).toBe(250);
    expect(RECEIVED_AT - SEAM_AT).toBe(150);
    expect(RENDERED_AT - RECEIVED_AT).toBe(30);
    expect(ACTED_AT - RENDERED_AT).toBe(470);
    expect(EARLY_AT).toBeLessThan(SEAM_AT);
  });

  it("drives every phase and every outcome at least once", () => {
    const drivenPhases = new Set(CASES.map((driven) => driven.phase));
    const drivenOutcomes = new Set(CASES.map((driven) => driven.outcome));
    expect([...drivenPhases].toSorted()).toEqual([...TIMING_PHASE_NAMES].toSorted());
    expect([...drivenOutcomes].toSorted()).toEqual([...OUTCOMES].toSorted());
  });
});

describe("each excluded pair's premise is asserted, not merely asserted to be true", () => {
  it("readClientClock stamps one clock identity, so two client readings never mismatch", () => {
    const first = readClientClock({ now: () => RECEIVED_AT });
    const second = readClientClock({ now: () => RENDERED_AT });
    expect(first.known ? first.clock : null).toBe(CONTROL_ROOM_CLOCK);
    expect(second.known ? second.clock : null).toBe(CONTROL_ROOM_CLOCK);
  });

  it("no readClientClock refusal carries an upstream refusal", () => {
    for (const refusal of [readClientClock(null), clientAt(Number.NaN)]) {
      expect(refusal.known).toBe(false);
      expect(refusal.known ? undefined : refusal.upstream).toBeUndefined();
    }
  });

  it("no readWireObservation arm answers TIMING_CLOCK_UNAVAILABLE", () => {
    const arms = [
      null, wire(WALL_CLOCK, SEAM_ISO), wire(WALL_CLOCK, "not-a-timestamp"), refusedWire(WALL_CLOCK),
    ];
    for (const arm of arms) {
      const reading = readWireObservation(arm);
      expect(reading.known ? null : reading.code).not.toBe("TIMING_CLOCK_UNAVAILABLE");
    }
  });
});

describe("every driven pair resolves to its exact code, observer and carrier", () => {
  it.each([...CASES])("$phase resolves $outcome", (driven: PhaseCase) => {
    const resolved = buildLiveTimingReceipt(driven.input)[driven.phase];
    expect(resolved.observedBy).toBe(TIMING_PHASE_OBSERVERS[driven.phase]);
    if (driven.outcome === MEASURED) {
      expect(resolved.known).toBe(true);
      expect(resolved.known ? resolved.durationMs : null).toBe(driven.durationMs);
      expect(Object.hasOwn(resolved, "reasonCode")).toBe(false);
      return;
    }
    expect(resolved.known).toBe(false);
    expect(resolved.known ? null : resolved.reasonCode).toBe(driven.outcome);
    // DoD 4: a refusal never carries a number, so it cannot be read as a zero span.
    expect(Object.hasOwn(resolved, "durationMs")).toBe(false);
    expect(resolved.known ? undefined : resolved.upstream).toEqual(driven.upstream);
  });
});
