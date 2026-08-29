import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PINNED_BENCHMARK_SPEC_RELATIVE_PATH, PINNED_DOCUMENT_ROOT_ENV,
  PINNED_REBUILD_DESIGN_RELATIVE_PATH, isPinnedDocument, readPinnedBenchmarkSpec,
  readPinnedRebuildDesign,
} from "./pre-freeze-pinned-documents.js";

const originalRoot = process.env[PINNED_DOCUMENT_ROOT_ENV];
const directories: string[] = [];

afterEach(() => {
  if (originalRoot === undefined) delete process.env[PINNED_DOCUMENT_ROOT_ENV];
  else process.env[PINNED_DOCUMENT_ROOT_ENV] = originalRoot;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function expectRootRequired(result: ReturnType<typeof readPinnedBenchmarkSpec>): void {
  expect(isPinnedDocument(result)).toBe(false);
  if (isPinnedDocument(result)) throw new Error("an absent root admitted a pinned document");
  expect(result).toEqual({
    code: "SPEC_UNPARSEABLE",
    layer: "PRE_FREEZE_AUDIT",
    line: 0,
    ok: false,
    token: PINNED_DOCUMENT_ROOT_ENV,
  });
}

describe("portable pinned-document root", () => {
  it("refuses when no explicit source root is configured", () => {
    delete process.env[PINNED_DOCUMENT_ROOT_ENV];

    expectRootRequired(readPinnedBenchmarkSpec());
    expectRootRequired(readPinnedRebuildDesign());
  });

  it("treats a whitespace-only source root as absent", () => {
    process.env[PINNED_DOCUMENT_ROOT_ENV] = " \t ";

    expectRootRequired(readPinnedBenchmarkSpec());
  });

  it("uses an explicit portable root and still enforces both document digests", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-benchmark-pins-"));
    directories.push(root);
    for (const relativePath of [
      PINNED_BENCHMARK_SPEC_RELATIVE_PATH,
      PINNED_REBUILD_DESIGN_RELATIVE_PATH,
    ]) {
      const path = join(root, ...relativePath.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `tampered ${relativePath}\n`, "utf8");
    }
    process.env[PINNED_DOCUMENT_ROOT_ENV] = root;

    const benchmark = readPinnedBenchmarkSpec();
    const design = readPinnedRebuildDesign();
    expect(isPinnedDocument(benchmark)).toBe(false);
    expect(isPinnedDocument(design)).toBe(false);
    if (isPinnedDocument(benchmark) || isPinnedDocument(design)) {
      throw new Error("tampered explicit documents were admitted");
    }
    expect(benchmark.code).toBe("SPEC_BYTES_UNPINNED");
    expect(design.code).toBe("SPEC_BYTES_UNPINNED");
  });

  it("contains no host-specific absolute-path fallback in the production reader", () => {
    const source = readFileSync(
      new URL("./pre-freeze-pinned-documents.ts", import.meta.url), "utf8",
    );

    expect(source).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(source).not.toContain("projexts");
  });
});
