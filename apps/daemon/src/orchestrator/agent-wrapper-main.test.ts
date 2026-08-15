import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createWrapperStopSignal,
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
