import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createEffortCollector } from "./effort-collector.js";
import type { EffortCollector } from "./effort-collector.js";

/**
 * The non-inference rail, pinned one forbidden derivation at a time.
 *
 * Every derivation below is individually plausible as a feature and individually fatal:
 * each one replaces something a human was OBSERVED doing with something this module
 * decided probably happened, and the record set stops being evidence the moment one of
 * them lands. Each test asserts the derived record is NOT produced.
 */

const PERFORMANCE_DIR = resolve(process.cwd(), "src/performance");

const EFFORT_MODULES = Object.freeze([
  ["effort-records.ts", "export function effortRefusal("],
  ["effort-admission.ts", "export function shapeEffortObservation("],
  ["effort-intervals.ts", "export function createIntervalMachine("],
  ["effort-collector.ts", "export function createEffortCollector("],
] as const);

/** A verdict, a score, a threshold, or an acceptability judgement. None belongs here. */
const AUTHORITY_WORDS =
  /\b(?:score|verdict|threshold|acceptab|benchmark|budget|grade|rating|passes|fails)\w*/iu;

function sourceOf(name: string): string {
  const source = readFileSync(join(PERFORMANCE_DIR, name), "utf8");
  expect(source.length, `${name} read empty`).toBeGreaterThan(400);
  return source;
}

/**
 * The ban is on CODE reaching for authority, not on prose naming the ban — the headers in
 * these modules say the words in order to forbid them. Comments are stripped first, and
 * the caller asserts the stripped set is non-empty, because a stripper that removed
 * everything would report a clean scan of nothing.
 */
function codeLinesOf(source: string): readonly string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("//"));
}

function focusOpen(observedAt: number): Readonly<Record<string, unknown>> {
  return {
    commandId: "cmd-1",
    intervalKind: "FOCUS",
    observedAt,
    source: "CONTROL_ROOM_DOM",
    type: "INTERVAL_OPEN",
  };
}

function focusClose(observedAt: number): Readonly<Record<string, unknown>> {
  return {
    commandId: "cmd-1",
    intervalKind: "FOCUS",
    observedAt,
    source: "CONTROL_ROOM_DOM",
    type: "INTERVAL_CLOSE",
  };
}

function recovery(observedAt: number, burden: string): Readonly<Record<string, unknown>> {
  return {
    action: "retried",
    burden,
    commandId: "cmd-1",
    observedAt,
    source: "OPERATOR_REPORT",
    type: "RECOVERY_ACTION",
  };
}

function twoAdjacentFocusIntervals(): EffortCollector {
  const collector = createEffortCollector();
  collector.record(focusOpen(10));
  collector.record(focusClose(20));
  collector.record(focusOpen(80));
  collector.record(focusClose(90));
  return collector;
}

