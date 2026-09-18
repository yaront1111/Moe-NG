import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeSpawnStarter } from "./agent-spawner.js";
import type { AgentSpawnerOptions } from "./agent-spawner.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/**
 * THE SILENT SEAT.
 *
 * A live seat was observed exactly ONCE in its whole lifetime: a single `setTimeout` at the
 * agent timeout, 30 minutes by default. `outputSeen` was computed on every chunk and read only
 * at settlement, so "this seat has printed nothing for twelve minutes" was knowable at every
 * instant and observed at none.
 *
 * The recorded live symptom: a seat hung for thirty minutes in total silence, then one line
 * appeared saying it had exceeded its timeout. Nothing in between — no wrapper line, no ledger
 * row, no surface change. An operator could not distinguish a working seat from a dead one.
 */

const MCP_ORIGIN = "http://127.0.0.1:39124";

interface FakeChild {
  readonly emitter: EventEmitter;
  readonly stderr: PassThrough;
  readonly stdout: PassThrough;
}

function fakeSpawn(): {
  readonly children: FakeChild[];
  readonly spawn: NonNullable<AgentSpawnerOptions["spawn"]>;
} {
  const children: FakeChild[] = [];
  const spawn: NonNullable<AgentSpawnerOptions["spawn"]> = () => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    children.push({ emitter, stderr, stdout });
    const child = Object.assign(emitter, {
      kill: vi.fn(),
      pid: 4242,
      stderr,
      stdin: new PassThrough(),
      stdout,
      unref: vi.fn(),
    });
    return child as unknown as ReturnType<NonNullable<AgentSpawnerOptions["spawn"]>>;
  };
  return { children, spawn };
}

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    credential: "agent-secret-0001",
    expiresAt: "2026-01-01T00:00:00.000Z",
    kind: "project.register",
    mission: "You hold the claim on project.register@proj-1. Dispatch it.",
    sessionId: "sess-wrap-0001",
    workItemId: "project.register@proj-1",
    workspace: null,
    ...overrides,
  };
}

const drain = (): Promise<void> =>
  new Promise<void>((resolve) => { setImmediate(resolve); });

/** Retires the fake child so `close()` has nothing live to contain and cannot hang the test. */
async function retire(child: FakeChild | undefined): Promise<void> {
  child?.emitter.emit("close", 0, null);
  await drain();
}

/**
 * Only the timers under test are faked. Faking `setImmediate` too would stall `drain()`, which
 * is how the promise plumbing in this file yields to the spawner's own microtasks.
 */
const useSeatTimers = (): void => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
};

afterEach(() => { vi.useRealTimers(); });

