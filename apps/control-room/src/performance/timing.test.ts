import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TIMING_PHASE_NAMES,
  describeTimingReceipt,
  evaluateTiming,
  measureElapsed,
} from "./timing.js";
import type { Clock, TimingInput, TimingPhaseName } from "./timing.js";

/**
 * DoD 1 is a NEGATIVE property over the module's source, so no amount of behaviour can
 * prove it: a green evaluator says nothing about whether the module reached for a real
 * clock on some path the tests did not drive. The scan below proves it structurally.
 *
 * The path resolves from `process.cwd()` — the Vitest root is this package — following
 * recovery-import-ban.test.ts, because `import.meta.url` is rewritten to an http URL
 * under the React plugin and a scan that silently reads nothing passes forever.
 */
const PERFORMANCE_DIR = resolve(process.cwd(), "src/performance");
const REAL_TIME_API = /Date\.now|performance\.now|new Date\(/u;

/**
 * DoD 1 binds every production module in this directory, not just this one, so the scan
 * enumerates the directory rather than naming a file. A new module added here is caught
 * by the same assertion instead of quietly escaping it.
 */
const PRODUCTION_MODULES = Object.freeze([
  ["timing.ts", "export function evaluateTiming("],
  ["command-latency.tsx", "export function CommandLatency("],
] as const);

/**
 * A test clock. It supplies input only — it reimplements no production logic, so the
 * assertions below still bear on the production surface (project rail 1).
 */
function testClock(startAt: number): Clock & { advance: (ms: number) => void } {
  let current = startAt;
  return {
    advance(ms: number): void {
      current += ms;
    },
    now(): number {
      return current;
    },
  };
}

const FOUR_PHASES: TimingInput = {
  human: { end: 4_040, start: 4_000 },
  render: { end: 3_030, start: 3_000 },
  server: { end: 1_010, start: 1_000 },
  stream: { end: 2_020, start: 2_000 },
};

describe("no module in this directory reads a real time API", () => {
  it("scans exactly the production modules present, so a new one cannot escape", () => {
    const present = readdirSync(PERFORMANCE_DIR)
      .filter((name) => !name.includes(".test."))
      .sort();
    expect(present).toEqual(PRODUCTION_MODULES.map(([name]) => name).toSorted());
  });

  it("contains no Date.now, performance.now, or new Date( in any of them", () => {
    for (const [name, anchor] of PRODUCTION_MODULES) {
      const source = readFileSync(join(PERFORMANCE_DIR, name), "utf8");
      expect(source.length, `${name} read empty`).toBeGreaterThan(400);
      expect(source, `${name} lost its anchor`).toContain(anchor);
      expect(REAL_TIME_API.test(source), `${name} reaches a real time API`).toBe(false);
    }
  });

  it("proves that scan actually bites rather than reporting a silent zero", () => {
    expect(REAL_TIME_API.test("const t = Date.now();")).toBe(true);
    expect(REAL_TIME_API.test("const t = performance.now();")).toBe(true);
    expect(REAL_TIME_API.test("const t = new Date();")).toBe(true);
  });
});

describe("measured elapsed fails closed with a named code", () => {
  it("refuses with TIMING_CLOCK_UNAVAILABLE when no clock was injected", () => {
    const phase = measureElapsed(1_000, undefined);
    expect(phase.known).toBe(false);
    expect(phase.known ? null : phase.reasonCode).toBe("TIMING_CLOCK_UNAVAILABLE");
  });

  it("refuses with TIMING_SOURCE_ABSENT when no start was supplied", () => {
    const phase = measureElapsed(undefined, testClock(5_000));
    expect(phase.known).toBe(false);
    expect(phase.known ? null : phase.reasonCode).toBe("TIMING_SOURCE_ABSENT");
  });

  it("refuses with TIMING_SOURCE_UNPARSEABLE for a non-finite start", () => {
    for (const start of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const phase = measureElapsed(start, testClock(5_000));
      expect(phase.known).toBe(false);
      expect(phase.known ? null : phase.reasonCode).toBe("TIMING_SOURCE_UNPARSEABLE");
    }
  });

  it("refuses with TIMING_NEGATIVE_INTERVAL when the clock reads before the start", () => {
    const phase = measureElapsed(9_000, testClock(5_000));
    expect(phase.known).toBe(false);
    expect(phase.known ? null : phase.reasonCode).toBe("TIMING_NEGATIVE_INTERVAL");
  });

  it("measures the advanced clock without waiting, and keeps zero a measurement", () => {
    const clock = testClock(1_000);
    const immediate = measureElapsed(1_000, clock);
    expect(immediate.known).toBe(true);
    expect(immediate.known ? immediate.durationMs : null).toBe(0);

    clock.advance(2_500);
    const later = measureElapsed(1_000, clock);
    expect(later.known ? later.durationMs : null).toBe(2_500);
  });
});

describe("the receipt separates four named phases", () => {
  it("names exactly server, stream, render and human", () => {
    expect([...TIMING_PHASE_NAMES]).toEqual(["server", "stream", "render", "human"]);
    const receipt = evaluateTiming(FOUR_PHASES);
    expect(Object.keys(receipt).sort()).toEqual(["human", "render", "server", "stream"]);
    expect(receipt.server.known ? receipt.server.durationMs : null).toBe(10);
    expect(receipt.stream.known ? receipt.stream.durationMs : null).toBe(20);
    expect(receipt.render.known ? receipt.render.durationMs : null).toBe(30);
    expect(receipt.human.known ? receipt.human.durationMs : null).toBe(40);
  });

  it("labels the control room's own observations as its own, never as daemon facts", () => {
    const receipt = evaluateTiming(FOUR_PHASES);
    expect(receipt.server.observedBy).toBe("DAEMON");
    expect(receipt.stream.observedBy).toBe("CONTROL_ROOM");
    expect(receipt.render.observedBy).toBe("CONTROL_ROOM");
    expect(receipt.human.observedBy).toBe("CONTROL_ROOM");
  });

  it("resolves each absent, unparseable, or skewed phase to its own stable code", () => {
    const receipt = evaluateTiming({
      human: { end: 40, start: 90 },
      render: { end: Number.NaN, start: 0 },
      server: {},
      stream: { start: 5 },
    });
    expect(receipt.server.known ? null : receipt.server.reasonCode).toBe("TIMING_SOURCE_ABSENT");
    expect(receipt.stream.known ? null : receipt.stream.reasonCode).toBe("TIMING_SOURCE_ABSENT");
    expect(receipt.render.known ? null : receipt.render.reasonCode)
      .toBe("TIMING_SOURCE_UNPARSEABLE");
    expect(receipt.human.known ? null : receipt.human.reasonCode)
      .toBe("TIMING_NEGATIVE_INTERVAL");
  });

  it("never contributes a computed duration for an unknown phase", () => {
    const receipt = evaluateTiming({});
    for (const name of TIMING_PHASE_NAMES) {
      const phase = receipt[name];
      expect(phase.known).toBe(false);
      expect(Object.hasOwn(phase, "durationMs")).toBe(false);
    }
  });
});

/**
 * DoD 2. If the record ever folded the phases into one total, collapsing any two of them
 * would leave that total unchanged and the description identical. Each of the six
 * unordered pairs is therefore built as a real input — b's interval folded into a, b left
 * absent — and compared against the four-phase description produced by the same
 * production function.
 */
function pairsOf(names: readonly TimingPhaseName[]): readonly (readonly [
  TimingPhaseName,
  TimingPhaseName,
])[] {
  const pairs: (readonly [TimingPhaseName, TimingPhaseName])[] = [];
  for (const [index, first] of names.entries()) {
    for (const second of names.slice(index + 1)) pairs.push([first, second] as const);
  }
  return pairs;
}

function collapse(a: TimingPhaseName, b: TimingPhaseName): TimingInput {
  const merged: Record<string, { end?: number | undefined; start?: number | undefined }> = {};
  for (const name of TIMING_PHASE_NAMES) {
    if (name === b) continue;
    const interval = FOUR_PHASES[name] ?? {};
    merged[name] = { ...interval };
  }
  // Fold b's measured span onto a, so the TOTAL is preserved and only the separation is
  // lost. A summary that reported only a total could not tell these apart.
  const folded = merged[a];
  const absorbed = FOUR_PHASES[b];
  if (folded !== undefined && absorbed?.end !== undefined && absorbed.start !== undefined) {
    folded.end = (folded.end ?? 0) + (absorbed.end - absorbed.start);
  }
  return merged as TimingInput;
}

describe("collapsing any two phases changes the rendered output", () => {
  const pairs = pairsOf(TIMING_PHASE_NAMES);

  it("generates exactly six unordered pairs, so a silent zero-case sweep cannot pass", () => {
    expect(pairs).toHaveLength(6);
  });

  it.each(pairs)("keeps %s distinct from %s", (a, b) => {
    const four = describeTimingReceipt(evaluateTiming(FOUR_PHASES));
    const collapsed = describeTimingReceipt(evaluateTiming(collapse(a, b)));
    expect(four).toHaveLength(4);
    expect(collapsed).not.toEqual(four);
  });

  it("describes every phase by name, so the description cannot be a bare total", () => {
    const described = describeTimingReceipt(evaluateTiming(FOUR_PHASES));
    expect(described.map((line) => line.phase)).toEqual([...TIMING_PHASE_NAMES]);
  });
});
