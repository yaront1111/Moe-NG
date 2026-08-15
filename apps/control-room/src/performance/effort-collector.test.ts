import { describe, expect, it } from "vitest";

import { createEffortCollector } from "./effort-collector.js";
import { UNATTRIBUTED } from "./effort-records.js";
import type { EffortCollector } from "./effort-collector.js";
import type { IntervalOutcome } from "./effort-intervals.js";
import type { IntervalKind } from "./effort-records.js";

/** Supplies input only; it reimplements no collector logic (project rail 1). */
function openInterval(
  intervalKind: IntervalKind,
  observedAt: number,
  commandId = "cmd-1",
): Readonly<Record<string, unknown>> {
  return {
    commandId,
    intervalKind,
    observedAt,
    source: "CONTROL_ROOM_DOM",
    type: "INTERVAL_OPEN",
  };
}

function closeInterval(
  intervalKind: IntervalKind,
  observedAt: number,
  commandId = "cmd-1",
): Readonly<Record<string, unknown>> {
  return {
    commandId,
    intervalKind,
    observedAt,
    source: "CONTROL_ROOM_DOM",
    type: "INTERVAL_CLOSE",
  };
}

function freeInteraction(
  observedAt: number,
  commandId = "cmd-1",
): Readonly<Record<string, unknown>> {
  return {
    commandId,
    interaction: "hovered the queue",
    observedAt,
    source: "CONTROL_ROOM_INPUT",
    type: "FREE_INTERACTION",
  };
}

function refusalFrom(
  collector: EffortCollector,
  value: unknown,
): { code: string; layer: string } {
  const answer = collector.record(value);
  if (answer.known) throw new Error(`expected a refusal, got ${answer.type}`);
  return { code: answer.code, layer: answer.layer };
}

function only(outcomes: readonly IntervalOutcome[]): IntervalOutcome {
  expect(outcomes).toHaveLength(1);
  const [first] = outcomes;
  if (first === undefined) throw new Error("expected exactly one interval outcome");
  return first;
}

describe("effort collector accumulation", () => {
  it("keeps admitted observations in the order they were observed", () => {
    const collector = createEffortCollector();
    collector.record(freeInteraction(1));
    collector.record(freeInteraction(2, "cmd-2"));
    expect(collector.observations().map((record) => record.observedAt)).toEqual([1, 2]);
    expect(collector.observations().map((record) => record.commandId)).toEqual([
      "cmd-1",
      "cmd-2",
    ]);
  });

  it("does not accumulate a payload the admission layer refused", () => {
    const collector = createEffortCollector();
    expect(refusalFrom(collector, { ...freeInteraction(1), source: undefined })).toEqual({
      code: "EFFORT_SOURCE_ABSENT",
      layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    });
    expect(collector.observations()).toHaveLength(0);
  });

  it("freezes every observation it hands back", () => {
    const collector = createEffortCollector();
    collector.record(freeInteraction(1));
    expect(collector.observations().every((record) => Object.isFrozen(record))).toBe(true);
    expect(Object.isFrozen(collector.observations())).toBe(true);
  });
});

