import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { nodeSpecLoader } from "./node-spec-loader.js";
import { COMPILED_EXECUTION_REF_PREFIX } from "./orchestrator/compiled-execution-ref.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? "", { force: true, recursive: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-node-specs-"));
  roots.push(root);
  return root;
}

function harness(directory: string): { readonly lines: string[]; readonly load: () => readonly { nodeRef: string }[] } {
  const lines: string[] = [];
  return { lines, load: nodeSpecLoader(directory, (line) => { lines.push(line); }) };
}

describe("nodeSpecLoader", () => {
  it("loads a well-formed spec with no dependencies, and says nothing", () => {
    const dir = scratch();
    writeFileSync(join(dir, "alpha.json"), JSON.stringify({ nodeRef: "node-alpha", title: "Alpha" }), "utf8");
    const { lines, load } = harness(dir);

    expect(load()).toEqual([{ dependsOn: [], nodeRef: "node-alpha", title: "Alpha" }]);
    expect(lines).toEqual([]);
  });

  it("says which spec it skipped and why, once per distinct line across repeated loads", () => {
    const dir = scratch();
    writeFileSync(join(dir, "broken.json"), "{ not json", "utf8");
    writeFileSync(join(dir, "untitled.json"), JSON.stringify({ nodeRef: "node-untitled" }), "utf8");
    writeFileSync(join(dir, "compiled.json"),
      JSON.stringify({ nodeRef: `${COMPILED_EXECUTION_REF_PREFIX}x`, title: "Forged" }), "utf8");
    writeFileSync(join(dir, "list.json"), "[]", "utf8");
    writeFileSync(join(dir, "good.json"), JSON.stringify({ nodeRef: "node-good", title: "Good" }), "utf8");
    const { lines, load } = harness(dir);

    expect(load().map((spec) => spec.nodeRef)).toEqual(["node-good"]);
    expect(load().map((spec) => spec.nodeRef)).toEqual(["node-good"]);

    expect(lines).toHaveLength(4);
    expect(lines.find((line) => line.startsWith("node spec skipped: broken.json: "))).toBeDefined();
    expect(lines).toContain("node spec skipped: compiled.json: COMPILED_EXECUTION_REF_RESERVED");
    expect(lines).toContain("node spec skipped: list.json: not an object");
    expect(lines).toContain("node spec skipped: untitled.json: title missing");
  });

  it("answers an empty list for an unreadable directory and says so, with the errno", () => {
    const missing = join(scratch(), "no-such-dir");
    const { lines, load } = harness(missing);

    expect(load()).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^node specs directory unreadable: .*no-such-dir: ENOENT: /u);
  });

  it("answers the same lists with no reporter, and keeps answering when the reporter throws", () => {
    const dir = scratch();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "broken.json"), "{", "utf8");
    writeFileSync(join(dir, "good.json"), JSON.stringify({ nodeRef: "node-good", title: "Good" }), "utf8");

    expect(nodeSpecLoader(dir)().map((spec) => spec.nodeRef)).toEqual(["node-good"]);
    expect(nodeSpecLoader(dir, () => { throw new Error("sink closed"); })().map((spec) => spec.nodeRef))
      .toEqual(["node-good"]);
  });
});
