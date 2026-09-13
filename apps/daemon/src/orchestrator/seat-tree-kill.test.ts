import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { spawnWindowsTreeKill, windowsSystemRoot } from "./seat-tree-kill.js";
import type { WindowsTreeKillInput } from "./seat-tree-kill.js";

/** What one spawn was asked for, plus the emitter the helper listens on. */
interface FakeKiller {
  readonly args: readonly string[];
  readonly emitter: EventEmitter;
  readonly file: string;
  readonly options: unknown;
  readonly unref: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<WindowsTreeKillInput> = {}): {
  readonly closeChild: () => void;
  readonly confirmed: ReturnType<typeof vi.fn>;
  readonly failed: ReturnType<typeof vi.fn>;
  readonly input: WindowsTreeKillInput;
  readonly spawned: FakeKiller[];
} {
  const spawned: FakeKiller[] = [];
  const confirmed = vi.fn();
  const failed = vi.fn();
  let childClosed = false;
  const spawn: WindowsTreeKillInput["spawn"] = (file, args, options) => {
    const emitter = new EventEmitter();
    const unref = vi.fn();
    spawned.push({ args, emitter, file, options, unref });
    return Object.assign(emitter, { unref }) as unknown as ReturnType<WindowsTreeKillInput["spawn"]>;
  };
  const input: WindowsTreeKillInput = {
    childClosed: () => childClosed,
    environment: { SYSTEMROOT: "C:\\Windows" },
    onConfirmed: confirmed,
    onFailed: failed,
    pid: 88288,
    spawn,
    ...overrides,
  };
  return { closeChild: () => { childClosed = true; }, confirmed, failed, input, spawned };
}

describe("windowsSystemRoot", () => {
  it("reads SYSTEMROOT under any casing, and only when it is absolute and non-empty", () => {
    expect(windowsSystemRoot({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows");
    expect(windowsSystemRoot({ SYSTEMROOT: "Windows" })).toBeNull();
    expect(windowsSystemRoot({ SYSTEMROOT: "" })).toBeNull();
    expect(windowsSystemRoot({})).toBeNull();
  });
});

describe("spawnWindowsTreeKill", () => {
  it("spawns taskkill /T /F from SYSTEMROOT, hidden and unref'd, and hands the killer back", () => {
    const h = harness();
    const killer = spawnWindowsTreeKill(h.input);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toMatchObject({
      args: ["/pid", "88288", "/T", "/F"],
      file: "C:\\Windows\\System32\\taskkill.exe",
      options: { stdio: "ignore", windowsHide: true },
    });
    expect(h.spawned[0]?.unref).toHaveBeenCalledTimes(1);
    expect(killer).toBe(h.spawned[0]?.emitter);
    expect(h.confirmed).not.toHaveBeenCalled();
    expect(h.failed).not.toHaveBeenCalled();
  });

  it("fails without spawning anything when no absolute SYSTEMROOT exists", () => {
    const h = harness({ environment: { SYSTEMROOT: "Windows" } });
    expect(spawnWindowsTreeKill(h.input)).toBeUndefined();
    expect(h.spawned).toHaveLength(0);
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.confirmed).not.toHaveBeenCalled();
  });

  it("fails exactly once when the spawn itself throws", () => {
    const h = harness({ spawn: () => { throw new Error("EACCES"); } });
    expect(spawnWindowsTreeKill(h.input)).toBeUndefined();
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.confirmed).not.toHaveBeenCalled();
  });

  it("confirms on exit 0", () => {
    const h = harness();
    spawnWindowsTreeKill(h.input);
    h.spawned[0]?.emitter.emit("close", 0, null);
    expect(h.confirmed).toHaveBeenCalledTimes(1);
    expect(h.failed).not.toHaveBeenCalled();
  });

  it("confirms on 128, taskkill's no-running-instance, even with the child still live", () => {
    const h = harness();
    spawnWindowsTreeKill(h.input);
    h.spawned[0]?.emitter.emit("close", 128, null);
    expect(h.confirmed).toHaveBeenCalledTimes(1);
    expect(h.failed).not.toHaveBeenCalled();
  });

  it("fails on any other nonzero exit while the child is live, but confirms once the child closed", () => {
    const live = harness();
    spawnWindowsTreeKill(live.input);
    live.spawned[0]?.emitter.emit("close", 1, null);
    expect(live.failed).toHaveBeenCalledTimes(1);
    expect(live.confirmed).not.toHaveBeenCalled();

    const closed = harness();
    spawnWindowsTreeKill(closed.input);
    // The child closes AFTER the killer was spawned: the flag must be read at the killer's
    // close, not captured at spawn.
    closed.closeChild();
    closed.spawned[0]?.emitter.emit("close", 1, null);
    expect(closed.confirmed).toHaveBeenCalledTimes(1);
    expect(closed.failed).not.toHaveBeenCalled();
  });

  it("fails once on the killer's error event and ignores the close that follows it", () => {
    const h = harness();
    spawnWindowsTreeKill(h.input);
    h.spawned[0]?.emitter.emit("error", new Error("taskkill unavailable"));
    h.spawned[0]?.emitter.emit("close", 0, null);
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.confirmed).not.toHaveBeenCalled();
  });
});
