import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createVerifiedWorkspacePort } from "./git-verified-workspace-port.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import type { VerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";

export interface ReviewResumeGitSnapshot { readonly binding: VerifiedWorkspaceBinding; readonly indexSha256: string }
/** Uses a private index for capture; the application's real index is observed, never rewritten. */
export async function captureReviewResumeGit(handle: RepositoryExecutionHandle): Promise<RepositoryRecoveryResult<{ snapshot: ReviewResumeGitSnapshot }>> {
  try {
    const index = join(handle.reservation.identity.gitDirectory, "index");
    const hashIndex = (): string => {
      if (!existsSync(index)) return "ABSENT";
      const stat = lstatSync(index);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("index");
      return createHash("sha256").update(readFileSync(index)).digest("hex");
    };
    const before = hashIndex();
    const captured = await createVerifiedWorkspacePort().capture(handle.reservation.identity.root);
    if (!captured.ok || before !== hashIndex()) return recoveryRefusal("REPOSITORY_REVIEW_WORKSPACE_CHANGED");
    return { ok: true, snapshot: { binding: captured.binding, indexSha256: before } };
  } catch { return recoveryRefusal("REPOSITORY_REVIEW_WORKSPACE_UNKNOWN"); }
}
