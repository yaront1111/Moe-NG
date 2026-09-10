import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { GitRunner } from "./git-landing-port.js";

/**
 * Materialise ONE committed path of ONE commit into a caller-owned directory, reading nothing
 * from the working tree.
 *
 * The recipe lives in `withBareSourceRepository` below and is SHARED with the deployment image
 * builder, which used to carry its own copy: verify the commit, point a BARE temporary repository
 * at the source repository's object store through `objects/info/alternates`, and read through that
 * isolated Git directory so worktree attributes, templates and replacement refs cannot reach the
 * result. This reader differs from the builder in the last step only: a `checkout` into an explicit
 * work tree rather than an archive stream, because `tar` is not a daemon dependency and a
 * `tar`-on-PATH assumption would make the extraction fail on hosts the image build survives.
 *
 * The source repository's own `.git` is never written: every mutation lands in the temporary bare
 * repository (which gains an `index`) or under `destination`.
 */
export interface CommittedSourceRequest {
  /** Caller-owned directory the path is written INTO. The caller creates and removes it. */
  readonly destination: string;
  /** Repository-root-relative, e.g. `migrations`. Never absolute, never `..`-bearing. */
  readonly path: string;
  readonly repository: string;
  readonly sha: string;
}

/** `SOURCE_COMMIT_UNAVAILABLE` = the tree cannot answer for that commit at all;
 *  `SOURCE_PATH_UNAVAILABLE` = the commit is real but the path is not in it (or not extractable). */
export type CommittedSourceResult = "OK" | "SOURCE_COMMIT_UNAVAILABLE" | "SOURCE_PATH_UNAVAILABLE";

