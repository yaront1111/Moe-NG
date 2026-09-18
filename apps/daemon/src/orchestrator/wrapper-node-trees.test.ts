import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeMission } from "./agent-wrapper.js";
import { NODE_TREES_DIRECTORY, forgetNodeTrees, nodeTreeName } from "./node-worktrees.js";
import { createNodeTreeMissions, nodeWorkspaceOf } from "./wrapper-node-trees.js";

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
/** No node holds the project checkout unless a case says so. */
const unheld = () => null;

/** The one place a node's workspace is chosen (owner decision 2026-09-16). */
describe("briefing a node into its own tree", () => {
  it("moves the mission into the node's tree and keeps everything else", () => {
    const root = project();
    const lines: string[] = [];

    const moved = createNodeTreeMissions((line) => lines.push(line), unheld)(brief(root), "node:v1:alpha");

    expect(moved).toMatchObject({ instructions: "build it", test: "pnpm test", title: "a node" });
    expect(moved?.workspace).toBe(join(root, NODE_TREES_DIRECTORY, nodeTreeName("node:v1:alpha")!));
    expect(lines).toEqual([]);
  }, 120_000);

  it("gives two nodes two different trees", () => {
    const root = project();
    const withTree = createNodeTreeMissions(() => {}, unheld);

    const first = withTree(brief(root), "node:v1:one");
    const second = withTree(brief(root), "node:v1:two");

    expect(first?.workspace).not.toBe(second?.workspace);
    expect(second?.workspace).not.toBe(root);
  }, 120_000);

  it("leaves the mission on the project's workspace when no tree can be made, saying so once", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "moe-tree-missions-bare-"))); roots.push(outside);
    const lines: string[] = [];
    const withTree = createNodeTreeMissions((line) => lines.push(line), unheld);

    expect(withTree(brief(outside), "node:v1:bare")?.workspace).toBe(outside);
    expect(withTree(brief(outside), "node:v1:bare")?.workspace).toBe(outside);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no working tree of its own");
    expect(lines[0]).toContain(outside);
  }, 120_000);

  it("leaves a node that already holds the project checkout where it is, saying so once", () => {
    const root = project();
    const lines: string[] = [];
    const withTree = createNodeTreeMissions((line) => lines.push(line), () => "node:v1:holding");

    // Its verifier and lander look at the checkout it holds; moving it now would strand that work.
    expect(withTree(brief(root), "node:v1:holding")?.workspace).toBe(root);
    expect(withTree(brief(root), "node:v1:holding")?.workspace).toBe(root);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the checkout it already holds");

    // A different node is not holding anything of its own: it takes its tree now.
    expect(withTree(brief(root), "node:v1:other")?.workspace).not.toBe(root);
  }, 120_000);

  it("has no mission to move when the node has none", () => {
    expect(createNodeTreeMissions(() => {}, unheld)(null, "node:v1:absent")).toBeNull();
  });

  /** Review evidence is captured here, so it must be the SAME answer the mission got. */
  it("names, without making anything, the workspace the mission was briefed into", () => {
    const root = project();
    // No tree yet: the project, and asking made none.
    expect(nodeWorkspaceOf(root, "node:v1:alpha", unheld)).toBe(root);
    const moved = createNodeTreeMissions(() => {}, unheld)(brief(root), "node:v1:alpha");
    expect(moved?.workspace).not.toBe(root);
    // Briefed into a tree: the evidence is captured from that tree, not the shared checkout.
    expect(nodeWorkspaceOf(root, "node:v1:alpha", unheld)).toBe(moved?.workspace);
    expect(nodeWorkspaceOf(root, "node:v1:beta", unheld)).toBe(root);
    // A node finishing in the checkout it holds stays there even though a tree of its exists.
    expect(nodeWorkspaceOf(root, "node:v1:alpha", () => "node:v1:alpha")).toBe(root);
  }, 120_000);
});
