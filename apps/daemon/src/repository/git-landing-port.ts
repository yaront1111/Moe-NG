import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { nodeGitRunner } from "./git-process-runner.js";
import type { GitRunner } from "./git-process-runner.js";
import { DELETED_BLOB } from "./landing-receipt-contracts.js";
import type { LandingBaselineEntry } from "./landing-receipt-contracts.js";

// The process launcher lives in git-process-runner.ts; every caller keeps importing it from here.
export { landingEnvironment, nodeGitRunner } from "./git-process-runner.js";
export type { GitRunResult, GitRunner } from "./git-process-runner.js";

/**
 * The lander's only effect boundary: observe a workspace's dirty paths and
 * commit an explicit list of them. Everything is `git` with argv arrays (no
 * shell), a bounded timeout, and no prompt. The port is an interface so the
 * lander is unit-tested against a fake and this file is tested against a real
 * scratch repository.
 *
 * Paths are repository-root-relative on both sides, whatever subdirectory the
 * workspace is. Untracked runtime metadata is excluded; tracked runtime metadata
 * changes refuse observation, since silently omitting them breaks the verified tree.
 */

export interface GitObservation {
  readonly entries: readonly LandingBaselineEntry[];
  readonly root: string;
  /** The subset of `entries` git does not track (`??`), so a landing can carry an import
   *  HEAD would otherwise lack. Optional: a fake that omits it reads as "none untracked". */
  readonly untracked?: readonly string[];
}

export type GitObserveResult =
  | Readonly<{ readonly observation: GitObservation; readonly ok: true }>
  | Readonly<{ readonly code: "NOT_A_REPOSITORY" | "GIT_FAILED" | typeof TRACKED_RUNTIME_METADATA_DIRTY; readonly detail: string; readonly ok: false; /** Present on TRACKED_RUNTIME_METADATA_DIRTY only: the full sorted dirty set, untruncated, for a self-heal to act on. `detail` shows at most four. */ readonly paths?: readonly string[] }>;

export const TRACKED_RUNTIME_METADATA_DIRTY = "TRACKED_RUNTIME_METADATA_DIRTY" as const;

export interface GitCommitReceipt {
  readonly branch: string;
  readonly parentSha: string | null;
  readonly sha: string;
}

export type GitCommitResult =
  | Readonly<{ readonly ok: true; readonly receipt: GitCommitReceipt }>
  | Readonly<{ readonly code: "GIT_COMMIT_FAILED"; readonly detail: string; readonly ok: false }>;

export interface GitLandingPort {
  commit(workspace: string, paths: readonly string[], message: string): Promise<GitCommitResult>;
  observe(workspace: string): Promise<GitObserveResult>;
}

export interface GitPushReceipt {
  readonly branch: string;
  readonly sha: string;
}

export type GitPushResult =
  | Readonly<{ readonly ok: true; readonly receipt: GitPushReceipt }>
  | Readonly<{ readonly code: "GIT_PUSH_FAILED" | "NOT_A_REPOSITORY" | "DETACHED_HEAD"; readonly detail: string; readonly ok: false }>;

/** `commit` of TRACKED paths with no `add` first (`add` exits 1 for one under an ignored directory: every hosted `.moe-next/`, 2026-09-18), each pathspec `:(literal)` so `[`, `*` and `?` never glob onto another file. Per path, not the global `--literal-pathspecs`, which leaks GIT_LITERAL_PATHSPECS=1 into the operator's hooks (measured 2026-09-18). */
export interface GitTrackedCommitPort { commitTracked(workspace: string, paths: readonly string[], message: string): Promise<GitCommitResult> }

/** The publisher's effect: push the workspace's current branch to a remote the human named. */
export interface GitPublishPort {
  push(workspace: string, remoteUrl: string): Promise<GitPushResult>;
}

const DETAIL_TAIL = 600;
const MOE_DIRECTORIES: ReadonlySet<string> = new Set([".moe", ".moe-next"]);
/** The identity every landing carries: Moe's, never the operator's. */
export const LANDER_IDENTITY = ["-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false"];

const tail = (text: string): string => text.slice(-DETAIL_TAIL).toWellFormed();

export function isMoeMetadata(path: string): boolean {
  return path.split("/").some((segment) => MOE_DIRECTORIES.has(process.platform === "win32" ? segment.toLowerCase() : segment));
}

/** `git status --porcelain=v1 -z --no-renames`: `XY path\0` records, root-relative. */
function parseStatus(
  output: string,
): readonly { readonly deleted: boolean; readonly path: string; readonly untracked: boolean }[] {
  const entries: { deleted: boolean; path: string; untracked: boolean }[] = [];
  for (const record of output.split("\0")) {
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path === "") continue;
    entries.push({ deleted: status.includes("D"), path, untracked: status === "??" });
  }
  return entries;
}

