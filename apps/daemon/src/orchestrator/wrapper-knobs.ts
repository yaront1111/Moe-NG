/**
 * The wrapper's operator knobs, parsed strictly. `Number("abc")` is NaN, and
 * NaN is quietly catastrophic here: `setTimeout(fn, NaN)` fires immediately,
 * so a typo in MOE_WRAPPER_INTERVAL_MS becomes a tight loop hammering the
 * store, and `active < NaN` is always false, so a typo in
 * MOE_WRAPPER_MAX_AGENTS staffs nothing forever while the log says the board
 * is idle. Refuse by name at startup instead.
 */
export interface WrapperKnobs {
  readonly intervalMs: number;
  readonly maxAgents: number;
  /** Consecutive staffings of ONE unmoved item before the wrapper stops respawning it. */
  readonly maxItemAttempts: number;
  readonly once: boolean;
}

export const WRAPPER_ENV_INVALID = "WRAPPER_ENV_INVALID" as const;

const DEFAULT_MAX_AGENTS = 2;
const DEFAULT_INTERVAL_MS = 15_000;
/** Below this the loop is a busy-wait against SQLite, not a poll. */
const MIN_INTERVAL_MS = 100;
/**
 * Live run 2026-08-20: a READY step whose command refuses at a daemon prerequisite
 * (BOOTSTRAP_POLICY_UNKNOWN) was restaffed every pass forever — each cycle minting a session,
 * claiming, spawning a real model, and releasing. Three attempts is enough to distinguish a
 * transient race from an unsatisfiable step; the counter resets when the step moves at all.
 */
const DEFAULT_MAX_ITEM_ATTEMPTS = 3;

function integer(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, minimum: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || !/^\d+$/u.test(raw.trim())) {
    throw new Error(`${WRAPPER_ENV_INVALID}: ${name} must be an integer >= ${String(minimum)}`);
  }
  return parsed;
}

export function readWrapperKnobs(
  env: Readonly<Record<string, string | undefined>>,
): WrapperKnobs {
  return Object.freeze({
    intervalMs: integer(env, "MOE_WRAPPER_INTERVAL_MS", DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS),
    maxAgents: integer(env, "MOE_WRAPPER_MAX_AGENTS", DEFAULT_MAX_AGENTS, 1),
    maxItemAttempts:
      integer(env, "MOE_WRAPPER_MAX_ITEM_ATTEMPTS", DEFAULT_MAX_ITEM_ATTEMPTS, 1),
    once: env["MOE_WRAPPER_ONCE"] === "1",
  });
}
