import { describe, expect, it } from "vitest";

import { shapeEffortObservation } from "./effort-admission.js";
import { createEffortCollector } from "./effort-collector.js";
import {
  DECISION_KINDS,
  EFFORT_LAYERS,
  EFFORT_RECORD_TYPES,
  EFFORT_SOURCES,
  EFFORT_UNKNOWN_CODES,
  INTERVAL_KINDS,
  INTERVAL_STATES,
  RECOVERY_BURDENS,
} from "./effort-records.js";
import type { EffortCollector } from "./effort-collector.js";
import type { BaselineDecisionKind, EffortSource, IntervalKind } from "./effort-records.js";

/**
 * The generated half of DoD 5.
 *
 * Every table below asserts its own EXACT length against a hand-written literal before
 * anything iterates it. A sweep that silently generates zero cases passes while testing
 * nothing, and a count computed from the generator cannot police the generator. Each
 * table then asserts it visited every member of its frozen vocabulary BY NAME, so a
 * member added later without a case fails the comparison instead of being skipped in
 * silence. Every refusal assertion pins the exact code AND the refusing layer.
 */

interface Refused {
  readonly code: string;
  readonly layer: string;
}

function observation(
  over: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    commandId: "cmd-1",
    interaction: "read the queue",
    observedAt: 1,
    source: "CONTROL_ROOM_INPUT",
    type: "FREE_INTERACTION",
    ...over,
  };
}

function demand(
  demandedKind: BaselineDecisionKind,
  observedAt: number,
  commandId: string,
): Readonly<Record<string, unknown>> {
  return {
    commandId,
    demandedKind,
    observedAt,
    source: "CONTROL_ROOM_DOM",
    type: "DEMANDED_DECISION",
  };
}

function interval(
  type: "INTERVAL_CLOSE" | "INTERVAL_OPEN",
  intervalKind: IntervalKind,
  observedAt: number,
): Readonly<Record<string, unknown>> {
  return {
    commandId: "cmd-1",
    intervalKind,
    observedAt,
    source: "CONTROL_ROOM_DOM",
    type,
  };
}

function refusedBy(collector: EffortCollector, value: unknown): Refused {
  const answer = collector.record(value);
  if (answer.known) throw new Error(`expected a refusal, got ${answer.type}`);
  return { code: answer.code, layer: answer.layer };
}

function refusedByAdmission(value: unknown): Refused {
  const answer = shapeEffortObservation(value);
  if (answer.known) throw new Error(`expected a refusal, got ${answer.type}`);
  return { code: answer.code, layer: answer.layer };
}

/** Every demanded-decision kind, including the derived additional arm. */
const DECISION_CASES = Object.freeze([
  { at: 0, demands: [["CREATE", "cmd-a"]], expected: "CREATE" },
  { at: 0, demands: [["APPROVE", "cmd-b"]], expected: "APPROVE" },
  { at: 0, demands: [["ACCEPT", "cmd-c"]], expected: "ACCEPT" },
  {
    at: 1,
    demands: [
      ["CREATE", "cmd-d"],
      ["APPROVE", "cmd-d"],
    ],
    expected: "ADDITIONAL",
  },
] as const);

/** Every interval state the vocabulary declares. */
const INTERVAL_CASES = Object.freeze([
  {
    expectedCode: null,
    run: (collector: EffortCollector): void => {
      collector.record(interval("INTERVAL_OPEN", "FOCUS", 10));
      collector.record(interval("INTERVAL_CLOSE", "FOCUS", 20));
    },
    seal: false,
    state: "CLOSED",
  },
  {
    expectedCode: null,
    run: (collector: EffortCollector): void => {
      collector.record(interval("INTERVAL_OPEN", "AWAY", 10));
    },
    seal: false,
    state: "OPEN",
  },
  {
    expectedCode: "EFFORT_INTERVAL_UNTERMINATED",
    run: (collector: EffortCollector): void => {
      collector.record(interval("INTERVAL_OPEN", "FOCUS", 10));
    },
    seal: true,
    state: "UNTERMINATED",
  },
  {
    expectedCode: "EFFORT_INTERVAL_OVERLAPPING",
    run: (collector: EffortCollector): void => {
      collector.record(interval("INTERVAL_OPEN", "FOCUS", 10));
      expect(refusedBy(collector, interval("INTERVAL_OPEN", "FOCUS", 20))).toEqual({
        code: "EFFORT_INTERVAL_OVERLAPPING",
        layer: "CONTROL_ROOM_EFFORT_COLLECTOR",
      });
    },
    seal: false,
    state: "OVERLAPPING",
  },
  {
    expectedCode: "EFFORT_OBSERVATION_CONTRADICTORY",
    run: (collector: EffortCollector): void => {
      expect(refusedBy(collector, interval("INTERVAL_CLOSE", "AWAY", 30))).toEqual({
        code: "EFFORT_OBSERVATION_CONTRADICTORY",
        layer: "CONTROL_ROOM_EFFORT_COLLECTOR",
      });
    },
    seal: false,
    state: "CONTRADICTORY",
  },
] as const);

