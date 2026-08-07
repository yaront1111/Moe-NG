import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

import { isCommitIdentity } from "../canonical.js";
import { ScopeObserverError, type GitObserver, type ScopePathObserver } from "./scope-contract.js";

export const MAX_SCOPE_OBSERVATION_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

/**
 * Builds the isolated environment a scope observation must run under.
 *
 * The base environment is a parameter rather than an ambient read so this
 * module stays deterministic and the daemon keeps control of what the child
 * sees. Every inherited GIT_* variable is dropped, global and system config are
 * neutralised (win32 has no /dev/null, so NUL is the only correct value there),
 * and optional locks are disabled because several agents share one checkout and
 * an observation must never churn index.lock.
 */
export function hermeticGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.toUpperCase().startsWith("GIT_")) {
      environment[key] = value;
    }
  }
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LC_ALL = "C";
  return environment;
}

function runGit(
  repository: string,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
  label: string,
): Uint8Array {
  try {
    const stdout = execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-c",
        `safe.directory=${repository}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...args,
      ],
      {
        cwd: repository,
        encoding: "buffer",
        env: environment,
        maxBuffer: MAX_SCOPE_OBSERVATION_BYTES,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return new Uint8Array(stdout);
  } catch (error) {
    // A truncated observation is worse than none: the overflow gets its own code.
    if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new ScopeObserverError(
        "RUNNER_SCOPE_OBSERVATION_OVERFLOW",
        `git ${label} exceeded ${MAX_SCOPE_OBSERVATION_BYTES} bytes`,
      );
    }
    throw new ScopeObserverError("RUNNER_SCOPE_OBSERVATION_FAILED", `git ${label} failed`);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ScopeObserverError(
      "RUNNER_SCOPE_STATUS_MALFORMED",
      `git ${label} output is not valid UTF-8`,
    );
  }
}

function decodeNulList(bytes: Uint8Array, label: string): readonly string[] {
  const text = decodeUtf8(bytes, label);
  if (text.length === 0) {
    return Object.freeze([]);
  }
  if (!text.endsWith("\0")) {
    throw new ScopeObserverError(
      "RUNNER_SCOPE_STATUS_MALFORMED",
      `git ${label} output is not NUL-terminated`,
    );
  }
  const entries = text.slice(0, -1).split("\0");
  if (entries.some((entry) => entry.length === 0)) {
    throw new ScopeObserverError(
      "RUNNER_SCOPE_STATUS_MALFORMED",
      `git ${label} output contains an empty record`,
    );
  }
  return Object.freeze(entries);
}

/** Gitlinks carry mode 160000, which is the only portable submodule signal. */
function gitlinkPaths(entries: readonly string[]): readonly string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) {
      throw new ScopeObserverError(
        "RUNNER_SCOPE_STATUS_MALFORMED",
        "git ls-files --stage record has no path separator",
      );
    }
    if (entry.slice(0, 6) === "160000") {
      paths.push(entry.slice(tab + 1));
    }
  }
  return Object.freeze(paths);
}

/**
 * Production GitObserver. Every call is a single plumbing spawn with no shell,
 * buffer encoding, fatal UTF-8 decoding, and NUL framing, so no locale or path
 * with a newline in it can reshape the observation.
 */
export function createNodeGitObserver(
  repository: string,
  environment: NodeJS.ProcessEnv,
): GitObserver {
  const git = (args: readonly string[], label: string): Uint8Array =>
    runGit(repository, environment, args, label);
  return Object.freeze({
    headCommit(): string {
      const text = decodeUtf8(git(["rev-parse", "--verify", "HEAD"], "rev-parse"), "rev-parse");
      const head = text.trimEnd();
      if (!isCommitIdentity(head)) {
        throw new ScopeObserverError(
          "RUNNER_SCOPE_STATUS_MALFORMED",
          "git rev-parse did not return a commit digest",
        );
      }
      return head;
    },
    statusPorcelainV2(): Uint8Array {
      return git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], "status");
    },
    lsFilesTracked(): readonly string[] {
      return decodeNulList(git(["ls-files", "-z"], "ls-files"), "ls-files");
    },
    lsFilesIgnored(): readonly string[] {
      return decodeNulList(
        git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], "ls-files-ignored"),
        "ls-files-ignored",
      );
    },
    submodulePaths(): readonly string[] {
      return gitlinkPaths(
        decodeNulList(git(["ls-files", "-z", "--stage"], "ls-files-stage"), "ls-files-stage"),
      );
    },
  });
}

export function createNodeScopePaths(): ScopePathObserver {
  return Object.freeze({
    realpath(path: string): string {
      return realpathSync(path);
    },
    exists(path: string): boolean {
      return existsSync(path);
    },
  });
}
