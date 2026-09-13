import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
 * workspace is; Moe's own metadata directories (`.moe-next`, `.moe`) are never
 * part of a landing.
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
  | Readonly<{ readonly code: "NOT_A_REPOSITORY" | "GIT_FAILED"; readonly detail: string; readonly ok: false }>;

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

/** The publisher's effect: push the workspace's current branch to a remote the human named. */
export interface GitPublishPort {
  push(workspace: string, remoteUrl: string): Promise<GitPushResult>;
}

const DETAIL_TAIL = 600;
const MOE_DIRECTORIES: ReadonlySet<string> = new Set([".moe", ".moe-next"]);
/** The identity every landing carries: Moe's, never the operator's. */
export const LANDER_IDENTITY = ["-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false"];

const tail = (text: string): string => text.slice(-DETAIL_TAIL).toWellFormed();

function isMoeMetadata(path: string): boolean {
  return path.split("/").some((segment) => MOE_DIRECTORIES.has(segment));
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
    if (path === "" || isMoeMetadata(path)) continue;
    entries.push({ deleted: status.includes("D"), path, untracked: status === "??" });
  }
  return entries;
}

export function createGitLandingPort(run: GitRunner = nodeGitRunner): GitLandingPort & GitPublishPort {
  // The repository root as git states it (a real path); the workspace resolved the same way,
  // so a temp directory reached through a symlink (macOS /var -> /private/var) does not read
  // as a path outside the repository when the two are made relative.
  // MEASURED 2026-09-13 (git 2.54): outside a repository `rev-parse --show-toplevel` exits 128 and
  // says `fatal: not a git repository`. Only those words are structural. A spawn error and a
  // timeout kill both arrive as `code: null`, and any other fatal is also 128: each is a moment
  // the lander must retry, never a refusal it records against the accepted delivery.
  const root = async (workspace: string): Promise<
    Readonly<{ top: string }> | Readonly<{ top: null; code: "NOT_A_REPOSITORY" | "GIT_FAILED"; detail: string }>
  > => {
    const top = await run(workspace, ["rev-parse", "--show-toplevel"]);
    if (top.code === 0) return { top: top.stdout.trim() };
    if (top.code === 128 && /not a git repository/u.test(top.stderr)) {
      return { code: "NOT_A_REPOSITORY", detail: `${workspace} is not inside a git repository`, top: null };
    }
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
      "--", scope === "" ? "." : scope,
    ]);
    if (status.code !== 0) return { code: "GIT_FAILED", detail: tail(status.stderr), ok: false };
    const dirty = parseStatus(status.stdout);
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

  const commit = async (
    workspace: string, paths: readonly string[], message: string,
  ): Promise<GitCommitResult> => {
    const located = await root(workspace);
    if (located.top === null) return { code: "GIT_COMMIT_FAILED", detail: located.detail, ok: false };
    const top = located.top;
    const pathspecs = `${paths.join("\0")}\0`;
    const added = await run(top, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], pathspecs);
    if (added.code !== 0) return { code: "GIT_COMMIT_FAILED", detail: tail(added.stderr), ok: false };
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

  return Object.freeze({ commit, observe, push });
}
