import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGitLandingPort } from "./git-landing-port.js";
import { DELETED_BLOB } from "./landing-receipt-contracts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A real repository with one commit, one tracked file, and a `.moe-next` directory. */
function scratchRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-landing-port-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=trunk");
  git(root, "config", "user.email", "operator@example.test");
  git(root, "config", "user.name", "Operator");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".moe-next"));
  writeFileSync(join(root, "src", "tracked.ts"), "export const before = 1;\n", "utf8");
  writeFileSync(join(root, "src", "doomed.ts"), "export const doomed = 1;\n", "utf8");
  writeFileSync(join(root, ".moe-next", "start.ps1"), "# start\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "operator: initial");
  return root;
}

describe("createGitLandingPort against a real repository", () => {
  it("observes dirty paths root-relative with blob ids, and never Moe's metadata", async () => {
    const root = scratchRepository();
    writeFileSync(join(root, "src", "tracked.ts"), "export const before = 2;\n", "utf8");
    writeFileSync(join(root, "src", "new.ts"), "export const fresh = 1;\n", "utf8");
    writeFileSync(join(root, ".moe-next", "start.ps1"), "# changed\n", "utf8");
    unlinkSync(join(root, "src", "doomed.ts"));
    const port = createGitLandingPort();
    const observed = await port.observe(join(root, "src"));
    if (!observed.ok) throw new Error(observed.detail);
    expect(observed.observation.entries.map((entry) => entry.path))
      .toEqual(["src/doomed.ts", "src/new.ts", "src/tracked.ts"]);
    expect(observed.observation.entries[0]?.blobId).toBe(DELETED_BLOB);
    expect(observed.observation.entries[1]?.blobId).toBe(git(root, "hash-object", "src/new.ts"));
    expect(observed.observation.entries[2]?.blobId).toBe(git(root, "hash-object", "src/tracked.ts"));
    // The untracked subset, root-relative and sorted: new.ts only (tracked.ts is modified).
    expect(observed.observation.untracked).toEqual(["src/new.ts"]);
  });

  it("refuses a directory outside any repository by name", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moe-landing-outside-"));
    roots.push(outside);
    const observed = await createGitLandingPort().observe(outside);
    expect(observed.ok).toBe(false);
    expect(!observed.ok && observed.code).toBe("NOT_A_REPOSITORY");
  });

  it("commits exactly the named paths as Moe on the current branch, leaving other dirt alone", async () => {
    const root = scratchRepository();
    writeFileSync(join(root, "src", "tracked.ts"), "export const before = 2;\n", "utf8");
    writeFileSync(join(root, "src", "new.ts"), "export const fresh = 1;\n", "utf8");
    writeFileSync(join(root, "operator-wip.md"), "not the seat's\n", "utf8");
    unlinkSync(join(root, "src", "doomed.ts"));
    const port = createGitLandingPort();
    const committed = await port.commit(
      join(root, "src"), ["src/new.ts", "src/tracked.ts", "src/doomed.ts"], "Land the node\n\nbody\n",
    );
    if (!committed.ok) throw new Error(committed.detail);
    expect(committed.receipt.branch).toBe("trunk");
    expect(committed.receipt.sha).toBe(git(root, "rev-parse", "HEAD"));
    expect(committed.receipt.parentSha).toBe(git(root, "rev-parse", "HEAD^"));
    expect(git(root, "log", "-1", "--format=%an <%ae>")).toBe("Moe <moe@moe.local>");
    expect(git(root, "log", "-1", "--format=%s")).toBe("Land the node");
    expect(git(root, "show", "--stat", "--format=", "HEAD")).toContain("src/doomed.ts");
    // The operator's own dirt is still uncommitted and untracked.
    expect(git(root, "status", "--porcelain")).toBe("?? operator-wip.md");
  });

  it("reports a failing commit with git's words instead of throwing", async () => {
    const root = scratchRepository();
    const committed = await createGitLandingPort().commit(root, ["src/does-not-exist.ts"], "nothing\n");
    expect(committed.ok).toBe(false);
    expect(!committed.ok && committed.code).toBe("GIT_COMMIT_FAILED");
    expect(!committed.ok && committed.detail).toContain("does-not-exist");
  });
});