// `core.autocrlf=false` rides on EVERY call rather than the checkout alone: a host with the global
// flag on would otherwise hand the migration tool CRLF bytes that the commit does not contain.
const GIT = ["--no-replace-objects", "-c", `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c", "core.autocrlf=false"];
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PATHSPEC = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/u;

/** What a caller does with a prepared bare repository, and what it answers when preparation fails.
 *  `T` is the CALLER's own result type, so neither caller has to translate a foreign refusal. */
export interface BareSourceHooks<T> {
  /** `mkdtempSync` prefix, so a leaked directory still names the seam that made it. */
  readonly prefix: string;
  /** Answers an unverifiable commit, an unusable object store, or a bare `init` that failed. */
  readonly refuse: () => T;
  /** The caller's OWN check, run after the commit is verified and BEFORE any temporary directory
   *  exists. A non-null answer is returned unchanged, which is what keeps each caller's refusal
   *  ORDER exactly where it was before the recipe was shared. */
  readonly precondition?: () => Promise<T | null>;
  /** Runs with the prepared bare repository. It is removed as soon as this settles, so anything
   *  that must read it — a `checkout`, an archive stream — has to finish inside. */
  readonly use: (directory: string) => Promise<T>;
}

/**
 * THE RECIPE BOTH READERS OF A COMMIT SHARE: verify the commit, point a BARE temporary repository
 * at the source repository's object store through `objects/info/alternates`, hand that directory
 * to the caller, and remove it under a prefix fence on every exit path.
 *
 * TEARDOWN IS AROUND `use`, NOT BEFORE IT. That is the whole reason this exists as a primitive
 * rather than as a call to `extractCommittedPath`: the image builder streams a `git archive` out
 * of the directory into Docker's stdin, so a helper that removed the directory before returning
 * would typecheck green and archive nothing. Exceptions are NOT caught here — each caller keeps
 * its own catch and its own vocabulary — but the `finally` still runs, so a throwing `use` cannot
 * leak the directory either.
 */
export async function withBareSourceRepository<T>(
  git: GitRunner, request: { readonly repository: string; readonly sha: string }, hooks: BareSourceHooks<T>,
): Promise<T> {
  let temporary: string | null = null;
  const temporaryRoot = resolve(tmpdir());
  try {
    // A timeout answers `code: null` (git-landing-port.ts:96-98). Only an explicit 0 is success:
    // every other answer, including the uncertain one, refuses.
    const commit = await git(request.repository, [...GIT, "rev-parse", "--verify", `${request.sha}^{commit}`]);
    if (commit.code !== 0 || commit.stdout.trim() !== request.sha) return hooks.refuse();
    const blocked = hooks.precondition === undefined ? null : await hooks.precondition();
    if (blocked !== null) return blocked;
    const objects = await git(request.repository, [...GIT, "rev-parse", "--path-format=absolute", "--git-path", "objects"]);
    const objectPath = objects.stdout.replace(/\r?\n$/u, "");
    if (objects.code !== 0 || !isAbsolute(objectPath) || /[\r\n\0]/u.test(objectPath)) return hooks.refuse();
    temporary = mkdtempSync(join(temporaryRoot, hooks.prefix));
    const initialized = await git(temporary, [...GIT, "init", "--bare", "--template=",
      `--object-format=${request.sha.length === 64 ? "sha256" : "sha1"}`, "."]);
    if (initialized.code !== 0) return hooks.refuse();
    mkdirSync(join(temporary, "objects", "info"), { recursive: true });
    writeFileSync(join(temporary, "objects", "info", "alternates"), `${objectPath.replaceAll("\\", "/")}\n`);
    return await hooks.use(temporary);
  } finally {
    // Prefix-fenced: a `temporary` that is not under the temporary root is never removed, whatever
    // produced it.
    if (temporary !== null && resolve(temporary).startsWith(`${temporaryRoot}${sep}`)) {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function canonical(value: string): string {
  const trimmed = resolve(value.replace(/\r?\n$/u, ""));
  try { return resolve(realpathSync(trimmed)); } catch { return trimmed; }
}

/** Windows compares paths case-insensitively; a case-different toplevel is the SAME directory. */
function sameDirectory(reported: string, expected: string): boolean {
  const left = canonical(reported);
  const right = canonical(expected);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function extractCommittedPath(
  git: GitRunner, request: CommittedSourceRequest,
): Promise<CommittedSourceResult> {
  if (!isAbsolute(request.repository) || !SHA.test(request.sha)) return "SOURCE_COMMIT_UNAVAILABLE";
  if (!isAbsolute(request.destination) || !PATHSPEC.test(request.path)
    || request.path.split("/").includes("..")) return "SOURCE_PATH_UNAVAILABLE";
  try {
    return await withBareSourceRepository<CommittedSourceResult>(git, request, {
      prefix: "moe-source-objects-",
      refuse: () => "SOURCE_COMMIT_UNAVAILABLE",
      // The checkout pathspec is REPOSITORY-ROOT relative, and `--git-path` answers for the
      // ENCLOSING repository. A workspace that is a subdirectory would therefore silently extract
      // the root's `<path>` instead of its own, so it is refused rather than served the wrong tree.
      // It runs as a PRECONDITION so it still answers before any temporary directory is made,
      // which is where it sat before the recipe was shared.
      precondition: async () => {
        const toplevel = await git(request.repository, [...GIT, "rev-parse", "--path-format=absolute", "--show-toplevel"]);
        return toplevel.code !== 0 || !sameDirectory(toplevel.stdout, request.repository)
          ? "SOURCE_PATH_UNAVAILABLE" : null;
      },
      use: async temporary => {
        // cwd is the work tree's own root, so the pathspec keeps its repository-root meaning.
        const checkout = await git(request.destination, [...GIT, `--git-dir=${temporary}`,
          `--work-tree=${request.destination}`, "checkout", request.sha, "--", request.path]);
        return checkout.code === 0 ? "OK" : "SOURCE_PATH_UNAVAILABLE";
      },
    });
  } catch { return "SOURCE_PATH_UNAVAILABLE"; }
}
