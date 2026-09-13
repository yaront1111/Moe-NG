import { WRAPPER_STDIN_STOP_TOKEN } from "../orchestrator/process-runner-lifecycle.js";

/** The wrapper child as the stop needs it: a stdin to ask on, an exit to watch, a kill to fall back to. */
export interface StoppableWrapperChild {
  kill(): unknown;
  once(event: "exit", listener: () => void): unknown;
  readonly stdin?: {
    on?(event: "error", listener: (error: Error) => void): unknown;
    write(chunk: string): unknown;
  } | null | undefined;
}

/**
 * How long a hosted wrapper gets to retire its seats before it is terminated. Shorter than
 * the dev launcher's 10 s on purpose: the manager bounds one whole stop at 10 s
 * (project-runtime-supervisor.ts DEFAULT_TIMEOUT_MS), and that window also has to fit the
 * daemon's shutdown and the broker's Job-empty poll.
 */
export const HOSTED_WRAPPER_STOP_GRACE_MS = 5_000;

export type WrapperStopRequest = "ASKED" | "KILLED";

/**
 * Asks the wrapper for the stop Ctrl-C would give it, and terminates it only when it is
 * still running after the grace.
 *
 * `child.kill()` on Windows is TerminateProcess: the wrapper's exit path
 * (`shutdownWrapperRuntime` -> `agentSpawner.close()` -> one tree kill per seat) never runs,
 * and every seat outlives it inside the Job. The host did exactly that on every stop until
 * 2026-09-13 (`kill: () => child.kill()`, wrapper stdin "ignore"). What that costs is read
 * off the code path, not off a measured stop: a seat live at stop time keeps the Job
 * non-empty, the broker's Job-empty wait then settles `Unobserved::JobActive` (its
 * settle.rs), so the manager's stop would read the broker's UNKNOWN instead of STOPPED and
 * the seats would die only when the broker closed the Job. The token reaches
 * `createWrapperStopSignal` over the wrapper's piped stdin, the same way `moe up` sends it.
 * A stdin that cannot be written falls back to the kill.
 */
export function stopWrapperChild(
  child: StoppableWrapperChild, graceMs: number = HOSTED_WRAPPER_STOP_GRACE_MS,
): WrapperStopRequest {
  const input = child.stdin;
  let asked = false;
  if (input !== null && input !== undefined) {
    // A pipe the wrapper already closed reports EPIPE asynchronously as an 'error' event;
    // unhandled, that event would crash the host. The kill below still follows the grace.
    try { input.on?.("error", () => undefined); } catch { /* not an emitter: nothing to swallow */ }
    try {
      input.write(`${WRAPPER_STDIN_STOP_TOKEN}\n`);
      asked = true;
    } catch { asked = false; }
  }
  if (!asked) {
    child.kill();
    return "KILLED";
  }
  let exited = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  child.once("exit", () => {
    exited = true;
    if (timer !== undefined) clearTimeout(timer);
  });
  timer = setTimeout(() => { if (!exited) child.kill(); }, graceMs);
  timer.unref?.();
  return "ASKED";
}
