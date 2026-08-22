/**
 * The wrapper's operator knobs, parsed strictly. `Number("abc")` is NaN, and
 * NaN is quietly catastrophic here: `setTimeout(fn, NaN)` fires immediately,
 * so a typo in MOE_WRAPPER_INTERVAL_MS becomes a tight loop hammering the
 * store, and `active < NaN` is always false, so a typo in
 * MOE_WRAPPER_MAX_AGENTS staffs nothing forever while the log says the board
 * is idle. Refuse by name at startup instead.
 */
export interface WrapperKnobs {
  /** Hard lifetime of one agent process; the same value the spawner enforces. */
  readonly agentTimeoutMs: number;
  /** work.claim lifetime per staffing: the reap horizon when a child dies without releasing. */
  readonly claimTtlMs: number;
  readonly intervalMs: number;
  readonly maxAgents: number;
  /** Consecutive staffings of ONE unmoved item before the wrapper stops respawning it. */
  readonly maxItemAttempts: number;
  readonly once: boolean;
  /**
   * session.open lifetime per staffing. Derived, never set directly: the bearer
   * must outlive the child by construction, because the exit-path release runs
   * under the agent's own secret. Bound to the claim TTL it died under a long
   * task that kept renewing its claim, and every later release was refused.
   */
  readonly sessionTtlMs: number;
}

export const WRAPPER_ENV_INVALID = "WRAPPER_ENV_INVALID" as const;

const DEFAULT_MAX_AGENTS = 2;
const DEFAULT_INTERVAL_MS = 15_000;
/** Below this the loop is a busy-wait against SQLite, not a poll. */
const MIN_INTERVAL_MS = 100;
/** Mirrors agent-spawner.ts DEFAULT_AGENT_TIMEOUT_MS; the spawner is handed this value. */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const CLAIM_TTL_MS = 30 * 60 * 1000;
/**
 * Added on top of the longer horizon so the bearer is still live when the
 * exit-path release is dispatched: covers the spawner's SIGKILL grace after a
 * timed-out child and the cleanup dispatch itself.
 */
const SESSION_EXIT_GRACE_MS = 60_000;
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
  // One knob for the agent lifetime; both TTLs follow from it. The spawner
  // parses the same variable leniently (a malformed value falls back to its
  // default), so it is refused by name HERE, before the spawner ever reads it.
  const agentTimeoutMs = integer(env, "MOE_AGENT_TIMEOUT_MS", DEFAULT_AGENT_TIMEOUT_MS, 1);
  return Object.freeze({
    agentTimeoutMs,
    claimTtlMs: CLAIM_TTL_MS,
    intervalMs: integer(env, "MOE_WRAPPER_INTERVAL_MS", DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS),
    maxAgents: integer(env, "MOE_WRAPPER_MAX_AGENTS", DEFAULT_MAX_AGENTS, 1),
    maxItemAttempts:
      integer(env, "MOE_WRAPPER_MAX_ITEM_ATTEMPTS", DEFAULT_MAX_ITEM_ATTEMPTS, 1),
    once: env["MOE_WRAPPER_ONCE"] === "1",
    sessionTtlMs: Math.max(CLAIM_TTL_MS, agentTimeoutMs) + SESSION_EXIT_GRACE_MS,
  });
}