/** MEASURED 2026-09-13 (Node 24.16, Windows): a removed directory stats ENOENT. Any other stat
 *  error proves nothing about the directory, so the caller keeps the answer git gave. */
function workspaceDirectoryGone(workspace: string): boolean {
  try {
    statSync(workspace);
    return false;
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT";
  }
}

export function createGitLandingPort(run: GitRunner = nodeGitRunner): GitLandingPort & GitPublishPort & GitTrackedCommitPort {
  // The repository root as git states it (a real path); the workspace resolved the same way,
  // so a temp directory reached through a symlink (macOS /var -> /private/var) does not read
  // as a path outside the repository when the two are made relative.
  // MEASURED 2026-09-13 (git 2.54, Node 24.16, Windows): outside a repository `rev-parse
  // --show-toplevel` exits 128 and says `fatal: not a git repository`; inside a bare one it exits
  // 128 and says `fatal: this operation must be run in a work tree`; with a cwd that no longer
  // exists Node never spawns git and answers `spawn git ENOENT` as `code: null`, the words a missing
  // binary also gives. Those two fatals and a directory measured gone are configurations git cannot
  // land into. A spawn failure with the directory present, a timeout kill (also `code: null`) and
  // any other fatal are moments the lander must retry, never refusals recorded against the delivery.
  const root = async (workspace: string): Promise<
    Readonly<{ top: string }> | Readonly<{ top: null; code: "NOT_A_REPOSITORY" | "GIT_FAILED"; detail: string }>
  > => {
    const top = await run(workspace, ["rev-parse", "--show-toplevel"]);
    if (top.code === 0) return { top: top.stdout.trim() };
    const refuse = (detail: string) => ({ code: "NOT_A_REPOSITORY" as const, detail, top: null });
    if (top.code === 128 && /not a git repository/u.test(top.stderr)) return refuse(`${workspace} is not inside a git repository`);
    if (top.code === 128 && /must be run in a work tree/u.test(top.stderr)) return refuse(`${workspace} is a bare repository (no work tree)`);
    if (top.code === null && workspaceDirectoryGone(workspace)) return refuse(`workspace directory does not exist: ${workspace}`);
    return { code: "GIT_FAILED", detail: tail(top.stderr), top: null };
  };
  const realWorkspace = (workspace: string): string => {
    try {
      return realpathSync.native(workspace);
    } catch {
      return workspace;
    }
  };

  const observe = async (workspace: string): Promise<GitObserveResult> => {
    const located = await root(workspace);
    if (located.top === null) return { code: located.code, detail: located.detail, ok: false };
    const top = located.top;
    // Only the workspace subtree, named relative to the root so the paths agree everywhere.
    const scope = relative(realWorkspace(top), realWorkspace(workspace)).split(sep).join("/");
    if (scope.startsWith("..")) {
      return { code: "NOT_A_REPOSITORY", detail: `${workspace} is outside ${top}`, ok: false };
    }
    const status = await run(top, [
      "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all",
      "--", ".",
    ]);
    if (status.code !== 0) return { code: "GIT_FAILED", detail: tail(status.stderr), ok: false };
    const all = parseStatus(status.stdout);
    // The verifier captures the whole repository, including tracked metadata outside a
    // requested subtree. Neither a current baseline nor an older incomplete baseline can
    // grant authority to silently omit or commit these preexisting runtime files.
    const metadata = all.filter((entry) => !entry.untracked && isMoeMetadata(entry.path));
    if (metadata.length > 0) {
      const shown = JSON.stringify(metadata.slice(0, 4).map((entry) => entry.path.slice(0, 120))).slice(0, 350);
      return { ok: false, code: TRACKED_RUNTIME_METADATA_DIRTY, paths: metadata.map((entry) => entry.path).sort(),
        detail: `${String(metadata.length)} tracked runtime metadata path(s) changed: ${shown}. Review these existing changes with git status --short before continuing.` };
    }
    const dirty = all.filter((entry) => !isMoeMetadata(entry.path)
      && (scope === "" || entry.path.startsWith(`${scope}/`)));
    const present = dirty.filter((entry) => !entry.deleted).map((entry) => entry.path);
    const blobs = new Map<string, string>();
    if (present.length > 0) {
      const hashed = await run(top, ["hash-object", "--stdin-paths"], `${present.join("\n")}\n`);
      if (hashed.code !== 0) return { code: "GIT_FAILED", detail: tail(hashed.stderr), ok: false };
      const ids = hashed.stdout.trim().split(/\r?\n/u);
      if (ids.length !== present.length) {
        return { code: "GIT_FAILED", detail: "hash-object answered a different number of ids", ok: false };
      }
      present.forEach((path, index) => { blobs.set(path, ids[index] as string); });
    }
    const entries = dirty
      .map((entry) => Object.freeze({
        blobId: entry.deleted ? DELETED_BLOB : (blobs.get(entry.path) as string), path: entry.path,
      }))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const untracked = dirty.filter((entry) => entry.untracked).map((entry) => entry.path)
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      observation: Object.freeze({
        entries: Object.freeze(entries), root: top, untracked: Object.freeze(untracked),
      }),
      ok: true,
    };
  };

  const commitPaths = (stage: boolean) => async (
    workspace: string, paths: readonly string[], message: string,
  ): Promise<GitCommitResult> => {
    const located = await root(workspace);
    if (located.top === null) return { code: "GIT_COMMIT_FAILED", detail: located.detail, ok: false };
    const top = located.top;
    const pathspecs = `${(stage ? paths : paths.map((path) => `:(literal)${path}`)).join("\0")}\0`;
    const added = stage ? await run(top, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], pathspecs) : null;
    if (added !== null && added.code !== 0) return { code: "GIT_COMMIT_FAILED", detail: tail(added.stderr), ok: false };
    const scratch = mkdtempSync(join(tmpdir(), "moe-landing-"));
    try {
      const messagePath = join(scratch, "message.txt");
      writeFileSync(messagePath, message, "utf8");
      const committed = await run(top, [
        ...LANDER_IDENTITY, "commit", "--only", "--quiet", "--no-status", `--file=${messagePath}`,
        "--pathspec-from-file=-", "--pathspec-file-nul",
      ], pathspecs);
      if (committed.code !== 0) {
        return { code: "GIT_COMMIT_FAILED", detail: tail(`${committed.stdout}${committed.stderr}`), ok: false };
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
    const head = await run(top, ["rev-parse", "HEAD"]);
    const branch = await run(top, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const parent = await run(top, ["rev-parse", "--verify", "--quiet", "HEAD^"]);
    if (head.code !== 0 || branch.code !== 0) {
      return { code: "GIT_COMMIT_FAILED", detail: tail(head.stderr + branch.stderr), ok: false };
    }
    return {
      ok: true,
      receipt: Object.freeze({
        branch: branch.stdout.trim(),
        parentSha: parent.code === 0 ? parent.stdout.trim() : null,
        sha: head.stdout.trim(),
      }),
    };
  };

  const push = async (workspace: string, remoteUrl: string): Promise<GitPushResult> => {
    const located = await root(workspace);
    if (located.top === null) {
      return { code: located.code === "NOT_A_REPOSITORY" ? "NOT_A_REPOSITORY" : "GIT_PUSH_FAILED", detail: located.detail, ok: false };
    }
    const top = located.top;
    const branch = await run(top, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const head = await run(top, ["rev-parse", "HEAD"]);
    if (branch.code !== 0 || head.code !== 0) {
      return { code: "GIT_PUSH_FAILED", detail: tail(branch.stderr + head.stderr), ok: false };
    }
    const name = branch.stdout.trim();
    if (name === "HEAD") return { code: "DETACHED_HEAD", detail: "the workspace has no branch checked out", ok: false };
    // The remote is the URL the human named, never a configured remote name: the decision
    // says where the bytes go, and a renamed origin cannot redirect it.
    const sha = head.stdout.trim();
    const ref = `refs/heads/${name}`;
    const pushed = await run(top, ["push", "--", remoteUrl, `${sha}:${ref}`]);
    if (pushed.code !== 0) {
      return { code: "GIT_PUSH_FAILED", detail: tail(`${pushed.stdout}${pushed.stderr}`), ok: false };
    }
    const confirmed = await run(top, ["ls-remote", "--refs", "--", remoteUrl, ref]);
    const remoteRefs = confirmed.stdout.trim().split(/\r?\n/u);
    if (confirmed.code !== 0 || remoteRefs.length !== 1 || remoteRefs[0] !== `${sha}\t${ref}`) {
      return { code: "GIT_PUSH_FAILED", detail: "remote branch did not confirm the pushed commit", ok: false };
    }
    return { ok: true, receipt: Object.freeze({ branch: name, sha }) };
  };

  return Object.freeze({ commit: commitPaths(true), commitTracked: commitPaths(false), observe, push });
}
