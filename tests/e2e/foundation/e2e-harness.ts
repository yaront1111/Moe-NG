/**
 * Run scaffolding for the Foundation Preview canary.
 *
 * Three properties this module exists to guarantee, all of them load-bearing
 * for a suite that certifies a cutover:
 *
 * 1. **Determinism.** Every seed is a fixed literal and time is a logical
 *    counter, so a failing journey reproduces. No harness module reads a wall
 *    clock or a random source; `e2e-harness.test.ts` scans the raw text of each
 *    one and fails if any of those four APIs appears. The scan is deliberately
 *    text-exact rather than comment-stripped — a stricter check cannot be
 *    fooled by a parser edge case — which is why this paragraph names none of
 *    them literally.
 * 2. **Cleanup on every exit path.** `withE2eRun` runs cleanup in its `finally`,
 *    a throwing cleanup does not prevent the rest from running, and the outcome
 *    reports which ones failed under the stable code `E2E_CLEANUP_FAILED`. On
 *    Windows a killed child holds file handles, so a leaked scratch directory
 *    would surface later as `EBUSY` instead of the real failure.
 * 3. **Containment.** Declared-boundary process termination lives in
 *    `e2e-process.ts` and is used only from this directory. The runner subtree is
 *    deliberately fenced against real process kills; this harness is the single
 *    place in the epic where they are legitimate, and the containment is
 *    asserted rather than promised.
 *
 * This module is NOT part of the system under certification and must never
 * stand in for one.
 */

/** Every stable reason code the harness can return. Frozen, no duplicates. */
export const E2E_ERROR_CODES = Object.freeze([
  "E2E_CLEANUP_FAILED",
  "E2E_PROCESS_ALREADY_KILLED",
  "E2E_UNDECLARED_BOUNDARY",
  "E2E_UNKNOWN_KILL_TARGET",
] as const);
export type E2eErrorCode = (typeof E2E_ERROR_CODES)[number];

/**
 * The boundaries at which this harness may terminate a real process.
 *
 * The design says "kill agent/runner/daemon at declared boundaries" (line 1099)
 * without enumerating them, so this list is ours — but it is DECLARED, frozen,
 * and a kill outside it is refused with `E2E_UNDECLARED_BOUNDARY`. A harness
 * that killed wherever a caller asked would make "at declared boundaries"
 * unfalsifiable.
 */
export const DECLARED_BOUNDARIES = Object.freeze([
  "AFTER_PROCESS_READY",
  "AFTER_PLAN_APPROVED",
  "AFTER_EFFECT_ACTIVATED",
  "AFTER_RECEIPT_COMMITTED",
  "BEFORE_FINAL_ACCEPTANCE",
] as const);
export type DeclaredBoundary = (typeof DECLARED_BOUNDARIES)[number];

export function isDeclaredBoundary(value: string): value is DeclaredBoundary {
  return (DECLARED_BOUNDARIES as readonly string[]).includes(value);
}

/** Fixed literals. Changing one changes every derived identifier in the suite. */
export const E2E_SEED = Object.freeze({
  runPrefix: "moe-e2e-foundation",
  logicalEpochUtc: "2026-01-01T00:00:00.000Z",
  logicalStepMs: 1000,
} as const);

const SECONDS_PER_DAY = 86_400;

