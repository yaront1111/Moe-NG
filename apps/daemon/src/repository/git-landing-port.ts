import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { DELETED_BLOB } from "./landing-receipt-contracts.js";
import type { LandingBaselineEntry } from "./landing-receipt-contracts.js";

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

export interface GitRunResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export type GitRunner = (
  cwd: string, args: readonly string[], stdin?: string,
) => Promise<GitRunResult>;

const GIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DETAIL_TAIL = 600;
const MOE_DIRECTORIES: ReadonlySet<string> = new Set([".moe", ".moe-next"]);
/** The identity every landing carries: Moe's, never the operator's. */
const LANDER_IDENTITY = ["-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false"];

function landingEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE from a parent shell would redirect the landing.
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  environment["GIT_OPTIONAL_LOCKS"] = "0";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["LC_ALL"] = "C";
  return environment;
}

export const nodeGitRunner: GitRunner = (cwd, args, stdin) => new Promise((resolve) => {
  const child = execFile("git", [...args], {
    cwd, encoding: "utf8", env: landingEnvironment(), maxBuffer: MAX_OUTPUT_BYTES,
    timeout: GIT_TIMEOUT_MS, windowsHide: true,
  }, (error, stdout, stderr) => {
    const code = error === null ? 0
      : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
    resolve({ code, stderr: `${stderr}${error === null || code !== null ? "" : String(error)}`, stdout });
  });
  if (child.stdin !== null) {
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  }
});

const tail = (text: string): string => text.slice(-DETAIL_TAIL).toWellFormed();

function isMoeMetadata(path: string): boolean {
  return path.split("/").some((segment) => MOE_DIRECTORIES.has(segment));
}

/** `git status --porcelain=v1 -z --no-renames`: `XY path\0` records, root-relative. */
function parseStatus(output: string): readonly { readonly deleted: boolean; readonly path: string }[] {
  const entries: { deleted: boolean; path: string }[] = [];
  for (const record of output.split("\0")) {
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path === "" || isMoeMetadata(path)) continue;
    entries.push({ deleted: status.includes("D"), path });
  }
  return entries;
}

export function createGitLandingPort(run: GitRunner = nodeGitRunner): GitLandingPort {
  const root = async (workspace: string): Promise<string | null> => {
    const top = await run(workspace, ["rev-parse", "--show-toplevel"]);
    return top.code === 0 ? top.stdout.trim() : null;
  };

  const observe = async (workspace: string): Promise<GitObserveResult> => {
    const top = await root(workspace);
    if (top === null) {
      return { code: "NOT_A_REPOSITORY", detail: `${workspace} is not inside a git repository`, ok: false };
    }
    // Only the workspace subtree, named relative to the root so the paths agree everywhere.
    const scope = relative(top, workspace).split(sep).join("/");
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
    return { observation: Object.freeze({ entries: Object.freeze(entries), root: top }), ok: true };
  };

  const commit = async (
    workspace: string, paths: readonly string[], message: string,
  ): Promise<GitCommitResult> => {
    const top = await root(workspace);
    if (top === null) return { code: "GIT_COMMIT_FAILED", detail: "not a repository", ok: false };
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

  return Object.freeze({ commit, observe });
}
