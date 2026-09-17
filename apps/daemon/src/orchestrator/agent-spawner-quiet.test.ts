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

  it("is off when no interval was asked for, so nothing changes for a caller that opts out",
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
