import { execFile } from "node:child_process";
import type { ChildProcess, ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { LANDER_IDENTITY, landingEnvironment, nodeGitRunner } from "./git-landing-port.js";
import type { GitRunner } from "./git-landing-port.js";
import { bootstrapRefusal, isBootstrapGithubRequest } from "./repository-bootstrap-contracts.js";
import type { BootstrapCode, BootstrapDetail, BootstrapGitPort,
  BootstrapGhPort, BootstrapPortResult, GhRunner, TreeWriterPort } from "./repository-bootstrap-contracts.js";

const failed = (code: BootstrapCode, detail: BootstrapDetail) =>
  ({ ok: false as const, refusal: bootstrapRefusal(code, detail) });

/** Sole git executable launcher remains nodeGitRunner; no new process implementation here. */
export function createBootstrapGitPort(run: GitRunner = nodeGitRunner): BootstrapGitPort {
  return { async commit(dir) {
    const commands = [["init", "--initial-branch=main"], ["add", "-A"],
      [...LANDER_IDENTITY, "commit", "-m", "chore: scaffold by Moe"], ["rev-parse", "HEAD"]];
    let sha = "";
    try {
      for (const args of commands) {
        const result = await run(dir, args);
        if (result.code !== 0) return failed("BOOTSTRAP_GIT_UNAVAILABLE",
          result.code === null ? "GIT_EXECUTABLE_UNAVAILABLE" : "GIT_COMMAND_FAILED");
        sha = result.stdout.trim();
      }
    } catch { return failed("BOOTSTRAP_GIT_UNAVAILABLE", "GIT_EXECUTABLE_UNAVAILABLE"); }
    return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha) ? { ok: true, sha }
      : failed("BOOTSTRAP_GIT_UNAVAILABLE", "GIT_SHA_INVALID");
  } };
}

export type GhExecute = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => Pick<ChildProcess, "stdin">;

/** Callback completes only after exit/timeout cleanup. No raw child output leaves this boundary. */
export function createNodeGhRunner(execute: GhExecute = execFile): GhRunner {
  return (cwd, args) => new Promise((done) => {
    try {
      const child = execute("gh", [...args], { cwd, encoding: "utf8", env: landingEnvironment(),
        shell: false, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error) => {
        done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          executableAbsent: error?.code === "ENOENT", stdout: "", stderr: "" });
      });
      child.stdin?.end();
    } catch (error) {
      done({ code: null, executableAbsent: hasCode(error, "ENOENT"), stdout: "", stderr: "" });
    }
  });
}

export function createBootstrapGhPort(run: GhRunner = createNodeGhRunner()): BootstrapGhPort {
  return { async create(dir, request) {
    if (!isBootstrapGithubRequest(request)) return failed("BOOTSTRAP_PAYLOAD_INVALID", "GITHUB_REQUEST_INVALID");
    try {
      const result = await run(dir, ["repo", "create", `${request.owner}/${request.name}`,
        `--${request.visibility}`, "--source", ".", "--push"]);
      if (result.executableAbsent) return failed("BOOTSTRAP_GH_UNAVAILABLE", "GH_EXECUTABLE_ABSENT");
      if (result.code !== 0) return failed("BOOTSTRAP_GH_UNAVAILABLE",
        result.code === null ? "GH_EXECUTION_FAILED" : "GITHUB_REFUSED");
      // Derive, never scrape stdout: userinfo, query strings and child diagnostics cannot surface.
      return { ok: true, remoteUrl: `https://github.com/${request.owner}/${request.name}` };
    } catch { return failed("BOOTSTRAP_GH_UNAVAILABLE", "GH_EXECUTION_FAILED"); }
  } };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function localTarget(dir: string): string | null {
  // Blank, UNC and device paths never touch fs (including on non-Windows hosts).
  if (dir.trim() === "" || /^[\\/]{2}/.test(dir) || /[\x00-\x1f]/.test(dir)) return null;
  return resolve(dir);
}

function inspectEmpty(dir: string): BootstrapPortResult<object> {
  const stat = lstatSync(dir);
  // Files, symlinks and junctions are invalid; dotfiles count exactly like every other entry.
  if (!stat.isDirectory() || stat.isSymbolicLink()) return failed("BOOTSTRAP_DIR_INVALID", "DIRECTORY_INVALID");
  if (readdirSync(dir).length !== 0) return failed("BOOTSTRAP_DIR_NOT_EMPTY", "DIRECTORY_NOT_EMPTY");
  return { ok: true };
}

function treePath(root: string, path: string): string | null {
  const segments = path.split(/[\\/]/);
  if (isAbsolute(path) || win32.isAbsolute(path) || segments.some((part) =>
    part === "" || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]|[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  const target = resolve(root, ...segments);
  const suffix = relative(root, target);
  return suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) ? null : target;
}

/** Caller must own the local directory throughout bootstrap. Recheck closes the ordinary
 * prepare/write gap; wx prevents overwrites. This is not an OS transaction against a hostile
 * concurrent local process swapping ancestors. Failure retains partial files for inspection. */
export const nodeTreeWriter: TreeWriterPort = {
  async prepare(dir) {
    const target = localTarget(dir);
    if (target === null) return failed("BOOTSTRAP_DIR_INVALID", "DIRECTORY_INVALID");
    try {
      try { lstatSync(target); } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        mkdirSync(target, { recursive: true });
      }
      const empty = inspectEmpty(target);
      return empty.ok ? { ok: true, dir: target } : empty;
    } catch { return failed("BOOTSTRAP_DIR_INVALID", "DIRECTORY_INVALID"); }
  },
  async write(dir, files) {
    const root = localTarget(dir);
    if (root === null) return failed("BOOTSTRAP_DIR_INVALID", "DIRECTORY_INVALID");
    const entries = [...files].map(([path, bytes]) => ({ target: treePath(root, path), bytes }));
    if (entries.some(({ target }) => target === null)) return failed("BOOTSTRAP_TREE_PATH_INVALID", "TREE_PATH_INVALID");
    try {
      const empty = inspectEmpty(root);
      if (!empty.ok) return empty;
      for (const { target, bytes } of entries) {
        if (target === null) return failed("BOOTSTRAP_TREE_PATH_INVALID", "TREE_PATH_INVALID");
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { encoding: "utf8", flag: "wx" });
      }
      return { ok: true };
    } catch { return failed("BOOTSTRAP_TREE_WRITE_FAILED", "TREE_WRITE_FAILED"); }
  },
};
