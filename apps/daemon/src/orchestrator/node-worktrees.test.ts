import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NODE_TREES_DIRECTORY, ensureNodeTree, forgetNodeTrees, nodeTreeName } from "./node-worktrees.js";

const roots: string[] = [];
afterEach(() => {
  forgetNodeTrees();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-node-trees-"))); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.email", "tree@example.test");
  git("config", "user.name", "Tree Fixture");
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "first");
  return root;
}
const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

/** One working tree per node, so nodes hold their own checkouts (owner decision 2026-09-16). */
describe("a node's own working tree", () => {
  it("names a tree readably, stably and distinctly per node", () => {
    const compiled = nodeTreeName("node:v1:a1b2c3");
    expect(compiled).toBe(nodeTreeName("node:v1:a1b2c3"));
    expect(compiled).toMatch(/^node-v1-a1b2c3-[0-9a-f]{8}$/u);
    expect(nodeTreeName("node:v1:a1b2c4")).not.toBe(compiled);
    expect(nodeTreeName("uai-r2-registry-release")).toMatch(/^uai-r2-registry-release-[0-9a-f]{8}$/u);
    // A long ref keeps a readable head and stays a single path segment.
    const long = nodeTreeName(`node:v1:${"f".repeat(200)}`);
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(49);
    expect(long).not.toContain("/");
  });

  it.each(["", "   ", "publish:decision-1", "criterion:node-1"])("names no tree for %j", (nodeRef) => {
    expect(nodeTreeName(nodeRef)).toBeNull();
  });

  it("makes the tree on its own branch, cut from the project's branch, and reuses it", () => {
    const root = project();
    const base = gitIn(root, "rev-parse", "HEAD");

    const tree = ensureNodeTree({ nodeRef: "node:v1:abc", projectRoot: root });

    expect(tree).not.toBeNull();
    expect(tree!.path).toBe(join(root, NODE_TREES_DIRECTORY, nodeTreeName("node:v1:abc")!));
    expect(existsSync(join(tree!.path, "README.md"))).toBe(true);
    expect(gitIn(tree!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(tree!.branch);
    expect(gitIn(tree!.path, "rev-parse", "HEAD")).toBe(base);
    // The project's own checkout keeps its branch: the node works beside it, not on it.
    expect(gitIn(root, "rev-parse", "--abbrev-ref", "HEAD")).not.toBe(tree!.branch);

    expect(ensureNodeTree({ nodeRef: "node:v1:abc", projectRoot: root })).toEqual(tree);
  }, 120_000);

  it("keeps each node's work on its own branch", () => {
    const root = project();
    const first = ensureNodeTree({ nodeRef: "node:v1:one", projectRoot: root });
    const second = ensureNodeTree({ nodeRef: "node:v1:two", projectRoot: root });
    if (first === null || second === null) throw new Error("expected two trees");

    writeFileSync(join(first.path, "one.txt"), "first node\n", "utf8");
    execFileSync("git", ["add", "one.txt"], { cwd: first.path, windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "-m", "one"], { cwd: first.path, windowsHide: true, stdio: "ignore" });

    expect(first.path).not.toBe(second.path);
    expect(existsSync(join(second.path, "one.txt"))).toBe(false);
    expect(gitIn(root, "rev-parse", first.branch)).not.toBe(gitIn(root, "rev-parse", second.branch));
  }, 120_000);

  it("reuses a branch a node already landed work on", () => {
    const root = project();
    const tree = ensureNodeTree({ nodeRef: "node:v1:kept", projectRoot: root });
    if (tree === null) throw new Error("expected a tree");
    writeFileSync(join(tree.path, "kept.txt"), "landed\n", "utf8");
    execFileSync("git", ["add", "kept.txt"], { cwd: tree.path, windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "-m", "landed"], { cwd: tree.path, windowsHide: true, stdio: "ignore" });
    const landed = gitIn(root, "rev-parse", tree.branch);
    // The tree is gone (a cleaned scratch directory), but the branch and its work are not.
    execFileSync("git", ["worktree", "remove", "--force", tree.path], { cwd: root, windowsHide: true, stdio: "ignore" });

    const again = ensureNodeTree({ nodeRef: "node:v1:kept", projectRoot: root });

    expect(again).toEqual(tree);
    expect(gitIn(again!.path, "rev-parse", "HEAD")).toBe(landed);
    expect(existsSync(join(again!.path, "kept.txt"))).toBe(true);
  }, 120_000);

  it.each([
    ["a directory that is not this repository's tree", true],
    ["a project that is not a repository", false],
  ])("answers null for %s", (_label, stray) => {
    const root = stray ? project() : realpathSync(mkdtempSync(join(tmpdir(), "moe-node-trees-bare-")));
    if (!stray) roots.push(root);
    if (stray) mkdirSync(join(root, NODE_TREES_DIRECTORY, nodeTreeName("node:v1:stray")!), { recursive: true });

    expect(ensureNodeTree({ nodeRef: "node:v1:stray", projectRoot: root })).toBeNull();
  }, 120_000);

  it("answers null when Git refuses, and never throws", () => {
    const root = project();
    expect(ensureNodeTree({ nodeRef: "node:v1:refused", projectRoot: root,
      run: () => ({ code: 128, stdout: "" }) })).toBeNull();
    expect(ensureNodeTree({ nodeRef: "node:v1:thrown", projectRoot: root,
      run: () => { throw new Error("git is gone"); } })).toBeNull();
  }, 120_000);
});
