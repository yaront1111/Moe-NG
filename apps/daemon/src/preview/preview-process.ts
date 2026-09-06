import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { connect } from "node:net";
import { win32 as windowsPath } from "node:path";

import { deliverEnvironment, type EnvironmentDeliveredVariables } from "../environment/environment-delivery.js";
import { probeProcessAlive } from "../orchestrator/process-runner-lifecycle.js";
import { detectPreviewPort, previewOrigin } from "./preview-command-resolution.js";
import { previewRefusal } from "./preview-contracts.js";
import type { PreviewRefusal } from "./preview-contracts.js";
import { previewOwnsListener } from "./preview-listener-owner.js";

/**
 * THE PREVIEW SERVER'S LIFE, and — the part that actually matters — its DEATH.
 *
 * A preview that leaks a child process is worse than no preview: it holds the port, and the
 * NEXT preview cannot bind. So every exit path stops the child, and `stop()` is idempotent and
 * safe to call from a decision handler, a deadline and a shutdown hook alike.
 *
 * WHY THIS IS NOT `createVerifierProcessRunner`. That runner's contract is
 * `(brief) => Promise<VerifierRunCapture>` and the promise resolves only when the child has
 * exited or been killed (verifier-process-runner.ts:202-217). It runs a command TO COMPLETION.
 * A preview server never completes: `start()` must RETURN while the child is still listening so
 * the browser can drive it and an operator can judge it minutes later. That is a lifecycle
 * difference, not a style one, and it is why a second spawner exists here at all
 * (recorded in this task's step-2 note).
 *
 * WHAT IS REUSED RATHER THAN REINVENTED:
 *   - `probeProcessAlive` from `orchestrator/process-runner-lifecycle.ts:47` — the daemon's
 *     existing liveness seam. ESRCH is dead; EPERM is ALIVE (a process owned by someone else
 *     still holds the port); anything else is rethrown rather than guessed as dead.
 *   - The KILL STRATEGY, copied from verifier-process-runner and cited: win32 gets
 *     `taskkill.exe /pid <n> /T /F` resolved through SYSTEMROOT (:255-262), because a detached
 *     child's descendants survive a bare `child.kill()` and the surviving GRANDCHILD is what
 *     holds the port. POSIX gets `killProcessGroup(-pid, "SIGKILL")` against the whole group
 *     (:298), which needs `detached: true` at spawn to have a group to signal (:153). ESRCH
 *     means the group is already gone — the state the signal was sent to reach — so it is
 *     containment REACHED, never a failure of it (:302-306).
 */

const DEFAULT_START_TIMEOUT_MS = 1_800_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const START_POLL_MS = 25;
/** How long the fast poll runs before backing off. A dev server is usually up well inside it. */
const FAST_POLL_WINDOW_MS = 10_000;
const SLOW_POLL_MS = 1_000;

/** The environment a preview child inherits. Same allow-list the verifier runner uses. */
const RUNTIME_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "COMSPEC", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "PATHEXT", "SYSTEMROOT",
  "TEMP", "TMP", "TMPDIR", "TZ", "WINDIR",
]);

type SpawnProcess = (
  file: string, args: readonly string[], options: SpawnOptions,
) => ChildProcess;

export interface PreviewProcessOptions {
  readonly delivered?: EnvironmentDeliveredVariables | undefined; // Onto the allowlisted RESULT.
  readonly environment?: NodeJS.ProcessEnv;
  readonly killGraceMs?: number;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnProcess;
  /** How long the child may take to announce a port. Production default is 30 minutes. */
  readonly startTimeoutMs?: number;
}

export interface PreviewProcessHandle {
  /** True while the OS still has a row for the child's pid. */
  readonly alive: () => boolean;
  readonly origin: string;
  readonly pid: number;
  readonly port: number;
  /** Idempotent. Resolves once the tree has been signalled; never throws. */
  readonly stop: () => Promise<void>;
}

