import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("links are never followed out of the frozen tree", () => {
  it("refuses a junction/symlink inside the tree rather than reading through it", () => {
    // The phase-0/1 contract: reject symlink/reparse escapes, fail closed. A junction
    // needs no admin rights on Windows, and `symlinkSync(..., "junction")` degrades to a
    // plain directory symlink elsewhere, so the fixture is portable. Following the link
    // would hash bytes wholly outside the frozen root and give them provenance.
    const outside = mkdtempSync(join(tmpdir(), "moe-import-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.txt"), "bytes outside the frozen tree");
    const root = tree([["real.json", '{"id":"r"}']]);
    symlinkSync(outside, join(root, "esc"), "junction");
    const result = buildSourceManifest(root);
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_SOURCE_UNREADABLE");
    expect(result.layer).toBe("MANIFEST");
    // The refusal names the link, so an operator can find and remove it.
    expect(result.detail).toContain("esc");
  });
});

/**
 * Spelled from code points so the source file itself stays ASCII: "e" followed by
 * COMBINING ACUTE ACCENT is the NFD spelling, LATIN SMALL LETTER E WITH ACUTE the NFC one.
 * They render identically and are different files on NTFS and ext4.
 */
const E_ACUTE_NFD = `e${String.fromCharCode(0x0301)}`;
const E_ACUTE_NFC = String.fromCharCode(0x00e9);

describe("every recorded path is readable by its recorded spelling", () => {
  it("refuses a file whose on-disk name is not NFC rather than recording a path it cannot re-read", () => {
    // The manifest records NFC. On a normalization-sensitive filesystem the NFD file hashes
    // cleanly and then ENOENTs when the decoder re-reads it by the recorded spelling, so
    // the refusal has to happen here, where the raw name is still in hand.
    const result = buildSourceManifest(tree([
      [`caf${E_ACUTE_NFD}.json`, '{"id":"c"}'],
      ["plain.json", '{"id":"p"}'],
    ]));
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_SOURCE_UNREADABLE");
    expect(result.layer).toBe("MANIFEST");
    expect(result.detail).toContain("NFC");
    expect(result.detail).toContain(`caf${E_ACUTE_NFC}.json`);
  });

  it("refuses a directory spelled in NFD the same way, since it prefixes every path below it", () => {
    const result = buildSourceManifest(tree([[`${E_ACUTE_NFD}dir/leaf.json`, "{}"]]));
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_SOURCE_UNREADABLE");
    expect(result.layer).toBe("MANIFEST");
    expect(result.detail).toContain(`${E_ACUTE_NFC}dir`);
  });

  it("still admits an accented name that is already NFC", () => {
    // The positive control: the refusal is about spelling, not about non-ASCII names.
    const manifest = manifestOf(buildSourceManifest(tree([[`caf${E_ACUTE_NFC}.json`, "{}"]])));
    expect(manifest.entries.map((entry) => entry.path)).toEqual([`caf${E_ACUTE_NFC}.json`]);
  });

  it("refuses two siblings that would record one manifest path", () => {
    // Provenance binds a record to its entry by path lookup, so two files behind one
    // recorded path would bind every record to whichever sorted first and leave the other
    // file's bytes with no provenance. Neither spelling may win.
    const result = buildSourceManifest(tree([
      [`${E_ACUTE_NFD}.json`, '{"id":"nfd"}'],
      [`${E_ACUTE_NFC}.json`, '{"id":"nfc"}'],
    ]));
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_SOURCE_UNREADABLE");
    expect(result.layer).toBe("MANIFEST");
    expect(result.detail).toContain(`${E_ACUTE_NFC}.json`);
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