/** One case per stable reason code, each naming the layer that answers it. */
const REFUSAL_CASES = Object.freeze([
  {
    code: "EFFORT_COMMAND_IDENTITY_ABSENT",
    layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    run: (): Refused => refusedByAdmission(observation({ commandId: undefined })),
  },
  {
    code: "EFFORT_SOURCE_ABSENT",
    layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    run: (): Refused => refusedByAdmission(observation({ source: undefined })),
  },
  {
    code: "EFFORT_OBSERVATION_ABSENT",
    layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    run: (): Refused => refusedByAdmission(observation({ observedAt: undefined })),
  },
  {
    code: "EFFORT_OBSERVATION_UNPARSEABLE",
    layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    run: (): Refused => refusedByAdmission(observation({ source: "A_GUESS" })),
  },
  {
    code: "EFFORT_OBSERVATION_CONTRADICTORY",
    layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    run: (): Refused =>
      refusedByAdmission(
        observation({
          demandedKind: "ADDITIONAL",
          interaction: undefined,
          type: "DEMANDED_DECISION",
        }),
      ),
  },
  {
    code: "EFFORT_INTERVAL_OVERLAPPING",
    layer: "CONTROL_ROOM_EFFORT_COLLECTOR",
    run: (): Refused => {
      const collector = createEffortCollector();
      collector.record(interval("INTERVAL_OPEN", "FOCUS", 1));
      return refusedBy(collector, interval("INTERVAL_OPEN", "FOCUS", 2));
    },
  },
  {
    code: "EFFORT_INTERVAL_UNTERMINATED",
    layer: "CONTROL_ROOM_EFFORT_COLLECTOR",
    run: (): Refused => {
      const collector = createEffortCollector();
      collector.record(interval("INTERVAL_OPEN", "FOCUS", 1));
      const outcome = collector.seal().intervals[0];
      if (outcome === undefined || outcome.state === "CLOSED" || outcome.state === "OPEN") {
        throw new Error("expected an unresolved interval outcome");
      }
      return { code: outcome.reasonCode, layer: outcome.layer };
    },
  },
] as const);

/** One admissible payload per record type. */
const RECORD_TYPE_CASES = Object.freeze([
  observation({ fromSurface: "queue", interaction: undefined, toSurface: "log", type: "ATTENTION_SWITCH" }),
  observation({ demandedKind: "CREATE", interaction: undefined, type: "DEMANDED_DECISION" }),
  observation({}),
  observation({ interaction: undefined, intervalKind: "AWAY", type: "INTERVAL_CLOSE" }),
  observation({ interaction: undefined, intervalKind: "AWAY", type: "INTERVAL_OPEN" }),
  observation({
    action: "retried",
    burden: "RETRY_SAME_COMMAND",
    interaction: undefined,
    type: "RECOVERY_ACTION",
  }),
  observation({
    evidence: "scrolled twice",
    interaction: undefined,
    surface: "plan",
    type: "SCROLL_FOCUS_EVIDENCE",
  }),
] as const);

describe("every demanded-decision kind is generated and asserted", () => {
  it("holds exactly four cases, one per declared decision kind", () => {
    expect(DECISION_CASES).toHaveLength(4);
    expect(DECISION_CASES.map((testCase) => testCase.expected).toSorted()).toEqual([
      ...DECISION_KINDS,
    ]);
  });

  it("resolves each case to its kind through the production collector", () => {
    let asserted = 0;
    for (const testCase of DECISION_CASES) {
      const collector = createEffortCollector();
      testCase.demands.forEach(([kind, commandId], order) => {
        collector.record(demand(kind, order + 1, commandId));
      });
      expect(collector.decisions()[testCase.at]?.decisionKind).toBe(testCase.expected);
      asserted += 1;
    }
    expect(asserted).toBe(4);
  });
});

