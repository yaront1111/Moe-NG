/**
 * Static control-room harness: build the bundle, serve it, wait for it to
 * answer, hand the caller a base URL, and tear the server down on EVERY exit
 * path.
 *
 * WHAT THIS LANE IS. The served application renders COMMITTED FIXTURES through
 * ControlRoomScaffold. There is no daemon, no transport and no live data here,
 * and a green run in this lane certifies nothing about a connected system.
 * Nothing in this module may be named or reported in a way that suggests
 * otherwise.
 *
 * Conventions are MIRRORED from tests/e2e/foundation/e2e-harness.ts — a frozen
 * code tuple, cleanup in a `finally`, and an outcome that names WHICH cleanup
 * failed — and nothing is imported from it. That module's own header states it
 * "must never stand in for" a system under certification, and its
 * declared-boundary process termination is fenced to that directory.
 *
 * Every effect is an INJECTED port, so the lifecycle's failure paths are
 * provable in the Node lane without building a bundle or binding a socket. The
 * readiness-timeout path in particular is only testable if the clock is
 * injected: a real one would have to be waited out.
 */
export const CONTROL_ROOM_E2E_ERROR_CODES = Object.freeze([
  "E2E_BUNDLE_BUILD_FAILED",
  "E2E_SERVER_BIND_FAILED",
  "E2E_READINESS_TIMEOUT",
  "E2E_CLEANUP_FAILED",
] as const);
export type ControlRoomE2eErrorCode = (typeof CONTROL_ROOM_E2E_ERROR_CODES)[number];

/** Bounded, so a server that never answers fails with a code instead of hanging. */
export const READINESS_BUDGET_MS = 30_000;

export interface ServedBundle {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

export interface StaticHarnessPorts {
  /** Resolves false when the bundle could not be produced; never throws for that case. */
  readonly buildBundle: () => Promise<boolean>;
  /** Resolves null when the server could not bind. An ephemeral port is the caller's job. */
  readonly startServer: () => Promise<ServedBundle | null>;
  /** True once the served URL answers. Polled, never slept against. */
  readonly probe: (baseUrl: string) => Promise<boolean>;
  /** Yields between polls. */
  readonly waitTick: () => Promise<void>;
  /** Monotonic milliseconds. Injected so the timeout path is provable. */
  readonly now: () => number;
}

export interface HarnessSucceeded<T> {
  readonly ok: true;
  readonly value: T;
}

export interface HarnessRefused {
  readonly ok: false;
  readonly code: ControlRoomE2eErrorCode;
  /** Present only for E2E_CLEANUP_FAILED: which cleanups failed, by name. */
  readonly failures?: readonly string[];
}

export type HarnessOutcome<T> = HarnessSucceeded<T> | HarnessRefused;

const refuse = (code: ControlRoomE2eErrorCode): HarnessRefused =>
  Object.freeze({ code, ok: false as const });

/**
 * Polls until the served URL answers or the budget is spent. Reads the clock
 * BEFORE each attempt, so a probe that resolves slowly still terminates: a loop
 * that only checked the deadline between fast polls would spin forever against
 * a slow one.
 */
async function awaitReadiness(ports: StaticHarnessPorts, baseUrl: string): Promise<boolean> {
  const deadline = ports.now() + READINESS_BUDGET_MS;
  for (;;) {
    if (await ports.probe(baseUrl)) return true;
    if (ports.now() >= deadline) return false;
    await ports.waitTick();
  }
}

/**
 * Runs every cleanup even if an earlier one throws, and reports the names of
 * those that failed. Stopping at the first failure would leak the rest — on
 * Windows a surviving child holds file handles and resurfaces later as EBUSY
 * rather than as the failure that actually happened.
 */
async function runCleanups(
  cleanups: readonly (readonly [string, () => Promise<void>])[],
): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const [name, cleanup] of cleanups) {
    try {
      await cleanup();
    } catch {
      failures.push(name);
    }
  }
  return Object.freeze(failures);
}

/**
 * Builds, serves, waits for readiness, runs `body` with the base URL, and tears
 * down in a `finally`.
 *
 * Precedence is deliberate: build refuses before the server is started, bind
 * refuses before the probe is called, and a cleanup failure NEVER overwrites an
 * earlier code — the operator needs the reason the run failed at all, not the
 * reason the teardown afterwards was untidy.
 */
export async function withStaticControlRoom<T>(
  ports: StaticHarnessPorts,
  body: (baseUrl: string) => Promise<T>,
): Promise<HarnessOutcome<T>> {
  if (!(await ports.buildBundle())) return refuse("E2E_BUNDLE_BUILD_FAILED");

  let served: ServedBundle | null;
  try {
    served = await ports.startServer();
  } catch {
    return refuse("E2E_SERVER_BIND_FAILED");
  }
  if (served === null) return refuse("E2E_SERVER_BIND_FAILED");

  const server = served;
  let primary: HarnessOutcome<T>;
  let cleanupFailures: readonly string[] = [];
  try {
    primary = (await awaitReadiness(ports, server.baseUrl))
      ? Object.freeze({ ok: true as const, value: await body(server.baseUrl) })
      : refuse("E2E_READINESS_TIMEOUT");
  } finally {
    // Cleanup happens even when `body` throws — that path RE-THROWS past this
    // point, which is deliberate: a failed journey assertion is the caller's
    // failure and must not be laundered into a harness reason code. The server
    // still comes down first.
    cleanupFailures = await runCleanups([["server", server.stop]]);
  }

  // A cleanup failure never overwrites an earlier code: the operator needs the
  // reason the run failed at all, not the reason teardown was untidy.
  if (cleanupFailures.length > 0 && primary.ok) {
    return Object.freeze({
      code: "E2E_CLEANUP_FAILED" as const,
      failures: cleanupFailures,
      ok: false as const,
    });
  }
  return primary;
}