export type PreviewStartResult =
  | Readonly<{ readonly handle: PreviewProcessHandle; readonly ok: true }>
  | PreviewRefusal;

export interface StartPreviewInput {
  readonly command: string;
  /** Stated by the contract; when null the port is detected from the child's stdout. */
  readonly port: number | null;
  readonly workspace: string;
}

function runtimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && RUNTIME_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  return environment;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Kills the child's whole TREE, not just the child. Best effort by design: the caller's job is
 * to STOP the preview, and a straggler the signal cannot reach must not turn an operator's
 * APPROVE into a thrown error. Liveness is asserted separately, by pid, so a kill that silently
 * failed is caught by the assertion rather than hidden by a resolved promise.
 */
async function killTree(
  child: ChildProcess, platform: NodeJS.Platform,
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void,
  spawn: SpawnProcess, systemRoot: string | null, killGraceMs: number,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    // THE ORDER HERE IS THE WHOLE BUG. `shell: true` makes the direct child `cmd.exe` and the
    // SERVER its grandchild, so `/T` is what actually reaches the process holding the port.
    // Killing the shell FIRST orphans the server before taskkill has walked the tree — measured:
    // the pid went away, the port stayed bound, and the next preview could not bind. So the
    // tree walk is AWAITED and the direct kill is only the fallback for when it could not run.
    if (systemRoot !== null && await awaitTreeKill(spawn, systemRoot, pid, killGraceMs)) return;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    return;
  }
  try {
    // `detached: true` at spawn made the shell the group leader; the NEGATIVE pid addresses the
    // whole group, grandchildren included.
    killProcessGroup(-pid, "SIGKILL");
  } catch (error) {
    // ESRCH is the group already being gone: the exact state the signal was sent to reach.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
}

/**
 * Runs `taskkill /T /F` and waits for it to EXIT, resolving true when the tree is gone.
 *
 * Exit 128 is taskkill's "no running instance" — the tree is ALREADY dead, which is the outcome
 * the call exists to reach, not an escape from it. Anything else (including the spawn failing)
 * answers false so the caller falls back to the direct kill rather than assuming success.
 */
