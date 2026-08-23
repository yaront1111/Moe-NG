import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  TRIVALENT_VERDICTS, auditGateInventory, isReportBlock, parseReportBlock, resolveRungVerdict,
} from "./pre-freeze-gate-audit.js";
import { isPinnedDocument, readPinnedBenchmarkSpec } from "./pre-freeze-pinned-documents.js";
import { type PinnedSource, isPinnedSource, readPinnedSource } from "./pre-freeze-source-reader.js";

const open = (text: string): PinnedSource => {
  const bytes = new TextEncoder().encode(text);
  const opened = readPinnedSource(bytes, createHash("sha256").update(bytes).digest("hex"));
  if (!isPinnedSource(opened)) throw new Error(`synthetic refused: ${opened.code}`);
  return opened;
};

const pinnedSpec = (): PinnedSource => {
  const document = readPinnedBenchmarkSpec();
  if (!isPinnedDocument(document)) {
    throw new Error(`pinned spec refused: ${document.code} at ${document.layer}`);
  }
  return document.source;
};

/** The pinned spec's own structure, retyped so a mutation of one line can be injected. */
const LADDER = [
  "| Rung | Gate ID | What must be shown | Sentence |",
  "| **L1 — internally correct** | `G-L1` | rule | template |",
  "| **L2 — safer** | `G-L2` | rule | template |",
  "| **L3 — faster** | `G-L3` | `G-L3-speed` `G-L3-budget` `G-L3-accept` `G-L3-cost` | t |",
  "| **L4 — no worse** | `G-L4` | `G-L4-quality[m]` `G-L4-accept[m]` `G-L4-effort[m]` `G-J1` "
    + "`G-overhead` `G-UI` `G-L4-userstudy` | t |",
  "| **L5 — best tool** | `G-L5` | `G-L4-quality[m]` `G-L5-accept[m]` `G-L5-cost[m]` "
    + "`G-L5-effort[m]` | t |",
];
const INVENTORY = [
  "RUNG -> GATE INVENTORY (rung PASSes iff every listed gate PASSes; any UNKNOWN -> UNKNOWN;"
    + " any FAIL -> FAIL. [m] gates are AND-ed over every member m.)",
  "  L1: G-L1",
  "  L2: G-L1, G-L2",
  "  L3: G-L1, G-L2, G-L3-speed, G-L3-budget, G-L3-accept, G-L3-cost   [umbrella alias G-L3"
    + " == AND of these]",
  "  L4: (L3 gates), G-L4-quality[m], G-L4-accept[m], G-L4-effort[m], G-J1, G-overhead, G-UI,"
    + " G-L4-userstudy   [umbrella alias G-L4 == AND of these over all m]",
  "  L5: (L4 gates), and per member m {G-L4-quality[m], G-L5-accept[m], G-L5-cost[m],"
    + " G-L5-effort[m]} AND-ed via intersection-union.   [G-expand is out-of-ladder]",
];
const GATE_RESULTS = [
  "GATE RESULTS (each: PASS/FAIL/UNKNOWN + effect size + CI + run-ID link)",
  ...[
    "G-L1", "G-L2", "G-L3-speed", "G-L3-accept", "G-L3-budget", "G-L3-cost",
    "G-L4-quality[m]", "G-L4-accept[m]", "G-L4-effort[m]", "G-J1", "G-overhead", "G-UI",
    "G-L4-userstudy", "G-L5-accept[m]", "G-L5-cost[m]", "G-L5-effort[m]", "G-L5", "G-expand",
  ].map((id) => `  ${id} ... {decision rule for ${id}}`),
];
const TRIVALENT_RULES = [
  "Absence-of-evidence => UNKNOWN; evidence-of-defect => FAIL. Precedence when both"
    + " co-occur: FAIL dominates.",
  "A gate whose constant is unset is `UNKNOWN`, never `PASS`.",
];
const syntheticSpec = (edit: (lines: string[]) => string[] = (l) => l): PinnedSource =>
  open(`${edit([...LADDER, "", ...INVENTORY, "", ...GATE_RESULTS, "", ...TRIVALENT_RULES]).join("\n")}\n`);

describe("report block parsing (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("parses the five ladder rows, five inventories and eighteen gate rules from real bytes", () => {
    const block = parseReportBlock(pinnedSpec());
    if (!isReportBlock(block)) throw new Error(`refused: ${block.code}`);
    expect(block.ladder.map((rung) => rung.rung)).toEqual(["L1", "L2", "L3", "L4", "L5"]);
    expect(block.inventories.map((rung) => rung.rung)).toEqual(["L1", "L2", "L3", "L4", "L5"]);
    expect(block.gateDefinitions.length).toBe(18);
    expect(block.gateDefinitions.filter((gate) => gate.indexed).map((gate) => gate.gateId))
      .toEqual([
        "G-L4-quality", "G-L4-accept", "G-L4-effort", "G-L5-accept", "G-L5-cost", "G-L5-effort",
      ]);
  });

  it("refuses SPEC_UNPARSEABLE rather than auditing a document with no ladder", () => {
    const refusal = parseReportBlock(open("nothing structural here\n"));
    expect(isReportBlock(refusal)).toBe(false);
    if (isReportBlock(refusal)) throw new Error("unreachable");
    expect(refusal.code).toBe("SPEC_UNPARSEABLE");
    expect(refusal.layer).toBe("PRE_FREEZE_AUDIT");
  });
});

