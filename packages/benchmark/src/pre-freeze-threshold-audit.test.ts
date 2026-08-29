import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type ComparatorVerdictTable, auditComparatorCoverage, auditThresholds, collectConstantSymbols,
} from "./pre-freeze-threshold-audit.js";
import {
  PINNED_DOCUMENT_ROOT_ENV, isPinnedDocument, readPinnedBenchmarkSpec,
} from "./pre-freeze-pinned-documents.js";
import { type PinnedSource, isPinnedSource, readPinnedSource } from "./pre-freeze-source-reader.js";
import {
  FROZEN_COMPARATOR_GATE_IDS, FROZEN_CONSTANT_SYMBOL_COUNT, FROZEN_NI_TAIL_DIRECTIONS,
} from "./pre-freeze-audit-rosters.js";

const HAS_EXPLICIT_PIN_ROOT =
  (process.env[PINNED_DOCUMENT_ROOT_ENV]?.trim().length ?? 0) > 0;

const pinnedSpec = (): PinnedSource => {
  const document = readPinnedBenchmarkSpec();
  if (!isPinnedDocument(document)) {
    throw new Error(`pinned spec refused: ${document.code} at ${document.layer}`);
  }
  return document.source;
};

/** Re-opens the pinned spec with one line rewritten. Its OWN digest admits it. */
const mutatedSpec = (rewrite: (line: string) => string): PinnedSource => {
  const text = pinnedSpec().lines.map(rewrite).join("\r\n");
  const bytes = new TextEncoder().encode(text);
  const opened = readPinnedSource(bytes, createHash("sha256").update(bytes).digest("hex"));
  if (!isPinnedSource(opened)) throw new Error(`mutant refused: ${opened.code}`);
  return opened;
};

const cohortOf = (size: number): readonly string[] =>
  Array.from({ length: size }, (_unused, index) => `member-${index + 1}`);

const fullTable = (cohort: readonly string[]): ComparatorVerdictTable =>
  Object.fromEntries(FROZEN_COMPARATOR_GATE_IDS.map((gate) => [
    gate, Object.fromEntries(cohort.map((member) => [member, "PASS" as const])),
  ]));

describe("frozen constants table (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it.runIf(HAS_EXPLICIT_PIN_ROOT)(
    "reads exactly the transcribed number of Section 0 symbols", () => {
    const symbols = collectConstantSymbols(pinnedSpec());
    expect(symbols.length).toBe(FROZEN_CONSTANT_SYMBOL_COUNT);
    expect(symbols).toContain("N_sched");
    expect(symbols).toContain("M_accept");
    expect(symbols).toContain("M_accept_x");
    expect(symbols).toContain("Γ_cost");
    },
  );
});

describe("threshold audit over real pinned bytes (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it.runIf(HAS_EXPLICIT_PIN_ROOT)("passes with no refusal", () => {
    const report = auditThresholds(pinnedSpec());
    expect(report.refusals).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.runIf(HAS_EXPLICIT_PIN_ROOT)("generated a positive case count for every sweep it ran", () => {
    const report = auditThresholds(pinnedSpec());
    expect(report.ciTailCases).toBe(7);
    expect(report.ciTailCases).toBe(Object.keys(FROZEN_NI_TAIL_DIRECTIONS).length);
    expect(report.marginCases).toBe(3);
    expect(report.constantCases).toBeGreaterThan(0);
    expect(report.generatedCases).toBe(
      report.ciTailCases + report.marginCases + report.constantCases,
    );
  });
});