describe("every interval state is generated and asserted", () => {
  it("holds exactly five cases, one per declared interval state", () => {
    expect(INTERVAL_CASES).toHaveLength(5);
    expect(INTERVAL_CASES.map((testCase) => testCase.state).toSorted()).toEqual([
      ...INTERVAL_STATES,
    ]);
  });

  it("reaches each state, pinning the exact code and layer where one refuses", () => {
    let asserted = 0;
    for (const testCase of INTERVAL_CASES) {
      const collector = createEffortCollector();
      testCase.run(collector);
      const outcomes = testCase.seal ? collector.seal().intervals : collector.intervals();
      const outcome = outcomes[0];
      expect(outcome?.state, `case ${testCase.state}`).toBe(testCase.state);
      if (testCase.expectedCode !== null && outcome !== undefined) {
        expect(
          outcome.state === "CLOSED" || outcome.state === "OPEN" ? null : outcome.reasonCode,
        ).toBe(testCase.expectedCode);
        expect(
          outcome.state === "CLOSED" || outcome.state === "OPEN" ? null : outcome.layer,
        ).toBe("CONTROL_ROOM_EFFORT_COLLECTOR");
      }
      asserted += 1;
    }
    expect(asserted).toBe(5);
  });
});

describe("every stable reason code is reachable and layer-attributed", () => {
  it("holds exactly seven cases, one per declared code", () => {
    expect(REFUSAL_CASES).toHaveLength(7);
    expect(REFUSAL_CASES.map((testCase) => testCase.code).toSorted()).toEqual([
      ...EFFORT_UNKNOWN_CODES,
    ]);
  });

  it("visits both refusing layers by name", () => {
    expect([...new Set(REFUSAL_CASES.map((testCase) => testCase.layer))].toSorted()).toEqual([
      ...EFFORT_LAYERS,
    ]);
  });

  it("produces each code from the production surface, with its layer", () => {
    let asserted = 0;
    for (const testCase of REFUSAL_CASES) {
      expect(testCase.run(), `case ${testCase.code}`).toEqual({
        code: testCase.code,
        layer: testCase.layer,
      });
      asserted += 1;
    }
    expect(asserted).toBe(7);
  });
});

describe("every vocabulary member is admissible by name", () => {
  it("admits one payload per record type, exactly seven of them", () => {
    expect(RECORD_TYPE_CASES).toHaveLength(7);
    const admitted = RECORD_TYPE_CASES.map((payload) => {
      const shaped = shapeEffortObservation(payload);
      if (!shaped.known) throw new Error(`case refused with ${shaped.code}`);
      return shaped.type;
    });
    expect(admitted.toSorted()).toEqual([...EFFORT_RECORD_TYPES]);
  });

  it("admits every declared source, exactly four of them", () => {
    expect(EFFORT_SOURCES).toHaveLength(4);
    const admitted = EFFORT_SOURCES.map((source: EffortSource) => {
      const shaped = shapeEffortObservation(observation({ source }));
      if (!shaped.known) throw new Error(`source ${source} refused with ${shaped.code}`);
      return shaped.source;
    });
    expect(admitted.toSorted()).toEqual([...EFFORT_SOURCES]);
  });

  it("admits every declared recovery burden, exactly four of them", () => {
    expect(RECOVERY_BURDENS).toHaveLength(4);
    const admitted = RECOVERY_BURDENS.map((burden) => {
      const shaped = shapeEffortObservation(
        observation({ action: "retried", burden, interaction: undefined, type: "RECOVERY_ACTION" }),
      );
      if (!shaped.known) throw new Error(`burden ${burden} refused with ${shaped.code}`);
      return shaped.type === "RECOVERY_ACTION" ? shaped.burden : null;
    });
    expect(admitted.toSorted()).toEqual([...RECOVERY_BURDENS]);
  });

  it("tracks every declared interval kind separately, exactly two of them", () => {
    expect(INTERVAL_KINDS).toHaveLength(2);
    const collector = createEffortCollector();
    for (const kind of INTERVAL_KINDS) {
      collector.record(interval("INTERVAL_OPEN", kind, 1));
    }
    const sealed = collector.seal();
    expect(sealed.intervals.map((outcome) => outcome.kind).toSorted()).toEqual([
      ...INTERVAL_KINDS,
    ]);
    expect(sealed.intervals.every((outcome) => outcome.state === "UNTERMINATED")).toBe(true);
  });
});
