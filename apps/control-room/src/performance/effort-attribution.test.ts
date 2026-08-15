import { describe, expect, it } from "vitest";

import { createEffortCollector } from "./effort-collector.js";
import { UNATTRIBUTED } from "./effort-records.js";
import type { EffortCollector } from "./effort-collector.js";
import type { BaselineDecisionKind } from "./effort-records.js";

/** Supplies input only; it reimplements no derivation (project rail 1). */
function demand(
  demandedKind: BaselineDecisionKind,
  observedAt: number,
  commandId = "cmd-1",
): Readonly<Record<string, unknown>> {
  return {
    commandId,
    demandedKind,
    observedAt,
    source: "CONTROL_ROOM_DOM",
    type: "DEMANDED_DECISION",
  };
}

function kindsOf(collector: EffortCollector): readonly string[] {
  return collector.decisions().map((decision) => decision.decisionKind);
}

describe("demanded-decision attribution", () => {
  it("records a demand against the command identity that carried it", () => {
    const collector = createEffortCollector();
    collector.record(demand("CREATE", 5, "cmd-7"));
    expect(collector.decisions()).toEqual([
      {
        commandId: "cmd-7",
        decisionKind: "CREATE",
        demandedKind: "CREATE",
        observedAt: 5,
        source: "CONTROL_ROOM_DOM",
      },
    ]);
  });

  it("derives a second demand on one command as an ADDITIONAL demand", () => {
    const collector = createEffortCollector();
    collector.record(demand("CREATE", 1));
    collector.record(demand("APPROVE", 2));
    expect(kindsOf(collector)).toEqual(["CREATE", "ADDITIONAL"]);
  });

  it("keeps the kind the surface actually demanded on the additional arm", () => {
    const collector = createEffortCollector();
    collector.record(demand("CREATE", 1));
    collector.record(demand("ACCEPT", 2));
    expect(collector.decisions()[1]).toEqual({
      commandId: "cmd-1",
      decisionKind: "ADDITIONAL",
      demandedKind: "ACCEPT",
      observedAt: 2,
      source: "CONTROL_ROOM_DOM",
    });
  });

  it("records every later demand rather than folding them into the first", () => {
    const collector = createEffortCollector();
    collector.record(demand("CREATE", 1));
    collector.record(demand("APPROVE", 2));
    collector.record(demand("ACCEPT", 3));
    expect(kindsOf(collector)).toEqual(["CREATE", "ADDITIONAL", "ADDITIONAL"]);
  });

  it("derives additional-ness per command, so another command starts at its baseline", () => {
    const collector = createEffortCollector();
    collector.record(demand("CREATE", 1, "cmd-a"));
    collector.record(demand("APPROVE", 2, "cmd-a"));
    collector.record(demand("APPROVE", 3, "cmd-b"));
    expect(kindsOf(collector)).toEqual(["CREATE", "ADDITIONAL", "APPROVE"]);
  });

  it("leaves an unattributed demand unattributed, never on the most recent command", () => {
    const collector = createEffortCollector();
    collector.record(demand("CREATE", 1, "cmd-a"));
    collector.record(demand("APPROVE", 2, UNATTRIBUTED));
    const unattributed = collector.decisions()[1];
    expect(unattributed?.commandId).toBe("UNATTRIBUTED");
    expect(unattributed?.decisionKind).toBe("APPROVE");
  });

  it("never derives additional-ness across unattributed demands", () => {
    const collector = createEffortCollector();
    collector.record(demand("CREATE", 1, UNATTRIBUTED));
    collector.record(demand("APPROVE", 2, UNATTRIBUTED));
    expect(kindsOf(collector)).toEqual(["CREATE", "APPROVE"]);
  });

  it("carries the decisions into the sealed set", () => {
    const collector = createEffortCollector();
    collector.record(demand("CREATE", 1));
    expect(collector.seal().decisions).toHaveLength(1);
    expect(Object.isFrozen(collector.seal().decisions)).toBe(true);
  });
});

describe("the other observed record kinds", () => {
  it("records a free interaction under its own kind, attributed", () => {
    const collector = createEffortCollector();
    collector.record({
      commandId: "cmd-3",
      interaction: "scrubbed the log",
      observedAt: 8,
      source: "CONTROL_ROOM_INPUT",
      type: "FREE_INTERACTION",
    });
    expect(collector.observations()[0]).toEqual({
      commandId: "cmd-3",
      interaction: "scrubbed the log",
      known: true,
      observedAt: 8,
      source: "CONTROL_ROOM_INPUT",
      type: "FREE_INTERACTION",
    });
    expect(collector.decisions()).toHaveLength(0);
  });

  it("records an attention switch between two named surfaces", () => {
    const collector = createEffortCollector();
    collector.record({
      commandId: UNATTRIBUTED,
      fromSurface: "queue",
      observedAt: 9,
      source: "SESSION_RECORDING",
      toSurface: "terminal",
      type: "ATTENTION_SWITCH",
    });
    expect(collector.observations()[0]).toMatchObject({
      commandId: "UNATTRIBUTED",
      fromSurface: "queue",
      toSurface: "terminal",
      type: "ATTENTION_SWITCH",
    });
  });

  it("records a recovery action carrying the burden that was observed on it", () => {
    const collector = createEffortCollector();
    collector.record({
      action: "re-entered the plan by hand",
      burden: "MANUAL_REPAIR",
      commandId: "cmd-4",
      observedAt: 11,
      source: "OPERATOR_REPORT",
      type: "RECOVERY_ACTION",
    });
    expect(collector.observations()[0]).toMatchObject({
      action: "re-entered the plan by hand",
      burden: "MANUAL_REPAIR",
      commandId: "cmd-4",
      type: "RECOVERY_ACTION",
    });
  });

  it("records scroll and focus evidence against the surface it was seen on", () => {
    const collector = createEffortCollector();
    collector.record({
      commandId: "cmd-5",
      evidence: "scrolled past the fold twice",
      observedAt: 12,
      source: "CONTROL_ROOM_DOM",
      surface: "plan review",
      type: "SCROLL_FOCUS_EVIDENCE",
    });
    expect(collector.observations()[0]).toMatchObject({
      commandId: "cmd-5",
      evidence: "scrolled past the fold twice",
      surface: "plan review",
      type: "SCROLL_FOCUS_EVIDENCE",
    });
  });

  it("keeps an unattributed observation unattributed beside an attributed one", () => {
    const collector = createEffortCollector();
    collector.record(demand("CREATE", 1, "cmd-a"));
    collector.record({
      commandId: UNATTRIBUTED,
      interaction: "read the queue",
      observedAt: 2,
      source: "CONTROL_ROOM_INPUT",
      type: "FREE_INTERACTION",
    });
    expect(collector.observations().map((record) => record.commandId)).toEqual([
      "cmd-a",
      "UNATTRIBUTED",
    ]);
  });
});
