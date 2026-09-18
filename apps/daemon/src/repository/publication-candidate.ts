import { execFileSync } from "node:child_process";
import { landingEnvironment } from "./git-landing-port.js";
import { admitRemoteUrl } from "./publish-receipt-contracts.js";
import {
  decodePublicationCandidate, publicationRefused, publicationRepositoryId, validPublicationBranch,
} from "./publication-approval-contracts.js";
import type { PublicationCandidateReader, PublicationTarget } from "./publication-approval-contracts.js";
import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";

/**
 * The pushed branch is set ONCE, here. The preview and the command read it with the same recorded
 * target, and the push replays the command's recorded decision, so the operator approves exactly
 * the ref that is pushed. A workspace on the remote's default branch, or on a remote whose default
 * is unknown, publishes to `moe/release/<goalId>` instead: an unmeasured default is no evidence that
 * pushing onto the workspace branch is safe. Branch names compare case-sensitively, as git does.
 */
function releaseBranch(workspaceBranch: string, target: PublicationTarget | undefined): string | null {
  return target === undefined || (target.remoteDefaultBranch !== null && target.remoteDefaultBranch !== workspaceBranch)
    ? null : `moe/release/${target.goalId}`;
}

/** Captures only committed content. The configured root never comes from the caller's request. */
export function createPublicationCandidateReader(workspace: string | null): PublicationCandidateReader {
  return (remoteUrl, target) => {
    if (admitRemoteUrl(remoteUrl) === null) return publicationRefused("PUBLISH_REMOTE_URL_INVALID");
    if (workspace === null || workspace === "") return publicationRefused("PUBLISH_WORKSPACE_UNCONFIGURED");
    const before = resolveRepositoryExecutionIdentity(workspace);
    if (!before.ok) return publicationRefused(before.code);
    const run = (args: string[]) => execFileSync("git", args, {
      cwd: before.identity.root, encoding: "utf8", env: landingEnvironment(),
      shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\r?\n$/u, "");
    try {
      const head = () => run(["rev-parse", "--verify", "HEAD^{commit}"]);
      const branchRef = () => run(["symbolic-ref", "--quiet", "HEAD"]);
      const sha = head(); const ref = branchRef();
      const after = resolveRepositoryExecutionIdentity(workspace);
      if (!after.ok || after.identity.root !== before.identity.root || after.identity.gitDirectory !== before.identity.gitDirectory
        || sha !== head() || ref !== branchRef() || !ref.startsWith("refs/heads/")) {
        return publicationRefused("PUBLISH_CANDIDATE_CHANGED");
      }
      const workspaceBranch = ref.slice("refs/heads/".length);
      const release = releaseBranch(workspaceBranch, target);
      // A goal id git would reject as a branch name is refused by name, so no such ref can reach a push.
      if (release !== null && !validPublicationBranch(release)) return publicationRefused("PUBLISH_RELEASE_BRANCH_INVALID");
      const candidate = decodePublicationCandidate({ identity: before.identity, approval: {
        branch: release ?? workspaceBranch, remoteUrl, sha, repositoryId: publicationRepositoryId(before.identity),
      } });
      return candidate === null ? publicationRefused("PUBLISH_CANDIDATE_UNREADABLE") : { ok: true, candidate };
    } catch { return publicationRefused("PUBLISH_CANDIDATE_UNREADABLE"); }
  };
}
