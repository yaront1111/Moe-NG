import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WRAPPER_STDIN_STOP_TOKEN } from "../orchestrator/process-runner-lifecycle.js";
import { HOSTED_WRAPPER_STOP_GRACE_MS, stopWrapperChild } from "./project-stack-wrapper-stop.js";
import type { StoppableWrapperChild } from "./project-stack-wrapper-stop.js";

interface FakeChild extends StoppableWrapperChild {
  exit(): void;
  readonly errorListeners: readonly ((error: Error) => void)[];
  readonly kills: number;
  readonly written: readonly string[];
}

function fakeChild(stdin: "pipe" | "closed" | "throwing"): FakeChild {
  const exitListeners: (() => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const written: string[] = [];
  let kills = 0;
  const input = stdin === "closed" ? null : {
    on: (_event: "error", listener: (error: Error) => void): void => { errorListeners.push(listener); },
    write: (chunk: string): void => {
      if (stdin === "throwing") throw new Error("EPIPE");
      written.push(chunk);
    },
  };
  return {
    errorListeners,
    exit: (): void => { for (const listener of exitListeners.splice(0)) listener(); },
    get kills(): number { return kills; },
    kill: (): void => { kills += 1; },
    once: (_event: "exit", listener: () => void): void => { exitListeners.push(listener); },
    stdin: input,
    written,
  };
}

describe("stopWrapperChild", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("writes the wrapper's own stop token to its stdin and does not terminate it inside the grace", () => {
    const child = fakeChild("pipe");
    expect(stopWrapperChild(child, 1_000)).toBe("ASKED");
    expect(child.written).toEqual([`${WRAPPER_STDIN_STOP_TOKEN}\n`]);
    vi.advanceTimersByTime(999);
    expect(child.kills).toBe(0);
  });

  it("terminates a wrapper that is still running when the grace ends", () => {
    const child = fakeChild("pipe");
    stopWrapperChild(child, 1_000);
    vi.advanceTimersByTime(1_000);
    expect(child.kills).toBe(1);
  });

  it("never terminates a wrapper that exited on its own inside the grace", () => {
    const child = fakeChild("pipe");
    stopWrapperChild(child, 1_000);
    vi.advanceTimersByTime(300);
    child.exit();
    vi.advanceTimersByTime(5_000);
    expect(child.kills).toBe(0);
  });

  it("falls back to the kill at once when the wrapper has no stdin to ask on", () => {
    const child = fakeChild("closed");
    expect(stopWrapperChild(child, 1_000)).toBe("KILLED");
    expect(child.kills).toBe(1);
  });

  it("falls back to the kill at once when the stdin write throws", () => {
    const child = fakeChild("throwing");
    expect(stopWrapperChild(child, 1_000)).toBe("KILLED");
    expect([child.kills, child.written]).toEqual([1, []]);
  });

  it("swallows the pipe's asynchronous error so a closed wrapper stdin cannot crash the host", () => {
    const child = fakeChild("pipe");
    stopWrapperChild(child, 1_000);
    expect(child.errorListeners).toHaveLength(1);
    expect(() => { for (const listener of child.errorListeners) listener(new Error("EPIPE")); }).not.toThrow();
  });

  it("defaults to a grace that fits inside the manager's 10 s stop bound with the daemon and broker legs", () => {
    const child = fakeChild("pipe");
    stopWrapperChild(child);
    expect(HOSTED_WRAPPER_STOP_GRACE_MS).toBeLessThanOrEqual(5_000);
    vi.advanceTimersByTime(HOSTED_WRAPPER_STOP_GRACE_MS - 1);
    expect(child.kills).toBe(0);
    vi.advanceTimersByTime(1);
    expect(child.kills).toBe(1);
  });
});
