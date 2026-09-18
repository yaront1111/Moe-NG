import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { landingEnvironment, nodeGitRunner } from "./git-landing-port.js";
import type { GitRunner } from "./git-landing-port.js";
import { decodePublicationCandidate, publicationRefused, publicationRepositoryId, validPublicationBranch, validPublicationSha } from "./publication-approval-contracts.js";
import type { PublicationCandidate, PublicationRefusal } from "./publication-approval-contracts.js";
import type { PublicationGitPort } from "./publication-effect-contracts.js";
import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";
import { publicationCredentialArguments } from "./git-publication-credentials.js";

/** No repository/global URL rewrites, hooks, or named-remote push configuration enter this process. */
export const publicationGitRunner: GitRunner = (cwd, args) => new Promise((done) => {
  const env = landingEnvironment();
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_SYSTEM"] = process.platform === "win32" ? "NUL" : "/dev/null";
  env["GIT_CONFIG_GLOBAL"] = env["GIT_CONFIG_SYSTEM"];
  execFile("git", [...args], { cwd, env, encoding: "utf8", shell: false, windowsHide: true,
    timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => done({
      code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout, stderr,
    }));
});
/** Git ran the push and exited non-zero: the one push failure that is an answer, not a silence. */
export const PUBLISH_PUSH_REJECTED = "PUBLISH_PUSH_REJECTED";
export interface GitPublicationOptions {
  readonly run?: GitRunner;
  readonly readConfig?: GitRunner;
  readonly resolveIdentity?: typeof resolveRepositoryExecutionIdentity;
}

const GIT_WORDS_LIMIT = 400;
/**
 * Git's own last words, bounded and on one line, with any `scheme://user:secret@host` the
 * remote or git echoed back reduced to `scheme://***@host`. A refusal used to carry only its
 * code, so "PUBLISH_PUSH_UNKNOWN" stood for a missing ssh key, a rejected non-fast-forward
 * and a dead network alike (UnAI 2026-09-18).
 */
export function gitFailureWords(code: number | null, stderr: string): string {
  const words = stderr.replace(/\s+/gu, " ").replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1***@").trim();
  const clipped = words.length > GIT_WORDS_LIMIT ? `${words.slice(0, GIT_WORDS_LIMIT)}…` : words;
  return `git exited ${code === null ? "without a code" : String(code)}${clipped === "" ? "" : `: ${clipped}`}`;
}
const refusedWith = (code: string, detail: string) => Object.freeze({ ok: false as const, code, detail });
const said = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * HEAD's own symref line from `ls-remote --symref -- <url> HEAD`: `ref: refs/heads/<name>\tHEAD`.
 * The pattern also tail-matches refs such as refs/remotes/origin/HEAD, whose lines never count. No
 * line for HEAD itself is an answer (the remote advertises no default); anything unreadable is refused.
 */
function defaultBranchOf(stdout: string): Readonly<{ ok: true; defaultBranch: string | null }> | PublicationRefusal {
  const heads: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith("ref:")) continue;
    const symref = /^ref: (\S+)\t(\S+)$/u.exec(line);
    if (symref === null) return refusedWith("PUBLISH_REMOTE_UNREADABLE", "ls-remote --symref answered an unreadable symref line");
    if (symref[2] === "HEAD") heads.push(symref[1] as string);
  }
  if (heads.length > 1) return refusedWith("PUBLISH_REMOTE_UNREADABLE", "ls-remote --symref answered more than one symref for HEAD");
  const target = heads[0];
  if (target === undefined) return { ok: true, defaultBranch: null };
  const branch = target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : null;
  return validPublicationBranch(branch) ? { ok: true, defaultBranch: branch }
    : refusedWith("PUBLISH_REMOTE_UNREADABLE", "remote HEAD is a symref to something other than a branch");
}

