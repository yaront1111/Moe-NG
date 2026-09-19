import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isRepositoryWorkflowRef } from "../repository/repository-workflow-ref.js";

/**
 * One Git working tree per node (owner decision 2026-09-16). Moe holds a checkout per working
 * tree, so every node sharing one tree meant exactly one node could code at a time: on UnAI the
 * siblings queued on REPOSITORY_EXECUTION_BUSY while a single seat worked. A linked worktree has
 * its own working tree, index and HEAD, so each node holds its own and they run in parallel;
 * their work meets again only where a merge can be judged.
 *
 * The trees live under `.moe-next/trees`, which Moe already keeps out of Git
 * (repository/runtime-metadata-excludes.ts), so a node's tree is never another node's dirty path.
 * Each tree is checked out on its own `moe/<name>` branch, cut from the integration branch the
 * project had when the tree was made, and a branch a node already landed work on is reused.
 *
 * Synchronous on purpose: a mission is resolved on every pass and in paths that cannot await, so
 * the answer is cached per runtime and Git is asked once per node. Every failure answers null and
 * the caller keeps the project's own workspace, which is the single-tree behaviour that shipped
 * before this. A tree is never invented for a workflow subject (publish, criterion); those act on
 * the project's own checkout.
 */
export const NODE_TREES_DIRECTORY = join(".moe-next", "trees");
export const NODE_BRANCH_PREFIX = "moe/";
/** The project a node's tree belongs to: a tree is `<project>/.moe-next/trees/<name>`, three levels under it. */
export const projectOfTree = (tree: string): string => resolve(tree, "..", "..", "..");
const NAME_LIMIT = 40;

export interface NodeTree {
  readonly branch: string;
  readonly path: string;
}

/** Stable, filesystem-safe and collision-free: readable prefix plus a digest of the exact ref. */
export function nodeTreeName(nodeRef: string): string | null {
  if (typeof nodeRef !== "string" || nodeRef.trim() === "" || nodeRef.length > 4096 || isRepositoryWorkflowRef(nodeRef)) return null;
  const readable = nodeRef.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, NAME_LIMIT)
    .replace(/-+$/gu, "");
  const digest = createHash("sha256").update(nodeRef, "utf8").digest("hex").slice(0, 8);
  return readable === "" ? `node-${digest}` : `${readable}-${digest}`;
}

export type GitRun = (cwd: string, args: readonly string[]) => { readonly code: number; readonly stdout: string };

const runGit: GitRun = (cwd, args) => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  try {
    const stdout = execFileSync("git", [...args], {
      cwd, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 1_048_576, stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    return { code: 0, stdout };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string };
    return { code: typeof failure.status === "number" ? failure.status : 1, stdout: failure.stdout ?? "" };
  }
};

/** Asked once per node per runtime; a tree that has since gone is made again. */
const known = new Map<string, NodeTree>();

/**
 * The node's own tree, made if it is not there yet. An existing directory is accepted only when
 * Git itself reports it as that tree's own root, so a stray folder never becomes a workspace.
 */
export function ensureNodeTree(input: {
  readonly nodeRef: string;
  readonly projectRoot: string;
  readonly run?: GitRun;
}): NodeTree | null {
  const run = input.run ?? runGit;
  const name = nodeTreeName(input.nodeRef);
  if (name === null) return null;
  try {
    // Git reports a root canonically (drive-letter case, 8.3 segments, links resolved), so the
    // root a launcher spelled is held the same way before the two are ever compared.
    const projectRoot = realpathSync.native(resolve(input.projectRoot));
    // A tree is never cut from inside another tree: that is a node's workspace already.
    if (projectRoot.includes(`${sep}${NODE_TREES_DIRECTORY}${sep}`)) return null;
    const path = join(projectRoot, NODE_TREES_DIRECTORY, name);
    const branch = `${NODE_BRANCH_PREFIX}${name}`;
    const key = `${projectRoot}\0${input.nodeRef}`;
    const cached = known.get(key);
    if (cached !== undefined && existsSync(cached.path)) return cached;
    const keep = (tree: NodeTree): NodeTree => { known.set(key, tree); return tree; };
    if (existsSync(path)) {
      const top = run(path, ["rev-parse", "--show-toplevel"]);
      if (top.code !== 0 || realpathSync.native(top.stdout.trim()) !== path) return null;
      return keep({ branch, path });
    }
    const project = run(projectRoot, ["rev-parse", "--show-toplevel"]);
    if (project.code !== 0 || realpathSync.native(project.stdout.trim()) !== projectRoot) return null;
    // Cut from the project's current integration branch, or from its HEAD when it has no branch.
    const head = run(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head.code !== 0) return null;
    const from = head.stdout.trim() === "" ? "HEAD" : head.stdout.trim();
    // A tree deleted outright (rm -rf, a swept scratch directory) stays registered, and Git will
    // not add over a registration it still holds: the stale ones are dropped first.
    if (run(projectRoot, ["worktree", "prune"]).code !== 0) return null;
    const made = run(projectRoot, ["worktree", "add", "--quiet", "-b", branch, path, from]);
    // A branch this node already used is reused rather than renamed: its landed work is on it.
    const added = made.code === 0 ? made : run(projectRoot, ["worktree", "add", "--quiet", path, branch]);
    if (added.code !== 0) return null;
    const top = run(path, ["rev-parse", "--show-toplevel"]);
    return top.code === 0 && realpathSync.native(top.stdout.trim()) === path ? keep({ branch, path }) : null;
  } catch { return null; }
}

/** Test seam: the cache is per runtime, and a fixture's repositories are not. */
export function forgetNodeTrees(): void { known.clear(); }
