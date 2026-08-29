import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EXPANDED_RANGE_SPAN_CAP, PINNED_BENCHMARK_SPEC_SHA256, PINNED_REBUILD_DESIGN_SHA256,
  PINNED_SOURCE_BRAND, type PinnedSource, collectBareScenarioTokens, collectFamilyDefinitions,
  collectFamilyUses, collectGateIdUses, collectHeadingNumbers, collectSectionPointers,
  expandFamilyRange, isPinnedSource, readPinnedSource,
} from "./pre-freeze-source-reader.js";
import {
  PINNED_DOCUMENT_ROOT_ENV, isPinnedDocument, readPinnedBenchmarkSpec,
  readPinnedRebuildDesign,
} from "./pre-freeze-pinned-documents.js";

const HAS_EXPLICIT_PIN_ROOT =
  (process.env[PINNED_DOCUMENT_ROOT_ENV]?.trim().length ?? 0) > 0;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
/**
 * Opens a pinned document or FAILS LOUD. Never skipped: a suite that quietly skipped when
 * the external document is absent would report green while the only arms that exercise the
 * audit against real bytes never ran.
 */
const pinnedSpec = () => {
  const document = readPinnedBenchmarkSpec();
  if (!isPinnedDocument(document)) {
    throw new Error(`pinned benchmark spec refused: ${document.code} at ${document.layer}`);
  }
  return document;
};
const pinnedDesign = () => {
  const document = readPinnedRebuildDesign();
  if (!isPinnedDocument(document)) {
    throw new Error(`pinned rebuild design refused: ${document.code} at ${document.layer}`);
  }
  return document;
};

/** Admits any synthetic document by handing in ITS OWN true digest, never the pin. */
const openSynthetic = (text: string) => {
  const bytes = utf8(text);
  const opened = readPinnedSource(bytes, sha256Of(bytes));
  if (!isPinnedSource(opened)) throw new Error(`synthetic document refused: ${opened.code}`);
  return opened;
};

describe("pinned-bytes gate (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("refuses SPEC_BYTES_UNPINNED at PRE_FREEZE_AUDIT before parsing anything", () => {
    const refusal = readPinnedSource(utf8("not the spec"), PINNED_BENCHMARK_SPEC_SHA256);
    expect(isPinnedSource(refusal)).toBe(false);
    if (isPinnedSource(refusal)) throw new Error("unreachable");
    expect(refusal.code).toBe("SPEC_BYTES_UNPINNED");
    expect(refusal.layer).toBe("PRE_FREEZE_AUDIT");
    expect(refusal.line).toBe(0);
    expect(refusal.ok).toBe(false);
  });

  it.runIf(HAS_EXPLICIT_PIN_ROOT)("refuses a one-byte edit of the real pinned spec", () => {
    const real = pinnedSpec();
    const mutated = utf8(`${new TextDecoder().decode(real.bytes)} `);
    const refusal = readPinnedSource(mutated, PINNED_BENCHMARK_SPEC_SHA256);
    expect(isPinnedSource(refusal)).toBe(false);
    if (isPinnedSource(refusal)) throw new Error("unreachable");
    expect(refusal.code).toBe("SPEC_BYTES_UNPINNED");
  });

  it.runIf(HAS_EXPLICIT_PIN_ROOT)(
    "admits the real pinned documents at their epic-rail digests", () => {
    const spec = pinnedSpec();
    const design = pinnedDesign();
    expect(spec.source.sha256).toBe(PINNED_BENCHMARK_SPEC_SHA256);
    expect(design.source.sha256).toBe(PINNED_REBUILD_DESIGN_SHA256);
    expect(PINNED_BENCHMARK_SPEC_SHA256)
      .toBe("a62b90436cc0b911fb28526af7b7e0f2d1370f6f93db91c26077f6e2956a589c");
    expect(PINNED_REBUILD_DESIGN_SHA256)
      .toBe("1d9d1ec97d3f07247fbbc088045e0ba2fd6da8307f10a9026c55106419383191");
    // `wc -l` reports 523 newline-terminated lines; splitting a trailing newline yields a
    // 524th empty element. Pinned here rather than rounded off, because `lines[n - 1]` is
    // physical line `n` and every reported source location depends on that holding.
    expect(spec.source.lines.length).toBe(524);
    expect(spec.source.lines[523]).toBe("");
    expect(spec.source.lines[7]).toContain("pre-freeze reference lint");
    expect(spec.source.lines[435]).toContain("Mechanical namespace and reference audit");
    },
  );

  it("rejects a hand-forged source, so the hash gate is not merely advisory", () => {
    const forged = { lines: ["a"], sha256: PINNED_BENCHMARK_SPEC_SHA256, text: "a" };
    expect(isPinnedSource(forged as unknown as PinnedSource)).toBe(false);
    expect(Object.getOwnPropertySymbols(openSynthetic("verified\n"))).toContain(PINNED_SOURCE_BRAND);
  });

  it("hashes the raw bytes as read, so CRLF is never normalised away", () => {
    const crlf = utf8("a\r\nb\r\n");
    const lf = utf8("a\nb\n");
    expect(sha256Of(crlf)).not.toBe(sha256Of(lf));
    const opened = readPinnedSource(crlf, sha256Of(crlf));
    if (!isPinnedSource(opened)) throw new Error("unreachable");
    expect(opened.sha256).toBe(sha256Of(crlf));
    expect(opened.lines[0]).toBe("a");
    expect(opened.lines[1]).toBe("b");
  });
});

