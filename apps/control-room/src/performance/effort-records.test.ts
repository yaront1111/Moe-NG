import { describe, expect, it } from "vitest";

import {
  ADDITIONAL_DECISION_KIND,
  BASELINE_DECISION_KINDS,
  DECISION_KINDS,
  EFFORT_ADMISSION_LAYER,
  EFFORT_COLLECTOR_LAYER,
  EFFORT_LAYERS,
  EFFORT_RECORD_TYPES,
  EFFORT_SOURCES,
  EFFORT_UNKNOWN_CODES,
  INTERVAL_KINDS,
  INTERVAL_STATES,
  RECOVERY_BURDENS,
  UNATTRIBUTED,
  effortRefusal,
} from "./effort-records.js";

describe("effort record vocabulary", () => {
  it("closes the unknown-code set at seven named members", () => {
    expect([...EFFORT_UNKNOWN_CODES]).toEqual([
      "EFFORT_COMMAND_IDENTITY_ABSENT",
      "EFFORT_INTERVAL_OVERLAPPING",
      "EFFORT_INTERVAL_UNTERMINATED",
      "EFFORT_OBSERVATION_ABSENT",
      "EFFORT_OBSERVATION_CONTRADICTORY",
      "EFFORT_OBSERVATION_UNPARSEABLE",
      "EFFORT_SOURCE_ABSENT",
    ]);
  });

  it("borrows no code from the timing family", () => {
    for (const code of EFFORT_UNKNOWN_CODES) {
      expect(code.startsWith("EFFORT_")).toBe(true);
    }
  });

  it("names the two layers that can refuse, separately", () => {
    expect(EFFORT_ADMISSION_LAYER).toBe("CONTROL_ROOM_EFFORT_ADMISSION");
    expect(EFFORT_COLLECTOR_LAYER).toBe("CONTROL_ROOM_EFFORT_COLLECTOR");
    expect([...EFFORT_LAYERS]).toEqual([
      "CONTROL_ROOM_EFFORT_ADMISSION",
      "CONTROL_ROOM_EFFORT_COLLECTOR",
    ]);
  });

  it("closes the record-type set at seven named members", () => {
    expect([...EFFORT_RECORD_TYPES]).toEqual([
      "ATTENTION_SWITCH",
      "DEMANDED_DECISION",
      "FREE_INTERACTION",
      "INTERVAL_CLOSE",
      "INTERVAL_OPEN",
      "RECOVERY_ACTION",
      "SCROLL_FOCUS_EVIDENCE",
    ]);
  });

  it("closes the provenance set and never admits an empty source", () => {
    expect([...EFFORT_SOURCES]).toEqual([
      "CONTROL_ROOM_DOM",
      "CONTROL_ROOM_INPUT",
      "OPERATOR_REPORT",
      "SESSION_RECORDING",
    ]);
  });

  it("keeps ADDITIONAL out of the kinds a caller may demand", () => {
    expect([...BASELINE_DECISION_KINDS]).toEqual(["ACCEPT", "APPROVE", "CREATE"]);
    expect([...DECISION_KINDS]).toEqual(["ACCEPT", "ADDITIONAL", "APPROVE", "CREATE"]);
    expect(ADDITIONAL_DECISION_KIND).toBe("ADDITIONAL");
    expect([...BASELINE_DECISION_KINDS]).not.toContain(ADDITIONAL_DECISION_KIND);
  });

  it("records focus and away as two separate interval kinds", () => {
    expect([...INTERVAL_KINDS]).toEqual(["AWAY", "FOCUS"]);
  });

  it("closes the interval-state set at five named members", () => {
    expect([...INTERVAL_STATES]).toEqual([
      "CLOSED",
      "CONTRADICTORY",
      "OPEN",
      "OVERLAPPING",
      "UNTERMINATED",
    ]);
  });

  it("closes the observed recovery burdens", () => {
    expect([...RECOVERY_BURDENS]).toEqual([
      "MANUAL_REPAIR",
      "REDO_FROM_SCRATCH",
      "RETRY_SAME_COMMAND",
      "UNRECOVERED",
    ]);
  });

  it("names the absence of a command identity explicitly", () => {
    expect(UNATTRIBUTED).toBe("UNATTRIBUTED");
  });

  it("freezes every vocabulary set", () => {
    for (const frozen of [
      BASELINE_DECISION_KINDS,
      DECISION_KINDS,
      EFFORT_LAYERS,
      EFFORT_RECORD_TYPES,
      EFFORT_SOURCES,
      EFFORT_UNKNOWN_CODES,
      INTERVAL_KINDS,
      INTERVAL_STATES,
      RECOVERY_BURDENS,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
  });
});

describe("effortRefusal", () => {
  it("carries the code and the refusing layer, frozen", () => {
    const refusal = effortRefusal("EFFORT_SOURCE_ABSENT", EFFORT_ADMISSION_LAYER);
    expect(refusal).toEqual({
      code: "EFFORT_SOURCE_ABSENT",
      known: false,
      layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    });
    expect(Object.isFrozen(refusal)).toBe(true);
  });

  it("lets the collector layer refuse under its own name", () => {
    const refusal = effortRefusal("EFFORT_INTERVAL_UNTERMINATED", EFFORT_COLLECTOR_LAYER);
    expect(refusal.layer).toBe("CONTROL_ROOM_EFFORT_COLLECTOR");
    expect(refusal.code).toBe("EFFORT_INTERVAL_UNTERMINATED");
  });
});
