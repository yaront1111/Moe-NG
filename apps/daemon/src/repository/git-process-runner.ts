import { execFile } from "node:child_process";

/**
 * The one git process launcher behind every landing, publication, bootstrap and migration
 * effect: argv arrays (no shell), a bounded timeout, no prompt, and the parent shell's GIT_*
 * redirections stripped. Split out of git-landing-port.ts (2026-09-13) to keep that file
 * inside the 250-line rail; that file re-exports everything here, so callers are unchanged.
 */

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

export function landingEnvironment(): NodeJS.ProcessEnv {
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
  let inputError: unknown = null;
  const child = execFile("git", [...args], {
    cwd, encoding: "utf8", env: landingEnvironment(), maxBuffer: MAX_OUTPUT_BYTES,
    timeout: GIT_TIMEOUT_MS, windowsHide: true,
  }, (error, stdout, stderr) => {
    const exit = error === null ? 0
      : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
    // A git that exited 0 without taking its whole input did not do what it was asked.
    const code = exit === 0 && inputError !== null ? null : exit;
    const words = `${stderr}${error === null || exit !== null ? "" : String(error)}`;
    resolve({ code, stderr: inputError === null ? words : `${words}stdin: ${String(inputError)}`, stdout });
  });
  if (child.stdin !== null) {
    // MEASURED 2026-09-13: `hash-object --stdin-paths` aborts on the first path it cannot open
    // (exit 128) and never drains a payload larger than the pipe. The pending write then fails
    // asynchronously on this stream (EOF on Windows, EPIPE on POSIX); without a listener that is
    // an uncaught exception, and it killed the process running the runner before the callback
    // above ever fired. git's own exit code and words remain the answer.
    child.stdin.on("error", (error) => { inputError = error; });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  }
});
