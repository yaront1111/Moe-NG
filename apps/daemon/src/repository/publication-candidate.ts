import { execFileSync } from "node:child_process";
import { landingEnvironment } from "./git-landing-port.js";
import { admitRemoteUrl } from "./publish-receipt-contracts.js";
import { decodePublicationCandidate, publicationRefused, publicationRepositoryId } from "./publication-approval-contracts.js";
import type { PublicationCandidateReader } from "./publication-approval-contracts.js";
import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";

/** Captures only committed content. The configured root never comes from the caller's request. */
export function createPublicationCandidateReader(workspace: string | null): PublicationCandidateReader {
  return (remoteUrl) => {
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
      const candidate = decodePublicationCandidate({ identity: before.identity, approval: {
        branch: ref.slice("refs/heads/".length), remoteUrl, sha, repositoryId: publicationRepositoryId(before.identity),
      } });
      return candidate === null ? publicationRefused("PUBLISH_CANDIDATE_UNREADABLE") : { ok: true, candidate };
    } catch { return publicationRefused("PUBLISH_CANDIDATE_UNREADABLE"); }
  };
}
