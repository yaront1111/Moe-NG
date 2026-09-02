import { describe, expect, it } from "vitest";

import {
  MAX_SECTION_HEADINGS, citedSections, documentHeadings, sectionCoverage,
} from "./document-coverage-sections.js";

const PRD = [
  "# Uai — Personal AI Chief of Staff",
  "",
  "## 11. Evidence",
  "### 11.1 Minimum fields",
  "### 11.2 Source anchors",
  "```",
  "## 99. Not a heading, inside a fence",
  "```",
  "## 40. Functional requirements",
  "## Appendix",
].join("\n");

describe("documentHeadings", () => {
  it("lists numbered and unnumbered headings in order and skips fenced code", () => {
    expect(documentHeadings(PRD)).toEqual([
      { heading: "Uai — Personal AI Chief of Staff", number: null },
      { heading: "11. Evidence", number: "11" },
      { heading: "11.1 Minimum fields", number: "11.1" },
      { heading: "11.2 Source anchors", number: "11.2" },
      { heading: "40. Functional requirements", number: "40" },
      { heading: "Appendix", number: null },
    ]);
  });

  it("stops at the heading bound", () => {
    const many = Array.from({ length: MAX_SECTION_HEADINGS + 5 }, (_, i) => `## ${i + 1}. H`).join("\n");
    expect(documentHeadings(many)).toHaveLength(MAX_SECTION_HEADINGS);
  });
});

describe("citedSections", () => {
  it("reads every § number once, with or without a space", () => {
    expect([...citedSections("Evidence is immutable (PRD §11.1, § 33.2) and again §11.1.")])
      .toEqual(["11.1", "33.2"]);
    expect([...citedSections("no citation here")]).toEqual([]);
  });
});

describe("sectionCoverage", () => {
  const requirements = [
    {
      criteria: [
        { statement: "getEvidence keeps every §11.1 field", status: "VERIFIED" },
        { statement: "observedAt is ledger-assigned", status: "PLANNED" },
      ],
      statement: "Evidence retains the minimum fields (PRD §11.1).",
    },
    {
      criteria: [{ statement: "anchors attach to known evidence", status: "VERIFIED" }],
      statement: "A source anchor is a precise location (PRD §11.2, §40 FR-100).",
    },
  ];

  it("attributes citations to the section and to its ancestors, never to siblings", () => {
    const map = new Map(sectionCoverage(PRD, requirements).map((row) => [row.heading, row]));
    expect(map.get("11. Evidence")).toMatchObject({ cited: 2, number: "11", verified: 2 });
    expect(map.get("11.1 Minimum fields")).toMatchObject({ cited: 1, verified: 1 });
    expect(map.get("11.2 Source anchors")).toMatchObject({ cited: 1, verified: 1 });
    expect(map.get("40. Functional requirements")).toMatchObject({ cited: 1, verified: 1 });
    expect(map.get("Appendix")).toEqual({ cited: 0, heading: "Appendix", number: null, verified: 0 });
    expect(map.get("Uai — Personal AI Chief of Staff")?.cited).toBe(0);
  });

  it("counts a criterion as verified only when its status says so", () => {
    const rows = sectionCoverage(PRD, [{
      criteria: [{ statement: "x", status: "PLANNED" }],
      statement: "Something about §11.1.",
    }]);
    expect(rows.find((row) => row.number === "11.1")).toMatchObject({ cited: 1, verified: 0 });
  });

  it("maps an empty document to no sections", () => {
    expect(sectionCoverage("", requirements)).toEqual([]);
  });
});
