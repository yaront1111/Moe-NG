import type { RecoveryLandedEvidence } from "./repository-recovery-evidence.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { attemptVerifiedGit, gitHead, literalPaths, verifiedGit, withVerifiedGit } from "./git-verified-workspace-runtime.js";
class RecoveryGitFailure extends Error { constructor(readonlyCode: string) { super(readonlyCode); } }
const mismatch = () => { throw new RecoveryGitFailure("REPOSITORY_RECOVERY_GIT_MISMATCH"); };
function acquireGuard(path: string): () => void {
  const marker = `moe-recovery:${randomUUID()}`;
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); } catch { throw new RecoveryGitFailure("REPOSITORY_RECOVERY_GIT_LOCKED"); }
  try { writeFileSync(fd, marker); } finally { closeSync(fd); }
  return () => { if (readFileSync(path, "utf8") !== marker) throw new RecoveryGitFailure("REPOSITORY_RECOVERY_GIT_UNKNOWN"); unlinkSync(path); };
}
export interface RepositoryRecoveryGitPort {
  guard<T>(evidence: RecoveryLandedEvidence, action: () => RepositoryRecoveryResult<T>): Promise<RepositoryRecoveryResult<T>>;
}
export function createRepositoryRecoveryGitPort(): RepositoryRecoveryGitPort {
  return { async guard(evidence, action) {
    const releases: (() => void)[] = [];
    try {
      return await withVerifiedGit(evidence.binding.root, async (context) => {
        const { binding, commit } = evidence;
        if (context.root !== binding.root || (await verifiedGit(context, ["rev-parse", "--show-ref-format"])).trim() !== "files") mismatch();
        const locations = (await verifiedGit(context, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-path", binding.branchRef])).replace(/\r?\n$/u, "").split(/\r?\n/u);
        if (locations.length !== 2) mismatch();
        const common = realpathSync.native(locations[0]!); const parent = realpathSync.native(dirname(locations[1]!));
        const contained = relative(common, parent);
        if (contained.startsWith("..") || isAbsolute(contained)) mismatch();
        releases.push(acquireGuard(join(context.gitDirectory, "index.lock")));
        releases.push(acquireGuard(join(context.gitDirectory, "HEAD.lock")));
        releases.push(acquireGuard(`${locations[1]!}.lock`));
        const head = await gitHead(context);
        if (head.branchRef !== binding.branchRef || head.headSha !== commit.sha || commit.parentSha !== binding.headSha
          || commit.branch !== binding.branchRef.slice("refs/heads/".length)) mismatch();
        const object = await verifiedGit(context, ["cat-file", "-p", commit.sha]);
        const separator = object.indexOf("\n\n"); if (separator < 0) mismatch();
        const headers = object.slice(0, separator).split("\n");
        const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
        if (headers[0] !== `tree ${binding.treeSha}` || JSON.stringify(parents) !== JSON.stringify(binding.headSha === null ? [] : [binding.headSha])
          || object.slice(separator + 2) !== commit.message) mismatch();
        const diff = await verifiedGit(context, ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", "--no-renames",
          ...(binding.headSha === null ? ["--root", commit.sha] : [binding.headSha, commit.sha]), "--"]);
        const changed = diff.split("\0").filter(Boolean).sort();
        if (JSON.stringify(changed) !== JSON.stringify([...commit.files].sort())) mismatch();
        const index = await attemptVerifiedGit(context, ["diff-index", "--cached", "--quiet", commit.sha, "--", ...literalPaths(commit.files)]);
        if (index.code !== 0) mismatch();
        return action();
      });
    } catch (error) {
      return recoveryRefusal(error instanceof RecoveryGitFailure ? error.message : "REPOSITORY_RECOVERY_GIT_UNKNOWN");
    } finally {
      // Never remove a pre-existing lock or one whose bytes no longer identify this guard.
      for (const release of releases.reverse()) { try { release(); } catch { /* A changed lock remains held. */ } }
    }
  } };
}
