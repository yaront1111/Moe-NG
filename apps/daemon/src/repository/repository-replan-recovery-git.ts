import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import type { VerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import { attemptVerifiedGit, gitHead, objectId, verifiedGit, withVerifiedGit } from "./git-verified-workspace-runtime.js";

export interface ReplanGitSnapshot { readonly headSha: string; readonly branchRef: string; readonly treeSha: string; readonly indexSha256: string }
/** Read only: human checkpoints may advance HEAD, but may not change the reviewed tree. */
export async function captureReplanGit(handle: RepositoryExecutionHandle, reviewed: VerifiedWorkspaceBinding):
Promise<RepositoryRecoveryResult<{ snapshot: ReplanGitSnapshot }>> {
  const changed = () => recoveryRefusal("REPOSITORY_REPLAN_WORKSPACE_CHANGED");
  try {
    return await withVerifiedGit(reviewed.root, async (context) => {
      if (context.root !== handle.reservation.identity.root || context.gitDirectory !== handle.reservation.identity.gitDirectory
        || reviewed.headSha === null) return changed();
      const indexPath = join(context.gitDirectory, "index");
      const indexHash = () => {
        const stat = lstatSync(indexPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("index identity unknown");
        return createHash("sha256").update(readFileSync(indexPath)).digest("hex");
      };
      const indexSha256 = indexHash(); const head = await gitHead(context);
      if (head.headSha === null || head.branchRef !== reviewed.branchRef) return changed();
      const status = await verifiedGit(context, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
      if (status !== "") return recoveryRefusal("REPOSITORY_REPLAN_WORKSPACE_DIRTY");
      // A fresh private index has no assume-unchanged/skip-worktree flags or stale stat cache.
      // diff-files reads the actual tracked bytes without changing the user's index or writing objects.
      await verifiedGit(context, ["read-tree", head.headSha], context.index);
      if ((await attemptVerifiedGit(context, ["update-index", "--really-refresh"], context.index)).code !== 0) {
        return recoveryRefusal("REPOSITORY_REPLAN_WORKSPACE_DIRTY");
      }
      if ((await attemptVerifiedGit(context, ["diff-files", "--quiet", "--no-ext-diff", "--ignore-submodules=none", "--"], context.index)).code !== 0) {
        return recoveryRefusal("REPOSITORY_REPLAN_WORKSPACE_DIRTY");
      }
      const treeSha = (await verifiedGit(context, ["rev-parse", "HEAD^{tree}"])).trim();
      if (!objectId(treeSha) || treeSha !== reviewed.treeSha
        || (await attemptVerifiedGit(context, ["merge-base", "--is-ancestor", reviewed.headSha, head.headSha])).code !== 0) return changed();
      if (indexHash() !== indexSha256 || JSON.stringify(await gitHead(context)) !== JSON.stringify(head)) return changed();
      return { ok: true, snapshot: { headSha: head.headSha, branchRef: head.branchRef, treeSha, indexSha256 } };
    });
  } catch { return recoveryRefusal("REPOSITORY_REPLAN_GIT_UNKNOWN"); }
}