export function createGitPublicationPort(options: GitPublicationOptions = {}): Required<PublicationGitPort> {
  const run = options.run ?? publicationGitRunner;
  const identityOf = options.resolveIdentity ?? resolveRepositoryExecutionIdentity;
  const configRunner = options.readConfig ?? options.run ?? nodeGitRunner;
  const admit = (raw: PublicationCandidate): PublicationCandidate | null => {
    const candidate = decodePublicationCandidate(raw);
    if (candidate === null) return null;
    const current = identityOf(candidate.identity.root);
    return current.ok && publicationRepositoryId(current.identity) === candidate.approval.repositoryId ? candidate : null;
  };
  const isolated = async <T>(candidate: PublicationCandidate, effect: (directory: string) => Promise<T>): Promise<T> => {
    const temporaryRoot = resolve(tmpdir());
    const directory = mkdtempSync(join(temporaryRoot, "moe-publication-"));
    try {
      const initialized = await run(temporaryRoot, ["init", "--bare", `--object-format=${candidate.approval.sha.length === 64 ? "sha256" : "sha1"}`, directory]);
      if (initialized.code !== 0) throw new Error("PUBLISH_GIT_UNAVAILABLE");
      return await effect(directory);
    } finally {
      const target = resolve(directory);
      if (target.startsWith(`${temporaryRoot}${sep}`)) rmSync(target, { recursive: true, force: true });
    }
  };
  /** Lends the candidate repository's objects to the isolated directory; none of its refs or config. */
  const borrow = async (candidate: PublicationCandidate, directory: string): Promise<PublicationRefusal | null> => {
    const objects = await run(candidate.identity.root, [`--git-dir=${candidate.identity.gitDirectory}`, "rev-parse", "--path-format=absolute", "--git-path", "objects"]);
    const objectPath = objects.stdout.replace(/\r?\n$/u, "");
    if (objects.code !== 0 || objectPath === "" || /[\r\n]/u.test(objectPath)) return publicationRefused("PUBLISH_OBJECTS_UNREADABLE");
    mkdirSync(join(directory, "objects", "info"), { recursive: true });
    writeFileSync(join(directory, "objects", "info", "alternates"), `${objectPath.replaceAll("\\", "/")}\n`);
    return null;
  };
  return Object.freeze({
    async push(raw: PublicationCandidate) {
      const candidate = admit(raw);
      if (candidate === null) return publicationRefused("PUBLISH_REPOSITORY_CHANGED");
      try {
        return await isolated(candidate, async (directory) => {
          const borrowed = await borrow(candidate, directory);
          if (borrowed !== null) return borrowed;
          const object = await run(directory, [`--git-dir=${directory}`, "cat-file", "-t", candidate.approval.sha]);
          if (object.code !== 0 || object.stdout.trim() !== "commit") return publicationRefused("PUBLISH_COMMIT_UNREADABLE");
          const authentication = await publicationCredentialArguments(configRunner, candidate);
          const pushed = await run(directory, [`--git-dir=${directory}`, ...authentication, "push", "--no-verify", "--", candidate.approval.remoteUrl,
            `${candidate.approval.sha}:refs/heads/${candidate.approval.branch}`]);
          // A number is git's own exit (it ran and refused); null is a timeout, kill or spawn failure that never answered. Only a refusal may help prove no landing.
          return pushed.code === 0 ? { ok: true as const }
            : refusedWith(pushed.code === null ? "PUBLISH_PUSH_UNKNOWN" : PUBLISH_PUSH_REJECTED, gitFailureWords(pushed.code, pushed.stderr));
        });
      } catch (error) { return refusedWith("PUBLISH_PUSH_UNKNOWN", `push threw: ${said(error)}`); }
    },
    async contains(raw: PublicationCandidate, remoteSha: string | null) {
      const candidate = admit(raw);
      if (candidate === null) return publicationRefused("PUBLISH_REPOSITORY_CHANGED");
      // An absent branch, or one already at the approved sha, is a fast-forward by definition.
      if (remoteSha === null || remoteSha === candidate.approval.sha) return { ok: true as const, contains: true, known: true };
      if (!validPublicationSha(remoteSha)) return refusedWith("PUBLISH_REMOTE_UNREADABLE", `remote tip ${remoteSha} is not a git object id`);
      try {
        return await isolated(candidate, async (directory) => {
          const borrowed = await borrow(candidate, directory);
          if (borrowed !== null) return borrowed;
          // `cat-file -e` exits 1, and only 1, for an object this repository never fetched: not
          // contained and not a failure (the operator's own commits are exactly what is missing).
          const present = await run(directory, [`--git-dir=${directory}`, "cat-file", "-e", remoteSha]);
          if (present.code === 1) return { ok: true as const, contains: false, known: false };
          if (present.code !== 0) return refusedWith("PUBLISH_REMOTE_UNREADABLE", gitFailureWords(present.code, present.stderr));
          const ancestry = await run(directory, [`--git-dir=${directory}`, "merge-base", "--is-ancestor", remoteSha, candidate.approval.sha]);
          if (ancestry.code === 0 || ancestry.code === 1) return { ok: true as const, contains: ancestry.code === 0, known: true };
          return refusedWith("PUBLISH_REMOTE_UNREADABLE", gitFailureWords(ancestry.code, ancestry.stderr));
        });
      } catch (error) { return refusedWith("PUBLISH_REMOTE_UNREADABLE", `merge-base threw: ${said(error)}`); }
    },
    async observe(raw: PublicationCandidate) {
      const candidate = admit(raw);
      if (candidate === null) return publicationRefused("PUBLISH_REPOSITORY_CHANGED");
      try {
        return await isolated(candidate, async (directory) => {
          const ref = `refs/heads/${candidate.approval.branch}`;
          const authentication = await publicationCredentialArguments(configRunner, candidate);
          const result = await run(directory, [`--git-dir=${directory}`, ...authentication, "ls-remote", "--refs", "--", candidate.approval.remoteUrl, ref]);
          if (result.code !== 0) return refusedWith("PUBLISH_REMOTE_UNREADABLE", gitFailureWords(result.code, result.stderr));
          const rows = result.stdout.replace(/\r?\n$/u, "").split(/\r?\n/u).filter(Boolean);
          if (rows.length === 0) return { ok: true as const, sha: null };
          const pair = rows[0]?.split("\t");
          return rows.length === 1 && pair?.length === 2 && validPublicationSha(pair[0]) && pair[1] === ref
            ? { ok: true as const, sha: pair[0] }
            : refusedWith("PUBLISH_REMOTE_UNREADABLE", `ls-remote answered ${String(rows.length)} row(s) for ${ref}, expected exactly one`);
        });
      } catch (error) { return refusedWith("PUBLISH_REMOTE_UNREADABLE", `ls-remote threw: ${said(error)}`); }
    },
    async measureDefaultBranch(raw: PublicationCandidate) {
      const candidate = admit(raw);
      if (candidate === null) return publicationRefused("PUBLISH_REPOSITORY_CHANGED");
      try {
        return await isolated(candidate, async (directory) => {
          const authentication = await publicationCredentialArguments(configRunner, candidate);
          // Never `--refs`: it drops every symref, and every remote would then read as having no default.
          const result = await run(directory, [`--git-dir=${directory}`, ...authentication, "ls-remote", "--symref", "--", candidate.approval.remoteUrl, "HEAD"]);
          return result.code === 0 ? defaultBranchOf(result.stdout) : refusedWith("PUBLISH_REMOTE_UNREADABLE", gitFailureWords(result.code, result.stderr));
        });
      } catch (error) { return refusedWith("PUBLISH_REMOTE_UNREADABLE", `ls-remote threw: ${said(error)}`); }
    },
  });
}