describe("rung-to-gate inventory audit (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("passes the pinned spec with no refusal and five generated rung cases", () => {
    const report = auditGateInventory(pinnedSpec());
    expect(report.refusals).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rungCases).toBe(5);
    expect(report.gateDefinitionCases).toBe(18);
  });

  it("passes the retyped synthetic spec too, so later mutations are attributable", () => {
    expect(auditGateInventory(syntheticSpec()).refusals).toEqual([]);
  });

  it("refuses when the Section 12 inventory drops a gate the ladder still wires", () => {
    const report = auditGateInventory(syntheticSpec((lines) =>
      lines.map((line) => line.replace(", G-L3-cost   [umbrella", "   [umbrella"))));
    const refusal = report.refusals.find((entry) => entry.code === "GATE_INVENTORY_MISMATCH");
    expect(refusal?.layer).toBe("PRE_FREEZE_AUDIT");
    expect(refusal?.token).toBe("L3");
    expect(report.ok).toBe(false);
  });

  it("refuses when the ladder wires a gate the transcribed roster does not carry", () => {
    const report = auditGateInventory(syntheticSpec((lines) =>
      lines.map((line) => line.replace("| **L2 — safer** | `G-L2` |", "| **L2 — safer** | `G-L2` `G-L9` |"))));
    const tokens = report.refusals.map((entry) => entry.token);
    expect(tokens).toContain("G-L9");
    expect(report.refusals.every((entry) => entry.layer === "PRE_FREEZE_AUDIT")).toBe(true);
  });

  it("refuses a gate cited positionally inside a rung inventory", () => {
    const report = auditGateInventory(syntheticSpec((lines) =>
      lines.map((line) => line.replace("  L1: G-L1", "  L1: G-L1, the gate of Section 7"))));
    const refusal = report.refusals.find((entry) => entry.token.startsWith("Section"));
    expect(refusal?.code).toBe("GATE_INVENTORY_MISMATCH");
    expect(refusal?.token).toBe("Section 7");
  });

  it("refuses a defined gate that no rung wires and that is not declared out-of-ladder", () => {
    const report = auditGateInventory(syntheticSpec((lines) =>
      lines.map((line) => line.replace(", G-L4-userstudy   [umbrella alias G-L4", "   [umbrella alias G-L4"))));
    const tokens = report.refusals
      .filter((entry) => entry.code === "GATE_INVENTORY_MISMATCH")
      .map((entry) => entry.token);
    expect(tokens).toContain("G-L4-userstudy");
  });
});

describe("three-valued handling (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("finds spec:85's precedence rule and the never-PASS guard in the pinned bytes", () => {
    const report = auditGateInventory(pinnedSpec());
    expect(report.trivalentCases).toBe(5);
    expect(report.refusals.filter((entry) => entry.code === "TRIVALENT_INCOMPLETE")).toEqual([]);
  });

  it.each([
    ["FAIL dominates", "FAIL dominates", "TRIVALENT_INCOMPLETE"],
    ["never-PASS guard", "never `PASS`", "TRIVALENT_INCOMPLETE"],
    ["any-FAIL arm", "any FAIL -> FAIL", "TRIVALENT_INCOMPLETE"],
    ["verdict domain", "PASS/FAIL/UNKNOWN", "TRIVALENT_INCOMPLETE"],
  ])("refuses when the %s clause is deleted", (_label, clause, code) => {
    const report = auditGateInventory(syntheticSpec((lines) =>
      lines.map((line) => line.replace(clause, "REMOVED"))));
    expect(report.refusals.some((entry) => entry.code === code)).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("resolves every three-valued combination with FAIL dominating, and generates 3^3 cases", () => {
    let generated = 0;
    for (const a of TRIVALENT_VERDICTS) {
      for (const b of TRIVALENT_VERDICTS) {
        for (const c of TRIVALENT_VERDICTS) {
          const verdicts = [a, b, c];
          generated += 1;
          const resolved = resolveRungVerdict(verdicts);
          if (verdicts.includes("FAIL")) expect(resolved).toBe("FAIL");
          else if (verdicts.includes("UNKNOWN")) expect(resolved).toBe("UNKNOWN");
          else expect(resolved).toBe("PASS");
        }
      }
    }
    expect(generated).toBe(27);
  });

  it("never lets an UNKNOWN gate reach PASS, and refuses an empty rung", () => {
    for (const other of TRIVALENT_VERDICTS) {
      expect(resolveRungVerdict(["UNKNOWN", other])).not.toBe("PASS");
    }
    expect(resolveRungVerdict([])).toBe("UNKNOWN");
    expect(resolveRungVerdict(["FAIL", "UNKNOWN"])).toBe("FAIL");
  });
});
