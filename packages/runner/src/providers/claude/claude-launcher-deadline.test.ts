import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { type WindowsProcessOutcome } from "../../platform/windows/windows-process-contract.js";
import {
  BOUNDARY_TIMEOUT_SLACK_MS,
  CLAUDE_LAUNCHER_DEFAULTS,
  launchClaude,
  type ClaudeLauncherDependencies,
} from "./claude-launcher.js";
import {
  PROCESS, PROVEN, boundaryHarness, dependencies, failureOf, request,
} from "./claude-launcher-test-fixtures.js";

/**
 * Where a launch's pre-run time goes. The boundary arms its padded backstop at
 * open, so the lifecycle deadline has to be measured from that same instant:
 * a deadline armed only once `started`, sealed-context delivery and
 * registration are behind it trails the backstop by however long they took,
 * and once that exceeds the padding the backstop fires first, tears the
 * provider channels down, and a plain timeout is renamed a stream fault. Both
 * phases a provider can hold up are covered — a start the broker reports late,
 * and a stdin the provider drains late — and `armed` fires the moment the
 * stall's timer exists, so the clock is only walked once there is one to fire.
 */
interface StallPlan {
  readonly name: string;
  started(stallMs: number, armed: () => void): Promise<typeof PROCESS>;
  stdin(stallMs: number, armed: () => void): Writable;
}
const STALLS: readonly StallPlan[] = [
  { name: "start",
    started: (stallMs, armed) => new Promise((resolve) => {
      setTimeout(() => resolve(PROCESS), stallMs); armed();
    }),
    stdin: () => new Writable({ write(_chunk, _encoding, callback) { callback(); } }) },
  { name: "stdin-drain",
    started: () => Promise.resolve(PROCESS),
    stdin: (stallMs, armed) => new Writable({ write(_chunk, _encoding, callback) {
      setTimeout(callback, stallMs); armed();
    } }) },
];

interface Clock { openedAt: number; closedAt: number; backstopFired: boolean }

/**
 * The BrokerSession shape: an internal timer armed from the open options that
 * destroys the provider channels when it fires, while `completed` keeps
 * waiting on a broker still winding down. The REAL `delay` port supplies the
 * lifecycle's own deadline, so the two timers race exactly as shipped.
 */
function stalledDeps(plan: StallPlan, stallMs: number, log: string[], clock: Clock,
  armed: () => void): ClaudeLauncherDependencies {
  const base = dependencies(boundaryHarness(), log);
  return { ...base, delay: CLAUDE_LAUNCHER_DEFAULTS.delay,
    openBoundary: (_value: unknown, options?: { readonly timeoutMs?: number }) => {
      log.push("open");
      clock.openedAt = Date.now();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = plan.stdin(stallMs, armed);
      let end!: (outcome: WindowsProcessOutcome) => void;
      const completed = new Promise<WindowsProcessOutcome>((resolve) => { end = resolve; });
      const backstop = setTimeout(() => {
        clock.backstopFired = true;
        stdout.destroy(new Error("scripted premature close"));
        stderr.destroy(new Error("scripted premature close"));
      }, options?.timeoutMs ?? 0);
      backstop.unref?.();
      return { started: plan.started(stallMs, armed), completed,
        providerStdin: stdin, providerStdout: stdout, providerStderr: stderr,
        cancel: (): void => undefined,
        close: async (): Promise<WindowsProcessOutcome> => {
          clock.closedAt = Date.now();
          clearTimeout(backstop);
          if (!stdout.destroyed && !stdout.writableEnded) stdout.end();
          if (!stderr.destroyed && !stderr.writableEnded) stderr.end();
          stdin.destroy();
          end(PROVEN);
          return PROVEN;
        } };
    } };
}

describe("the launch deadline is measured from the open", () => {
  it("names a run that outlives its deadline TIMEOUT after a pre-run stall longer than the slack", async () => {
    // The reported numbers: a ten-minute budget, and a pre-run phase that takes
    // longer than the padding the launcher hands the backstop but far less
    // than the budget, so the stall itself is never what times out.
    const timeoutMs = 600_000;
    const stallMs = BOUNDARY_TIMEOUT_SLACK_MS + 5_000;
    expect(stallMs).toBeGreaterThan(BOUNDARY_TIMEOUT_SLACK_MS);
    expect(stallMs).toBeLessThan(timeoutMs);
    expect(STALLS.length).toBe(2);
    let ran = 0;
    vi.useFakeTimers();
    try {
      for (const plan of STALLS) {
        const log: string[] = [];
        const clock: Clock = { openedAt: -1, closedAt: -1, backstopFired: false };
        let armed!: () => void;
        const stalled = new Promise<void>((resolve) => { armed = resolve; });
        const launched = launchClaude(request({
          limits: { stdoutBytes: 64, stderrBytes: 64, tailBytes: 4, timeoutMs },
        }), { platform: "win32", deps: stalledDeps(plan, stallMs, log, clock, armed) });
        await stalled;
        // Through the stall: the run is registered and waiting on the provider.
        await vi.advanceTimersByTimeAsync(stallMs);
        expect({ name: plan.name, registered: log.filter((entry) => entry === "register").length })
          .toEqual({ name: plan.name, registered: 2 });
        // Past the deadline AND the backstop, so whichever fires first names the run.
        await vi.advanceTimersByTimeAsync(timeoutMs + BOUNDARY_TIMEOUT_SLACK_MS);
        const result = await launched;
        expect({ name: plan.name, ...failureOf(result) })
          .toEqual({ name: plan.name, code: "CLAUDE_LAUNCH_TIMEOUT", layer: "LAUNCHER" });
        // The deadline led by the whole slack: closed at exactly the budget from
        // the open, and the backstop never had to act.
        expect({ name: plan.name, elapsed: clock.closedAt - clock.openedAt,
          backstop: clock.backstopFired })
          .toEqual({ name: plan.name, elapsed: timeoutMs, backstop: false });
        expect(log.filter((entry) => entry === "unlock")).toHaveLength(1);
        ran += 1;
      }
    } finally { vi.useRealTimers(); }
    expect(ran).toBe(STALLS.length);
  });
});
