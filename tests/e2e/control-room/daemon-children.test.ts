import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KILL_CONFIRM_BUDGET_MS, killTree, running, survivingChildren } from "./daemon-children.js";

/**
 * Node-lane tests for the daemon lane's process primitives. Named `*.test.ts`,
 * not `*.spec.ts`, for the reason `harness.test.ts` gives: this runs under the
 * root vitest include inside `pnpm test:e2e`, with no browser and no daemon.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT is a teardown that kills by NUMBER. The
 * seed exits on its own long before the lane comes down; on a shared host its pid
 * may by then belong to a stranger, and `taskkill /t /f` on that number reaps the
 * stranger's whole tree. The same number read back through `tasklist` would then
 * report the stranger as this lane's orphan. Both halves are pinned here against
 * HANDLES whose exit state is set by hand, so the cases run in milliseconds.
 *
 * Only `taskkill` is intercepted, and only to record what would have been sent:
 * every other spawn, `tasklist` included, runs for real. The kill-confirmation
 * cases therefore hold a pid no Windows process can carry (pids are multiples of
 * four; this one is odd), so an interception that somehow failed to apply could
 * not reach a real process.
 */
const taskkills = vi.hoisted(() => ({ sent: [] as readonly string[][] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = (command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess => {
    if (command !== "taskkill") return actual.spawn(command, args ?? [], options ?? {});
    taskkills.sent = [...taskkills.sent, [...(args ?? [])]];
    const killer = new EventEmitter();
    // `taskkill` answers on a later turn, as the real one does; its exit status
    // is deliberately NOT what the subject is allowed to treat as confirmation.
    process.nextTick(() => { killer.emit("close", 0); });
    return killer as unknown as ChildProcess;
  };
  return { ...actual, spawn };
});

/** Odd, so no Windows process can hold it: a kill that reached the OS hits nothing. */
const UNHOLDABLE_PID = 2_147_483_647;

interface HandleState {
  readonly exitCode: number | null;
  readonly pid: number | undefined;
  readonly signalCode: NodeJS.Signals | null;
}

type Handle = ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null };

/** A handle with its reaped-or-not state set by hand. Emits like the real one. */
const handle = (state: HandleState): Handle =>
  Object.assign(new EventEmitter(), state) as unknown as Handle;

afterEach(() => {
  taskkills.sent = [];
  vi.useRealTimers();
});

describe("running reads the handle, never the number", () => {
  it("is true only while neither an exit code nor a signal has been recorded", () => {
    expect(running(handle({ exitCode: null, pid: 1, signalCode: null }))).toBe(true);
    expect(running(handle({ exitCode: 0, pid: 1, signalCode: null }))).toBe(false);
    expect(running(handle({ exitCode: 1, pid: 1, signalCode: null }))).toBe(false);
    expect(running(handle({ exitCode: null, pid: 1, signalCode: "SIGTERM" }))).toBe(false);
  });
});

describe("killTree sends nothing at a child Node has already reaped", () => {
  it("does not spawn taskkill for a child that exited 0", async () => {
    await killTree(handle({ exitCode: 0, pid: UNHOLDABLE_PID, signalCode: null }));
    expect(taskkills.sent).toEqual([]);
  });

  it("does not spawn taskkill for a child that exited non-zero, or by signal", async () => {
    await killTree(handle({ exitCode: 1, pid: UNHOLDABLE_PID, signalCode: null }));
    await killTree(handle({ exitCode: null, pid: UNHOLDABLE_PID, signalCode: "SIGKILL" }));
    expect(taskkills.sent).toEqual([]);
  });

  it("does not spawn taskkill for a child that never got a pid", async () => {
    await killTree(handle({ exitCode: null, pid: undefined, signalCode: null }));
    expect(taskkills.sent).toEqual([]);
  });
});

describe("killTree on a child that is still running", () => {
  it("sends ONE tree kill at the handle's pid, and resolves only once the handle exits", async () => {
    const child = handle({ exitCode: null, pid: UNHOLDABLE_PID, signalCode: null });
    let exitedFirst = false;
    // Read at resolution: true only if the handle's exit preceded it.
    const settled = killTree(child).then(() => exitedFirst);
    await vi.waitFor(() => { expect(taskkills.sent).toHaveLength(1); });
    expect(taskkills.sent[0]).toEqual(["/pid", String(UNHOLDABLE_PID), "/t", "/f"]);
    // The kill request has been accepted and answered; the process has not yet
    // gone. A subject confirming through taskkill's exit would have settled here.
    await new Promise((done) => { setTimeout(done, 20); });
    child.exitCode = 1;
    exitedFirst = true;
    child.emit("exit", 1, null);
    expect(await settled).toBe(true);
  });

  it("gives up waiting after KILL_CONFIRM_BUDGET_MS rather than hanging teardown", async () => {
    vi.useFakeTimers();
    const child = handle({ exitCode: null, pid: UNHOLDABLE_PID, signalCode: null });
    let settled = false;
    const kill = killTree(child).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(KILL_CONFIRM_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await kill;
    expect(settled).toBe(true);
    expect(taskkills.sent).toHaveLength(1);
  });
});

describe("survivingChildren probes only what the handle cannot account for", () => {
  // This process's own pid: a number `tasklist` is certain to list as alive. If
  // the probe went by number, every case below but the control would false-flag.
  const alivePid = process.pid;

  it("reports nothing for a reaped child whose number is demonstrably alive", async () => {
    expect(await survivingChildren([
      handle({ exitCode: 0, pid: alivePid, signalCode: null }),
      handle({ exitCode: 1, pid: alivePid, signalCode: null }),
      handle({ exitCode: null, pid: alivePid, signalCode: "SIGTERM" }),
    ])).toEqual([]);
  });

  it("reports nothing for a child that never got a pid", async () => {
    expect(await survivingChildren([
      handle({ exitCode: null, pid: undefined, signalCode: null }),
    ])).toEqual([]);
  });

  it("still names an unreaped child that is alive: the probe is real, not vacuous", async () => {
    expect(await survivingChildren([
      handle({ exitCode: 0, pid: alivePid, signalCode: null }),
      handle({ exitCode: null, pid: alivePid, signalCode: null }),
    ])).toEqual([alivePid]);
  });
});
