import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listNodeSpecs } from "./node-spec-listing.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function specDir(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "moe-node-specs-"));
  cleanups.push(() => { rmSync(dir, { force: true, recursive: true }); });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
  return dir;
}

describe("listNodeSpecs", () => {
  it("keeps every well-formed spec when one file is malformed, and names the skipped one", () => {
    // One broken spec used to drop EVERY spec-dir node from the verifier and the lander.
    const dir = specDir({
      "a.json": '{"nodeRef":"node-a"}',
      "broken.json": "{not json",
      "c.json": '{"nodeRef":"node-c","objective":"x"}',
    });
    const listing = listNodeSpecs(dir);
    expect(listing.nodes).toEqual([{ nodeRef: "node-a" }, { nodeRef: "node-c" }]);
    expect(listing.skipped).toHaveLength(1);
    expect(listing.skipped[0]).toMatch(/^broken\.json: /);
    expect(Object.isFrozen(listing.nodes)).toBe(true);
  });

  it("ignores non-json files and specs that name no nodeRef, without reporting them as skipped", () => {
    const dir = specDir({
      "notes.txt": "nodeRef: node-z",
      "no-ref.json": '{"objective":"x"}',
      "array.json": '[{"nodeRef":"node-in-array"}]',
      "ok.json": '{"nodeRef":"node-ok"}',
    });
    expect(listNodeSpecs(dir)).toEqual({ nodes: [{ nodeRef: "node-ok" }], skipped: [] });
  });

  it("contributes nothing for a directory that cannot be read", () => {
    const parent = specDir({});
    mkdirSync(join(parent, "gone"));
    rmSync(join(parent, "gone"), { recursive: true });
    expect(listNodeSpecs(join(parent, "gone"))).toEqual({ nodes: [], skipped: [] });
  });
});