describe("no observation is inferred from another", () => {
  it("does not turn a free interaction into a demanded decision", () => {
    const collector = createEffortCollector();
    collector.record({
      commandId: "cmd-1",
      interaction: "clicked around the plan",
      observedAt: 3,
      source: "CONTROL_ROOM_INPUT",
      type: "FREE_INTERACTION",
    });
    expect(collector.decisions()).toEqual([]);
    expect(collector.seal().decisions).toEqual([]);
  });

  it("does not produce an away interval from the absence of a focus interval", () => {
    // A sixty-tick gap between two focus intervals. Nobody observed an away interval in
    // it, so there is no away interval — an absence is not an observation.
    const sealed = twoAdjacentFocusIntervals().seal();
    expect(sealed.intervals.map((outcome) => outcome.kind)).toEqual(["FOCUS", "FOCUS"]);
    expect(sealed.intervals.some((outcome) => outcome.kind === "AWAY")).toBe(false);
  });

  it("does not produce an away interval while a focus interval is merely unclosed", () => {
    const collector = createEffortCollector();
    collector.record(focusOpen(10));
    const sealed = collector.seal();
    expect(sealed.intervals).toHaveLength(1);
    expect(sealed.intervals[0]?.kind).toBe("FOCUS");
    expect(sealed.intervals[0]?.state).toBe("UNTERMINATED");
  });

  it("does not synthesise an attention switch from two adjacent focus intervals", () => {
    const sealed = twoAdjacentFocusIntervals().seal();
    const types = sealed.observations.map((record) => record.type);
    expect(types).toEqual([
      "INTERVAL_OPEN",
      "INTERVAL_CLOSE",
      "INTERVAL_OPEN",
      "INTERVAL_CLOSE",
    ]);
    expect(types).not.toContain("ATTENTION_SWITCH");
  });

  it("does not compute a recovery burden from a count of recovery actions", () => {
    const collector = createEffortCollector();
    collector.record(recovery(1, "RETRY_SAME_COMMAND"));
    collector.record(recovery(2, "RETRY_SAME_COMMAND"));
    collector.record(recovery(3, "RETRY_SAME_COMMAND"));
    const sealed = collector.seal();
    // Three observed burdens, each still the one that was observed. No aggregate exists,
    // and none was escalated because three of them arrived.
    for (const record of sealed.observations) {
      expect(record.type === "RECOVERY_ACTION" ? record.burden : null).toBe(
        "RETRY_SAME_COMMAND",
      );
    }
    expect(Object.keys(sealed).toSorted()).toEqual([
      "decisions",
      "intervals",
      "observations",
    ]);
  });

  it("does not infer a demanded decision from an affordance that was only rendered", () => {
    const collector = createEffortCollector();
    collector.record({
      commandId: "cmd-1",
      evidence: "an approve button was painted and never pressed",
      observedAt: 6,
      source: "CONTROL_ROOM_DOM",
      surface: "plan review",
      type: "SCROLL_FOCUS_EVIDENCE",
    });
    expect(collector.decisions()).toEqual([]);
    expect(collector.observations()).toHaveLength(1);
  });

  it("does not derive a decision from an interval, or an interval from a decision", () => {
    const collector = createEffortCollector();
    collector.record({
      commandId: "cmd-1",
      demandedKind: "APPROVE",
      observedAt: 4,
      source: "CONTROL_ROOM_DOM",
      type: "DEMANDED_DECISION",
    });
    expect(collector.intervals()).toEqual([]);
    collector.record(focusOpen(5));
    expect(collector.decisions()).toHaveLength(1);
  });
});

describe("the effort domain is observational only", () => {
  it("carries no verdict, score, threshold or acceptability field on any record", () => {
    const collector = twoAdjacentFocusIntervals();
    collector.record(recovery(95, "UNRECOVERED"));
    const sealed = collector.seal();
    const keys = [
      ...sealed.observations.flatMap((record) => Object.keys(record)),
      ...sealed.intervals.flatMap((outcome) => Object.keys(outcome)),
      ...sealed.decisions.flatMap((decision) => Object.keys(decision)),
    ];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(AUTHORITY_WORDS.test(key), `${key} grants authority`).toBe(false);
    }
  });

  it("reads no benchmark constant and states no acceptable effort in its source", () => {
    for (const [name, anchor] of EFFORT_MODULES) {
      const source = sourceOf(name);
      expect(source, `${name} lost its anchor`).toContain(anchor);
      const code = codeLinesOf(source);
      expect(code.length, `${name} stripped to nothing`).toBeGreaterThan(30);
      expect(code.some((line) => line.includes(anchor)), `${name} lost its anchor`).toBe(
        true,
      );
      const offending = code.filter((line) => AUTHORITY_WORDS.test(line));
      expect(offending, `${name} reaches for authority`).toEqual([]);
    }
  });

  it("proves that source scan bites rather than reporting a silent zero", () => {
    expect(AUTHORITY_WORDS.test("const score = 4;")).toBe(true);
    expect(AUTHORITY_WORDS.test("if (elapsed > THRESHOLD_MS) {")).toBe(true);
    expect(AUTHORITY_WORDS.test("import { BENCHMARK_BUDGET } from './x.js';")).toBe(true);
    expect(AUTHORITY_WORDS.test("const commandId = record.commandId;")).toBe(false);
    // The stripper must remove prose without removing code, or the scan reads clean while
    // seeing nothing at all.
    const stripped = codeLinesOf("/** a score */\nconst kept = 1;\n// a verdict\n");
    expect(stripped).toEqual(["const kept = 1;"]);
  });
});
