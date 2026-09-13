import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { replaceRuntimeExcludeBlock } from "./runtime-metadata-exclude-file.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-exclude-file-")); roots.push(root); return join(root, "exclude");
}
it("refuses an inline end marker without consuming foreign bytes or leaving its lock", () => {
  const path = fixture();
  const original = "# operator\n# moe-runtime key begin\n/runtime\nforeign-rule# moe-runtime key end\n";
  writeFileSync(path, original);
  expect(() => replaceRuntimeExcludeBlock(path, "key", ["/next"])).toThrow();
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(existsSync(`${path}.lock`)).toBe(false);
});
it("retains unrelated non-UTF8 bytes when replacing only a valid managed block", () => {
  const path = fixture(); const foreign = Buffer.from([35, 32, 255, 254, 10]);
  writeFileSync(path, foreign); replaceRuntimeExcludeBlock(path, "key", ["/runtime"]);
  replaceRuntimeExcludeBlock(path, "key", ["/next"]);
  expect(readFileSync(path).subarray(0, foreign.length)).toEqual(foreign);
  expect(readFileSync(path).subarray(foreign.length).toString()).toBe("# moe-runtime key begin\n/next\n# moe-runtime key end\n");
});
it("refuses an unusable exclusion target and cleans only its own lock", () => {
  const path = fixture(); mkdirSync(path);
  expect(() => replaceRuntimeExcludeBlock(path, "key", ["/runtime"])).toThrow();
  expect(existsSync(path)).toBe(true);
  expect(existsSync(`${path}.lock`)).toBe(false);
});