function awaitTreeKill(
  spawn: SpawnProcess, systemRoot: string, pid: number, killGraceMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    let killer: ChildProcess;
    try {
      killer = spawn(
        windowsPath.join(systemRoot, "System32", "taskkill.exe"),
        ["/pid", String(pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
    } catch {
      settle(false);
      return;
    }
    const timer = setTimeout(() => { settle(false); }, Math.max(1_000, killGraceMs));
    timer.unref?.();
    killer.once("error", () => { clearTimeout(timer); settle(false); });
    killer.once("close", (code) => {
      clearTimeout(timer);
      settle(code === 0 || code === 128);
    });
  });
}

/**
 * Starts the product and waits for it to be answerable, or refuses PREVIEW_START_TIMEOUT @
 * RUNNER when it never announces a port inside the budget.
 *
 * THE TIMEOUT PATH STILL KILLS. A child that started but never listened is exactly the process
 * that would hold a port forever, so the refusal path runs the same `killTree` the success path
 * does. A refusal that leaked the process it refused would be the worst of both.
 */
export async function startPreviewProcess(
  input: StartPreviewInput, options: PreviewProcessOptions = {},
): Promise<PreviewStartResult> {
  const sourceEnvironment = options.environment ?? process.env;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const killProcessGroup = options.killProcessGroup ?? process.kill.bind(process);
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? nodeSpawn;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const systemRootValue = Object.entries(sourceEnvironment)
    .find(([key, value]) => key.toUpperCase() === "SYSTEMROOT" && typeof value === "string" && value !== "")?.[1];
  const systemRoot = systemRootValue !== undefined && windowsPath.isAbsolute(systemRootValue)
    ? systemRootValue
    : null;

  let child: ChildProcess;
  if (input.port !== null && await portAccepts(input.port)) return previewRefusal("PREVIEW_START_TIMEOUT");
  try {
    child = spawn(input.command, [], {
      cwd: input.workspace,
      // detached gives POSIX a process GROUP the negative pid can address; on win32 the tree is
      // reached with taskkill /T instead.
      detached: platform !== "win32",
      // UNDER the allowlist: the overlay lands on what the filter RETURNED, so an arbitrary
      // operator name arrives without the closed roster being widened to admit it.
      env: deliverEnvironment(runtimeEnvironment(sourceEnvironment), options.delivered).environment,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return previewRefusal("PREVIEW_START_TIMEOUT");
  }

  let output = "";
  const absorb = (chunk: Buffer | string): void => {
    output = (output + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk)).slice(-65_536);
  };
  child.stdout?.on("data", absorb);
  child.stderr?.on("data", absorb);
  // Contained here so a pipe error after the child dies is never an uncaught throw.
  child.on("error", () => undefined);

  const aliveNow = (): boolean => {
    const pid = child.pid;
    if (pid === undefined) return false;
    try {
      return probeProcessAlive(pid);
    } catch {
      // An unknown probe failure is not evidence of death, and the caller's assertion must see
      // a live pid rather than a comfortable false.
      return true;
    }
  };

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async (): Promise<void> => {
      await killTree(child, platform, killProcessGroup, spawn, systemRoot, killGraceMs);
      for (const stream of [child.stdout, child.stderr]) {
        try { stream?.destroy(); } catch { /* already released */ }
      }
      // taskkill returns once the kill is REQUESTED, not once the OS has reaped
      // (tests/e2e/foundation/orphan-reap.ts:1-17 measures 68-100ms, longer under load), so the
      // stop waits for the pid to actually leave rather than claiming a reap it has not seen.
      const polls = Math.max(1, Math.ceil(killGraceMs / START_POLL_MS));
      for (let remaining = polls; remaining > 0; remaining -= 1) {
        if (!aliveNow()) return;
        await sleep(START_POLL_MS);
      }
    })();
    return stopped;
  };

  const started = Date.now();
  // The probe below opens a real socket every poll. At a flat 25ms the 30-minute production
  // budget would open ~72,000 of them against a product that never listens — a handle burn this
  // host is measurably sensitive to. So the interval backs off to a second once the fast window
  // is past: a server that comes up quickly is still detected quickly, and one that never comes
  // up costs ~1,800 probes instead.
  let pollMs = START_POLL_MS;
  for (;;) {
    // ANSWERABLE, not merely spawned. A stated port is still only a claim until something
    // accepts on it, and a child that printed an origin can still die before the browser
    // arrives — so both paths end at the same TCP probe, and a product that starts but never
    // listens reaches the timeout in either.
    const candidate = input.port === null ? detectPreviewPort(output)?.port ?? null : input.port;
    const pid = child.pid;
    if (candidate !== null && pid !== undefined && aliveNow() && await portAccepts(candidate)
      && await previewOwnsListener(pid, candidate, platform, sourceEnvironment) && aliveNow()) {
      return {
        handle: Object.freeze({
          alive: aliveNow, origin: previewOrigin(candidate), pid, port: candidate, stop,
        }),
        ok: true,
      };
    }
    if (Date.now() - started >= startTimeoutMs) {
      // The child that never listened is exactly the one that would hold a port forever.
      await stop();
      return previewRefusal("PREVIEW_START_TIMEOUT");
    }
    await sleep(pollMs);
    if (Date.now() - started >= FAST_POLL_WINDOW_MS) pollMs = SLOW_POLL_MS;
  }
}

/** Does something accept a TCP connection on this loopback port right now? */
function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(START_POLL_MS * 4);
    socket.once("connect", () => { settle(true); });
    socket.once("timeout", () => { settle(false); });
    socket.once("error", () => { settle(false); });
  });
}
