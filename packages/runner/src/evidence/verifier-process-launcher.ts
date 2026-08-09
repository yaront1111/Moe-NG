import { execFile, spawn } from "node:child_process";

/**
 * The process port and its one production adapter.
 *
 * A launcher takes an exact file and argument vector, never a command string:
 * this seam is where a free-form command would become a shell injection, so the
 * shape simply cannot express one.
 */
export interface VerifierLaunchSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface VerifierExitObservation {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface LaunchedProcess {
  readonly pid: number | null;
  /** Settles on CLOSE, not exit: the stdio pipes drain after the process ends. */
  readonly closed: Promise<VerifierExitObservation>;
  readonly onStdout: (listener: (chunk: Uint8Array) => void) => void;
  readonly onStderr: (listener: (chunk: Uint8Array) => void) => void;
  readonly kill: () => void;
}

export interface ProcessLauncher {
  readonly launch: (spec: VerifierLaunchSpec) => LaunchedProcess;
}

const isWindows = process.platform === "win32";

/**
 * `child.kill()` on win32 reaches only the direct child, and a surviving
 * grandchild keeps the sealed candidate tree open. `taskkill /t /f` walks the
 * tree; on posix the child is its own process group leader, so the negative pid
 * does the same job. Either way this is a REQUEST — the caller still has to
 * await close before it may claim the tree was reaped.
 */
function killTree(pid: number | null): void {
  if (pid === null) {
    return;
  }
  if (isWindows) {
    execFile("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already reaped; close will confirm it.
    }
  }
}

export function createNodeProcessLauncher(): ProcessLauncher {
  return Object.freeze({
    launch(spec: VerifierLaunchSpec): LaunchedProcess {
      const child = spawn(spec.file, [...spec.args], {
        cwd: spec.cwd,
        detached: !isWindows,
        env: spec.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const closed = new Promise<VerifierExitObservation>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
      });
      const pid = child.pid ?? null;
      return Object.freeze({
        pid,
        closed,
        // Registered in the caller's synchronous tick, before the event loop can
        // deliver a 'data' event, so no chunk is ever observed by nobody.
        onStdout: (listener: (chunk: Uint8Array) => void): void => {
          child.stdout?.on("data", (chunk: Buffer) => listener(chunk));
        },
        onStderr: (listener: (chunk: Uint8Array) => void): void => {
          child.stderr?.on("data", (chunk: Buffer) => listener(chunk));
        },
        kill: (): void => killTree(pid),
      });
    },
  });
}
