import { writeSync } from "node:fs";

/**
 * A DEVELOPMENT-ONLY CRASH KNOB FOR THE LANDING WRITE.
 *
 * Proving "a landing survives a crash mid-write" needs the daemon to die inside a window
 * that is microseconds wide — between the git commit and the journal completion that
 * records it. An external `kill` cannot aim there; only the process itself can.
 *
 * So this is a switch that terminates the daemon, and it is written to be USELESS to
 * anyone who did not deliberately arm it:
 *
 *   - OFF unless `MOE_FAULT_INJECT_LANDING` names a point. No point, no knob.
 *   - REFUSES unless `MOE_DEVELOPMENT_ONLY` is exactly "1". A truthy-ish value is not
 *     enough; "true", "yes" and "0" are all refused, because the failure mode of a loose
 *     parser here is a denial-of-service control in a normal run.
 *   - The development fence answers FIRST. An unknown point name outside development
 *     reads NOT_DEVELOPMENT, never POINT_UNKNOWN, so an unarmed caller learns nothing
 *     about which names exist.
 *
 * Every refusal carries a stable code, so a test can pin WHICH fence refused rather than
 * merely that nothing blew up.
 *
 * NOT A SECURITY BOUNDARY, stated plainly: anyone who can set this daemon's environment
 * can already start a different daemon. The fences exist so the knob cannot fire by
 * accident in a normal run, which is a correctness property, not a threat model.
 */

/** The named points inside a landing write. `node-lander-journal.ts` trips all four. */
export const LANDING_FAULT_POINTS = [
  /** Entry, before the intent is journaled: nothing durable has been written yet. */
  "before-intent",
  /** Intent journaled and the attempt started, before git is touched. */
  "after-intent",
  /** THE INTERESTING ONE: git has committed, the completion is not journaled yet. */
  "after-commit",
  /** Completion journaled, before the caller records the landing receipt. */
  "after-completion",
] as const;

export type LandingFaultPoint = (typeof LANDING_FAULT_POINTS)[number];

export type LandingFaultRefusal =
  /** No point named — the default, and the reason the knob does nothing in production. */
  | "FAULT_INJECTION_DISARMED"
  /** A point was named, but this daemon is not in development mode. */
  | "FAULT_INJECTION_NOT_DEVELOPMENT"
  /** Development mode is on, but the named point is not in the roster. */
  | "FAULT_INJECTION_POINT_UNKNOWN";

export interface LandingFaultArming {
  readonly point: LandingFaultPoint | null;
  readonly refusal: LandingFaultRefusal | null;
}

export const LANDING_FAULT_POINT_ENV = "MOE_FAULT_INJECT_LANDING";
export const LANDING_FAULT_DEVELOPMENT_ENV = "MOE_DEVELOPMENT_ONLY";

function isPoint(name: string): name is LandingFaultPoint {
  return (LANDING_FAULT_POINTS as readonly string[]).includes(name);
}

/** Reads the two variables and says, with a code, why the knob is or is not armed. */
export function readLandingFaultArming(env: NodeJS.ProcessEnv): LandingFaultArming {
  const named = (env[LANDING_FAULT_POINT_ENV] ?? "").trim();
  if (named === "") return { point: null, refusal: "FAULT_INJECTION_DISARMED" };
  if (env[LANDING_FAULT_DEVELOPMENT_ENV] !== "1") {
    return { point: null, refusal: "FAULT_INJECTION_NOT_DEVELOPMENT" };
  }
  if (!isPoint(named)) return { point: null, refusal: "FAULT_INJECTION_POINT_UNKNOWN" };
  return { point: named, refusal: null };
}

export interface LandingFaultInjector {
  readonly armedPoint: LandingFaultPoint | null;
  readonly refusal: LandingFaultRefusal | null;
  /** Dies here if this is the armed point; returns immediately otherwise. */
  readonly trip: (point: LandingFaultPoint) => void;
}

export interface LandingFaultInjectorConfig {
  readonly env?: NodeJS.ProcessEnv;
  /** Test injection. Production terminates the process and never returns. */
  readonly kill?: (note: string) => void;
  readonly now?: () => string;
}

/**
 * SIGKILL, not `process.exit`. An exit runs handlers, flushes streams and closes the
 * store cleanly — that is a graceful shutdown, and recovering from one proves nothing.
 * The note goes out with a synchronous `writeSync` to fd 2 BEFORE the signal, because
 * nothing after it will flush.
 */
function terminate(note: string): void {
  try { writeSync(2, note); } catch { /* a closed stderr must not stop the crash */ }
  process.kill(process.pid, "SIGKILL");
}

export function createLandingFaultInjector(
  config: LandingFaultInjectorConfig = {},
): LandingFaultInjector {
  const arming = readLandingFaultArming(config.env ?? process.env);
  const kill = config.kill ?? terminate;
  const now = config.now ?? ((): string => new Date().toISOString());
  return Object.freeze({
    armedPoint: arming.point,
    refusal: arming.refusal,
    trip: (point: LandingFaultPoint): void => {
      if (arming.point !== point) return;
      kill(`${LANDING_FAULT_POINT_ENV} point=${point} pid=${String(process.pid)} at=${now()}\n`);
    },
  });
}