describe("focus and away interval state machine", () => {
  it("records a closed interval as both observed stamps and never as a duration", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("FOCUS", 100));
    collector.record(closeInterval("FOCUS", 260));
    const outcome = only(collector.intervals());
    expect(outcome).toEqual({
      closedAt: 260,
      commandId: "cmd-1",
      kind: "FOCUS",
      openedAt: 100,
      source: "CONTROL_ROOM_DOM",
      state: "CLOSED",
    });
    expect(Object.hasOwn(outcome, "durationMs")).toBe(false);
  });

  it("tracks focus and away separately, so neither closes the other", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("FOCUS", 10));
    collector.record(openInterval("AWAY", 20));
    collector.record(closeInterval("AWAY", 30));
    const [focus, away] = collector.intervals();
    expect(focus?.state).toBe("OPEN");
    expect(focus?.kind).toBe("FOCUS");
    expect(away?.state).toBe("CLOSED");
    expect(away?.kind).toBe("AWAY");
  });

  it("reports a live unclosed interval as OPEN, carrying no end", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("FOCUS", 10));
    const outcome = only(collector.intervals());
    expect(outcome.state).toBe("OPEN");
    expect(Object.hasOwn(outcome, "closedAt")).toBe(false);
  });

  it("resolves an interval that was never closed to UNKNOWN when the set is sealed", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("FOCUS", 10));
    const outcome = only(collector.seal().intervals);
    expect(outcome).toEqual({
      commandId: "cmd-1",
      kind: "FOCUS",
      layer: "CONTROL_ROOM_EFFORT_COLLECTOR",
      openedAt: 10,
      reasonCode: "EFFORT_INTERVAL_UNTERMINATED",
      source: "CONTROL_ROOM_DOM",
      state: "UNTERMINATED",
    });
  });

  it("never closes an unterminated interval at read time", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("FOCUS", 10));
    collector.record(freeInteraction(400));
    const outcome = only(collector.seal().intervals);
    expect(Object.hasOwn(outcome, "closedAt")).toBe(false);
    expect(outcome.state).toBe("UNTERMINATED");
  });

  it("refuses a second open of the same kind instead of merging or auto-closing", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("FOCUS", 10));
    expect(refusalFrom(collector, openInterval("FOCUS", 20))).toEqual({
      code: "EFFORT_INTERVAL_OVERLAPPING",
      layer: "CONTROL_ROOM_EFFORT_COLLECTOR",
    });
    const outcome = only(collector.intervals());
    expect(outcome.state).toBe("OVERLAPPING");
    expect(Object.hasOwn(outcome, "closedAt")).toBe(false);
  });

  it("refuses a close of a kind that was never opened", () => {
    const collector = createEffortCollector();
    expect(refusalFrom(collector, closeInterval("AWAY", 30))).toEqual({
      code: "EFFORT_OBSERVATION_CONTRADICTORY",
      layer: "CONTROL_ROOM_EFFORT_COLLECTOR",
    });
    const outcome = only(collector.intervals());
    expect(outcome.state).toBe("CONTRADICTORY");
    expect(outcome.kind).toBe("AWAY");
  });

  it("refuses a close observed before its own open rather than reporting a negative", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("FOCUS", 90));
    expect(refusalFrom(collector, closeInterval("FOCUS", 40))).toEqual({
      code: "EFFORT_OBSERVATION_CONTRADICTORY",
      layer: "CONTROL_ROOM_EFFORT_COLLECTOR",
    });
    const outcome = only(collector.intervals());
    expect(outcome.state).toBe("CONTRADICTORY");
    expect(Object.hasOwn(outcome, "closedAt")).toBe(false);
  });

  it("admits a zero-length interval, which is an observation and not an absence", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("AWAY", 55));
    collector.record(closeInterval("AWAY", 55));
    const outcome = only(collector.intervals());
    expect(outcome.state).toBe("CLOSED");
    expect(outcome).toMatchObject({ closedAt: 55, openedAt: 55 });
  });

  it("does not reopen a kind whose intervals already contradicted each other", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("FOCUS", 10));
    collector.record(openInterval("FOCUS", 20));
    expect(refusalFrom(collector, closeInterval("FOCUS", 30)).code).toBe(
      "EFFORT_OBSERVATION_CONTRADICTORY",
    );
  });
});

describe("collector sealing", () => {
  it("reads no clock of its own, so the same observations resolve identically", () => {
    const build = (): EffortCollector => {
      const collector = createEffortCollector();
      collector.record(openInterval("FOCUS", 10));
      collector.record(closeInterval("FOCUS", 20));
      collector.record(openInterval("AWAY", 30));
      return collector;
    };
    expect(build().seal().intervals).toEqual(build().seal().intervals);
  });

  it("refuses an observation offered after the set was sealed", () => {
    const collector = createEffortCollector();
    collector.seal();
    expect(refusalFrom(collector, freeInteraction(1))).toEqual({
      code: "EFFORT_OBSERVATION_CONTRADICTORY",
      layer: "CONTROL_ROOM_EFFORT_COLLECTOR",
    });
    expect(collector.observations()).toHaveLength(0);
  });

  it("hands back a frozen sealed set", () => {
    const collector = createEffortCollector();
    collector.record(openInterval("AWAY", 5, UNATTRIBUTED));
    const sealed = collector.seal();
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.intervals)).toBe(true);
    expect(sealed.intervals[0]?.commandId).toBe("UNATTRIBUTED");
  });
});
