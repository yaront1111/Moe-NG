import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { type WindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import { launchClaude } from "./claude-launcher.js";
import {
  PROCESS,
  PROVEN,
  boundaryHarness,
  dependencies,
  failureOf,
  request,
} from "./claude-launcher-test-fixtures.js";

function dependenciesWithStdin(
  harness: ReturnType<typeof boundaryHarness>,
  portsLog: string[],
  stdin: Writable,
): ReturnType<typeof dependencies> {
  const base = dependencies(harness, portsLog);
  return {
    ...base,
    openBoundary(value: unknown, options?: { readonly timeoutMs?: number }): WindowsProcessBoundary {
      const opened = base.openBoundary(value, options) as WindowsProcessBoundary;
      return {
        ...opened,
        providerStdin: stdin,
        close: async () => {
          stdin.destroy();
          return await opened.close();
        },
      };
    },
  };
}

const HOSTILE_STDIN_METHODS = Object.freeze(["once", "write", "end", "off"] as const);

describe("Claude sealed-context delivery", () => {
  it("writes the exact UTF-8 bytes once after start and before completion, then ends stdin", async () => {
    let announceStart!: (value: typeof PROCESS) => void;
    let announceCompletion!: (value: typeof PROVEN) => void;
    const started = new Promise<typeof PROCESS>((resolve) => { announceStart = resolve; });
    const completed = new Promise<typeof PROVEN>((resolve) => { announceCompletion = resolve; });
    const harness = boundaryHarness({ started, completed });
    const lifecycle: string[] = [];
    const written: Buffer[] = [];
    const stdin = harness.boundary.providerStdin;
    const write = vi.spyOn(stdin, "write");
    stdin.on("data", (chunk: Buffer) => {
      lifecycle.push("write");
      written.push(Buffer.from(chunk));
    });
    stdin.on("finish", () => {
      lifecycle.push("stdin-ended");
      announceCompletion(PROVEN);
      lifecycle.push("completion-ready");
    });
    const portsLog: string[] = [];
    const renderedContext = "sealed: λ🧵\n";
    const contextManifestDigest = "cd".repeat(32);

    const launched = launchClaude(request({ renderedContext, contextManifestDigest }), {
      platform: "win32",
      deps: dependencies(harness, portsLog),
    });
    await vi.waitFor(() => expect(portsLog).toContain("open"));
    expect(write).toHaveBeenCalledTimes(0);
    lifecycle.push("started");
    announceStart(PROCESS);

    const result = await launched;
    expect(result.kind).toBe("OBSERVED");
    if (result.kind !== "OBSERVED") throw new Error(`launch refused: ${result.code}`);
    expect(write).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(written)).toEqual(Buffer.from(renderedContext, "utf8"));
    expect(stdin.writableEnded).toBe(true);
    expect(lifecycle).toEqual(["started", "write", "stdin-ended", "completion-ready"]);
    expect(result.observation.deliveredByteLength).toBe(Buffer.byteLength(renderedContext, "utf8"));
    expect(result.observation.contextManifestDigest).toBe(contextManifestDigest);
  });

  it("refuses at the launcher layer when the provider stdin write fails", async () => {
    const failedStdin = new Writable({
      write() { /* stays pending until the scripted transport error */ },
    });
    failedStdin.once("newListener", (event) => {
      if (event === "error") {
        setImmediate(() => failedStdin.destroy(new Error("scripted provider stdin failure")));
      }
    });
    const harness = boundaryHarness();
    const portsLog: string[] = [];
    const deps = dependenciesWithStdin(harness, portsLog, failedStdin);

    const result = await launchClaude(request(), { platform: "win32", deps });

    expect(failureOf(result)).toEqual({
      code: "CLAUDE_LAUNCH_CONTEXT_DELIVERY_FAILED",
      layer: "LAUNCHER",
    });
    expect(result.kind).toBe("REFUSED");
    expect("observation" in result).toBe(false);
    expect(portsLog.filter((event) => event === "register")).toHaveLength(1);
    expect(portsLog).not.toContain("observe");
  });

  it("generates exactly four hostile provider stdin method arms", () => {
    expect(HOSTILE_STDIN_METHODS).toHaveLength(4);
    expect(new Set(HOSTILE_STDIN_METHODS).size).toBe(HOSTILE_STDIN_METHODS.length);
  });

  it.each(HOSTILE_STDIN_METHODS)(
    "contains a hostile provider stdin %s throw as a launcher-layer refusal",
    async (method) => {
      const hostileStdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      Object.defineProperty(hostileStdin, method, {
        configurable: true,
        value: () => { throw new Error(`scripted hostile ${method}`); },
      });
      const harness = boundaryHarness();
      const portsLog: string[] = [];

      const result = await launchClaude(request(), {
        platform: "win32",
        deps: dependenciesWithStdin(harness, portsLog, hostileStdin),
      });

      expect(failureOf(result)).toEqual({
        code: "CLAUDE_LAUNCH_CONTEXT_DELIVERY_FAILED",
        layer: "LAUNCHER",
      });
      expect(result.kind).toBe("REFUSED");
      expect("observation" in result).toBe(false);
      expect(harness.log).toEqual(["cancel", "close"]);
      expect(portsLog.filter((event) => event === "unlock")).toHaveLength(1);
    },
  );

  it("cancels a stalled provider stdin delivery without awaiting its write callback", async () => {
    let acknowledge!: () => void;
    const stalledStdin = new Writable({
      write(_chunk, _encoding, callback) { acknowledge = callback; },
    });
    const write = vi.spyOn(stalledStdin, "write");
    const harness = boundaryHarness();
    const portsLog: string[] = [];
    const controller = new AbortController();
    const launched = launchClaude(request(), {
      platform: "win32",
      signal: controller.signal,
      deps: dependenciesWithStdin(harness, portsLog, stalledStdin),
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    controller.abort();

    const result = await Promise.race([
      launched,
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), 500); }),
    ]);
    if (result === null) {
      acknowledge();
      await launched;
      throw new Error("cancellation waited for provider stdin acknowledgement");
    }
    expect(failureOf(result)).toEqual({ code: "CLAUDE_LAUNCH_CANCELLED", layer: "LAUNCHER" });
    expect(harness.log).toEqual(["cancel", "close"]);
    expect(portsLog.filter((event) => event === "unlock")).toHaveLength(1);
  });

  it("times out a stalled provider stdin delivery without awaiting its write callback", async () => {
    let acknowledge!: () => void;
    const stalledStdin = new Writable({
      write(_chunk, _encoding, callback) { acknowledge = callback; },
    });
    const write = vi.spyOn(stalledStdin, "write");
    const harness = boundaryHarness();
    const portsLog: string[] = [];
    const launched = launchClaude(request({
      limits: { stdoutBytes: 64, stderrBytes: 64, tailBytes: 4, timeoutMs: 10 },
    }), {
      platform: "win32",
      deps: dependenciesWithStdin(harness, portsLog, stalledStdin),
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));

    const result = await Promise.race([
      launched,
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), 500); }),
    ]);
    if (result === null) {
      acknowledge();
      await launched;
      throw new Error("timeout waited for provider stdin acknowledgement");
    }
    expect(failureOf(result)).toEqual({ code: "CLAUDE_LAUNCH_TIMEOUT", layer: "LAUNCHER" });
    expect(harness.log).toEqual(["cancel", "close"]);
    expect(portsLog.filter((event) => event === "unlock")).toHaveLength(1);
  });
});