export function deterministicId(kind: string, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new RangeError(`deterministic ordinal must be a non-negative integer, got ${ordinal}`);
  }
  return `${E2E_SEED.runPrefix}-${kind}-${String(ordinal).padStart(4, "0")}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Formats an offset from the fixed epoch without constructing a `Date`.
 *
 * The epoch date itself never rolls: a canary that ran past a day boundary
 * would have a wall-clock-shaped bug, so exceeding the day throws instead of
 * silently producing a second date.
 */
function instantAtOffset(secondsFromEpoch: number): string {
  if (secondsFromEpoch >= SECONDS_PER_DAY) {
    throw new RangeError(`logical clock exhausted after ${SECONDS_PER_DAY} steps`);
  }
  const hour = Math.floor(secondsFromEpoch / 3600);
  const minute = Math.floor((secondsFromEpoch % 3600) / 60);
  const second = secondsFromEpoch % 60;
  return `2026-01-01T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.000Z`;
}

/** Matches the injected-clock port the production adapters accept. */
export interface LogicalClock {
  observedAt: () => string;
}

export function createLogicalClock(): LogicalClock {
  let ticks = 0;
  return {
    observedAt(): string {
      const instant = instantAtOffset((ticks * E2E_SEED.logicalStepMs) / 1000);
      ticks += 1;
      return instant;
    },
  };
}

export interface CleanupFailure {
  readonly label: string;
  readonly message: string;
}

export type CleanupOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "E2E_CLEANUP_FAILED";
      readonly failures: readonly CleanupFailure[];
    };

export interface E2eRun {
  readonly runId: string;
  readonly clock: LogicalClock;
  registerCleanup: (label: string, cleanup: () => void | Promise<void>) => void;
}

interface CleanupEntry {
  readonly label: string;
  readonly cleanup: () => void | Promise<void>;
}

class Run implements E2eRun {
  readonly runId: string;
  readonly clock: LogicalClock = createLogicalClock();
  readonly entries: CleanupEntry[] = [];

  constructor(runOrdinal: number) {
    this.runId = deterministicId("run", runOrdinal);
  }

  registerCleanup(label: string, cleanup: () => void | Promise<void>): void {
    this.entries.push({ label, cleanup });
  }
}

export function createE2eRun(runOrdinal: number): E2eRun {
  return new Run(runOrdinal);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs every registered cleanup, newest first, and never stops early.
 *
 * Stopping at the first failure is what leaks the handle that makes the NEXT
 * case fail with `EBUSY` instead of its real error, so a throwing entry is
 * recorded and the rest still run.
 */
export async function finishE2eRun(run: E2eRun): Promise<CleanupOutcome> {
  if (!(run instanceof Run)) {
    // Fail closed. Returning an empty cleanup list for a run this module did
    // not create would report success while cleaning up nothing, which is the
    // exact shape of leak this function exists to prevent.
    throw new TypeError("finishE2eRun requires a run produced by createE2eRun");
  }
  const entries = [...run.entries].reverse();
  const failures: CleanupFailure[] = [];
  for (const entry of entries) {
    try {
      await entry.cleanup();
    } catch (error: unknown) {
      failures.push({ label: entry.label, message: messageOf(error) });
    }
  }
  return failures.length === 0
    ? { ok: true }
    : { ok: false, code: "E2E_CLEANUP_FAILED", failures: Object.freeze(failures) };
}

/**
 * Runs `body` with a fresh run and guarantees cleanup on every exit path.
 *
 * A body failure is rethrown unchanged, so a failing journey shows its own
 * assertion message rather than a harness wrapper. A cleanup failure is NEVER
 * swallowed: when the body succeeded it is raised directly, and when the body
 * also failed it is raised with the body error attached as `cause`. Dropping it
 * on the failure path would hide exactly the leaked process or held handle that
 * makes the NEXT case fail for the wrong reason.
 */
export async function withE2eRun<T>(
  runOrdinal: number,
  body: (run: E2eRun) => T | Promise<T>,
): Promise<T> {
  const run = createE2eRun(runOrdinal);
  let bodyError: { readonly error: unknown } | null = null;
  try {
    return await body(run);
  } catch (error: unknown) {
    bodyError = { error };
    throw error;
  } finally {
    const outcome = await finishE2eRun(run);
    if (outcome.ok === false) {
      const detail = outcome.failures.map((entry) => `${entry.label}: ${entry.message}`).join("; ");
      const message = `${outcome.code} for ${run.runId} — ${detail}`;
      throw bodyError === null ? new Error(message) : new Error(message, { cause: bodyError.error });
    }
  }
}
