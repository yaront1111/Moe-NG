import { describe, expect, it } from "vitest";

import { shapeEffortObservation } from "./effort-admission.js";
import { UNATTRIBUTED } from "./effort-records.js";

/** Supplies input only; it reimplements no admission logic (project rail 1). */
function payload(over: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    commandId: "cmd-1",
    observedAt: 10,
    source: "CONTROL_ROOM_INPUT",
    type: "FREE_INTERACTION",
    interaction: "hovered",
    ...over,
  };
}

function refusalOf(value: unknown): { code: string; layer: string } {
  const shaped = shapeEffortObservation(value);
  if (shaped.known) throw new Error(`expected a refusal, got ${shaped.type}`);
  return { code: shaped.code, layer: shaped.layer };
}

describe("shapeEffortObservation admission", () => {
  it("admits an observation carrying its source and command identity, frozen", () => {
    const shaped = shapeEffortObservation(payload({}));
    expect(shaped).toEqual({
      commandId: "cmd-1",
      interaction: "hovered",
      known: true,
      observedAt: 10,
      source: "CONTROL_ROOM_INPUT",
      type: "FREE_INTERACTION",
    });
    expect(Object.isFrozen(shaped)).toBe(true);
  });

  it("records an observation with no command identity as explicitly unattributed", () => {
    const shaped = shapeEffortObservation(payload({ commandId: UNATTRIBUTED }));
    if (!shaped.known) throw new Error(`expected admission, got ${shaped.code}`);
    expect(shaped.commandId).toBe("UNATTRIBUTED");
  });

  it("refuses an absent payload as absent, not malformed", () => {
    expect(refusalOf(undefined)).toEqual({
      code: "EFFORT_OBSERVATION_ABSENT",
      layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    });
    expect(refusalOf(null).code).toBe("EFFORT_OBSERVATION_ABSENT");
  });

  it("refuses a payload that is not an observation shape as unparseable", () => {
    expect(refusalOf("FREE_INTERACTION").code).toBe("EFFORT_OBSERVATION_UNPARSEABLE");
    expect(refusalOf([payload({})]).code).toBe("EFFORT_OBSERVATION_UNPARSEABLE");
  });

  it("separates an absent type from an unknown one", () => {
    const { type: _dropped, ...noType } = payload({});
    expect(refusalOf(noType).code).toBe("EFFORT_OBSERVATION_ABSENT");
    expect(refusalOf(payload({ type: "TELEPATHY" })).code).toBe(
      "EFFORT_OBSERVATION_UNPARSEABLE",
    );
  });

  it("refuses a record with no provenance rather than defaulting its source", () => {
    const { source: _dropped, ...noSource } = payload({});
    expect(refusalOf(noSource)).toEqual({
      code: "EFFORT_SOURCE_ABSENT",
      layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    });
    expect(refusalOf(payload({ source: "A_GUESS" })).code).toBe(
      "EFFORT_OBSERVATION_UNPARSEABLE",
    );
    // A key stating `undefined` states nothing, exactly as timing.ts reads an undefined
    // reading: absent, not malformed.
    expect(refusalOf(payload({ source: undefined })).code).toBe("EFFORT_SOURCE_ABSENT");
    expect(refusalOf(payload({ commandId: undefined })).code).toBe(
      "EFFORT_COMMAND_IDENTITY_ABSENT",
    );
  });

  it("refuses an observation that never states a command identity", () => {
    const { commandId: _dropped, ...noCommand } = payload({});
    expect(refusalOf(noCommand)).toEqual({
      code: "EFFORT_COMMAND_IDENTITY_ABSENT",
      layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    });
    expect(refusalOf(payload({ commandId: "" })).code).toBe(
      "EFFORT_OBSERVATION_UNPARSEABLE",
    );
    expect(refusalOf(payload({ commandId: 7 })).code).toBe(
      "EFFORT_OBSERVATION_UNPARSEABLE",
    );
  });

  it("separates an unobserved timestamp from an unreadable one", () => {
    const { observedAt: _dropped, ...noStamp } = payload({});
    expect(refusalOf(noStamp).code).toBe("EFFORT_OBSERVATION_ABSENT");
    expect(refusalOf(payload({ observedAt: Number.NaN })).code).toBe(
      "EFFORT_OBSERVATION_UNPARSEABLE",
    );
    expect(refusalOf(payload({ observedAt: "10" })).code).toBe(
      "EFFORT_OBSERVATION_UNPARSEABLE",
    );
  });

  it("checks absent before unparseable so a missing field is never called malformed", () => {
    const { source: _dropped, ...noSource } = payload({ observedAt: "later" });
    expect(refusalOf(noSource).code).toBe("EFFORT_SOURCE_ABSENT");
  });

  it("refuses a caller-supplied durationMs, count or burden instead of dropping it", () => {
    expect(refusalOf(payload({ durationMs: 900 })).code).toBe(
      "EFFORT_OBSERVATION_UNPARSEABLE",
    );
    expect(refusalOf(payload({ count: 3 })).code).toBe("EFFORT_OBSERVATION_UNPARSEABLE");
    expect(refusalOf(payload({ burden: "MANUAL_REPAIR" })).code).toBe(
      "EFFORT_OBSERVATION_UNPARSEABLE",
    );
  });

  it("admits a key that states undefined, which supplies nothing to honour", () => {
    // Consistent with every other field: a key set to undefined states nothing, so there
    // is no supplied duration to refuse. A key carrying a VALUE is still refused above.
    const shaped = shapeEffortObservation(payload({ durationMs: undefined }));
    if (!shaped.known) throw new Error(`expected admission, got ${shaped.code}`);
    expect(Object.hasOwn(shaped, "durationMs")).toBe(false);
  });

  it("refuses a caller that declares its demand additional", () => {
    expect(
      refusalOf({
        commandId: "cmd-1",
        demandedKind: "ADDITIONAL",
        observedAt: 4,
        source: "CONTROL_ROOM_DOM",
        type: "DEMANDED_DECISION",
      }),
    ).toEqual({
      code: "EFFORT_OBSERVATION_CONTRADICTORY",
      layer: "CONTROL_ROOM_EFFORT_ADMISSION",
    });
  });

  it("refuses an attention switch that leaves and arrives at the same surface", () => {
    expect(
      refusalOf({
        commandId: UNATTRIBUTED,
        fromSurface: "queue",
        observedAt: 4,
        source: "CONTROL_ROOM_DOM",
        toSurface: "queue",
        type: "ATTENTION_SWITCH",
      }).code,
    ).toBe("EFFORT_OBSERVATION_CONTRADICTORY");
  });

  it("refuses a recovery action whose burden is not an observed burden", () => {
    expect(
      refusalOf({
        action: "reran the command",
        burden: "SLIGHT",
        commandId: "cmd-2",
        observedAt: 9,
        source: "OPERATOR_REPORT",
        type: "RECOVERY_ACTION",
      }).code,
    ).toBe("EFFORT_OBSERVATION_UNPARSEABLE");
  });

  it("separates a missing type-specific field from a malformed one", () => {
    const { interaction: _dropped, ...noInteraction } = payload({});
    expect(refusalOf(noInteraction).code).toBe("EFFORT_OBSERVATION_ABSENT");
    expect(refusalOf(payload({ interaction: "" })).code).toBe(
      "EFFORT_OBSERVATION_UNPARSEABLE",
    );
  });

  it("never carries a duration on an admitted record", () => {
    const shaped = shapeEffortObservation(payload({}));
    expect(Object.hasOwn(shaped, "durationMs")).toBe(false);
  });
});