describe("a live seat that says nothing", () => {
  it("reports the silence long before the timeout kills it", async () => {
    useSeatTimers();
    let now = 1_000_000;
    const lines: string[] = [];
    const { children, spawn } = fakeSpawn();
    const start = claudeSpawnStarter(MCP_ORIGIN, {
      log: (line) => { lines.push(line); },
      now: () => now,
      output: { stderr: new PassThrough(), stdout: new PassThrough() },
      quietNoticeMs: 60_000,
      spawn,
      timeoutMs: 30 * 60_000,
    });

    const started = start(request());
    await drain();
    children[0]?.emitter.emit("spawn");
    await started;

    now += 60_000;
    vi.advanceTimersByTime(60_000);

    const quiet = lines.filter((line) => line.includes("seat quiet"));
    expect(quiet.length).toBe(1);
    expect(quiet[0]).toContain("project.register@proj-1");
    // The two numbers an operator needs: how long it has been silent, and how long it has left.
    expect(quiet[0]).toContain("60000ms");
    expect(quiet[0]).toMatch(/pid 4242/u);

    await retire(children[0]);
    await start.close();
  });

  it("stays quiet about a seat that is producing output", async () => {
    useSeatTimers();
    let now = 1_000_000;
    const lines: string[] = [];
    const { children, spawn } = fakeSpawn();
    const start = claudeSpawnStarter(MCP_ORIGIN, {
      log: (line) => { lines.push(line); },
      now: () => now,
      output: { stderr: new PassThrough(), stdout: new PassThrough() },
      quietNoticeMs: 60_000,
      spawn,
      timeoutMs: 30 * 60_000,
    });

    const started = start(request());
    await drain();
    children[0]?.emitter.emit("spawn");
    await started;

    // Speaks at the halfway mark, so it has never been silent for a whole interval.
    now += 30_000;
    vi.advanceTimersByTime(30_000);
    children[0]?.stdout.write("working on it\n");
    await drain();
    now += 30_000;
    vi.advanceTimersByTime(30_000);

    expect(lines.filter((line) => line.includes("seat quiet"))).toEqual([]);

    await retire(children[0]);
    await start.close();
  });

  it("says nothing further once the seat has closed", async () => {
    useSeatTimers();
    let now = 1_000_000;
    const lines: string[] = [];
    const { children, spawn } = fakeSpawn();
    const start = claudeSpawnStarter(MCP_ORIGIN, {
      log: (line) => { lines.push(line); },
      now: () => now,
      output: { stderr: new PassThrough(), stdout: new PassThrough() },
      quietNoticeMs: 60_000,
      spawn,
      timeoutMs: 30 * 60_000,
    });

    const started = start(request());
    await drain();
    children[0]?.emitter.emit("spawn");
    const result = await started;
    children[0]?.emitter.emit("close", 0, null);
    if (result.ok) await result.exit;
    await drain();

    const before = lines.filter((line) => line.includes("seat quiet")).length;
    now += 300_000;
    vi.advanceTimersByTime(300_000);

    expect(lines.filter((line) => line.includes("seat quiet")).length).toBe(before);

    await start.close();
  });

  it("prints no notice when none was asked for (the silence kill itself stays armed: see below)",
    async () => {
      useSeatTimers();
      const lines: string[] = [];
      const { children, spawn } = fakeSpawn();
      const start = claudeSpawnStarter(MCP_ORIGIN, {
        log: (line) => { lines.push(line); },
        output: { stderr: new PassThrough(), stdout: new PassThrough() },
        quietNoticeMs: 0,
        spawn,
        timeoutMs: 30 * 60_000,
      });

      const started = start(request());
      await drain();
      children[0]?.emitter.emit("spawn");
      await started;
      vi.advanceTimersByTime(600_000);

      expect(lines.filter((line) => line.includes("seat quiet"))).toEqual([]);

      await retire(children[0]);
      await start.close();
    });
});

/**
 * THE SEAT TIMEOUT WAS A WALL-CLOCK CAP, NOT A LIVENESS TEST (UnAI 2026-09-18).
 *
 * `claude -p` writes nothing until it finishes, so "0 bytes seen" was true of every seat for its
 * whole life and said nothing. Node 6 was killed at exactly 30 min while a bash tool child was
 * alive; node 5 finished with 59 s to spare. These arms drive the spawner with a fake clock and a
 * fake probe: silence (no output, no tool child, flat CPU) kills at MOE_AGENT_SILENCE_MS and names
 * itself; a live tool child holds the seat past that; the absolute cap fires regardless and names
 * what the seat was last seen doing.
 */
