import type { LandingCommit } from "../repository/landing-receipt-contracts.js";
import type { VerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";
import type { IntegrationGit } from "./node-integration.js";
import { NODE_BRANCH_PREFIX } from "./node-worktrees.js";

// ponytail: the receipt names at most this many paths; the commit itself is never truncated.
// Page the list if a node ever lands more and a reader needs every name.
const ADOPTED_FILES_MAX = 2000;
const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * A SEAT-AUTHORED COMMIT IS A LANDING. A seat in its own tree may commit its work itself, and to
 * answer a merge conflict it has to: a merge only exists once it is committed. The tree is then
 * clean, nothing differs from the staffing baseline, and the lander recorded NOTHING_TO_COMMIT.
 * `landedWithNoEffect` credits that code as "this node owed no bytes" and `landedNodeBranches`
 * offers a branch only for a COMMITTED receipt, so the node read as delivered while its commits
 * were never merged. UnAI 2026-09-19: seats were hand-merging the project branch inside
 * .moe-next/trees/<node>; one that committed the merge was accepted and credited as nothing.
 *
 * The verified HEAD is adopted as the landing when the project's own branch does not contain it
 * yet. There is NO Git effect and so no landing intent: the commit already exists, on the node's
 * own branch, at exactly the state the verifier bound (the caller has already matched the clean
 * tree against that binding). Only a `moe/` branch is adopted: a commit on the project's own
 * branch is already where the work belongs.
 *
 * A HEAD equal to the sha this node landed before is adopted ON PURPOSE. A seat that resolved
 * nothing is then offered to the integrator again and conflicts again, rather than being credited
 * NOTHING_TO_COMMIT with its branch never merged.
 */
export function adoptedSeatCommit(
  git: IntegrationGit, projectRoot: string | null, binding: Pick<VerifiedWorkspaceBinding, "branchRef" | "headSha">, message: string,
): LandingCommit | null {
  const sha = binding.headSha;
  if (projectRoot === null || sha === null || !binding.branchRef.startsWith(`${BRANCH_REF_PREFIX}${NODE_BRANCH_PREFIX}`)) return null;
  // EXACTLY 1 is Git's "not an ancestor". 0 is already merged, which owes nothing; anything else
  // (128: a commit this checkout cannot reach, a repository that is not there) proves nothing,
  // and an unproved commit is never credited.
  if (git(projectRoot, ["merge-base", "--is-ancestor", sha, "HEAD"]).code !== 1) return null;
  // Three dots: what the node's line added since it left the project's, not what the project gained.
  const changed = git(projectRoot, ["diff", "--name-only", "-z", "--no-renames", `HEAD...${sha}`]);
  if (changed.code !== 0) return null;
  const files = changed.stdout.split("\0").filter((path) => path !== "").slice(0, ADOPTED_FILES_MAX);
  if (files.length === 0) return null;
  const parent = git(projectRoot, ["rev-parse", "--verify", "--quiet", `${sha}^`]);
  return {
    branch: binding.branchRef.slice(BRANCH_REF_PREFIX.length), files, message,
    parentSha: parent.code === 0 && parent.stdout.trim() !== "" ? parent.stdout.trim() : null, sha,
  };
}