describe.runIf(HAS_EXPLICIT_PIN_ROOT)(
  "threshold audit refusals (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("catches the acceptance-gate sign inversion the spec says this check exists for", () => {
    const source = mutatedSpec((line) => (line.includes("  G-L4-accept[m] {")
      ? line.replace("lower 95% CI of D >= -M_accept_x", "upper 95% CI of D <= M_accept_x")
      : line));
    const refusal = auditThresholds(source).refusals
      .find((entry) => entry.code === "CI_TAIL_DIRECTION_WRONG");
    expect(refusal?.layer).toBe("PRE_FREEZE_AUDIT");
    expect(refusal?.token).toBe("G-L4-accept:UPPER");
    expect(refusal?.line).toBe(414);
  });

  it("catches a cost gate flipped to the lower tail", () => {
    const source = mutatedSpec((line) => (line.includes("  G-L5-cost[m] {")
      ? line.replace("upper CI <= M_cost", "lower CI >= M_cost") : line));
    const tokens = auditThresholds(source).refusals
      .filter((entry) => entry.code === "CI_TAIL_DIRECTION_WRONG").map((entry) => entry.token);
    expect(tokens).toEqual(["G-L5-cost:LOWER"]);
  });

  it("catches a gate whose rule no longer states any tail at all", () => {
    const source = mutatedSpec((line) => (line.includes("  G-overhead . {")
      ? line.replace("upper (1-alpha_test) CI", "some interval") : line));
    const tokens = auditThresholds(source).refusals
      .filter((entry) => entry.code === "CI_TAIL_DIRECTION_WRONG").map((entry) => entry.token);
    expect(tokens).toEqual(["G-overhead:tail-unstated"]);
  });

  it("catches the fan-out margin trap: M_accept where M_accept_x belongs", () => {
    const source = mutatedSpec((line) => (line.includes("  G-L5-accept[m] {")
      ? line.replace(/M_accept_x/g, "M_accept") : line));
    const tokens = auditThresholds(source).refusals
      .filter((entry) => entry.code === "CONSTANT_UNRESOLVED").map((entry) => entry.token);
    expect(tokens).toContain("G-L5-accept:M_accept");
    expect(tokens).toContain("G-L5-accept:M_accept_x");
  });

  it("catches a gate consuming an inline literal instead of its table symbol", () => {
    const source = mutatedSpec((line) => (line.includes("  G-UI ....... {")
      ? line.replace("vs L_UI", "vs 500 ms") : line));
    const tokens = auditThresholds(source).refusals
      .filter((entry) => entry.code === "CONSTANT_UNRESOLVED").map((entry) => entry.token);
    expect(tokens).toEqual(["G-UI:L_UI"]);
  });

  it("catches the CORE ScheduleCoverageManifest floor losing its governor", () => {
    const source = mutatedSpec((line) => (line.includes("| `N_sched` |")
      ? line.replace("the manifest governs", "the benchmark governs") : line));
    const tokens = auditThresholds(source).refusals
      .filter((entry) => entry.code === "CONSTANT_UNRESOLVED").map((entry) => entry.token);
    expect(tokens).toEqual(["CORE manifest governs"]);
  });

  it("catches N_sched dropping below its 10,000 floor", () => {
    const source = mutatedSpec((line) => (line.includes("| `N_sched` |")
      ? line.replace("10,000", "1,000") : line));
    const tokens = auditThresholds(source).refusals
      .filter((entry) => entry.code === "CONSTANT_UNRESOLVED").map((entry) => entry.token);
    expect(tokens).toEqual(["N_sched >= 10,000"]);
  });

  it("catches a comparator gate that lost its member index", () => {
    const source = mutatedSpec((line) => (line.includes("  G-L5-effort[m] {")
      ? line.replace("G-L5-effort[m] {", "G-L5-effort {") : line));
    const refusal = auditThresholds(source).refusals
      .find((entry) => entry.code === "COMPARATOR_INDEX_MISSING");
    expect(refusal?.token).toBe("G-L5-effort");
    expect(refusal?.layer).toBe("PRE_FREEZE_AUDIT");
  });
  },
);

describe("comparator cohort coverage (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("passes a fully printed cohort of C_min members and generates 6 x 4 cases", () => {
    const cohort = cohortOf(4);
    const report = auditComparatorCoverage(cohort, fullTable(cohort));
    expect(report.refusals).toEqual([]);
    expect(report.generatedCases).toBe(24);
    expect(report.verdict).toBe("PASS");
  });

  it("refuses COMPARATOR_INDEX_MISSING on an empty cohort instead of vacuously passing", () => {
    const report = auditComparatorCoverage([], {});
    expect(report.refusals.map((entry) => entry.code))
      .toEqual(["COMPARATOR_INDEX_MISSING", "SWEEP_ZERO_CASES"]);
    expect(report.refusals[0]?.token).toBe("COMPARABLE cohort");
    expect(report.refusals.every((entry) => entry.layer === "PRE_FREEZE_AUDIT")).toBe(true);
    expect(report.generatedCases).toBe(0);
    expect(report.verdict).toBe("UNKNOWN");
    expect(report.ok).toBe(false);
  });

  it("refuses a cohort below the C_min floor of four", () => {
    const cohort = cohortOf(3);
    const report = auditComparatorCoverage(cohort, fullTable(cohort));
    expect(report.refusals.map((entry) => entry.token)).toEqual(["C_min"]);
    expect(report.generatedCases).toBe(18);
  });

  it("refuses one missing member verdict and resolves the cohort to UNKNOWN, not PASS", () => {
    const cohort = cohortOf(4);
    const table = fullTable(cohort);
    const costRow = Object.fromEntries(
      Object.entries(table["G-L5-cost"] ?? {}).filter(([member]) => member !== "member-3"),
    );
    expect(Object.keys(costRow).length).toBe(3);
    const holed: ComparatorVerdictTable = { ...table, "G-L5-cost": costRow };
    const report = auditComparatorCoverage(cohort, holed);
    expect(report.refusals).toEqual([{
      code: "COMPARATOR_INDEX_MISSING", layer: "PRE_FREEZE_AUDIT", line: 0, ok: false,
      token: "G-L5-cost[member-3]",
    }]);
    expect(report.verdict).toBe("UNKNOWN");
  });

  it("lets one member FAIL dominate the intersection-union verdict", () => {
    const cohort = cohortOf(4);
    const table = fullTable(cohort);
    const failing = {
      ...table,
      "G-L4-quality": { ...table["G-L4-quality"], "member-2": "FAIL" as const },
      "G-L5-accept": { ...table["G-L5-accept"], "member-4": "UNKNOWN" as const },
    };
    expect(auditComparatorCoverage(cohort, failing).verdict).toBe("FAIL");
  });
});
