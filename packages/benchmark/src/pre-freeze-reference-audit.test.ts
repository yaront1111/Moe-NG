import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { auditReferences } from "./pre-freeze-reference-audit.js";
import {
  isPinnedDocument, readPinnedBenchmarkSpec, readPinnedRebuildDesign,
} from "./pre-freeze-pinned-documents.js";
import { type PinnedSource, isPinnedSource, readPinnedSource } from "./pre-freeze-source-reader.js";
import type { PreFreezeAuditRefusal } from "./pre-freeze-audit-vocabulary.js";

const open = (text: string): PinnedSource => {
  const bytes = new TextEncoder().encode(text);
  const opened = readPinnedSource(bytes, createHash("sha256").update(bytes).digest("hex"));
  if (!isPinnedSource(opened)) throw new Error(`synthetic refused: ${opened.code}`);
  return opened;
};

const pinned = (which: "benchmark" | "design"): PinnedSource => {
  const document = which === "benchmark" ? readPinnedBenchmarkSpec() : readPinnedRebuildDesign();
  if (!isPinnedDocument(document)) {
    throw new Error(`pinned ${which} refused: ${document.code} at ${document.layer}`);
  }
  return document.source;
};

/** Builds a well-formed design: 22 CORE-I and 14 CORE-S definition anchors. */
const syntheticDesign = (coreI = 22, coreS = 14): PinnedSource => {
  const rows = [
    ...Array.from({ length: coreI }, (_u, i) => `${i + 1}. **CORE-I${i + 1} invariant:** body`),
    ...Array.from({ length: coreS }, (_u, i) => `${i + 1}. **CORE-S${i + 1} scenario:** body`),
  ];
  expect(rows.length).toBe(coreI + coreS);
  return open(`# design\n\n${rows.join("\n")}\n`);
};

/** Builds a well-formed benchmark: 14 BENCH-S anchors plus every roster reference. */
const syntheticBenchmark = (extra: readonly string[] = []): PinnedSource => {
  const rows = Array.from({ length: 14 }, (_u, i) => `- **BENCH-S${i + 1} scenario.** body`);
  const gates = [
    "G-J1", "G-L1", "G-L2", "G-L3", "G-L3-accept", "G-L3-budget", "G-L3-cost", "G-L3-speed",
    "G-L4", "G-L4-accept", "G-L4-effort", "G-L4-quality", "G-L4-userstudy", "G-L5",
    "G-L5-accept", "G-L5-cost", "G-L5-effort", "G-UI", "G-expand", "G-overhead",
  ].map((id) => `\`${id}\``).join(" ");
  expect(rows.length).toBe(14);
  return open([
    "## 0. Frozen constants",
    "ranges `CORE-I1`…`CORE-I22` and `CORE-S1`…`CORE-S14` and BENCH-S1..BENCH-S14",
    `gates ${gates}`,
    "pointer to Section 0",
    ...rows,
    ...extra,
    "",
  ].join("\n"));
};

const find = (
  refusals: readonly PreFreezeAuditRefusal[],
  code: string,
): PreFreezeAuditRefusal | undefined => refusals.find((refusal) => refusal.code === code);

