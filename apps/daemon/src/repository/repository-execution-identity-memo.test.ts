import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";

/**
 * Every repository-port call resolved the checkout's identity with a synchronous `git
 * rev-parse`; the wrapper made ~70 of them per delivery pass, and `spawn` was the largest
 * self-time in its profile (UnAI 2026-09-17). The identity is remembered, and these pin the
 * only ways it can legitimately change: the root's `.git` entry replaced, the git directory
 * gone, or a nested repository appearing between the workspace and its root.
 */

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

/** The suite's own git calls go through the real `spawnSync`, so only the unit's spawns count. */
const git = (cwd: string, ...args: readonly string[]): void => {
  const result = spawnSync("git", [...args], { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
};
const revParses = (): number => vi.mocked(execFileSync).mock.calls
  .filter(([file, args]) => file === "git" && Array.isArray(args) && args.includes("rev-parse")).length;

const roots: string[] = [];
function repository(): string {
  // git answers with the realpath; macOS's tmpdir() is /var/folders, a symlink into /private.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-identity-"))); roots.push(root);
  git(root, "init", "--quiet");
  writeFileSync(join(root, "app.txt"), "one\n");
  git(root, "add", "--", "app.txt");
  git(root, "-c", "commit.gpgSign=false", "commit", "-qm", "base");
  return root;
}
const identityOf = (workspace: string) => {
  const resolved = resolveRepositoryExecutionIdentity(workspace);
  if (!resolved.ok) throw new Error(`unexpected refusal for ${workspace}`);
  return resolved.identity;
};
const slashed = (path: string): string => path.replace(/\\/gu, "/").toLowerCase();

afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

describe("resolveRepositoryExecutionIdentity", () => {
  it("spawns git once per checkout, not once per call", () => {
    const root = repository();
    vi.mocked(execFileSync).mockClear();

    const first = identityOf(root);
    for (let call = 0; call < 5; call += 1) expect(identityOf(root)).toEqual(first);

    expect(revParses()).toBe(1);
    expect(slashed(first.gitDirectory)).toBe(slashed(join(first.root, ".git")));
  });

  it("asks git again when a nested repository appears between the workspace and its root", () => {
    const root = repository();
    const nested = join(root, "packages", "inner");
    mkdirSync(nested, { recursive: true });
    const before = identityOf(nested);
    expect(slashed(before.root)).toBe(slashed(identityOf(root).root));
    vi.mocked(execFileSync).mockClear();

    git(nested, "init", "--quiet");
    const after = identityOf(nested);

    expect(revParses()).toBe(1);
    expect(slashed(after.root)).toBe(slashed(nested));
  });

  it("asks git again when a linked worktree is replaced by a clone at the same path", () => {
    const root = repository();
    const tree = join(root, "trees", "node-a");
    git(root, "worktree", "add", "--quiet", "-b", "moe/node-a", tree);
    const asWorktree = identityOf(tree);
    expect(slashed(asWorktree.gitDirectory)).toContain("/.git/worktrees/node-a");
    vi.mocked(execFileSync).mockClear();

    // The tree is torn down with rm -rf and a plain repository put in its place: the `.git`
    // entry turns from a file naming the shared git dir into a directory of its own.
    rmSync(tree, { force: true, recursive: true });
    mkdirSync(tree, { recursive: true });
    git(tree, "init", "--quiet");
    const asClone = identityOf(tree);

    expect(revParses()).toBe(1);
    expect(slashed(asClone.gitDirectory)).toBe(slashed(join(tree, ".git")));
  });

  it("does not remember a refusal, so a checkout that appears later is found", () => {
    const later = mkdtempSync(join(tmpdir(), "moe-identity-later-")); roots.push(later);
    // No repository yet: git refuses, and nothing is kept from that.
    expect(resolveRepositoryExecutionIdentity(later).ok).toBe(false);
    vi.mocked(execFileSync).mockClear();

    git(later, "init", "--quiet");
    const found = resolveRepositoryExecutionIdentity(later);

    expect(found.ok).toBe(true);
    expect(revParses()).toBe(1);
  });
});
