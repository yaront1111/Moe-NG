import { realpathSync } from "node:fs";
import { LANDER_IDENTITY, isMoeMetadata } from "../repository/git-landing-port.js";
import { conflictRecipe } from "./node-delivery-withdrawal.js";
import { reasonOf, runGit } from "./node-integration.js";
import type { IntegrationGit } from "./node-integration.js";
import { ownNodeTree } from "./wrapper-node-trees.js";

/**
 * THE PROJECT'S BRANCH IS BROUGHT INTO A NODE'S TREE BEFORE EACH SEAT. A tree is cut from the
 * project's HEAD at the node's FIRST staffing (node-worktrees.ts) and then stands still while the
 * project's branch moves under the integrator. UnAI 2026-09-19, 6 of 7 tree-landed nodes: every
 * node touched the same registry-style files (CLAUDE.md, Navigation.tsx, platform.ts, index.ts),
 * so almost every landed branch conflicted at integration, was withdrawn (INTEGRATION_CONFLICT)
 * and cost the node a review round plus a whole seat to merge the project's branch by hand. The
 * nodes re-staffed AFTER the branch had moved merged clean first time: their seat began up to date.
 *
 * So the staffing path merges the project's current HEAD into a CLEAN tree before the landing
 * baseline is recorded and before the seat starts (repository-delivery-coordinator.ts): a
 * fast-forward when the tree has nothing of its own, a merge commit authored as Moe otherwise.
 * Either leaves a clean tree, so the baseline records no entries and the merge is never counted
 * as the seat's delivery; the verifier's binding is captured only after the seat exits, so it
 * never sees HEAD move; and a commit the seat makes now carries the project's HEAD in its
 * ancestry, so the integrator's own merge is clean by construction (node-lander-adopt.ts).
 *
 * A merge that CONFLICTS is aborted whole, the tree left exactly as it was, and the seat told in
 * its mission which paths conflict, in the words the withdrawal already hands a seat: settled by
 * the seat, never by guessing. A tree with uncommitted work (a node between rounds) is never
 * touched, and the project's own checkout — a node finishing where it holds, or pinned back to it
 * — is never synced. Nothing durable is recorded beyond the commit: one `[trees]` line per node
 * per outcome is the whole record.
 */
export type TreeSyncOutcome = "SYNCED" | "SYNC_CONFLICT" | "SYNC_SKIPPED" | "SYNC_FAILED";
export interface TreeSyncReport {
  readonly conflictPaths: readonly string[];
  /** What the `[trees]` line says in parentheses. */
  readonly detail: string;
  /** The tree's HEAD before, and after; they differ only when SYNCED. */
  readonly from: string | null;
  readonly outcome: TreeSyncOutcome;
  /** The project's HEAD as a seat should name it: its branch, or its sha when it is detached. */
  readonly project: string | null;
  readonly to: string | null;
}
/** The integrator's own bound on the paths one conflict names (node-integration.ts). */
const MAX_CONFLICT_PATHS = 64;
const short = (sha: string): string => sha.slice(0, 10);

