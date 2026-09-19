import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { LandingCommit } from "../repository/landing-receipt-contracts.js";
import type { VerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";
import type { IntegrationGit } from "./node-integration.js";

// ponytail: the receipt names at most this many paths; the commit itself is never truncated.
// Page the list if a node ever lands more and a reader needs every name.
const ADOPTED_FILES_MAX = 2000;
const BRANCH_REF_PREFIX = "refs/heads/";
/** The lander's outcome for UNPROVEN: reported, never recorded, asked again on the next pass. */
export const LANDING_ADOPTION_UNPROVEN = "LANDING_ADOPTION_UNPROVEN";

/** Two spellings of one directory compare equal; a path that is not there compares as written. */
export const realPathOf = (path: string): string => { try { return realpathSync.native(path); } catch { return resolve(path); } };

/**
 * THE THREE ANSWERS about a clean, verified workspace. Only ADOPT and NO_EFFECT are evidence;
 * UNPROVEN is the absence of it, and nothing may read it as either of the others.
 */
export type SeatCommitAnswer =
  | { readonly kind: "ADOPT"; readonly commit: LandingCommit }
  | { readonly kind: "NO_EFFECT"; readonly detail: string }
  | { readonly kind: "UNPROVEN"; readonly detail: string };

const unproven = (detail: string): SeatCommitAnswer => ({ detail, kind: "UNPROVEN" });
const noEffect = (detail: string): SeatCommitAnswer => ({ detail, kind: "NO_EFFECT" });

/**
 * A SEAT-AUTHORED COMMIT IS A LANDING. A seat in its own tree may commit its work itself, and to
 * answer a merge conflict it has to: a merge only exists once it is committed. The tree is then
 * clean, nothing differs from the staffing baseline, and the lander recorded NOTHING_TO_COMMIT.
 * `landedWithNoEffect` credits that code as "this node owed no bytes", so the node read as
 * delivered while its commits were never merged. UnAI 2026-09-19: seats were hand-merging the
 * project branch inside .moe-next/trees/<node>; one that committed the merge was credited as nothing.
 *
 * "COULD NOT ESTABLISH WHETHER WORK REMAINS" IS NOT "NO WORK REMAINS". This used to answer null for
 * both, and every null was recorded NOTHING_TO_COMMIT and credited. It answers one of three:
 *
 * ADOPT: the verified HEAD was made in a node's own tree (the workspace is not the project's
 * checkout, compared as real paths) and `merge-base --is-ancestor` says EXACTLY 1, with a
 * three-dot diff that ran and names paths. There is NO Git effect and so no landing intent: the
 * commit already exists at exactly the state the verifier bound (the caller has already matched the
 * clean tree against that binding). Decided by WHERE the commit was made, never by how its branch
 * is spelled (http/dependency-integration.ts argues the same): a seat that ran `git switch -c wip`
 * in its tree still made the node's work there, and the integrator merges by sha.
 *
 * NO_EFFECT, each one PROVEN: no project checkout is configured, or the workspace IS the project's
 * checkout (a commit there is already on the project's branch, so the clean tree against the
 * baseline is the whole truth, as before node trees existed); `--is-ancestor` exits EXACTLY 0 (the
 * project's HEAD contains it); or it exits 1 and the diff ran (exit 0) and names nothing.
 *
 * UNPROVEN, with what could not be established: an unborn HEAD, any other `--is-ancestor` exit
 * (128: a commit this checkout cannot reach, a Git that never answered), a diff that failed, or
 * unmerged work on a HEAD that names no branch, which no landing receipt can carry.
 *
 * A HEAD equal to the sha this node landed before is adopted ON PURPOSE. A seat that resolved
 * nothing is then offered to the integrator again and conflicts again, rather than being credited
 * NOTHING_TO_COMMIT with its branch never merged.
 */
export function adoptedSeatCommit(
  git: IntegrationGit, projectRoot: string | null, binding: Pick<VerifiedWorkspaceBinding, "branchRef" | "headSha" | "root">, message: string,
): SeatCommitAnswer {
  if (projectRoot === null) return noEffect("no project checkout is configured, so the clean workspace is the whole truth");
  if (realPathOf(projectRoot) === realPathOf(binding.root)) return noEffect("the workspace is the project's own checkout, where a commit is already on the project's branch");
  const sha = binding.headSha;
  if (sha === null) return unproven("the node's tree has an unborn HEAD, so nothing says where its work is");
  // EXACTLY 1 is Git's "not an ancestor" and EXACTLY 0 its "contained". Anything else (128: a
  // commit this checkout cannot reach, a repository that is not there) proves neither.
  const ancestry = git(projectRoot, ["merge-base", "--is-ancestor", sha, "HEAD"]).code;
  if (ancestry === 0) return noEffect(`the project's HEAD already contains ${sha}`);
  if (ancestry !== 1) return unproven(`merge-base --is-ancestor ${sha} HEAD exited ${String(ancestry)}, which proves neither answer`);
  // Three dots: what the node's line added since it left the project's, not what the project gained.
  const changed = git(projectRoot, ["diff", "--name-only", "-z", "--no-renames", `HEAD...${sha}`]);
  if (changed.code !== 0) return unproven(`git diff HEAD...${sha} exited ${String(changed.code)}, so what the commit adds is unknown`);
  const files = changed.stdout.split("\0").filter((path) => path !== "").slice(0, ADOPTED_FILES_MAX);
  if (files.length === 0) return noEffect(`${sha} adds no path to the project's branch`);
  const branch = binding.branchRef.startsWith(BRANCH_REF_PREFIX) ? binding.branchRef.slice(BRANCH_REF_PREFIX.length) : "";
  if (branch === "") return unproven(`${sha} holds work the project lacks but HEAD names no branch, and a landing receipt must name one`);
  const parent = git(projectRoot, ["rev-parse", "--verify", "--quiet", `${sha}^`]);
  return { commit: { branch, files, message,
    parentSha: parent.code === 0 && parent.stdout.trim() !== "" ? parent.stdout.trim() : null, sha }, kind: "ADOPT" };
}
