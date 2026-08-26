import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { driveBrokerBoundary } from "./windows-boundary-driver.js";
import { type BrokerPipes } from "./windows-broker-process.js";
import { type WindowsProcessBoundary } from "./windows-boundary-session.js";

interface BrokerHarness {
  readonly calls: string[];
  readonly pipes: BrokerPipes;
  exit(code: number | null, signal?: string | null): void;
}

const brokerHarness = (): BrokerHarness => {
  const calls: string[] = [];
  let onExit: ((code: number | null, signal: string | null) => void) | null = null;
  const providerStdin = new PassThrough();
  const providerStdout = new PassThrough();
  const providerStderr = new PassThrough();
  const pipes: BrokerPipes = {
    pid: 42,
    providerStdin,
    providerStdout,
    providerStderr,
    writeControl: (bytes) => { calls.push(`writeControl:${bytes.length}`); },
    endControl: () => { calls.push("endControl"); },
    closeProviderChannels: () => {
      calls.push("closeProviderChannels");
      providerStdin.end();
      providerStdout.destroy();
      providerStderr.destroy();
    },
    onStatus: () => {},
    onExit: (listener) => { onExit = listener; },
    onError: () => {},
    kill: () => { calls.push("kill"); },
    dispose: () => {
      calls.push("dispose");
      providerStdin.destroy();
      providerStdout.destroy();
      providerStderr.destroy();
    },
  };
  return { calls, pipes, exit: (code, signal = null) => { onExit?.(code, signal); } };
};

const openBoundary = (timeoutMs: number | null, fake: BrokerHarness): WindowsProcessBoundary => {
  const result = driveBrokerBoundary(
    "C:\\Moe\\moe-windows-job-broker.exe",
    Uint8Array.from([1, 2, 3]),
    () => fake.pipes,
    timeoutMs,
    50,
  );
  if ("truthClass" in result) throw new Error(`boundary refused: ${result.code}`);
  return result;
};

afterEach(() => { vi.useRealTimers(); });

describe("the broker launch timeout is explicitly nullable", () => {
  it("keeps numeric timeout cancellation and cleanup behavior", async () => {
    vi.useFakeTimers();
    const fake = brokerHarness();
    const boundary = openBoundary(25, fake);
    expect(fake.calls).toEqual(["writeControl:3"]);

    await vi.advanceTimersByTimeAsync(25);
    expect(fake.calls).toEqual(["writeControl:3", "endControl", "closeProviderChannels"]);
    fake.exit(null);

    await expect(boundary.completed).resolves.toMatchObject({
      truthClass: "UNKNOWN",
      code: "PROCESS_BOUNDARY_LAUNCH_TIMED_OUT",
      layer: "WINDOWS_PROCESS_TRANSPORT",
    });
    expect(fake.calls.at(-1)).toBe("dispose");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("creates no timer for null and still supports explicit cancellation and cleanup", async () => {
    vi.useFakeTimers();
    const fake = brokerHarness();
    const boundary = openBoundary(null, fake);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
    expect(fake.calls).toEqual(["writeControl:3"]);
    boundary.cancel();
    expect(fake.calls).toEqual(["writeControl:3", "endControl", "closeProviderChannels"]);
    fake.exit(0);

    await expect(boundary.completed).resolves.toMatchObject({
      truthClass: "UNKNOWN",
      code: "PROCESS_BOUNDARY_BROKER_EXITED",
      layer: "WINDOWS_PROCESS_TRANSPORT",
    });
    expect(fake.calls.at(-1)).toBe("dispose");
    expect(fake.pipes.providerStdout.destroyed).toBe(true);
    expect(fake.pipes.providerStderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
