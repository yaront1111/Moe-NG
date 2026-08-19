/**
 * Orphan-reap probe.
 *
 * `taskkill /PID <n> /T /F` returns once the kill is REQUESTED, not once the OS has reaped the
 * process. Measured on this host while idle, a killed pid stays visible to `tasklist` for
 * 68-100ms afterwards (8 of 8 samples, every one gone by the end of its budget), and the
 * window widens under full-suite load: the J3 and J4 orphan assertions reddened in 2 of 5
 * clean-clone root-suite runs reporting `alive: true` on a pid that was already dying, while
 * zero processes from those runs survived them.
 *
 * Sampling liveness immediately after a kill therefore grades the sampling instant, not the
 * containment claim. Waiting for the reap keeps the claim intact and still fails closed: a pid
 * still alive once the budget is spent is a real orphan, and the caller's assertion names it.
 *
 * The budget counts POLLS rather than milliseconds because `e2e-harness.test.ts` forbids every
 * wall-clock source in a harness module, and a poll budget needs no clock. A reaped pid leaves
 * on the first or second poll, so the budget is only ever spent on the failing path.
 */
import { pidIsAlive } from "./j1-loop-harness.js";

/** Polls a pid may survive before it counts as a real orphan. */
export const ORPHAN_REAP_POLLS = 200;

const POLL_INTERVAL_MS = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Whether `pid` left the OS process table within `polls` samples. Answers false rather than
 * throwing when the pid outlives the budget, so the caller asserts on it and reports which pid
 * survived.
 */
export async function pidReaped(
  pid: number,
  polls: number = ORPHAN_REAP_POLLS,
): Promise<boolean> {
  for (let remaining = polls; remaining > 0; remaining -= 1) {
    if (!pidIsAlive(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !pidIsAlive(pid);
}
