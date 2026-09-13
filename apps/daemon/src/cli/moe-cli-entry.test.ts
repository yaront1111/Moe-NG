import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { isMainModule } from "./moe-cli-entry.js";

const OWN_PATH = fileURLToPath(import.meta.url);
const OWN_META = Object.freeze({ url: import.meta.url });
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { force: true, recursive: true });
});

describe("isMainModule", () => {
  it("trusts import.meta.main whenever the runtime provides it", () => {
    expect(isMainModule({ main: true, url: import.meta.url }, undefined)).toBe(true);
    expect(isMainModule({ main: false, url: import.meta.url }, OWN_PATH)).toBe(false);
  });

  it("falls back to argv[1] naming this file when the flag is absent, as on Node 24.0-24.1", () => {
    expect(isMainModule(OWN_META, OWN_PATH)).toBe(true);
    expect(isMainModule(OWN_META, relative(process.cwd(), OWN_PATH))).toBe(true);
  });

  it("answers false when argv[1] names another file or nothing at all", () => {
    expect(isMainModule(OWN_META, join(OWN_PATH, "..", "moe-cli-main.ts"))).toBe(false);
    expect(isMainModule(OWN_META, undefined)).toBe(false);
  });

  it("compares case-insensitively on win32 only, where the file system does", () => {
    // A file that does not exist: the real-path fallback cannot answer for it (on a Windows
    // host it would resolve the case of a file that does), so only the platform rule decides.
    const missing = join(tmpdir(), "moe-cli-entry-missing", "Entry.ts");
    const meta = { url: pathToFileURL(missing).href };
    expect(isMainModule(meta, missing.toUpperCase(), "win32")).toBe(true);
    expect(isMainModule(meta, missing.toUpperCase(), "linux")).toBe(false);
  });

  it.runIf(process.platform === "win32")("recognizes the entry through a directory junction", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-cli-entry-"));
    scratch.push(root);
    const real = join(root, "real");
    mkdirSync(real);
    writeFileSync(join(real, "entry.ts"), "", "utf8");
    const link = join(root, "link");
    symlinkSync(real, link, "junction");
    const meta = { url: pathToFileURL(join(real, "entry.ts")).href };
    expect(isMainModule(meta, join(link, "entry.ts"))).toBe(true);
    expect(isMainModule(meta, join(link, "other.ts"))).toBe(false);
  });
});

describe("moe-cli-main entry guard", () => {
  // A TEXT pin, on purpose. The guard's only observable difference is on a Node that loads
  // .ts yet lacks import.meta.main (23.6-23.11, 24.0-24.1), and no such Node runs here: under
  // vitest the old `meta.main === true` guard and isMainModule both answer false, so no
  // behavioural test in this suite can tell them apart. Reading the source can.
  it("decides the entry with isMainModule, and the flag-only guard is gone", () => {
    const source = readFileSync(join(import.meta.dirname, "moe-cli-main.ts"), "utf8");
    expect(source).toContain('import { isMainModule } from "./moe-cli-entry.js";');
    expect(source).toContain("if (isMainModule(import.meta, process.argv[1])) {");
    expect(source).not.toContain("meta.main === true");
  });
});