/** The Git work alone: `tree` is taken to be this node's own tree, on a branch of its own. */
export function syncNodeTree(input: { readonly git?: IntegrationGit; readonly projectRoot: string; readonly tree: string }): TreeSyncReport {
  const git = input.git ?? runGit;
  const report = (outcome: TreeSyncOutcome, detail: string, facts: Partial<TreeSyncReport>): TreeSyncReport =>
    Object.freeze({ conflictPaths: [], from: null, project: null, to: null, ...facts, detail, outcome });
  const sha = (cwd: string, ref: string): string | null => {
    const answer = git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return answer.code === 0 && answer.stdout.trim() !== "" ? answer.stdout.trim() : null;
  };
  const head = sha(input.projectRoot, "HEAD");
  if (head === null) return report("SYNC_FAILED", "the project checkout's HEAD could not be read", {});
  const named = git(input.projectRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const project = named.code === 0 && named.stdout.trim() !== "" ? named.stdout.trim() : head;
  const from = sha(input.tree, "HEAD");
  if (from === null) return report("SYNC_FAILED", "the tree's HEAD could not be read", { project });
  const facts = { from, project, to: from };
  // `.git` in a linked worktree is a FILE, so no path under it proves a merge in progress: Git is asked.
  if (sha(input.tree, "MERGE_HEAD") !== null) return report("SYNC_SKIPPED", "merge in progress", facts);
  // Moe's own runtime files are nobody's uncommitted work (the integrator's and the lander's own
  // reading): read as dirt, one edited launcher would skip every sync for good.
  const readStatus = () => git(input.tree, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  const clean = (status: ReturnType<IntegrationGit>): boolean =>
    status.code === 0 && !status.stdout.split("\0").some((entry) => entry.length > 3 && !isMoeMetadata(entry.slice(3)));
  const status = readStatus();
  if (status.code !== 0) return report("SYNC_FAILED", `the tree could not be read: ${reasonOf(status.stderr)}`, facts);
  if (!clean(status)) return report("SYNC_SKIPPED", "dirty", facts);
  // The sha, not the branch: the branch may move between this read and the merge. Moe's identity,
  // because a merge commit in an operator checkout with no user.email dies without one.
  const merged = git(input.tree, [...LANDER_IDENTITY, "merge", "--no-edit", head]);
  if (merged.code === 0) {
    const to = sha(input.tree, "HEAD") ?? from;
    return to === from ? report("SYNC_SKIPPED", "up to date", facts) : report("SYNCED", `${short(from)} -> ${short(to)}`, { ...facts, to });
  }
  const conflicts = git(input.tree, ["diff", "--name-only", "--diff-filter=U"]);
  const paths = conflicts.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "").slice(0, MAX_CONFLICT_PATHS);
  // Whole, as the integrator aborts. A merge Git refused before it began left no MERGE_HEAD, and
  // then the abort touches nothing. The abort is CHECKED: an index.lock held by a straggler, or a
  // Git killed mid-merge, leaves MERGE_HEAD or half-applied paths behind, and a seat briefed that
  // "the tree was left exactly as it was" would then be staffed on a tree the baseline reads as
  // dirty. The tree held nothing uncommitted but Moe metadata (proved above), so `reset --hard`
  // to the HEAD it started from loses nobody's work.
  git(input.tree, ["merge", "--abort"]);
  if (sha(input.tree, "MERGE_HEAD") !== null || !clean(readStatus())) {
    const reset = git(input.tree, ["reset", "--hard", from]);
    if (reset.code !== 0 || sha(input.tree, "MERGE_HEAD") !== null || !clean(readStatus())) {
      return report("SYNC_FAILED", `the conflicting merge could not be undone: ${reasonOf(reset.stderr)}`, facts);
    }
  }
  return paths.length === 0
    ? report("SYNC_FAILED", reasonOf(merged.stderr), facts)
    : report("SYNC_CONFLICT", `${String(paths.length)} path(s)`, { ...facts, conflictPaths: paths });
}

/** What a seat staffed on a tree the project's branch could not be merged into reads, after its mission. */
export const syncConflictBrief = (report: Pick<TreeSyncReport, "conflictPaths" | "project">): string => conflictRecipe([
  `SYNC_CONFLICT: your working tree is behind the project's branch ${report.project ?? "HEAD"}, and Moe could not bring it in: the merge conflicts, so your tree was left exactly as it was.`,
  "Merge it yourself BEFORE you start. Work built on a stale base conflicts again at integration and its acceptance is withdrawn.",
], report.conflictPaths, report.project ?? "HEAD", "Then do the task above, run the test, and submit the review.");

export interface TreeSyncBeforeSeat {
  readonly git?: IntegrationGit;
  readonly log: (line: string) => void;
  readonly nodeRef: string;
  /** The project's own checkout, the source of the HEAD; null = no MOE_NODE_WORKSPACE, nothing to sync from. */
  readonly projectRoot: string | null;
  /** Where the node is briefed. Only its own tree is ever synced. */
  readonly workspace: string;
}

/**
 * The staffing path's half: the node's own tree and nothing else, one `[trees]` line, and the
 * seat's brief when the merge conflicts. It never throws: a sync that fails costs the seat only
 * its head start, never its staffing.
 */
export function syncTreeBeforeSeat(input: TreeSyncBeforeSeat): string | null {
  if (input.projectRoot === null) return null;
  try {
    // Proved as the withdrawal proves a node's own tree (node-delivery-withdrawal.ts), never
    // inferred from the knob: a node finishing in the project's checkout, one that fell back to
    // it, and one pinned back to it by a refused landing all hold the shared checkout.
    const tree = ownNodeTree(input.projectRoot, input.nodeRef);
    if (tree === null || realpathSync.native(input.workspace) !== tree) return null;
    const report = syncNodeTree({ ...(input.git === undefined ? {} : { git: input.git }), projectRoot: input.projectRoot, tree });
    input.log(`[trees] ${input.nodeRef}: ${report.outcome} (${report.detail})`);
    return report.outcome === "SYNC_CONFLICT" ? syncConflictBrief(report) : null;
  } catch (error) {
    input.log(`[trees] ${input.nodeRef}: SYNC_FAILED (${error instanceof Error ? error.message.slice(0, 240) : "unknown failure"})`);
    return null;
  }
}
