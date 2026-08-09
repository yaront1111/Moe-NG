import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SOURCE_MANIFEST_VERSION } from "./import-contract.js";
import { buildSourceManifest } from "./source-manifest.js";
import type { SourceManifest } from "./source-manifest.js";

/**
 * Design §21.2: "Before import, hash every source file and emit a manifest; never change
 * source content or mtime intentionally."
 *
 * Two properties decide this module, and neither is provable by reading the code:
 *   ORDER — `readdir` order varies by filesystem, platform and inode reuse, so the
 *           manifest must impose its own total order. A wrong sort reproduces on nobody's
 *           machine except in CI, months later.
 *   READ-ONLY — proven by measuring digest AND mtime before and after, because a tool
 *           that rewrites a file with identical bytes still bumps mtime.
 */

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { force: true, recursive: true });
  }
});

/** Builds a temp tree. Files are written in a deliberately unsorted creation order. */
function tree(files: readonly (readonly [path: string, body: string])[]): string {
  const root = mkdtempSync(join(tmpdir(), "moe-import-"));
  roots.push(root);
  for (const [path, body] of files) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const SAMPLE = Object.freeze([
  ["zeta.json", '{"id":"z"}'],
  ["alpha.json", '{"id":"a"}'],
  ["nested/mid.json", '{"id":"m"}'],
  ["nested/deep/leaf.json", '{"id":"l"}'],
] as const);

function manifestOf(result: ReturnType<typeof buildSourceManifest>): SourceManifest {
  if ("outcome" in result) {
    throw new Error(`expected a manifest, got ${result.code}/${result.layer}`);
  }
  return result;
}

/** Digest + mtime of every file, which together prove the tree was not written to. */
function snapshot(root: string, paths: readonly string[]): readonly string[] {
  return paths.map((path) => {
    const stat = statSync(join(root, path));
    return `${path}:${String(stat.mtimeMs)}:${String(stat.size)}`;
  });
}

describe("the manifest imposes its own total order", () => {
  it("sorts entries by path regardless of creation or readdir order", () => {
    const manifest = manifestOf(buildSourceManifest(tree(SAMPLE)));
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "alpha.json",
      "nested/deep/leaf.json",
      "nested/mid.json",
      "zeta.json",
    ]);
    expect(manifest.version).toBe(SOURCE_MANIFEST_VERSION);
  });

  it("sorts by CODE UNIT, which differs from the host's case-insensitive listing", () => {
    // The only fixture on Windows that can tell the two apart. NTFS hands back
    // directory entries case-insensitively (alpha, Beta), while code-unit order puts
    // uppercase first ("B" is 0x42, "a" is 0x61). An all-lowercase fixture cannot
    // distinguish a working comparator from a neutered one on this filesystem, so
    // without this case the sort looks tested here and is not.
    const manifest = manifestOf(buildSourceManifest(tree([
      ["alpha.json", "{}"],
      ["Beta.json", "{}"],
      ["Zulu.json", "{}"],
      ["mid.json", "{}"],
    ])));
    expect(manifest.entries.map((entry) => entry.path))
      .toEqual(["Beta.json", "Zulu.json", "alpha.json", "mid.json"]);
  });

  it("uses forward slashes so a manifest does not depend on the host separator", () => {
    const manifest = manifestOf(buildSourceManifest(tree(SAMPLE)));
    for (const entry of manifest.entries) {
      expect(entry.path).not.toContain("\\");
    }
  });

  it("produces the identical digest for two trees with the same bytes", () => {
    // Different temp directories and different creation order: only the bytes match.
    const first = manifestOf(buildSourceManifest(tree(SAMPLE)));
    const second = manifestOf(buildSourceManifest(tree([...SAMPLE].reverse())));
    expect(second.digest).toBe(first.digest);
    expect(second.entries).toEqual(first.entries);
  });

  it("produces a different digest when one byte differs", () => {
    // The negative control. Without it the digest could ignore content entirely.
    const base = manifestOf(buildSourceManifest(tree(SAMPLE)));
    const changed = manifestOf(buildSourceManifest(tree([
      ["zeta.json", '{"id":"Z"}'],
      ["alpha.json", '{"id":"a"}'],
      ["nested/mid.json", '{"id":"m"}'],
      ["nested/deep/leaf.json", '{"id":"l"}'],
    ])));
    expect(changed.digest).not.toBe(base.digest);
  });

  it("records a safe-integer size and a 64-hex digest for every entry", () => {
    const manifest = manifestOf(buildSourceManifest(tree(SAMPLE)));
    expect(manifest.entries.length).toBe(4);
    for (const entry of manifest.entries) {
      expect(Number.isSafeInteger(entry.size)).toBe(true);
      expect(entry.digest).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe("the source tree is never written to", () => {
  it("leaves every file's mtime and size unchanged across a manifest build", () => {
    const root = tree(SAMPLE);
    const paths = SAMPLE.map(([path]) => path);
    const before = snapshot(root, paths);
    buildSourceManifest(root);
    expect(snapshot(root, paths)).toEqual(before);
  });

  it("leaves the tree unchanged even when the build refuses", () => {
    const root = tree(SAMPLE);
    const paths = SAMPLE.map(([path]) => path);
    const before = snapshot(root, paths);
    const result = buildSourceManifest(join(root, "no-such-subtree"));
    expect("outcome" in result).toBe(true);
    expect(snapshot(root, paths)).toEqual(before);
  });
});

describe("refusals name their code and layer", () => {
  it("refuses a root that does not exist", () => {
    const result = buildSourceManifest(join(tmpdir(), "moe-import-absent-root-fixture"));
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_ROOT_INVALID");
    expect(result.layer).toBe("INPUT");
  });

  it("refuses an empty tree rather than reporting an import of nothing", () => {
    const result = buildSourceManifest(tree([]));
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_MANIFEST_EMPTY");
    expect(result.layer).toBe("MANIFEST");
  });
});