describe("pre-freeze reference audit, real pinned bytes (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  const report = auditReferences({ benchmark: pinned("benchmark"), design: pinned("design") });

  it("passes the pinned documents with no refusal at all", () => {
    expect(report.refusals).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("generated 22 / 14 / 14 family cases — the range-expansion falsifier", () => {
    expect(report.familyCases).toEqual({ "BENCH-S": 14, "CORE-I": 22, "CORE-S": 14 });
    expect(report.gateIdCases).toBe(20);
    expect(report.sectionPointerCases).toBe(29);
    expect(report.generatedCases).toBe(22 + 14 + 14 + 20 + 29);
  });
});

describe("pre-freeze reference audit refusals (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  const design = syntheticDesign();

  it("refuses an unresolved family use at its exact source location", () => {
    const benchmark = syntheticBenchmark(["the oracle for BENCH-S99 is sealed"]);
    const refusal = find(
      auditReferences({ benchmark, design }).refusals, "REFERENCE_UNRESOLVED",
    );
    expect(refusal).toEqual({
      code: "REFERENCE_UNRESOLVED", layer: "PRE_FREEZE_AUDIT", line: 19, ok: false,
      token: "BENCH-S99",
    });
  });

  it("refuses a duplicate definition, naming the second anchor", () => {
    const benchmark = syntheticBenchmark(["- **BENCH-S4 scenario.** a second definition"]);
    const refusal = find(auditReferences({ benchmark, design }).refusals, "REFERENCE_DUPLICATE");
    expect(refusal).toEqual({
      code: "REFERENCE_DUPLICATE", layer: "PRE_FREEZE_AUDIT", line: 19, ok: false,
      token: "BENCH-S4",
    });
  });

  it("refuses a definition nothing uses, which one-directional sweeps cannot see", () => {
    const report = auditReferences({ benchmark: syntheticBenchmark(), design: syntheticDesign(22, 15) });
    const refusal = find(report.refusals, "TOKEN_SET_MISMATCH");
    expect(refusal?.code).toBe("TOKEN_SET_MISMATCH");
    expect(refusal?.layer).toBe("PRE_FREEZE_AUDIT");
    expect(refusal?.token).toBe("CORE-S15");
  });

  it("refuses a family whose definition count left the frozen cardinality", () => {
    const report = auditReferences({ benchmark: syntheticBenchmark(), design: syntheticDesign(21) });
    const tokens = report.refusals
      .filter((refusal) => refusal.code === "TOKEN_SET_MISMATCH")
      .map((refusal) => refusal.token);
    // CORE-I22 is USED (the benchmark's range expands to it) but no longer DEFINED, so it
    // is unresolved, not a set mismatch; the family cardinality is the mismatch.
    expect(tokens).toEqual(["CORE-I"]);
    expect(report.refusals.some(
      (refusal) => refusal.code === "REFERENCE_UNRESOLVED" && refusal.token === "CORE-I22",
    )).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("refuses an ambiguous bare S/I token at its exact source location", () => {
    const benchmark = syntheticBenchmark(["the oracle for S3 collides with I3"]);
    const bare = auditReferences({ benchmark, design }).refusals
      .filter((refusal) => refusal.code === "REFERENCE_AMBIGUOUS");
    expect(bare).toEqual([
      { code: "REFERENCE_AMBIGUOUS", layer: "PRE_FREEZE_AUDIT", line: 19, ok: false, token: "S3" },
      { code: "REFERENCE_AMBIGUOUS", layer: "PRE_FREEZE_AUDIT", line: 19, ok: false, token: "I3" },
    ]);
  });

  it("refuses a gate cited positionally instead of by its gate ID", () => {
    const benchmark = syntheticBenchmark(["the acceptance gate in Section 0 is decisive"]);
    const refusal = auditReferences({ benchmark, design }).refusals
      .find((entry) => entry.code === "REFERENCE_AMBIGUOUS" && entry.token.includes("Section"));
    expect(refusal?.line).toBe(19);
    expect(refusal?.layer).toBe("PRE_FREEZE_AUDIT");
    expect(refusal?.token).toBe("gate in Section 0");
  });

  it("refuses a section pointer that resolves to no heading", () => {
    const benchmark = syntheticBenchmark(["see Section 99 for the protocol"]);
    const refusal = auditReferences({ benchmark, design }).refusals
      .find((entry) => entry.code === "REFERENCE_UNRESOLVED" && entry.token.startsWith("Section"));
    expect(refusal).toEqual({
      code: "REFERENCE_UNRESOLVED", layer: "PRE_FREEZE_AUDIT", line: 19, ok: false,
      token: "Section 99",
    });
  });

  it("refuses an unresolved gate ID and a gate the roster requires but nothing uses", () => {
    const benchmark = open("## 0. h\n`G-L9` and `CORE-I1`…`CORE-I22`\n");
    const refusals = auditReferences({ benchmark, design }).refusals;
    expect(find(refusals, "REFERENCE_UNRESOLVED")?.token).toBe("G-L9");
    const missing = refusals
      .filter((entry) => entry.code === "TOKEN_SET_MISMATCH")
      .map((entry) => entry.token);
    expect(missing).toContain("G-L1");
    expect(missing).toContain("G-overhead");
  });

  it("refuses SWEEP_ZERO_CASES per family rather than passing a document with no tokens", () => {
    const report = auditReferences({ benchmark: open("## 0. h\nnothing here\n"), design: open("# d\n") });
    const zero = report.refusals
      .filter((entry) => entry.code === "SWEEP_ZERO_CASES")
      .map((entry) => entry.token);
    expect(zero).toEqual(expect.arrayContaining(["CORE-I", "CORE-S", "BENCH-S", "G-*"]));
    expect(report.ok).toBe(false);
    expect(report.familyCases).toEqual({ "BENCH-S": 0, "CORE-I": 0, "CORE-S": 0 });
  });
});
