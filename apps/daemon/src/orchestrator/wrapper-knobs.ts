/**
 * The wrapper's operator knobs, parsed strictly. `Number("abc")` is NaN, and
 * NaN is quietly catastrophic here: `setTimeout(fn, NaN)` fires immediately,
 * so a typo in MOE_WRAPPER_INTERVAL_MS becomes a tight loop hammering the
 * store, and `active < NaN` is always false, so a typo in
 * MOE_WRAPPER_MAX_AGENTS staffs nothing forever while the log says the board
 * is idle. Refuse by name at startup instead.
 */
export interface WrapperKnobs {
  /**
   * How long a seat may show NO ACTIVITY (no output, no tool child, flat CPU) before the
   * spawner kills it. The hang detector; `agentTimeoutMs` is the absolute cap behind it.
   */
  readonly agentSilenceMs: number;
  /** Absolute lifetime of one agent process whatever it is doing; the same value the spawner enforces. */
  readonly agentTimeoutMs: number;
  /** work.claim lifetime per staffing: the reap horizon when a child dies without releasing. */
  readonly claimTtlMs: number;
  readonly intervalMs: number;
  readonly maxAgents: number;
  /** Consecutive staffings of ONE unmoved item before the wrapper stops respawning it. */
  readonly maxItemAttempts: number;
  /** MOE_NODE_TREES=1 briefs each node into its own Git working tree, so nodes code in parallel. */
  readonly nodeTrees: boolean;
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
/**
 * Mirrors agent-spawner.ts DEFAULT_AGENT_TIMEOUT_MS; the spawner is handed this value. Two
 * hours: it is the ABSOLUTE cap behind the silence watch, not the hang detector it used to be,
 * so it only needs to outlast a working node's longest verification lane (UnAI 2026-09-18: a
 * node was killed at exactly the old 30 min with a tool child alive). It is still what the
 * bearer TTL is derived from, so the session now outlives a two-hour seat by construction.
 */
const DEFAULT_AGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/**
 * Mirrors agent-spawner.ts DEFAULT_AGENT_SILENCE_MS: no output, no tool child and flat CPU for
 * twenty minutes is a hung seat. Set it at or above the timeout to leave only the absolute cap.
 */
const DEFAULT_AGENT_SILENCE_MS = 20 * 60 * 1000;
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

/** `20m`, `2h`, `90s`: the shortest whole unit that says it exactly, else minutes with a decimal. */
function span(ms: number): string {
  if (ms % 3_600_000 === 0) return `${String(ms / 3_600_000)}h`;
  if (ms % 60_000 === 0) return `${String(ms / 60_000)}m`;
  if (ms % 1_000 === 0) return `${String(ms / 1_000)}s`;
  return `${String(ms)}ms`;
}

/**
 * The seat budget as the wrapper will enforce it, stated once at startup beside the verifier
 * database line, so the FIRST lines of wrapper.log prove the policy the process actually holds:
 * the silence kill, the absolute cap, the claim horizon and how often the wrapper renews it.
 * Measured 2026-09-18: a seat cap the owner set at the launcher, a claim TTL nobody renewed and
 * a silence rule that did not exist yet were each discovered from a lost attempt an hour later.
 * Says "(defaults: …)" when no MOE_AGENT_* knob reached this process, the way the verifier
 * line does for MOE_VERIFIER_DB_*, because a knob dropped by the broker roster looks exactly
 * like a knob never set.
 */
export function describeSeatBudget(knobs: WrapperKnobs, env: NodeJS.ProcessEnv, renewEveryMs: number): string {
  const stated = ["MOE_AGENT_SILENCE_MS", "MOE_AGENT_TIMEOUT_MS"].some((key) => env[key] !== undefined);
  return `[wrapper] seat budget: silence=${span(knobs.agentSilenceMs)} cap=${span(knobs.agentTimeoutMs)}`
    + ` claim=${span(knobs.claimTtlMs)} renew=${span(renewEveryMs)} session=${span(knobs.sessionTtlMs)}`
    + (stated ? "" : " (defaults: no MOE_AGENT_* reached this process)");
}

export function readWrapperKnobs(
  env: Readonly<Record<string, string | undefined>>,
): WrapperKnobs {
  // One knob for the agent lifetime; both TTLs follow from it. The spawner
  // parses the same variable leniently (a malformed value falls back to its
  // default), so it is refused by name HERE, before the spawner ever reads it.
  const agentTimeoutMs = integer(env, "MOE_AGENT_TIMEOUT_MS", DEFAULT_AGENT_TIMEOUT_MS, 1);
  return Object.freeze({
    agentSilenceMs: integer(env, "MOE_AGENT_SILENCE_MS", DEFAULT_AGENT_SILENCE_MS, 1),
    agentTimeoutMs,
    claimTtlMs: CLAIM_TTL_MS,
    intervalMs: integer(env, "MOE_WRAPPER_INTERVAL_MS", DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS),
    maxAgents: integer(env, "MOE_WRAPPER_MAX_AGENTS", DEFAULT_MAX_AGENTS, 1),
    maxItemAttempts:
      integer(env, "MOE_WRAPPER_MAX_ITEM_ATTEMPTS", DEFAULT_MAX_ITEM_ATTEMPTS, 1),
    nodeTrees: env["MOE_NODE_TREES"] === "1",
    once: env["MOE_WRAPPER_ONCE"] === "1",
    sessionTtlMs: Math.max(CLAIM_TTL_MS, agentTimeoutMs) + SESSION_EXIT_GRACE_MS,
  });
}
