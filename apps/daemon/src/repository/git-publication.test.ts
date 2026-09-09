import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitLandingPort, nodeGitRunner } from "./git-landing-port.js";
import type { GitRunner } from "./git-landing-port.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd, encoding: "utf8", windowsHide: true,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "", GIT_TERMINAL_PROMPT: "0" },
}).trim();

function repository(): { workspace: string; remote: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "moe-review-publish-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const remote = join(root, "remote.git");
  mkdirSync(workspace);
  git(workspace, "init", "--quiet", "--initial-branch=delivery");
  git(workspace, "config", "user.name", "Moe test");
  git(workspace, "config", "user.email", "test@moe.local");
  git(workspace, "config", "commit.gpgsign", "false");
  writeFileSync(join(workspace, "product.txt"), "approved product\n");
  git(workspace, "add", "--", "product.txt");
  git(workspace, "commit", "--quiet", "-m", "approved product");
  git(root, "init", "--quiet", "--bare", remote);
  return { workspace, remote, sha: git(workspace, "rev-parse", "HEAD") };
}

describe("Git publication records the exact commit pushed", () => {
  it("pushes the observed SHA when local HEAD changes before the effect", async () => {
    const { workspace, remote, sha } = repository();
    const run: GitRunner = async (cwd, args, stdin) => {
      if (args[0] === "push") {
        writeFileSync(join(workspace, "product.txt"), "later unapproved product\n");
        git(workspace, "add", "--", "product.txt");
        git(workspace, "commit", "--quiet", "-m", "later work");
      }
      return nodeGitRunner(cwd, args, stdin);
    };

    const result = await createGitLandingPort(run).push(workspace, remote);
    expect(result).toEqual({ ok: true, receipt: { branch: "delivery", sha } });
    expect(git(remote, "rev-parse", "refs/heads/delivery")).toBe(sha);
    expect(git(workspace, "rev-parse", "HEAD")).not.toBe(sha);
  }, 60_000);

  it.each(["different", "missing", "failed"])("refuses a %s remote confirmation", async (confirmation) => {
    const sha = "a".repeat(40);
    const run: GitRunner = async (_cwd, args) => {
      const stdout = args[0] === "ls-remote"
        ? confirmation === "different" ? `${"b".repeat(40)}\trefs/heads/delivery\n` : ""
        : args.includes("--show-toplevel") ? "/workspace\n"
          : args.includes("--abbrev-ref") ? "delivery\n" : args[0] === "rev-parse" ? `${sha}\n` : "";
      return { code: args[0] === "ls-remote" && confirmation === "failed" ? 1 : 0, stderr: "", stdout };
    };
    const result = await createGitLandingPort(run).push("/workspace", "local-remote");
    expect(result).toMatchObject({ ok: false, code: "GIT_PUSH_FAILED" });
    if (!result.ok) expect(result.detail).toContain("remote branch did not confirm");
  });
});
