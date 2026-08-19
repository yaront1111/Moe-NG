/**
 * Orphan-reap probe.
 *
 * `taskkill /PID <n> /T /F` returns once the kill is REQUESTED, not once the OS has reaped the
 * process. Measured on this host with the machine idle, a killed pid stays visible to
 * `tasklist` for 68-100ms afterwards (8 of 8 samples, every one gone by the end of its bound),
 * and the window widens under full-suite load: the J3 and J4 orphan assertions reddened in 2
 * of 5 root-suite runs reporting `alive: true` on a pid that was already dying, while zero
 * processes from those runs survived them.
 *
 * Sampling liveness immediately after a kill therefore grades the sampling instant, not the
 * containment claim. Waiting for the reap keeps the claim intact and still fails closed: a pid
 * still alive at the bound is a real orphan, and the caller's assertion names it.
 */
import { pidIsAlive } from "./j1-loop-harness.js";

/** How long a reap may take before a surviving pid counts as a real orphan. */
export const ORPHAN_REAP_BOUND_MS = 30_000;

const POLL_INTERVAL_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Whether `pid` left the OS process table within `boundMs`. Answers false rather than throwing
 * when the pid is still alive at the deadline, so the caller asserts on it and reports which
 * pid survived.
 */
export async function pidReaped(
  pid: number,
  boundMs: number = ORPHAN_REAP_BOUND_MS,
): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  for (;;) {
    if (!pidIsAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}
