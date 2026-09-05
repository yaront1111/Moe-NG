import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { landingEnvironment, nodeGitRunner } from "./git-landing-port.js";
import type { GitRunner } from "./git-landing-port.js";
import { decodePublicationCandidate, publicationRefused, publicationRepositoryId, validPublicationSha } from "./publication-approval-contracts.js";
import type { PublicationCandidate } from "./publication-approval-contracts.js";
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
export interface GitPublicationOptions {
  readonly run?: GitRunner;
  readonly readConfig?: GitRunner;
  readonly resolveIdentity?: typeof resolveRepositoryExecutionIdentity;
}

export function createGitPublicationPort(options: GitPublicationOptions = {}): PublicationGitPort {
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
  return Object.freeze({
    async push(raw: PublicationCandidate) {
      const candidate = admit(raw);
      if (candidate === null) return publicationRefused("PUBLISH_REPOSITORY_CHANGED");
      try {
        return await isolated(candidate, async (directory) => {
          const objects = await run(candidate.identity.root, [`--git-dir=${candidate.identity.gitDirectory}`, "rev-parse", "--path-format=absolute", "--git-path", "objects"]);
          const objectPath = objects.stdout.replace(/\r?\n$/u, "");
          if (objects.code !== 0 || objectPath === "" || /[\r\n]/u.test(objectPath)) return publicationRefused("PUBLISH_OBJECTS_UNREADABLE");
          mkdirSync(join(directory, "objects", "info"), { recursive: true });
          writeFileSync(join(directory, "objects", "info", "alternates"), `${objectPath.replaceAll("\\", "/")}\n`);
          const object = await run(directory, [`--git-dir=${directory}`, "cat-file", "-t", candidate.approval.sha]);
          if (object.code !== 0 || object.stdout.trim() !== "commit") return publicationRefused("PUBLISH_COMMIT_UNREADABLE");
          const authentication = await publicationCredentialArguments(configRunner, candidate);
          const pushed = await run(directory, [`--git-dir=${directory}`, ...authentication, "push", "--no-verify", "--", candidate.approval.remoteUrl,
            `${candidate.approval.sha}:refs/heads/${candidate.approval.branch}`]);
          return pushed.code === 0 ? { ok: true as const } : publicationRefused("PUBLISH_PUSH_UNKNOWN");
        });
      } catch { return publicationRefused("PUBLISH_PUSH_UNKNOWN"); }
    },
    async observe(raw: PublicationCandidate) {
      const candidate = admit(raw);
      if (candidate === null) return publicationRefused("PUBLISH_REPOSITORY_CHANGED");
      try {
        return await isolated(candidate, async (directory) => {
          const ref = `refs/heads/${candidate.approval.branch}`;
          const authentication = await publicationCredentialArguments(configRunner, candidate);
          const result = await run(directory, [`--git-dir=${directory}`, ...authentication, "ls-remote", "--refs", "--", candidate.approval.remoteUrl, ref]);
          if (result.code !== 0) return publicationRefused("PUBLISH_REMOTE_UNREADABLE");
          const rows = result.stdout.replace(/\r?\n$/u, "").split(/\r?\n/u).filter(Boolean);
          if (rows.length === 0) return { ok: true as const, sha: null };
          const pair = rows[0]?.split("\t");
          return rows.length === 1 && pair?.length === 2 && validPublicationSha(pair[0]) && pair[1] === ref
            ? { ok: true as const, sha: pair[0] } : publicationRefused("PUBLISH_REMOTE_UNREADABLE");
        });
      } catch { return publicationRefused("PUBLISH_REMOTE_UNREADABLE"); }
    },
  });
}
