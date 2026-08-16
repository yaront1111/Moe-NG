import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createWrapperStopSignal,
  probeProcessAlive,
  shutdownWrapperRuntime,
} from "./agent-wrapper-main.js";

const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("agent wrapper process lifecycle", () => {
  it("waits for every owned child and agent cleanup before closing authority", async () => {
    const agents = deferred();
    const verifier = deferred();
    const order: string[] = [];

    const done = shutdownWrapperRuntime({
      closeAgentSpawner: () => { order.push("agents:stop"); return agents.promise; },
      closeProvider: () => { order.push("provider:close"); },
      closeVerifierRunner: () => { order.push("verifier:stop"); return verifier.promise; },
      closeVerifierStore: () => { order.push("verifier-store:close"); },
      settleAgents: async () => { order.push("agents:settle"); },
      stopAuthorityHost: async () => { order.push("host:stop"); },
    });

    await Promise.resolve();
    expect(order).toEqual(["verifier:stop", "agents:stop"]);
    verifier.resolve();
    await Promise.resolve();
    expect(order).toEqual(["verifier:stop", "agents:stop"]);
    agents.resolve();
    await done;

    expect(order).toEqual([
      "verifier:stop", "agents:stop", "agents:settle", "host:stop",
      "verifier-store:close", "provider:close",
    ]);
  });

  it("revokes authority and fails loudly when child containment is uncertain", async () => {
    const calls: string[] = [];
    await expect(shutdownWrapperRuntime({
      closeAgentSpawner: async () => { calls.push("agents:stop"); },
      closeProvider: () => { calls.push("provider:close"); },
      closeVerifierRunner: async () => {
        calls.push("verifier:stop");
        throw Object.assign(new Error("tree status unknown"), {
          code: "VERIFIER_PROCESS_CONTAINMENT_FAILED",
        });
      },
      closeVerifierStore: () => { calls.push("verifier-store:close"); },
      settleAgents: async () => { calls.push("agents:settle"); },
      stopAuthorityHost: async () => { calls.push("host:stop"); },
    })).rejects.toMatchObject({ code: "VERIFIER_PROCESS_CONTAINMENT_FAILED" });

    expect(calls).toEqual([
      "verifier:stop", "agents:stop", "agents:settle", "host:stop",
      "verifier-store:close", "provider:close",
    ]);
  });

  it("attempts every shutdown stage and retains failures in deterministic stage order", async () => {
    const calls: string[] = [];
    const failure = await shutdownWrapperRuntime({
      closeAgentSpawner: async () => { calls.push("agents:stop"); throw new Error("agent tree"); },
      closeProvider: () => { calls.push("provider:close"); throw new Error("provider close"); },
      closeVerifierRunner: async () => {
        calls.push("verifier:stop");
        throw new Error("verifier tree");
      },
      closeVerifierStore: () => {
        calls.push("verifier-store:close");
        throw new Error("verifier store");
      },
      settleAgents: async () => { calls.push("agents:settle"); throw new Error("agent settle"); },
      stopAuthorityHost: async () => { calls.push("host:stop"); throw new Error("host stop"); },
    }).then(() => null, (error: unknown) => error);

    expect(calls).toEqual([
      "verifier:stop", "agents:stop", "agents:settle", "host:stop",
      "verifier-store:close", "provider:close",
    ]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "verifier tree", "agent tree", "agent settle", "host stop",
      "verifier store", "provider close",
    ]);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s requests owned-child shutdown once and wakes the loop",
    async (name) => {
      const source = new EventEmitter();
      const onRequest = vi.fn();
      const stop = createWrapperStopSignal(source, onRequest);

      source.emit(name);
      source.emit(name);
      source.emit(name === "SIGINT" ? "SIGTERM" : "SIGINT");
      await expect(stop.wait()).resolves.toBeUndefined();
      expect(stop.requested()).toBe(true);
      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(source.listenerCount("SIGINT")).toBe(1);
      expect(source.listenerCount("SIGTERM")).toBe(1);

      stop.close();
      expect(source.listenerCount("SIGINT")).toBe(0);
      expect(source.listenerCount("SIGTERM")).toBe(0);
    },
  );
});

/**
 * The guard that would have caught QA reject #1.
 *
 * The fence shipped fully tested and completely inert: every drill exercised the
 * gate WITH a fence injected, and nothing asserted that the one production
 * construction passes one. `createStaffingGate(undefined).admit` returns null,
 * so an unwired binary admits every pass while the whole suite stays green.
 * "The guard works" and "the guard is installed" are separate claims and need
 * separate assertions.
 */
describe("wrapper binary staffing wiring", () => {
  const SOURCE = readFileSync(
    new URL("./agent-wrapper-main.ts", import.meta.url), "utf8",
  );
  const wrapperCall = (source: string): string => {
    const start = source.indexOf("createAgentWrapper({");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(["", "    });"].join("\n"), start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("passes a staffingFence in the production createAgentWrapper call", () => {
    expect(wrapperCall(SOURCE)).toContain("staffingFence:");
  });

  it("builds that fence from the real store and the real liveness probe", () => {
    // Pins WHAT is injected, not merely that the key is present: a
    // `staffingFence: undefined` would satisfy the assertion above while leaving
    // the binary exactly as unfenced as the rejected version.
    const call = wrapperCall(SOURCE);
    expect(call).toContain("staffingFence: createAgentSessionFence({");
    expect(call).toContain("isProcessAlive: probeProcessAlive");
    expect(call).toContain("store: verifierStore");
    expect(call).not.toContain("staffingFence: undefined");
  });

  it("scans a slice that can actually fail (positive control)", () => {
    // Without this, a scan that silently matched nothing would report success.
    const unwired = SOURCE.replace(/staffingFence: createAgentSessionFence\(\{/, "");
    expect(() => expect(wrapperCall(unwired)).toContain("staffingFence: createAgentSessionFence({"))
      .toThrow();
  });

  it("reads a live pid as alive and a vanished pid as dead", () => {
    const gone = Object.assign(new Error("no such process"), { code: "ESRCH" });
    expect(probeProcessAlive(1, () => undefined)).toBe(true);
    expect(probeProcessAlive(1, () => { throw gone; })).toBe(false);
  });

  it("reads a foreign-owned pid as ALIVE, never as gone", () => {
    // EPERM means the process EXISTS under another owner. Treating it as dead
    // would admit a second agent beside a live child — the defect itself.
    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    expect(probeProcessAlive(1, () => { throw denied; })).toBe(true);
  });

  it("propagates an unknown probe failure instead of guessing dead", () => {
    // The fence turns this into LIVENESS_UNKNOWN. Swallowing it here as `false`
    // would silently convert "cannot tell" into "safe to staff".
    const weird = Object.assign(new Error("EIO"), { code: "EIO" });
    expect(() => probeProcessAlive(1, () => { throw weird; })).toThrow("EIO");
  });

  it("asks with signal 0 and the pid it was given, delivering nothing", () => {
    const calls: Array<readonly [number, number]> = [];
    probeProcessAlive(4242, (pid, signal) => { calls.push([pid, signal]); });

    expect(calls).toStrictEqual([[4242, 0]]);
  });
});
