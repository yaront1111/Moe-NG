import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryRecoveryGitPort } from "./repository-recovery-git.js";
import type { RecoveryLandedEvidence } from "./repository-recovery-evidence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(): RecoveryLandedEvidence {
  const root = mkdtempSync(join(tmpdir(), "moe-recovery-git-")); roots.push(root);
  git(root, "init", "--quiet", "-b", "trunk");
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.test");
  writeFileSync(join(root, "owned.txt"), "before\n"); writeFileSync(join(root, "foreign.txt"), "foreign\n");
  git(root, "add", "--", "owned.txt", "foreign.txt"); git(root, "commit", "--quiet", "-m", "initial");
  const parentSha = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "owned.txt"), "verified\n"); git(root, "add", "--", "owned.txt"); git(root, "commit", "--quiet", "-m", "land");
  const sha = git(root, "rev-parse", "HEAD");
  return { binding: { version: "moe-verified-workspace/1", root: realpathSync.native(root), branchRef: "refs/heads/trunk", headSha: parentSha,
    treeSha: git(root, "rev-parse", "HEAD^{tree}"), dirtySha256: "a".repeat(64) },
    commit: { branch: "trunk", parentSha, sha, files: ["owned.txt"], message: "land\n" },
    needsLandingReceipt: true, verifierReceiptId: "b".repeat(64), receiptId: "c".repeat(64), proof: { kind: "LANDING_COMPLETION", id: "d".repeat(64) } };
}
describe("read-only Git reconciliation guard", () => {
  it("proves the existing exact commit, preserves staged foreign bytes, and excludes concurrent HEAD changes", async () => {
    const evidence = fixture(); const root = evidence.binding.root;
    writeFileSync(join(root, "foreign.txt"), "staged operator work\n"); git(root, "add", "--", "foreign.txt");
    const index = readFileSync(join(root, ".git", "index")); let attempts = 0;
    const result = await createRepositoryRecoveryGitPort().guard(evidence, () => {
      attempts += 1;
      const writer = spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/other"], { cwd: root, shell: false, windowsHide: true });
      expect(writer.status).not.toBeNull(); expect(writer.status).not.toBe(0);
      return { ok: true, recorded: true };
    });
    expect(result).toEqual({ ok: true, recorded: true }); expect(attempts).toBe(1);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    expect(git(root, "show", ":foreign.txt")).toBe("staged operator work");
    expect(git(root, "rev-parse", "HEAD")).toBe(evidence.commit.sha);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false); expect(existsSync(join(root, ".git", "HEAD.lock"))).toBe(false);
  }, 180_000);
  it("preserves a pre-existing Git lock and refuses an unverified tree without entering the action", async () => {
    const evidence = fixture(); const root = evidence.binding.root; let attempts = 0;
    const action = () => { attempts += 1; return { ok: true as const }; };
    writeFileSync(join(root, ".git", "index.lock"), "unknown lock owner");
    expect(await createRepositoryRecoveryGitPort().guard(evidence, action)).toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_GIT_LOCKED" });
    expect(readFileSync(join(root, ".git", "index.lock"), "utf8")).toBe("unknown lock owner");
    const other = fixture();
    expect(await createRepositoryRecoveryGitPort().guard({ ...other, binding: { ...other.binding, treeSha: "e".repeat(40) } }, action))
      .toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_GIT_MISMATCH" });
    expect(attempts).toBe(0);
  }, 240_000);
  it("refuses a symbolic branch whose unlocked target could move during reconciliation", async () => {
    const evidence = fixture(); const root = evidence.binding.root; let entered = false;
    git(root, "update-ref", "refs/heads/indirect-target", evidence.commit.sha);
    git(root, "symbolic-ref", "refs/heads/trunk", "refs/heads/indirect-target");
    expect(await createRepositoryRecoveryGitPort().guard(evidence, () => { entered = true; return { ok: true as const }; }))
      .toMatchObject({ ok: false, code: "REPOSITORY_RECOVERY_GIT_MISMATCH" });
    expect(entered).toBe(false);
  }, 180_000);
});
