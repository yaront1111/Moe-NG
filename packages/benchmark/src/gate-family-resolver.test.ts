import { describe, expect, it } from "vitest";

import { GATE_FAMILIES } from "./gate-families.js";
import {
  resolveAll,
  resolveFamily,
} from "./gate-family-resolver.js";
import type { GateFamilyEvidence } from "./gate-family-resolver.js";

function evidence(
  overrides: Partial<GateFamilyEvidence> = {},
): GateFamilyEvidence {
  return {
    countLine: null,
    exitCode: null,
    familyId: "repository",
    ...overrides,
  };
}

describe("gate-family evidence resolver", () => {
  it("keeps a family with no execution evidence UNKNOWN", () => {
    expect(resolveFamily(evidence())).toEqual({
      familyId: "repository",
      ok: true,
      permitReason: null,
      verdict: "UNKNOWN",
    });
  });

  it("requires a nonzero count line in addition to exit zero", () => {
    const exitOnly = evidence({ exitCode: 0 });
    const counted = { ...exitOnly, countLine: "Test Files  1 passed (1)" };

    expect(resolveFamily(exitOnly)).toEqual({
      familyId: "repository",
      ok: true,
      permitReason: null,
      verdict: "UNKNOWN",
    });
    expect(resolveFamily(counted)).toEqual({
      familyId: "repository",
      ok: true,
      permitReason: null,
      verdict: "PASS",
    });
  });

  it("rejects vacuous exit-zero output as UNKNOWN", () => {
    const unsafeCount = "9".repeat(400);
    const vacuousLines = Object.freeze([
      "Test Files  0 passed (0)",
      "Tests  0 passed (0)",
      "No test files found",
      "No projects matched the filters",
      `Tests  ${unsafeCount} passed (${unsafeCount})`,
    ]);
    let executed = 0;
    for (const countLine of vacuousLines) {
      expect(resolveFamily(evidence({ countLine, exitCode: 0 }))).toMatchObject({
        familyId: "repository",
        ok: true,
        verdict: "UNKNOWN",
      });
      executed += 1;
    }
    expect(unsafeCount).toHaveLength(400);
    expect(executed).toBe(5);
    expect(vacuousLines).toHaveLength(5);
  });

  it("answers FAIL for a nonzero exit even without a count line", () => {
    expect(resolveFamily(evidence({ exitCode: 2 }))).toEqual({
      familyId: "repository",
      ok: true,
      permitReason: null,
      verdict: "FAIL",
    });
  });

  it("attaches an explicit permit reason to NON_APPLICABLE", () => {
    expect(resolveFamily(evidence({
      familyId: "independent-review",
      permitReason: "third-party review is outside this local campaign",
    }))).toEqual({
      familyId: "independent-review",
      ok: true,
      permitReason: "third-party review is outside this local campaign",
      verdict: "NON_APPLICABLE",
    });
  });

  it("refuses NON_APPLICABLE when the requested permit reason is blank", () => {
    expect(resolveFamily(evidence({
      familyId: "independent-review",
      permitReason: "   ",
    }))).toEqual({
      code: "GATE_FAMILY_PERMIT_REASON_MISSING",
      familyId: "independent-review",
      layer: "BENCHMARK_GATE_FAMILY_RESOLVER",
      ok: false,
    });
  });

  it("does not let a permit reason mask recorded execution", () => {
    expect(resolveFamily(evidence({
      exitCode: 1,
      permitReason: "not applicable",
    }))).toEqual({
      familyId: "repository",
      ok: true,
      permitReason: null,
      verdict: "FAIL",
    });
  });

  it("refuses an unknown family with its stable code and layer", () => {
    expect(resolveFamily(evidence({ familyId: "not-a-family" }))).toEqual({
      code: "GATE_FAMILY_UNKNOWN",
      familyId: "not-a-family",
      layer: "BENCHMARK_GATE_FAMILY_RESOLVER",
      ok: false,
    });
  });

  it("resolves a frozen ten-family table and fills missing evidence UNKNOWN", () => {
    const result = resolveAll([
      evidence({ countLine: "Tests  2 passed | 1 skipped (3)", exitCode: 0 }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.verdicts)).toBe(true);
    expect(result.verdicts).toHaveLength(10);
    expect(result.verdicts.map(({ familyId }) => familyId)).toEqual(
      GATE_FAMILIES.map(({ id }) => id),
    );
    expect(result.verdicts[0]).toMatchObject({ verdict: "PASS" });
    expect(result.verdicts.slice(1).every(({ verdict }) => verdict === "UNKNOWN")).toBe(true);
    expect(result.verdicts.every(Object.isFrozen)).toBe(true);
  });

  it("executes exactly one evidence-less resolution for every family", () => {
    let executed = 0;
    for (const family of GATE_FAMILIES) {
      expect(resolveFamily(evidence({ familyId: family.id }))).toMatchObject({
        familyId: family.id,
        ok: true,
        verdict: "UNKNOWN",
      });
      executed += 1;
    }
    expect(executed).toBe(10);
    expect(GATE_FAMILIES).toHaveLength(10);
  });

  it("refuses duplicate evidence instead of accepting last-write-wins authority", () => {
    expect(resolveAll([evidence(), evidence({ exitCode: 1 })])).toEqual({
      code: "GATE_FAMILY_EVIDENCE_DUPLICATE",
      familyId: "repository",
      layer: "BENCHMARK_GATE_FAMILY_RESOLVER",
      ok: false,
    });
  });
});
