import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";
import { landingEnvironment, nodeGitRunner } from "../repository/git-landing-port.js";
import type { GitRunner } from "../repository/git-landing-port.js";
import { withBareSourceRepository } from "../repository/git-source-extract.js";
import type { DeployRunResult } from "./deploy-ports.js";

export interface DeployBuildRequest { readonly context: string; readonly sha: string; readonly tag: string }
export type DeployBuildPort = (request: DeployBuildRequest) => Promise<DeployRunResult>;
type Spawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export const dockerArchiveBuildArgv = (tag: string): readonly string[] => ["build", "--tag", tag, "-"];
const failed = (code: string): DeployRunResult => ({ code: 1, stdout: "", stderr: code });
const LIMIT = 8 * 1024 * 1024;
const GIT = ["--no-replace-objects", "-c", `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`];

/** Immutable objects only. An isolated Git directory excludes worktree/info attributes,
 * templates and replacement refs. The archive is streamed as binary bytes into LOCAL Docker.
 *
 * The bare-repository half is `withBareSourceRepository`, shared with the migration source reader
 * so the two cannot drift. The archive runs INSIDE its `use` callback because the directory is
 * removed the moment that callback settles, and Docker must have drained the tar by then. The
 * archive keeps this module's OWN `GIT` array: the shared primitive adds `core.autocrlf=false`,
 * which is inert for `rev-parse` and `init` and which `init` does not persist into the temporary
 * repository's config, so the archived bytes are the same bytes as before the recipe was shared. */
export function createDeploymentImageBuilder(options: { readonly git?: GitRunner; readonly spawn?: Spawn; readonly timeoutMs?: number } = {}): DeployBuildPort {
  const git = options.git ?? nodeGitRunner;
  const spawn = options.spawn ?? nodeSpawn;
  return async request => {
    if (!isAbsolute(request.context) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(request.sha)
      || !/^moe-deploy-[a-zA-Z0-9_-]+:[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(request.tag)) return failed("DEPLOY_COMMIT_UNAVAILABLE");
    try {
      return await withBareSourceRepository<DeployRunResult>(
        git, { repository: request.context, sha: request.sha }, {
          prefix: "moe-deploy-source-",
          refuse: () => failed("DEPLOY_COMMIT_UNAVAILABLE"),
          use: temporary => archiveIntoDocker(spawn, temporary, request, options.timeoutMs ?? 900_000),
        });
    } catch { return failed("DEPLOY_BUILD_UNAVAILABLE"); }
  };
}

function archiveIntoDocker(spawn: Spawn, directory: string, request: DeployBuildRequest, timeoutMs: number): Promise<DeployRunResult> {
  return new Promise(resolveResult => {
    let archive: ChildProcess | undefined; let docker: ChildProcess | undefined;
    let archiveCode: number | null | undefined; let dockerCode: number | null | undefined;
    let stderr = ""; let stdout = ""; let uncertain = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (archiveCode === undefined || dockerCode === undefined) return;
      clearTimeout(timer);
      resolveResult({ code: uncertain ? null : archiveCode !== 0 ? archiveCode : dockerCode, stderr, stdout });
    };
    const abort = (): void => { uncertain = true; archive?.kill(); docker?.kill(); };
    try {
      archive = spawn("git", [...GIT, "archive", "--format=tar", request.sha], {
        cwd: directory, env: landingEnvironment(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      archive.on("error", () => { stderr = "DEPLOY_ARCHIVE_UNAVAILABLE"; abort(); });
      archive.on("close", code => { archiveCode = code; if (code !== 0) docker?.kill(); finish(); });
      archive.stderr?.on("data", () => { stderr = "DEPLOY_ARCHIVE_FAILED"; });
      docker = spawn("docker", dockerArchiveBuildArgv(request.tag), {
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      docker.on("error", () => { stderr = "DEPLOY_DOCKER_UNAVAILABLE"; abort(); });
      docker.on("close", code => { dockerCode = code; if (code !== 0) archive?.kill(); finish(); });
      docker.stdout?.on("data", (bytes: Buffer) => { stdout = (stdout + bytes.toString("utf8")).slice(-LIMIT); });
      docker.stderr?.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString("utf8")).slice(-LIMIT); });
      docker.stdin?.on("error", () => { stderr = "DEPLOY_BUILD_STDIN_FAILED"; abort(); });
      if (archive.stdout === null || docker.stdin === null) abort();
      else archive.stdout.pipe(docker.stdin);
      timer = setTimeout(() => { stderr = "DEPLOY_BUILD_TIMED_OUT"; abort(); }, timeoutMs);
      timer.unref?.();
    } catch {
      stderr = "DEPLOY_BUILD_UNAVAILABLE"; abort();
      if (archive === undefined) archiveCode = null;
      if (docker === undefined) dockerCode = null;
      finish();
    }
  });
}

export const nodeDeployBuild = createDeploymentImageBuilder();
