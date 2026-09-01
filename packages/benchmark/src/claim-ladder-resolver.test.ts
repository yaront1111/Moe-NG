import { describe, expect, it } from "vitest";

import { CLAIM_LADDER } from "./claim-ladder-contract.js";
import { resolveReachedRung } from "./claim-ladder-resolver.js";

const RUNG_CASES = Object.freeze(["L1", "L2", "L3", "L4", "L5"] as const);

function passThrough(rungId: (typeof RUNG_CASES)[number]): Record<string, "PASS"> {
  const verdicts: Record<string, "PASS"> = {};
  for (const rung of CLAIM_LADDER) {
    verdicts[rung.gateId] = "PASS";
    for (const gateId of rung.subGateIds) verdicts[gateId] = "PASS";
    if (rung.rungId === rungId) break;
  }
  return verdicts;
}

describe("resolveReachedRung", () => {
  it("returns the highest rung whose gates and every lower gate pass", () => {
    const verdicts: Record<string, "PASS" | "UNKNOWN"> = {
      ...passThrough("L3"),
      "G-L4": "UNKNOWN",
    };

    expect(resolveReachedRung(verdicts)).toEqual({ ok: true, rung: "L3" });
  });

  it("cannot jump over an unknown lower rung", () => {
    const verdicts: Record<string, "PASS" | "UNKNOWN"> = {
      ...passThrough("L3"),
      "G-L2": "UNKNOWN",
    };

    expect(resolveReachedRung(verdicts)).toEqual({ ok: true, rung: "L1" });
  });

  it("refuses an unrecognized gate id with its own stable code and layer", () => {
    expect(resolveReachedRung({ "G-L1": "PASS", "G-NOT-REAL": "PASS" })).toEqual({
      code: "CLAIM_LADDER_GATE_UNKNOWN",
      gateId: "G-NOT-REAL",
      layer: "BENCHMARK_CLAIM_LADDER",
      ok: false,
    });
  });

  it("treats a missing gate verdict as unknown rather than pass", () => {
    const verdicts: Record<string, "PASS"> = passThrough("L3");
    delete verdicts["G-L3-budget"];

    expect(resolveReachedRung(verdicts)).toEqual({ ok: true, rung: "L2" });
  });

  it("does not let a failed lower rung authorize a higher rung", () => {
    const verdicts: Record<string, "PASS" | "FAIL"> = {
      ...passThrough("L3"),
      "G-L2": "FAIL",
    };

    expect(resolveReachedRung(verdicts)).toEqual({ ok: true, rung: "L1" });
  });

  it("answers L0 for an empty verdict map", () => {
    expect(resolveReachedRung({})).toEqual({ ok: true, rung: "L0" });
  });

  it("executes exactly one all-pass case for every rung", () => {
    let executed = 0;
    expect(Object.isFrozen(RUNG_CASES)).toBe(true);
    for (const rung of RUNG_CASES) {
      expect(resolveReachedRung(passThrough(rung))).toEqual({ ok: true, rung });
      executed += 1;
    }
    expect(executed).toBe(5);
    expect(RUNG_CASES).toHaveLength(5);
  });
});
