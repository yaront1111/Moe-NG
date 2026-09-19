import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { landedFromTree } from "../http/dependency-integration.js";
import type { LandingCommit } from "../repository/landing-receipt-contracts.js";
import type { VerifiedWorkspaceBinding } from "../repository/verified-workspace-contracts.js";
import type { IntegrationGit } from "./node-integration.js";
import { projectOfTree } from "./node-worktrees.js";

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
 *
 * `workProven` marks the one UNPROVEN that is not Git's silence: Git PROVED the tree holds work the
 * project lacks, and only what a landing RECEIPT needs is missing (a branch name, a path to name).
 * The lander still records nothing for it. The withdrawal scan writes no receipt, so it reads the
 * flag as found (node-delivery-withdrawal.ts) instead of deciding the same thing a second time.
 */
export type SeatCommitAnswer =
  | { readonly kind: "ADOPT"; readonly commit: LandingCommit }
  | { readonly kind: "NO_EFFECT"; readonly detail: string }
  | { readonly kind: "UNPROVEN"; readonly detail: string; readonly workProven?: true };

const unproven = (detail: string): SeatCommitAnswer => ({ detail, kind: "UNPROVEN" });
const workProven = (detail: string): SeatCommitAnswer => ({ detail, kind: "UNPROVEN", workProven: true });
const noEffect = (detail: string): SeatCommitAnswer => ({ detail, kind: "NO_EFFECT" });

/**
 * The paths a receipt names, BEST-EFFORT and never invented. The full recursive list first. A
 * commit that names more than runGit's output buffer holds (vendored code, build output) fails that
 * read with no exit status, which reads as 128, on every pass for good; the fallback is the
 * top-level names (`diff-tree` without `-r`), which are real paths of the same change. Truncated
 * output is never used: its last name may be cut short. Empty = no valid list could be produced.
 */
function adoptedPaths(git: IntegrationGit, project: string, sha: string): readonly string[] {
  const names = (answer: ReturnType<IntegrationGit>): readonly string[] =>
    answer.code !== 0 ? [] : answer.stdout.split("\0").filter((path) => path !== "").slice(0, ADOPTED_FILES_MAX);
  // Three dots: what the node's line added since it left the project's, not what the project gained.
  const every = names(git(project, ["diff", "--name-only", "-z", "--no-renames", `HEAD...${sha}`]));
  if (every.length > 0) return every;
  const base = git(project, ["merge-base", "HEAD", sha]);
  return base.code !== 0 || base.stdout.trim() === "" ? []
    : names(git(project, ["diff-tree", "--name-only", "-z", base.stdout.trim(), sha]));
}

