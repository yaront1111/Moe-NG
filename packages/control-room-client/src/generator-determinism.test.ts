import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { emitGeneratedClient } from "../generator/generate.js";

const COMMITTED_DIR = fileURLToPath(new URL("./generated/", import.meta.url));
const CARRIAGE_RETURN = 0x0d;

/**
 * Emission targets `os.tmpdir()` only. Writing scratch output anywhere under the repo
 * root is unsafe: the wrapper auto-commit sweeps transient strays. A `git diff` oracle
 * is equally unsafe here because HEAD moves under concurrent workers.
 */
function emitIntoTemp(): { readonly dir: string; readonly files: readonly string[] } {
  const dir = mkdtempSync(join(tmpdir(), "moe-control-room-client-"));
  return { dir, files: emitGeneratedClient(dir) };
}

it("emits byte-identical output on repeated runs", () => {
  const first = emitIntoTemp();
  const second = emitIntoTemp();
  try {
    expect(first.files).toEqual(second.files);
    expect(first.files.length).toBeGreaterThan(0);
    for (const name of first.files) {
      expect(readFileSync(join(first.dir, name))).toEqual(readFileSync(join(second.dir, name)));
    }
  } finally {
    rmSync(first.dir, { force: true, recursive: true });
    rmSync(second.dir, { force: true, recursive: true });
  }
});

it("matches the committed generated output byte for byte", () => {
  const emitted = emitIntoTemp();
  try {
    for (const name of emitted.files) {
      const fresh = readFileSync(join(emitted.dir, name));
      const committed = readFileSync(join(COMMITTED_DIR, name));
      expect(committed.equals(fresh)).toBe(true);
    }
  } finally {
    rmSync(emitted.dir, { force: true, recursive: true });
  }
});

it("emits LF line endings only", () => {
  const emitted = emitIntoTemp();
  try {
    for (const name of emitted.files) {
      const bytes = readFileSync(join(emitted.dir, name));
      expect(bytes.includes(CARRIAGE_RETURN)).toBe(false);
      expect(readFileSync(join(COMMITTED_DIR, name)).includes(CARRIAGE_RETURN)).toBe(false);
    }
  } finally {
    rmSync(emitted.dir, { force: true, recursive: true });
  }
});
