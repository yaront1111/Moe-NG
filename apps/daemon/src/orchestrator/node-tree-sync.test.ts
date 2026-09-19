import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "./node-integration.js";
import type { IntegrationGit } from "./node-integration.js";
import { syncNodeTree, syncTreeBeforeSeat } from "./node-tree-sync.js";
import { ensureNodeTree, forgetNodeTrees } from "./node-worktrees.js";

const roots: string[] = [];
afterEach(() => { forgetNodeTrees(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
/** A commit under a FIXTURE identity given per call, so neither checkout ever holds a user.name of its own. */
const commit = (cwd: string, file: string, content: string): string => {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "--", file);
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", `${file}: ${content.trim()}`);
  return git(cwd, "rev-parse", "HEAD");
};
const NODE = "node:v1:a";
/** A project on `main` and one node tree cut from its first commit, exactly as the wrapper cuts one. */
function fixture() {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), "moe-tree-sync-"))); roots.push(project);
  git(project, "init", "--quiet", "-b", "main");
  git(project, "config", "core.autocrlf", "false");
  const base = commit(project, "shared.txt", "base\n");
  const tree = ensureNodeTree({ nodeRef: NODE, projectRoot: project });
  if (tree === null) throw new Error("no tree");
  return { base, project, tree: tree.path };
}
/** Everything a sync may touch, read back byte for byte. */
const stateOf = (tree: string) => ({
  head: git(tree, "rev-parse", "HEAD"), shared: readFileSync(join(tree, "shared.txt"), "utf8"), status: git(tree, "status", "--porcelain"),
  merging: (() => { try { git(tree, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"); return true; } catch { return false; } })(),
});

describe("bringing the project's branch into a node's tree", () => {
  it("fast-forwards a tree with nothing of its own onto the project's HEAD", () => {
    const f = fixture();
    const moved = commit(f.project, "a.txt", "a\n");

    const report = syncNodeTree({ projectRoot: f.project, tree: f.tree });

    expect(report).toEqual({ conflictPaths: [], detail: `${f.base.slice(0, 10)} -> ${moved.slice(0, 10)}`, from: f.base, outcome: "SYNCED", project: "main", to: moved });
    expect(stateOf(f.tree)).toEqual({ head: moved, merging: false, shared: "base\n", status: "" });
    // A fast-forward, not a merge commit: the tree's line IS the project's.
    expect(git(f.tree, "rev-list", "--count", "HEAD")).toBe("2");
  }, 120_000);

  it("merges as Moe when the tree has its own commit, and leaves the tree clean", () => {
    const f = fixture();
    const own = commit(f.tree, "own.txt", "own\n");
    const moved = commit(f.project, "a.txt", "a\n");

    const report = syncNodeTree({ projectRoot: f.project, tree: f.tree });

    expect(report).toMatchObject({ conflictPaths: [], from: own, outcome: "SYNCED", project: "main" });
    const head = git(f.tree, "rev-parse", "HEAD");
    expect(report.to).toBe(head);
    expect(git(f.tree, "rev-parse", "HEAD^1", "HEAD^2").split(/\r?\n/u)).toEqual([own, moved]);
    expect(git(f.tree, "log", "-1", "--format=%an <%ae>")).toBe("Moe <moe@moe.local>");
    expect(readFileSync(join(f.tree, "a.txt"), "utf8")).toBe("a\n");
    expect(stateOf(f.tree)).toMatchObject({ merging: false, status: "" });
    // The project's branch itself never moves: only the tree's does.
    expect(git(f.project, "rev-parse", "HEAD")).toBe(moved);
  }, 120_000);

  it("does nothing to a tree the project's HEAD is already in", () => {
    const f = fixture();

    expect(syncNodeTree({ projectRoot: f.project, tree: f.tree }))
      .toEqual({ conflictPaths: [], detail: "up to date", from: f.base, outcome: "SYNC_SKIPPED", project: "main", to: f.base });
    expect(stateOf(f.tree)).toEqual({ head: f.base, merging: false, shared: "base\n", status: "" });
  }, 120_000);

  it("aborts a conflicting merge whole, names the paths, and leaves the tree byte-identical", () => {
    const f = fixture();
    const own = commit(f.tree, "shared.txt", "the tree's line\n");
    commit(f.project, "shared.txt", "the project's line\n");
    const before = stateOf(f.tree);

    const report = syncNodeTree({ projectRoot: f.project, tree: f.tree });

    expect(report).toEqual({ conflictPaths: ["shared.txt"], detail: "1 path(s)", from: own, outcome: "SYNC_CONFLICT", project: "main", to: own });
    expect(stateOf(f.tree)).toEqual(before);
    expect(before).toEqual({ head: own, merging: false, shared: "the tree's line\n", status: "" });
  }, 120_000);

  it("never touches a tree holding uncommitted work, and reads Moe's own runtime files as nobody's", () => {
    const f = fixture();
    const moved = commit(f.project, "a.txt", "a\n");
    writeFileSync(join(f.tree, "shared.txt"), "half done\n");

    expect(syncNodeTree({ projectRoot: f.project, tree: f.tree })).toMatchObject({ detail: "dirty", from: f.base, outcome: "SYNC_SKIPPED", to: f.base });
    expect(stateOf(f.tree)).toEqual({ head: f.base, merging: false, shared: "half done\n", status: "M shared.txt" });

    // An untracked .moe/ beside the work is not work (node-integration.ts, git-landing-port.ts).
    writeFileSync(join(f.tree, "shared.txt"), "base\n");
    mkdirSync(join(f.tree, ".moe")); writeFileSync(join(f.tree, ".moe", "state.json"), "{}\n");
    expect(git(f.tree, "status", "--porcelain")).toBe("?? .moe/");
    expect(syncNodeTree({ projectRoot: f.project, tree: f.tree })).toMatchObject({ outcome: "SYNCED", to: moved });
  }, 120_000);

  it("leaves a merge already in progress to whoever began it", () => {
    const f = fixture();
    const own = commit(f.tree, "shared.txt", "the tree's line\n");
    commit(f.project, "shared.txt", "the project's line\n");
    expect(() => git(f.tree, "merge", "main")).toThrow();
    expect(stateOf(f.tree)).toMatchObject({ head: own, merging: true });

    expect(syncNodeTree({ projectRoot: f.project, tree: f.tree })).toMatchObject({ detail: "merge in progress", outcome: "SYNC_SKIPPED" });
    expect(stateOf(f.tree)).toMatchObject({ head: own, merging: true, status: "UU shared.txt" });
  }, 120_000);

  // node-worktrees.ts's own runner answers a Git that never ran with 1, which for `merge` IS a
  // conflict; the sync asks through node-integration.ts's runner, which answers 128, and a merge
  // Git stopped for a reason of its own (no unmerged path) is a failure, never a conflict.
  const answering = (merge: { code: number; stderr?: string }): IntegrationGit => (_cwd, args) => {
    if (args.includes("MERGE_HEAD")) return { code: 1, stdout: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${"a".repeat(40)}\n` };
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n" };
    if (args.includes("merge") && !args.includes("--abort")) return { ...merge, stdout: "" };
    return { code: 0, stdout: "" };
  };
  it.each([
    [128, "fatal: unable to read tree 0123\n", "fatal: unable to read tree 0123"],
    [1, "error: Your local changes to the following files would be overwritten by merge:\n\tshared.txt\n", "error: Your local changes to the following files would be overwritten by merge: shared.txt"],
    [1, "", "Git gave no reason"],
  ])("reports a merge Git stopped with exit %i and no unmerged path as a failure in Git's words", (code, stderr, detail) => {
    expect(syncNodeTree({ git: answering({ code, stderr }), projectRoot: "/project", tree: "/tree" }))
      .toMatchObject({ conflictPaths: [], detail, outcome: "SYNC_FAILED" });
  });

  // Real Git, except the named verbs never run and answer as Git does under a straggler's
  // index.lock: an abort that did nothing leaves MERGE_HEAD and the half-applied paths behind.
  const LOCKED = "fatal: Unable to create 'index.lock': File exists.";
  const lockedOn = (...verbs: string[]): IntegrationGit => (cwd, args) =>
    verbs.some((verb) => args.join(" ").startsWith(verb)) ? { code: 128, stderr: `${LOCKED}\n`, stdout: "" } : runGit(cwd, args);
  const conflicted = () => {
    const f = fixture();
    const own = commit(f.tree, "shared.txt", "the tree's line\n");
    commit(f.project, "shared.txt", "the project's line\n");
    return { ...f, own };
  };

  it("resets a conflicting merge its abort left behind, and reports the conflict over a clean tree", () => {
    const f = conflicted();

    const report = syncNodeTree({ git: lockedOn("merge --abort"), projectRoot: f.project, tree: f.tree });

    expect(report).toEqual({ conflictPaths: ["shared.txt"], detail: "1 path(s)", from: f.own, outcome: "SYNC_CONFLICT", project: "main", to: f.own });
    expect(stateOf(f.tree)).toEqual({ head: f.own, merging: false, shared: "the tree's line\n", status: "" });
  }, 120_000);

  it("reports a conflicting merge neither the abort nor the reset could undo as a failure, never as a conflict", () => {
    const f = conflicted();

    const report = syncNodeTree({ git: lockedOn("merge --abort", "reset --hard"), projectRoot: f.project, tree: f.tree });

    // No conflict brief may tell a seat "your tree was left exactly as it was" over this tree.
    expect(report).toEqual({ conflictPaths: [], detail: `the conflicting merge could not be undone: ${LOCKED}`, from: f.own, outcome: "SYNC_FAILED", project: "main", to: f.own });
    expect(stateOf(f.tree)).toMatchObject({ head: f.own, merging: true, status: "UU shared.txt" });
  }, 120_000);
});

describe("the sync the staffing path runs", () => {
  it("syncs only the node's own tree: never the project's checkout, and nothing without one", () => {
    const f = fixture();
    commit(f.project, "a.txt", "a\n");
    const lines: string[] = [];

    expect(syncTreeBeforeSeat({ log: (line) => lines.push(line), nodeRef: NODE, projectRoot: f.project, workspace: f.project })).toBeNull();
    expect(syncTreeBeforeSeat({ log: (line) => lines.push(line), nodeRef: NODE, projectRoot: null, workspace: f.tree })).toBeNull();
    expect(syncTreeBeforeSeat({ log: (line) => lines.push(line), nodeRef: "node:v1:other", projectRoot: f.project, workspace: f.tree })).toBeNull();
    expect(lines).toEqual([]);
    expect(git(f.tree, "rev-parse", "HEAD")).toBe(f.base);
  }, 120_000);

  it("says one line per outcome and briefs the seat only on a conflict, in the withdrawal's words", () => {
    const f = fixture();
    const lines: string[] = [];
    const log = (line: string): void => { lines.push(line); };
    const moved = commit(f.project, "a.txt", "a\n");

    expect(syncTreeBeforeSeat({ log, nodeRef: NODE, projectRoot: f.project, workspace: f.tree })).toBeNull();
    expect(lines).toEqual([`[trees] ${NODE}: SYNCED (${f.base.slice(0, 10)} -> ${moved.slice(0, 10)})`]);

    commit(f.tree, "shared.txt", "the tree's line\n");
    commit(f.project, "shared.txt", "the project's line\n");
    const brief = syncTreeBeforeSeat({ log, nodeRef: NODE, projectRoot: f.project, workspace: f.tree });

    expect(lines.at(-1)).toBe(`[trees] ${NODE}: SYNC_CONFLICT (1 path(s))`);
    expect(brief).toBe([
      "SYNC_CONFLICT: your working tree is behind the project's branch main, and Moe could not bring it in: the merge conflicts, so your tree was left exactly as it was.",
      "Merge it yourself BEFORE you start. Work built on a stale base conflicts again at integration and its acceptance is withdrawn.",
      "Git could not join 1 path(s):",
      "shared.txt",
      "Answer it in your own working tree:",
      "1. Run: git -c user.name=Moe -c user.email=moe@moe.local -c commit.gpgsign=false merge main",
      "2. Settle every conflicting path, keeping every criterion you own satisfied.",
      "3. COMMIT the merge. Leave no merge in progress and nothing uncommitted.",
      "4. Then do the task above, run the test, and submit the review.",
    ].join("\n"));
    // The recipe it hands is the one that works: the seat's own merge meets the same conflict.
    expect(() => git(f.tree, "-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false", "merge", "main")).toThrow();
    expect(git(f.tree, "status", "--porcelain")).toBe("UU shared.txt");
  }, 120_000);
});
