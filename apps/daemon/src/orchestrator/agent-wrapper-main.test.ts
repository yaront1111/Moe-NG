import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentSessionFence } from "./agent-session-fence.js";
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

  it("announces incomplete standing verifier authority at startup, from the real store", () => {
    // The per-node VERIFICATION_AUTHORITY_UNAVAILABLE verdict only prints after a delivery;
    // the first real project sat silent for days. The preflight must read the store, not a
    // constant, and name both slices.
    expect(SOURCE).toContain("readVerifierStandingAuthority(verifierStore, config.projectId)");
    expect(SOURCE).toContain("standing authority incomplete:");
    expect(SOURCE).toContain("moe-verifier-policy/1");
    expect(SOURCE).toContain("moe-reviewer-calibration/1");
  });

  it("scans the preflight slice that can actually fail (positive control)", () => {
    const silent = SOURCE.replace("readVerifierStandingAuthority(verifierStore, config.projectId)", "");
    expect(() => expect(silent).toContain("readVerifierStandingAuthority(verifierStore, config.projectId)"))
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

/**
 * The wrapper's ONE store handle serves BOTH the staffing fence and the node
 * verifier (see the comment above the open site). Opened UNASSERTED, every
 * durable write through it refuses PROJECT_SCOPE_REQUIRED, so a MOE_WRAPPER_ONCE
 * pass ends `AGENT_STAFFING_RECORD_FAILED:PROJECT_SCOPE_REQUIRED` and no node can
 * reach COMMITTED. These cases pin the ABSENCE of that code on the fixed handle
 * — and, because an absence assertion is one layer away from vacuous, they pair
 * it with the positive control (the code IS reachable on the old handle) and
 * with the positive staffing row.
 */
describe("wrapper staffing handle is project-asserted", () => {
  const PROJECT = "proj-wrapper-scope";
  const ITEM = "work-item-scope-1";
  const roots: string[] = [];
  const stores: SqliteEventStore[] = [];

  afterEach(() => {
    while (stores.length > 0) stores.pop()?.close();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
    }
  });

  /** Opened inside a case, never in a describe body: a held handle kills the worker. */
  const scratchPath = (label: string): string => {
    const root = mkdtempSync(join(tmpdir(), `moe-wrapper-scope-${label}-`));
    roots.push(root);
    return join(root, "project.db");
  };

  const track = (store: SqliteEventStore): SqliteEventStore => {
    stores.push(store);
    return store;
  };

  const recordThrough = (store: SqliteEventStore): readonly Error[] =>
    createAgentSessionFence({
      isProcessAlive: () => false, projectId: PROJECT, store,
    }).recordLiveChild({
      childPid: 4242, claimAggregateVersion: 0, sessionId: "sess-scope", workItemId: ITEM,
    });

  const staffingRows = (store: SqliteEventStore): readonly string[] => store
    .readEvents(`wrapper-staffing/${createHash("sha256").update(ITEM, "utf8").digest("hex")}`)
    .map((event) => event.eventType);

  it("commits the staffing record with no PROJECT_SCOPE_REQUIRED on the fixed handle", () => {
    const path = scratchPath("fixed");
    const store = track(SqliteEventStore.openForProject(path, PROJECT));

    const errors = recordThrough(store);

    // Absence, then the positive row: without the second assertion a fence that
    // silently wrote nothing would satisfy the first.
    expect(errors.map((error) => error.message)).toStrictEqual([]);
    expect(errors.some((error) => error.message.includes("PROJECT_SCOPE_REQUIRED"))).toBe(false);
    expect(staffingRows(store)).toStrictEqual(["AgentStaffingAdmitted"]);
  });

  it("POSITIVE CONTROL: the unasserted handle the wrapper used to open still refuses", () => {
    // `SqliteEventStore.open(config.storePath)` was the pre-fix call. If this
    // arm ever goes green, the absence assertion above stopped meaning anything.
    const path = scratchPath("unasserted");
    const store = track(SqliteEventStore.open(path));

    const errors = recordThrough(store);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("AGENT_STAFFING_RECORD_FAILED");
    expect(errors[0]?.message).toContain("PROJECT_SCOPE_REQUIRED");
    expect(staffingRows(store)).toStrictEqual([]);
  });

  it("opens the binary's own handle project-asserted, not bare", () => {
    // Behaviour above proves the FIX works; this pins that the BINARY uses it.
    const source = readFileSync(new URL("./agent-wrapper-main.ts", import.meta.url), "utf8");

    expect(source).toContain(
      "SqliteEventStore.openForProject(config.storePath, config.projectId)",
    );
    expect(source).not.toContain("SqliteEventStore.open(config.storePath)");
  });
});

/**
 * The boot-time reclaim has to run in the SHIPPED binary, exactly once, before
 * the first staffing pass. Both halves are load-bearing and neither is visible
 * to a behavioural test of the pass itself: a reclaim that never runs leaves the
 * 30-minute wait exactly as it was, and one that runs inside the interval loop
 * would fight the wrapper's own live children every tick.
 */
describe("wrapper binary reclaim wiring", () => {
  const SOURCE = readFileSync(
    new URL("./agent-wrapper-main.ts", import.meta.url), "utf8",
  );
  const reclaimCall = (source: string): string => {
    const start = source.indexOf("runReclaimPass({");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("});", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("runs the reclaim after the spawner is armed and before the interval loop", () => {
    const armed = SOURCE.indexOf("secureSpawn = agentSpawner;");
    const reclaim = SOURCE.indexOf("runReclaimPass({");
    const loop = SOURCE.indexOf("for (;;) {");
    expect(armed).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(-1);
    expect(reclaim).toBeGreaterThan(armed);
    expect(reclaim).toBeLessThan(loop);
  });

  it("calls it exactly once, so it can never be inside the loop", () => {
    expect(SOURCE.split("runReclaimPass(").length).toBe(2);
  });

  it("hands it the real store, the real probe and the operator credential", () => {
    // WHAT is injected, not merely that the call exists: a pass built over a
    // stub probe or a second store would report a clean board it never read.
    const call = reclaimCall(SOURCE);
    expect(call).toContain("isProcessAlive: probeProcessAlive");
    expect(call).toContain("store: verifierStore");
    expect(call).toContain("operatorCredential: config.credential");
    expect(call).toContain("projectId: config.projectId");
  });

  it("prints the pass summary even when it reclaimed nothing", () => {
    expect(SOURCE).toContain("[wrapper] reclaim pass:");
  });

  it("scans a slice that can actually fail (positive control)", () => {
    const stripped = SOURCE.replace("runReclaimPass({", "");
    expect(() => expect(stripped.split("runReclaimPass(").length).toBe(2)).toThrow();
  });
});
