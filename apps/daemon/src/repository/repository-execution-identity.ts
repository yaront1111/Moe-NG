import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { repositoryExecutionFailure } from "./repository-execution-contracts.js";
import type { RepositoryExecutionIdentity, RepositoryExecutionResult } from "./repository-execution-contracts.js";

/**
 * WHY THE ANSWER IS REMEMBERED. Every repository-port call resolves the checkout's identity by
 * spawning `git rev-parse`, and the wrapper's delivery pass makes several port calls per
 * workspace per pass. Measured on UnAI 2026-09-17 with a 15 s CPU profile of the live wrapper,
 * after the ledger walks were memoised: 26% of its CPU under this function and `spawn` the
 * single largest self-time at 25.8% — ~70 synchronous git spawns per pass, each holding the
 * event loop for its whole life.
 *
 * WHY IT IS STILL EXACT. The identity is what `git rev-parse` would say NOW, and it can only
 * change through the filesystem: the root's `.git` entry (a file naming the git dir for a
 * linked worktree, a directory for a clone) can be replaced, the git directory can go away, or
 * a nested repository can appear on the path between the workspace and its root — in which
 * case git would answer with the nested one. Each remembered identity records those three facts
 * as observed, and a hit re-observes all of them with a handful of stats before answering. Any
 * difference falls back to git. A failure is never remembered: the checkout may appear later.
 */

type GitEntry =
  | { readonly kind: "directory" }
  | { readonly kind: "file"; readonly content: string };

interface RememberedIdentity {
  readonly identity: RepositoryExecutionIdentity;
  readonly gitEntry: GitEntry;
  /** Directories strictly between the resolved workspace and its root, nearest first. */
  readonly hops: readonly string[];
}

const remembered = new Map<string, RememberedIdentity>();

function gitEntryOf(root: string): GitEntry | null {
  const path = join(root, ".git");
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return { kind: "directory" };
    if (stat.isFile()) return { kind: "file", content: readFileSync(path, "utf8") };
    return null;
  } catch { return null; }
}

function hopsBetween(workspace: string, root: string): readonly string[] {
  const hops: string[] = [];
  let current = workspace;
  while (current !== root) {
    hops.push(current);
    const parent = dirname(current);
    if (parent === current) return hops;
    current = parent;
  }
  return hops;
}

function stillCurrent(held: RememberedIdentity): boolean {
  const entry = gitEntryOf(held.identity.root);
  if (entry === null || entry.kind !== held.gitEntry.kind) return false;
  if (entry.kind === "file" && held.gitEntry.kind === "file" && entry.content !== held.gitEntry.content) return false;
  if (!existsSync(held.identity.gitDirectory)) return false;
  for (const hop of held.hops) if (existsSync(join(hop, ".git"))) return false;
  return true;
}

function remember(workspace: string, identity: RepositoryExecutionIdentity): void {
  try {
    const resolved = realpathSync.native(workspace);
    const gitEntry = gitEntryOf(identity.root);
    if (gitEntry === null) return;
    remembered.set(workspace, { gitEntry, hops: hopsBetween(resolved, identity.root), identity });
  } catch { /* A workspace whose path cannot be resolved is answered fresh each time. */ }
}

/** Per-checkout git-dir identity: linked worktrees have different working trees and indexes. */
export function resolveRepositoryExecutionIdentity(workspace: string): RepositoryExecutionResult<{ identity: RepositoryExecutionIdentity }> {
  const held = remembered.get(workspace);
  if (held !== undefined) {
    if (stillCurrent(held)) return { ok: true, identity: held.identity };
    remembered.delete(workspace);
  }
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    const output = execFileSync("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], {
      cwd: workspace, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000,
      maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    const lines = output.replace(/\r?\n$/u, "").split(/\r?\n/u);
    if (lines.length !== 2 || !lines[0] || !lines[1] || !isAbsolute(lines[0]) || !isAbsolute(lines[1])) {
      return repositoryExecutionFailure("REPOSITORY_IDENTITY_UNKNOWN");
    }
    const identity = Object.freeze({ root: realpathSync.native(lines[0]), gitDirectory: realpathSync.native(lines[1]) });
    remember(workspace, identity);
    return { ok: true, identity };
  } catch { return repositoryExecutionFailure("REPOSITORY_IDENTITY_UNKNOWN"); }
}
