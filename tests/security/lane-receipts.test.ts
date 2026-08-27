import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CoverageDiagnostic,
  SECURITY_COVERAGE_DIAGNOSTICS,
  readSliceReceipts,
  resolveExecutedCoverage,
  writeSliceReceipt,
  type SliceReceipt,
} from "./lane-receipts.js";

const roots: string[] = [];
const ARMS = ["AFTER", "BEFORE", "RACE"] as const;

function receipt(runId: string, sliceFile: string, boundary = "BOUNDARY_A"): SliceReceipt {
  return {
    entries: ARMS.map((arm) => ({ arm, boundary, caseId: `${sliceFile} ${arm}` })),
    runId,
    sliceFile,
  };
}

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "moe-security-receipts-test-"));
  roots.push(directory);
  return directory;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CoverageDiagnostic);
    expect((error as CoverageDiagnostic).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("security lane receipt diagnostics", () => {
  it("freezes a unique nonzero roster of seven stable codes", () => {
    expect(Object.isFrozen(SECURITY_COVERAGE_DIAGNOSTICS)).toBe(true);
    expect(SECURITY_COVERAGE_DIAGNOSTICS).toHaveLength(7);
    expect(new Set(SECURITY_COVERAGE_DIAGNOSTICS).size).toBe(7);
  });

  it("refuses an unexecuted registration before writing a receipt", () => {
    const directory = root();
    const invalid = receipt("run-a", "slice-a.security.ts");
    invalid.entries[0] = { ...invalid.entries[0]!, caseId: "" };
    expectCode(
      () => writeSliceReceipt(directory, invalid),
      "SECURITY_COVERAGE_UNEXECUTED_REGISTRATION",
    );
    expect(readdirSync(directory)).toEqual([]);
  });

  it("refuses a duplicate slice receipt and leaves no temporary file", () => {
    const directory = root();
    const value = receipt("run-a", "slice-a.security.ts");
    writeSliceReceipt(directory, value);
    expectCode(
      () => writeSliceReceipt(directory, value),
      "SECURITY_COVERAGE_DUPLICATE_SLICE_RECEIPT",
    );
    expect(readdirSync(directory)).toEqual(["slice-a.security.ts.json"]);
  });

  it("refuses a receipt from another run", () => {
    const directory = root();
    writeSliceReceipt(directory, receipt("run-a", "slice-a.security.ts"));
    expectCode(
      () => readSliceReceipts(directory, "run-b"),
      "SECURITY_COVERAGE_FOREIGN_RUN",
    );
  });
});

describe("executed coverage resolution", () => {
  it("names one missing slice receipt", () => {
    const result = resolveExecutedCoverage({
      receipts: [receipt("run-a", "slice-a.security.ts")],
      roster: ["BOUNDARY_A"],
      sliceFiles: ["slice-a.security.ts", "slice-b.security.ts"],
    });
    expect(result.diagnostics.map(({ code }) => code))
      .toEqual(["SECURITY_COVERAGE_MISSING_SLICE_RECEIPT"]);
    expect(result.diagnostics[0]?.detail).toBe("slice-b.security.ts");
    expect(result.pairs).toEqual([]);
  });

  it("names one foreign boundary", () => {
    const result = resolveExecutedCoverage({
      receipts: [receipt("run-a", "slice-a.security.ts", "BOUNDARY_FOREIGN")],
      roster: [],
      sliceFiles: ["slice-a.security.ts"],
    });
    expect(result.diagnostics.map(({ code }) => code))
      .toEqual(["SECURITY_COVERAGE_FOREIGN_BOUNDARY"]);
    expect(result.diagnostics[0]?.detail).toBe("BOUNDARY_FOREIGN");
    expect(result.pairs).toEqual([]);
  });

  it("names a boundary claimed by two slices", () => {
    const result = resolveExecutedCoverage({
      receipts: [
        receipt("run-a", "slice-a.security.ts"),
        receipt("run-a", "slice-b.security.ts"),
      ],
      roster: ["BOUNDARY_A"],
      sliceFiles: ["slice-a.security.ts", "slice-b.security.ts"],
    });
    expect(result.diagnostics.map(({ code }) => code))
      .toEqual(["SECURITY_COVERAGE_DUPLICATE_BOUNDARY_CLAIM"]);
    expect(result.diagnostics[0]?.detail).toBe(
      "BOUNDARY_A: slice-a.security.ts, slice-b.security.ts",
    );
    expect(result.pairs).toEqual([]);
  });

  it("names one missing executed arm", () => {
    const value = receipt("run-a", "slice-a.security.ts");
    value.entries = value.entries.filter(({ arm }) => arm !== "AFTER");
    const result = resolveExecutedCoverage({
      receipts: [value],
      roster: ["BOUNDARY_A"],
      sliceFiles: ["slice-a.security.ts"],
    });
    expect(result.diagnostics.map(({ code }) => code))
      .toEqual(["SECURITY_COVERAGE_MISSING_ARM"]);
    expect(result.diagnostics[0]?.detail).toBe("BOUNDARY_A#AFTER");
    expect(result.pairs).toEqual([]);
  });

  it("resolves the exact pair set for two executed slices", () => {
    const result = resolveExecutedCoverage({
      receipts: [
        receipt("run-a", "slice-a.security.ts", "BOUNDARY_A"),
        receipt("run-a", "slice-b.security.ts", "BOUNDARY_B"),
      ],
      roster: ["BOUNDARY_A", "BOUNDARY_B"],
      sliceFiles: ["slice-a.security.ts", "slice-b.security.ts"],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.pairs).toEqual([
      { arm: "AFTER", boundary: "BOUNDARY_A" },
      { arm: "BEFORE", boundary: "BOUNDARY_A" },
      { arm: "RACE", boundary: "BOUNDARY_A" },
      { arm: "AFTER", boundary: "BOUNDARY_B" },
      { arm: "BEFORE", boundary: "BOUNDARY_B" },
      { arm: "RACE", boundary: "BOUNDARY_B" },
    ]);
  });
});
