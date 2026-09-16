import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeMission } from "./agent-wrapper.js";
import { NODE_TREES_DIRECTORY, forgetNodeTrees, nodeTreeName } from "./node-worktrees.js";
import { createNodeTreeMissions } from "./wrapper-node-trees.js";

const roots: string[] = [];
afterEach(() => {
  forgetNodeTrees();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-tree-missions-"))); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.email", "tree@example.test");
  git("config", "user.name", "Tree Fixture");
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "first");
  return root;
}
const brief = (workspace: string): NodeMission =>
  ({ instructions: "build it", test: "pnpm test", title: "a node", workspace });

/** The one place a node's workspace is chosen (owner decision 2026-09-16). */
describe("briefing a node into its own tree", () => {
  it("moves the mission into the node's tree and keeps everything else", () => {
    const root = project();
    const lines: string[] = [];

    const moved = createNodeTreeMissions((line) => lines.push(line))(brief(root), "node:v1:alpha");

    expect(moved).toMatchObject({ instructions: "build it", test: "pnpm test", title: "a node" });
    expect(moved?.workspace).toBe(join(root, NODE_TREES_DIRECTORY, nodeTreeName("node:v1:alpha")!));
    expect(lines).toEqual([]);
  }, 120_000);

  it("gives two nodes two different trees", () => {
    const root = project();
    const withTree = createNodeTreeMissions(() => {});

    const first = withTree(brief(root), "node:v1:one");
    const second = withTree(brief(root), "node:v1:two");

    expect(first?.workspace).not.toBe(second?.workspace);
    expect(second?.workspace).not.toBe(root);
  }, 120_000);

  it("leaves the mission on the project's workspace when no tree can be made, saying so once", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "moe-tree-missions-bare-"))); roots.push(outside);
    const lines: string[] = [];
    const withTree = createNodeTreeMissions((line) => lines.push(line));

    expect(withTree(brief(outside), "node:v1:bare")?.workspace).toBe(outside);
    expect(withTree(brief(outside), "node:v1:bare")?.workspace).toBe(outside);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no working tree of its own");
    expect(lines[0]).toContain(outside);
  }, 120_000);

  it("has no mission to move when the node has none", () => {
    expect(createNodeTreeMissions(() => {})(null, "node:v1:absent")).toBeNull();
  });
});