/**
 * A SEAT-AUTHORED COMMIT IS A LANDING. A seat in its own tree may commit its work itself, and to
 * answer a merge conflict it has to: a merge only exists once it is committed. The tree is then
 * clean, nothing differs from the staffing baseline, and the lander recorded NOTHING_TO_COMMIT.
 * `landedWithNoEffect` credits that code as "this node owed no bytes", so the node read as
 * delivered while its commits were never merged. UnAI 2026-09-19: seats were hand-merging the
 * project branch inside .moe-next/trees/<node>; one that committed the merge was credited as nothing.
 *
 * "COULD NOT ESTABLISH WHETHER WORK REMAINS" IS NOT "NO WORK REMAINS". This used to answer null for
 * both, and every null was recorded NOTHING_TO_COMMIT and credited. It answers one of three.
 *
 * ONE RULE decides whether Git is asked at all: ONLY when the workspace is a node's own tree, its
 * real path `<project>/.moe-next/trees/<name>` (`landedFromTree`, the predicate every consumer of
 * the receipt uses, so an adopted landing is always one the integrator is offered). Git is asked in
 * the configured project root when the tree is that root's own, else in the root DERIVED from the
 * tree's own path (`projectOfTree`), which also covers no configured root: node trees do not depend
 * on one. Every other workspace (the project's checkout itself, a separate single-tree repository a
 * spec names, anything else) answers NO_EFFECT without asking: a commit made there is already on
 * its own branch, which is the truth from before node trees, and asking a foreign checkout about
 * its sha answers 128 for good and strands the reservation in AWAITING_LANDING.
 *
 * ADOPT: `merge-base --is-ancestor` says EXACTLY 1 and `diff --quiet HEAD...<sha>` says EXACTLY 1
 * (it differs). There is NO Git effect and so no landing intent: the commit already exists at
 * exactly the state the verifier bound (the caller has already matched the clean tree against that
 * binding). Decided by WHERE the commit was made, never by how its branch is spelled
 * (http/dependency-integration.ts argues the same): a seat that ran `git switch -c wip` in its tree
 * still made the node's work there, and the integrator merges by sha. The decision never waits on
 * reading every name; the receipt's paths are `adoptedPaths`.
 *
 * NO_EFFECT, each one PROVEN: not a node's tree (above); `--is-ancestor` exits EXACTLY 0 (the
 * project's HEAD contains it); or it exits 1 and `diff --quiet` exits EXACTLY 0 (identical).
 *
 * UNPROVEN, with what could not be established: an unborn HEAD, any other `--is-ancestor` or
 * `diff --quiet` exit (128: a commit this checkout cannot reach, a Git that never answered), and,
 * flagged `workProven`, work Git proved on a HEAD that names no branch or whose paths could not be
 * listed, neither of which a landing receipt can carry.
 *
 * A HEAD equal to the sha this node landed before is adopted ON PURPOSE. A seat that resolved
 * nothing is then offered to the integrator again and conflicts again, rather than being credited
 * NOTHING_TO_COMMIT with its branch never merged.
 */
export function adoptedSeatCommit(
  git: IntegrationGit, projectRoot: string | null, binding: Pick<VerifiedWorkspaceBinding, "branchRef" | "headSha" | "root">, message: string,
): SeatCommitAnswer {
  const tree = realPathOf(binding.root);
  if (!landedFromTree(tree)) return noEffect("the workspace is no node's own tree, so a commit made in it is already on its own branch and the clean workspace is the whole truth");
  const owner = projectOfTree(tree);
  const project = projectRoot !== null && realPathOf(projectRoot) === owner ? projectRoot : owner;
  const sha = binding.headSha;
  if (sha === null) return unproven("the node's tree has an unborn HEAD, so nothing says where its work is");
  // EXACTLY 1 is Git's "not an ancestor" and EXACTLY 0 its "contained". Anything else (128: a
  // commit this checkout cannot reach, a repository that is not there) proves neither.
  const ancestry = git(project, ["merge-base", "--is-ancestor", sha, "HEAD"]).code;
  if (ancestry === 0) return noEffect(`the project's HEAD already contains ${sha}`);
  if (ancestry !== 1) return unproven(`merge-base --is-ancestor ${sha} HEAD exited ${String(ancestry)}, which proves neither answer`);
  // `--quiet` DECIDES, and prints nothing: 0 is "identical", 1 is "differs", anything else is no answer.
  const differs = git(project, ["diff", "--quiet", `HEAD...${sha}`]).code;
  if (differs === 0) return noEffect(`${sha} adds no path to the project's branch`);
  if (differs !== 1) return unproven(`git diff HEAD...${sha} exited ${String(differs)}, so what the commit adds is unknown`);
  const branch = binding.branchRef.startsWith(BRANCH_REF_PREFIX) ? binding.branchRef.slice(BRANCH_REF_PREFIX.length) : "";
  if (branch === "") return workProven(`${sha} holds work the project lacks but HEAD names no branch, and a landing receipt must name one`);
  const files = adoptedPaths(git, project, sha);
  if (files.length === 0) {
    return workProven(`${sha} holds work the project lacks, but neither its full path list nor its top-level names could be read: a list past the 4 MiB output limit fails this way, and no path is invented for the receipt`);
  }
  const parent = git(project, ["rev-parse", "--verify", "--quiet", `${sha}^`]);
  return { commit: { branch, files, message,
    parentSha: parent.code === 0 && parent.stdout.trim() !== "" ? parent.stdout.trim() : null, sha }, kind: "ADOPT" };
}