describe("a seat judged on liveness, not on the clock alone", () => {
  const MINUTE = 60_000;
  const SILENCE = 20 * MINUTE;
  const CAP = 2 * 60 * MINUTE;

  function seat(probe: AgentSpawnerOptions["probeActivity"], overrides: Partial<AgentSpawnerOptions> = {}): {
    readonly advance: (ms: number) => void;
    readonly groupKills: number[];
    readonly lines: string[];
    readonly start: ReturnType<typeof claudeSpawnStarter>;
    readonly spawned: FakeChild[];
    readonly warnings: string[];
  } {
    useSeatTimers();
    let now = Date.parse("2026-09-18T13:12:04.000Z");
    const lines: string[] = [];
    const warnings: string[] = [];
    const groupKills: number[] = [];
    const { children, spawn } = fakeSpawn();
    const start = claudeSpawnStarter(MCP_ORIGIN, {
      // Wide enough that a test can advance past a kill without tripping CLOSE_NOT_OBSERVED.
      killGraceMs: 10 * MINUTE,
      killProcessGroup: (pid) => { groupKills.push(pid); },
      log: (line) => { lines.push(line); },
      now: () => now,
      output: { stderr: new PassThrough(), stdout: new PassThrough() },
      platform: "linux",
      probeActivity: probe,
      quietNoticeMs: MINUTE,
      silenceMs: SILENCE,
      spawn,
      timeoutMs: CAP,
      warn: (line) => { warnings.push(line); },
      ...overrides,
    });
    return {
      advance: (ms) => {
        // One tick at a time, so the fake clock and the fake timers agree at every tick.
        for (let left = ms; left > 0; left -= MINUTE) {
          const step = Math.min(left, MINUTE);
          now += step;
          vi.advanceTimersByTime(step);
        }
      },
      groupKills, lines, spawned: children, start, warnings,
    };
  }

  const admit = async (h: ReturnType<typeof seat>): Promise<void> => {
    const started = h.start(request());
    await drain();
    h.spawned[0]?.emitter.emit("spawn");
    await started;
  };

  const killLines = (lines: readonly string[]): string[] => lines.filter((l) => l.includes("killing"));

  it("does NOT kill a silent seat at the silence threshold while a tool child is alive", async () => {
    // cmd.exe -> model is the chain the first tick sees (2); the bash tool child makes 3.
    let ticks = 0;
    const h = seat(() => { ticks += 1; return { cpuMs: 1_000, descendants: ticks === 1 ? 2 : 3 }; });
    await admit(h);

    h.advance(SILENCE + 5 * MINUTE);

    expect(killLines(h.lines)).toEqual([]);
    expect(h.groupKills).toEqual([]);
    // Truthful notice: no output, but the operator can see WHY the seat is still alive.
    const quiet = h.lines.filter((l) => l.includes("seat quiet"));
    expect(quiet.length).toBe(SILENCE / MINUTE + 5);
    expect(quiet.at(-1)).toContain("no output; 1 tool child alive; cpu unchanged");
    expect(quiet.at(-1)).not.toContain("bytes seen");

    h.spawned[0]?.emitter.emit("close", 0, null);
    await drain();
    await h.start.close();
  });

  it("kills a silent seat with no tool child and flat CPU at the silence threshold, and names it", async () => {
    const h = seat(() => ({ cpuMs: 1_000, descendants: 2 }));
    await admit(h);

    h.advance(SILENCE - MINUTE);
    expect(killLines(h.lines)).toEqual([]);
    expect(h.groupKills).toEqual([]);

    h.advance(MINUTE);
    expect(h.groupKills).toEqual([-4242]);
    const killed = killLines(h.lines);
    expect(killed.length).toBe(1);
    expect(killed[0]).toBe("[wrapper] project.register@proj-1 killing: silent 20m0s"
      + " (no output, no tool child, cpu unchanged since 13:12:04Z); absolute cap 2h0m not reached (age 20m0s)");
    // Killed ONCE: later ticks do not re-fire against a seat already being terminated.
    h.advance(5 * MINUTE);
    expect(killLines(h.lines).length).toBe(1);

    h.spawned[0]?.emitter.emit("close", null, "SIGKILL");
    await drain();
    await h.start.close();
  });

  it("counts any CPU growth as activity, so a silent seat that is computing is not a hung seat", async () => {
    let cpuMs = 0;
    const h = seat(() => { cpuMs += 125; return { cpuMs, descendants: 2 }; });
    await admit(h);

    h.advance(SILENCE + 5 * MINUTE);

    expect(killLines(h.lines)).toEqual([]);
    expect(h.lines.filter((l) => l.includes("seat quiet")).at(-1)).toContain("no output; no tool child; cpu +125ms");

    h.spawned[0]?.emitter.emit("close", 0, null);
    await drain();
    await h.start.close();
  });

  it("kills at the absolute cap whatever the seat is doing, and names the last activity", async () => {
    // Computing at every tick for the whole two hours: never silent, still capped.
    let cpuMs = 0;
    const h = seat(() => { cpuMs += 125; return { cpuMs, descendants: 2 }; });
    await admit(h);

    h.advance(CAP);

    expect(h.groupKills).toEqual([-4242]);
    const killed = killLines(h.lines);
    expect(killed.length).toBe(1);
    // The old pin, kept: `exceeded <ms>; killing`, now followed by WHICH limit and the last fact.
    // The cap timer was armed before the tick interval, so at 2h it fires first: the last
    // activity on record is the tick one minute earlier.
    expect(killed[0]).toBe("[wrapper] project.register@proj-1 agent exceeded 7200000ms; killing:"
      + " absolute cap 2h0m reached (last activity: cpu +125ms at 15:11:04Z)");

    h.spawned[0]?.emitter.emit("close", null, "SIGKILL");
    await drain();
    await h.start.close();
  });

  it("names a live tool child as the last activity when the cap kills a working seat", async () => {
    let ticks = 0;
    const h = seat(() => { ticks += 1; return { cpuMs: 1_000, descendants: ticks === 1 ? 2 : 3 }; });
    await admit(h);

    h.advance(CAP);

    const killed = killLines(h.lines);
    expect(killed.length).toBe(1);
    expect(killed[0]).toContain("absolute cap 2h0m reached (last activity: 1 tool child alive at 15:11:04Z)");
    expect(killed[0]).not.toContain("silent");

    h.spawned[0]?.emitter.emit("close", null, "SIGKILL");
    await drain();
    await h.start.close();
  });

  it("writes a truthful quiet notice: silence and cap countdowns beside what the tick saw", async () => {
    const h = seat(() => ({ cpuMs: 1_000, descendants: 2 }));
    await admit(h);

    h.advance(2 * MINUTE);

    const quiet = h.lines.filter((l) => l.includes("seat quiet"));
    expect(quiet).toEqual([
      "[wrapper] project.register@proj-1 seat quiet: 60000ms since last output (age 60000ms,"
        + " 1140000ms to silence kill, 7140000ms to absolute cap, pid 4242;"
        + " no output; no tool child; cpu baseline taken)",
      "[wrapper] project.register@proj-1 seat quiet: 120000ms since last output (age 120000ms,"
        + " 1080000ms to silence kill, 7080000ms to absolute cap, pid 4242;"
        + " no output; no tool child; cpu unchanged)",
    ]);

    h.spawned[0]?.emitter.emit("close", 0, null);
    await drain();
    await h.start.close();
  });

  it("awaits an asynchronous probe (one in flight at a time) before judging", async () => {
    let inFlight = 0;
    let overlap = 0;
    const h = seat(async () => {
      inFlight += 1;
      if (inFlight > 1) overlap += 1;
      await drain();
      inFlight -= 1;
      return { cpuMs: 1_000, descendants: 2 };
    });
    await admit(h);

    for (let minute = 0; minute < SILENCE / MINUTE; minute += 1) {
      h.advance(MINUTE);
      await drain();
      await drain();
    }

    expect(overlap).toBe(0);
    expect(h.groupKills).toEqual([-4242]);
    expect(killLines(h.lines)[0]).toContain("killing: silent 20m0s (no output, no tool child, cpu unchanged since");

    h.spawned[0]?.emitter.emit("close", null, "SIGKILL");
    await drain();
    await h.start.close();
  });

  it("counts no silence, and says so, when no probe was handed over", async () => {
    const h = seat(undefined);
    await admit(h);

    h.advance(SILENCE + 5 * MINUTE);

    expect(killLines(h.lines)).toEqual([]);
    expect(h.lines.filter((l) => l.includes("seat quiet")).at(-1)).toContain("no output; no activity probe");
    expect(h.warnings).toEqual([]);

    h.advance(CAP - SILENCE - 5 * MINUTE);
    expect(killLines(h.lines)).toEqual([
      "[wrapper] project.register@proj-1 agent exceeded 7200000ms; killing:"
        + " absolute cap 2h0m reached (last activity: seat start at 13:12:04Z)",
    ]);

    h.spawned[0]?.emitter.emit("close", null, "SIGKILL");
    await drain();
    await h.start.close();
  });

  /**
   * A PROBE THAT FAILS EVERY TICK (PowerShell timing out, WMI down, `ps` missing) cannot see the
   * tree, so those ticks are neither activity nor silence. Only the absolute cap can end the seat
   * while the probe is blind. The reason the probe gave is in every notice, and the first failure
   * is a warning-level line — not because a silence kill is coming, but so the operator can see
   * the probe is broken while the seat is still alive.
   */
  it("names the probe's failure reason in the notice and one early warning, and kills only at the cap", async () => {
    const h = seat(() => ({ ok: false, reason: "powershell.exe timed out after 30000ms (SIGTERM)" }));
    await admit(h);

    h.advance(MINUTE);
    expect(h.warnings).toEqual([
      "[wrapper] project.register@proj-1 liveness probe failed: powershell.exe timed out after 30000ms (SIGTERM);"
        + " the tree is unobserved, so no silence is counted until the probe sees it again, and until then only"
        + " the absolute cap (2h0m) can kill this seat",
    ]);
    expect(h.groupKills).toEqual([]);
    const quiet = h.lines.filter((l) => l.includes("seat quiet"));
    expect(quiet.length).toBe(1);
    expect(quiet[0]).toContain("1200000ms to silence kill");
    expect(quiet[0]).toContain("no output; tree unobserved: powershell.exe timed out after 30000ms (SIGTERM)");
    expect(quiet[0]).not.toContain("answered nothing");

    h.advance(SILENCE + 4 * MINUTE);
    expect(h.groupKills).toEqual([]);
    expect(killLines(h.lines)).toEqual([]);

    h.advance(CAP - SILENCE - 5 * MINUTE);
    // Unobserved for the whole life: only the absolute cap fires, last activity is still seat start.
    expect(h.groupKills).toEqual([-4242]);
    expect(killLines(h.lines)).toEqual([
      "[wrapper] project.register@proj-1 agent exceeded 7200000ms; killing:"
        + " absolute cap 2h0m reached (last activity: seat start at 13:12:04Z)",
    ]);
    expect(h.warnings.length).toBe(1);

    h.spawned[0]?.emitter.emit("close", null, "SIGKILL");
    await drain();
    await h.start.close();
  });

  it("warns with the thrown message when the probe throws, and counts no silence", async () => {
    const h = seat(() => { throw new Error("ps: not found"); });
    await admit(h);

    h.advance(SILENCE + 5 * MINUTE);

    expect(h.warnings.length).toBe(1);
    expect(h.warnings[0]).toContain(
      "liveness probe failed: probe threw: ps: not found; the tree is unobserved, so no silence is counted",
    );
    expect(killLines(h.lines)).toEqual([]);
    expect(h.groupKills).toEqual([]);
    expect(h.lines.filter((l) => l.includes("seat quiet")).at(-1))
      .toContain("no output; tree unobserved: probe threw: ps: not found");

    h.spawned[0]?.emitter.emit("close", 0, null);
    await drain();
    await h.start.close();
  });

  it("a probe that fails only at tick 6 moves the silence kill to 20 min after that tick", async () => {
    let ticks = 0;
    const h = seat(() => {
      ticks += 1;
      if (ticks === 6) return { ok: false, reason: "powershell.exe timed out after 30000ms (SIGTERM)" };
      return { cpuMs: 1_000, descendants: 2 };
    });
    await admit(h);

    h.advance(SILENCE + 5 * MINUTE);
    expect(h.groupKills).toEqual([]);

    h.advance(MINUTE);
    expect(killLines(h.lines)).toEqual([
      "[wrapper] project.register@proj-1 killing: silent 20m0s"
        + " (no output, no tool child, cpu unchanged since 13:18:04Z); absolute cap 2h0m not reached (age 26m0s)",
    ]);
    expect(h.groupKills).toEqual([-4242]);
    expect(h.warnings.length).toBe(1);

    h.spawned[0]?.emitter.emit("close", null, "SIGKILL");
    await drain();
    await h.start.close();
  });

  /**
   * quietNoticeMs 0 used to disarm the whole tick, so a caller that only wanted the notice off
   * also lost the silence kill and was back to the wall-clock cap alone. The notice and the
   * liveness tick are now decoupled: the notice is optional, the silence kill is not.
   */
  it("still kills a silent no-child seat at silenceMs when the quiet notice is turned off", async () => {
    const h = seat(() => ({ cpuMs: 1_000, descendants: 2 }), { quietNoticeMs: 0 });
    await admit(h);

    h.advance(SILENCE - MINUTE);
    expect(h.groupKills).toEqual([]);

    h.advance(MINUTE);
    expect(h.groupKills).toEqual([-4242]);
    expect(killLines(h.lines)).toEqual([
      "[wrapper] project.register@proj-1 killing: silent 20m0s"
        + " (no output, no tool child, cpu unchanged since 13:12:04Z); absolute cap 2h0m not reached (age 20m0s)",
    ]);
    // The notice really is off: not one quiet line in twenty minutes of silence.
    expect(h.lines.filter((l) => l.includes("seat quiet"))).toEqual([]);

    h.spawned[0]?.emitter.emit("close", null, "SIGKILL");
    await drain();
    await h.start.close();
  });

  it("keeps a working seat alive with the notice off, so the tick judges rather than merely reports", async () => {
    let ticks = 0;
    const h = seat(() => { ticks += 1; return { cpuMs: 1_000, descendants: ticks === 1 ? 2 : 3 }; },
      { quietNoticeMs: 0 });
    await admit(h);

    h.advance(SILENCE + 5 * MINUTE);

    expect(h.groupKills).toEqual([]);
    expect(killLines(h.lines)).toEqual([]);
    // The tick ran at the default cadence: one probe per minute, none skipped for the silent notice.
    expect(ticks).toBe(SILENCE / MINUTE + 5);

    h.spawned[0]?.emitter.emit("close", 0, null);
    await drain();
    await h.start.close();
  });
});

describe("a seat that could not be spawned at all", () => {
  it("names the errno and the command instead of an opaque refusal", async () => {
    const lines: string[] = [];
    const start = claudeSpawnStarter(MCP_ORIGIN, {
      log: (line) => { lines.push(line); },
      output: { stderr: new PassThrough(), stdout: new PassThrough() },
      spawn: () => {
        throw Object.assign(new Error("spawn claude ENOENT"), {
          code: "ENOENT", errno: -4058, syscall: "spawn claude",
        });
      },
    });

    await expect(start(request())).rejects.toThrow();

    const failed = lines.filter((line) => line.includes("spawn failed"));

    expect(failed.length).toBe(1);
    // A mistyped MOE_AGENT_COMMAND or a missing claude.cmd reached the operator as
    // AGENT_SPAWN_FAILED:UNADMITTED, with the word ENOENT appearing nowhere.
    expect(failed[0]).toContain("ENOENT");
    expect(failed[0]).toContain("project.register@proj-1");

    await start.close();
  });
});
