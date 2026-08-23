import { afterEach, describe, expect, it } from "vitest";

import { auditPreFreezeSources, runPreFreezeAudit } from "./pre-freeze-audit.js";
import {
  PINNED_DOCUMENT_ROOT_ENV, isPinnedDocument, readPinnedBenchmarkSpec, readPinnedRebuildDesign,
} from "./pre-freeze-pinned-documents.js";
import type { PinnedSource } from "./pre-freeze-source-reader.js";

const original = process.env[PINNED_DOCUMENT_ROOT_ENV];
afterEach(() => {
  if (original === undefined) delete process.env[PINNED_DOCUMENT_ROOT_ENV];
  else process.env[PINNED_DOCUMENT_ROOT_ENV] = original;
});

const sourceOf = (which: "benchmark" | "design"): PinnedSource => {
  const document = which === "benchmark" ? readPinnedBenchmarkSpec() : readPinnedRebuildDesign();
  if (!isPinnedDocument(document)) {
    throw new Error(`pinned ${which} refused: ${document.code} at ${document.layer}`);
  }
  return document.source;
};

describe("pre-freeze audit entry point (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("passes the two pinned documents end to end", () => {
    const report = runPreFreezeAudit();
    expect(report.refusals).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.references?.ok).toBe(true);
    expect(report.gateInventory?.ok).toBe(true);
    expect(report.thresholds?.ok).toBe(true);
  });

  it("sums every half's case count, and every half generated cases", () => {
    const report = runPreFreezeAudit();
    const halves = [report.references, report.gateInventory, report.thresholds];
    for (const half of halves) expect(half?.generatedCases ?? 0).toBeGreaterThan(0);
    expect(report.generatedCases)
      .toBe(halves.reduce((sum, half) => sum + (half?.generatedCases ?? 0), 0));
    expect(report.references?.familyCases).toEqual({ "BENCH-S": 14, "CORE-I": 22, "CORE-S": 14 });
    expect(report.thresholds?.ciTailCases).toBe(7);
    expect(report.gateInventory?.rungCases).toBe(5);
  });

  it("agrees with the pure form given the same already-verified sources", () => {
    const pure = auditPreFreezeSources({
      benchmark: sourceOf("benchmark"), design: sourceOf("design"),
    });
    expect(pure.generatedCases).toBe(runPreFreezeAudit().generatedCases);
    expect(pure.refusals).toEqual([]);
  });

  it("refuses rather than passing when a pinned document cannot be read", () => {
    process.env[PINNED_DOCUMENT_ROOT_ENV] = "D:\\no\\such\\pinned\\root";
    const report = runPreFreezeAudit();
    expect(report.ok).toBe(false);
    expect(report.generatedCases).toBe(0);
    expect(report.references).toBeNull();
    expect(report.refusals.map((refusal) => refusal.code))
      .toEqual(["SPEC_UNPARSEABLE", "SPEC_UNPARSEABLE", "SWEEP_ZERO_CASES"]);
    expect(report.refusals.every((refusal) => refusal.layer === "PRE_FREEZE_AUDIT")).toBe(true);
  });
});