describe("range expansion (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it("expands an endpoint pair to every member, never to the two endpoints", () => {
    const members = expandFamilyRange("CORE-I", 1, 22);
    expect(members).toEqual(Array.from({ length: 22 }, (_, i) => `CORE-I${i + 1}`));
    expect(members?.length).toBe(22);
  });

  it("refuses a malformed range instead of silently emitting a short set", () => {
    expect(expandFamilyRange("CORE-I", 22, 1)).toBeNull();
    expect(expandFamilyRange("CORE-I", 0, 4)).toBeNull();
    expect(expandFamilyRange("CORE-I", 1, 1)).toEqual(["CORE-I1"]);
  });

  it("refuses an absurd span instead of allocating it", () => {
    expect(expandFamilyRange("CORE-I", 1, EXPANDED_RANGE_SPAN_CAP)?.length)
      .toBe(EXPANDED_RANGE_SPAN_CAP);
    expect(expandFamilyRange("CORE-I", 1, EXPANDED_RANGE_SPAN_CAP + 1)).toBeNull();
    expect(expandFamilyRange("CORE-I", 1, 999_999_999)).toBeNull();
  });

  it.each([
    ["U+2026 ellipsis", "`CORE-I1`…`CORE-I22`"],
    ["U+2013 en dash", "`CORE-I1`–`CORE-I22`"],
    ["U+2014 em dash", "`CORE-I1`—`CORE-I22`"],
    ["ASCII dot-dot", "CORE-I1..CORE-I22"],
    ["brace range", "`CORE-I{1..22}`"],
  ])("expands the %s spelling to all 22 members", (_label, written) => {
    const source = openSynthetic(`intro\n${written}\n`);
    const uses = collectFamilyUses(source, "CORE-I");
    expect(new Set(uses.map((use) => use.text)).size).toBe(22);
    expect(uses.every((use) => use.line === 2)).toBe(true);
  });

  it.runIf(HAS_EXPLICIT_PIN_ROOT)(
    "expands every range spelling the pinned spec actually uses", () => {
    const { source } = pinnedSpec();
    for (const family of ["CORE-I", "CORE-S", "BENCH-S"] as const) {
      const uses = collectFamilyUses(source, family);
      expect(uses.length).toBeGreaterThan(0);
      expect(new Set(uses.map((use) => use.text)).size)
        .toBe(family === "CORE-I" ? 22 : 14);
    }
    },
  );

  it.runIf(HAS_EXPLICIT_PIN_ROOT)(
    "proves the endpoint-pair trap is live: literal tokens alone are 2 of 22", () => {
    const { source } = pinnedSpec();
    const literal = new Set(
      source.text.match(/CORE-I\d+/g) ?? [],
    );
    expect(literal).toEqual(new Set(["CORE-I1", "CORE-I22"]));
    },
  );
});

describe("token collection with source locations (task-71a4fac5d15044c08f6617f50a561e39)", () => {
  it.runIf(HAS_EXPLICIT_PIN_ROOT)(
    "locates every definition anchor in both pinned documents", () => {
    const { source: spec } = pinnedSpec();
    const { source: design } = pinnedDesign();
    expect(collectFamilyDefinitions(spec, "BENCH-S").length).toBe(14);
    expect(collectFamilyDefinitions(design, "CORE-I").length).toBe(22);
    expect(collectFamilyDefinitions(design, "CORE-S").length).toBe(14);
    const first = collectFamilyDefinitions(spec, "BENCH-S")[0];
    expect(first).toEqual({ line: 176, text: "BENCH-S1" });
    },
  );

  it.runIf(HAS_EXPLICIT_PIN_ROOT)(
    "finds the twenty gate IDs used in the pinned spec, with locations", () => {
    const { source } = pinnedSpec();
    const uses = collectGateIdUses(source);
    expect(new Set(uses.map((use) => use.text)).size).toBe(20);
    expect(uses.every((use) => use.line >= 1 && use.line <= 523)).toBe(true);
    },
  );

  it.runIf(HAS_EXPLICIT_PIN_ROOT)(
    "reports the pinned spec free of bare S/I tokens, as spec:62 requires", () => {
    const { source } = pinnedSpec();
    expect(collectBareScenarioTokens(source)).toEqual([]);
    },
  );

  it("is not blind: a planted bare token is located exactly", () => {
    const source = openSynthetic("line one\nthe oracle for S3 is sealed\n");
    expect(collectBareScenarioTokens(source)).toEqual([{ line: 2, text: "S3" }]);
  });

  it("does not mistake the `S{1..14}` prohibition notation for a bare token", () => {
    const source = openSynthetic("no bare `S{1..14}` or `I{1..22}` reference appears\n");
    expect(collectBareScenarioTokens(source)).toEqual([]);
  });

  it("does not mistake a prefixed token for a bare one", () => {
    const source = openSynthetic("CORE-S3 and BENCH-S3 and CORE-I7\n");
    expect(collectBareScenarioTokens(source)).toEqual([]);
  });

  it.runIf(HAS_EXPLICIT_PIN_ROOT)(
    "collects section pointers and numbered headings separately", () => {
    const { source } = pinnedSpec();
    const pointers = new Set(collectSectionPointers(source).map((p) => p.text));
    const headings = new Set(collectHeadingNumbers(source).map((h) => h.text));
    expect(pointers.size).toBeGreaterThan(0);
    expect(headings).toContain("12.1");
    expect(headings).toContain("0");
    for (const pointer of pointers) expect(headings).toContain(pointer);
    },
  );
});
