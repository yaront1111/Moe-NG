import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { repositoryExecutionFailure } from "./repository-execution-contracts.js";
import type { RepositoryExecutionIdentity, RepositoryExecutionResult } from "./repository-execution-contracts.js";

/** Per-checkout git-dir identity: linked worktrees have different working trees and indexes. */
export function resolveRepositoryExecutionIdentity(workspace: string): RepositoryExecutionResult<{ identity: RepositoryExecutionIdentity }> {
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
    return { ok: true, identity: Object.freeze({ root: realpathSync.native(lines[0]), gitDirectory: realpathSync.native(lines[1]) }) };
  } catch { return repositoryExecutionFailure("REPOSITORY_IDENTITY_UNKNOWN"); }
}
