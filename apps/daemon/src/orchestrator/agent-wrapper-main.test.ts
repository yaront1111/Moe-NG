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

  it("a `stop` line on a piped stdin requests the same shutdown, once, and nothing else does", async () => {
    // `moe up` cannot deliver Ctrl-C to a windowless child and its kill() is TerminateProcess,
    // which skips the exit path that retires the seats; the supervisor asks over the pipe.
    const stdin = new EventEmitter() as EventEmitter & { isTTY?: boolean; unref: () => void };
    const unref = vi.fn();
    stdin.unref = unref;
    const source = Object.assign(new EventEmitter(), { stdin });
    const onRequest = vi.fn();
    const stop = createWrapperStopSignal(source, onRequest);
    expect(unref).toHaveBeenCalledTimes(1);

    stdin.emit("data", Buffer.from("status\n"));
    stdin.emit("data", "sto");
    expect(stop.requested()).toBe(false);
    stdin.emit("data", "p\r\n");
    await expect(stop.wait()).resolves.toBeUndefined();
    expect(onRequest).toHaveBeenCalledTimes(1);
    stdin.emit("data", "stop\n");
    expect(onRequest).toHaveBeenCalledTimes(1);

    stop.close();
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("leaves a TTY stdin and a missing stdin alone", () => {
    const tty = Object.assign(new EventEmitter(), { isTTY: true, unref: vi.fn() });
    const withTty = Object.assign(new EventEmitter(), { stdin: tty });
    createWrapperStopSignal(withTty, vi.fn());
    expect(tty.listenerCount("data")).toBe(0);
    expect(tty.unref).not.toHaveBeenCalled();
    const bare = Object.assign(new EventEmitter(), { stdin: null });
    expect(createWrapperStopSignal(bare, vi.fn()).requested()).toBe(false);
  });
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
  const fenceConstruction = (source: string): string => {
    const marker = "const staffingFence = createAgentSessionFence({";
    expect(source.split(marker)).toHaveLength(2);
    const start = source.indexOf(marker);
    const end = source.indexOf("    });", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(start).toBeLessThan(source.indexOf("createRepositoryDeliveryRuntime({"));
    expect(start).toBeLessThan(source.indexOf("createAgentWrapper({"));
    return source.slice(start, end);
  };
  const assertStaffingWiring = (source: string): void => {
    expect(wrapperCall(source)).toMatch(/^\s+staffingFence,\r?$/mu);
    const construction = fenceConstruction(source);
    expect(construction).toContain("isProcessAlive: probeProcessAlive");
    expect(construction).toContain("projectId: config.projectId");
    expect(construction).toContain("store: verifierStore");
    const start = source.indexOf("createRepositoryDeliveryRuntime({");
    const end = source.indexOf("    });", start);
    expect(source.slice(start, end)).toContain("fence: staffingFence");
  };

  it("passes a staffingFence in the production createAgentWrapper call", () => {
    expect(wrapperCall(SOURCE)).toMatch(/^\s+staffingFence,\r?$/mu);
  });

  it("builds that fence from the real store and the real liveness probe", () => {
    // The same constructed fence now serves staffing and repository delivery.
    assertStaffingWiring(SOURCE);
  });

  it.each([
    ["wrapper injection", "      staffingFence,", "      staffingFence: undefined,"],
    ["constructor", "const staffingFence = createAgentSessionFence({", "const unusedFence = createAgentSessionFence({"],
    ["liveness witness", "isProcessAlive: probeProcessAlive", "isProcessAlive: () => false"],
    ["store witness", "isProcessAlive: probeProcessAlive, projectId: config.projectId, store: verifierStore,",
      "isProcessAlive: probeProcessAlive, projectId: config.projectId, store: undefined,"],
    ["repository injection", "fence: staffingFence", "fence: undefined"],
  ])("rejects removal of the %s (positive control)", (_name, from, to) => {
    const unwired = SOURCE.replace(from, to);
    expect(unwired).not.toBe(SOURCE);
    expect(() => assertStaffingWiring(unwired)).toThrow();
  });

  it("passes a providerPause built from the real store in the production call", () => {
    // Pins WHAT is injected, not merely that the key is present: a `providerPause: undefined`
    // leaves the binary exactly as unable to survive a provider limit as before this row.
    const call = wrapperCall(SOURCE);
    expect(call).toContain("providerPause: createProviderPauseGate({");
    const start = call.indexOf("providerPause: createProviderPauseGate({");
    const block = call.slice(start, call.indexOf("      }),", start));
    expect(block).toContain("store: verifierStore");
    expect(block).toContain("providerFor(process.env[\"MOE_AGENT_COMMAND\"]");
    // The seat-exit scrub list: every credential value in THIS process's environment - the same
    // values the spawner forwards to every seat. A `() => []` here would write echoed keys durably.
    expect(block).toContain("secrets: () => credentialValues(process.env)");
    expect(call).not.toContain("providerPause: undefined");
  });

  it("scans a providerPause slice that can actually fail (positive control)", () => {
    const unwired = SOURCE.replace(/providerPause: createProviderPauseGate\(\{/, "");
    expect(() =>
      expect(wrapperCall(unwired)).toContain("providerPause: createProviderPauseGate({"))
      .toThrow();
  });

  // The two compiler-lane closures MOVED to ./wrapper-mission-inputs.ts when the design edge was
  // threaded: this file stood at exactly the 400-line split threshold and could not take the
  // wiring line. The claims below did not change, only where each half is measured — the binary
  // is still asserted to WIRE them, and the composition is still asserted to be the right one.
  const INPUTS = readFileSync(
    new URL("./wrapper-mission-inputs.ts", import.meta.url), "utf8",
  );

  it("wires both compiler-lane mission inputs from the real store in the production call", () => {
    const call = wrapperCall(SOURCE);
    expect(call).toContain("compilerGateRef: missionInputs.compilerGateRef,");
    expect(call).toContain("compilerInstructions: missionInputs.compilerInstructions,");
    expect(call).not.toContain("compilerInstructions: undefined");
    // The factory is built from the REAL store, not from a placeholder.
    const built = SOURCE.slice(SOURCE.indexOf("const missionInputs = createCompilerMissionInputs({"));
    expect(built.slice(0, built.indexOf("});"))).toContain("store: verifierStore");
  });

  it("composes the operator's rejection reason into compilerInstructions", () => {
    // The composer is unit-tested to death next door, but "the composer works" and "the binary
    // calls it" are separate claims. Before this pin, `compilerInstructions` answered the goal's
    // catalog brief and nothing else, so a re-staffed compiler seat received a mission byte-
    // identical to the one whose plan had just been rejected.
    expect(INPUTS).toContain("compilerInstructions: (goalId) =>");
    // EXACTLY ONCE: two call sites would mean one of them is dead, and a `toContain` cannot tell.
    expect(INPUTS.split("composeCompilerInstructions(brief, latestRejectionReason(").length - 1)
      .toBe(1);
    // Pins the ARGUMENTS, not merely the call: `latestRejectionReason(store, projectId, <the
    // GOAL id>)` would walk an aggregate that has no run history and answer null forever, while
    // every assertion that only looked for the call name stayed green.
    expect(INPUTS).toContain("laneStore, config.projectId, refsOfGoal(goalId).planningRunRef,");
  });

  it("scans a compilerInstructions slice that can actually fail (positive control)", () => {
    const unwired = INPUTS.replace("composeCompilerInstructions(brief, latestRejectionReason(", "");
    expect(unwired).not.toBe(INPUTS);
    expect(() => expect(unwired)
      .toContain("composeCompilerInstructions(brief, latestRejectionReason(")).toThrow();
  });

  it("supplies designBrief from the real store, so a seat reads its goal's actual design", () => {
    // THE DEFECT THIS ROW CLOSED. `designBrief` was declared on AgentWrapperConfig and consumed
    // at two call sites, and no caller ever supplied it — so every live compiler seat evaluated
    // `undefined ?? null` and was told "NO DESIGN ACCOMPANIES THIS BRIEF" over a goal whose
    // design was durably present. `wrapper-mission-inputs.test.ts` proves the resolver's
    // BEHAVIOUR against a real store; this arm proves the binary actually passes it.
    const call = wrapperCall(SOURCE);
    expect(call).toContain("designBrief: createDesignBriefResolver({");
    expect(call).not.toContain("designBrief: undefined");
    const start = call.indexOf("designBrief: createDesignBriefResolver({");
    const block = call.slice(start, call.indexOf("      }),", start));
    expect(block).toContain("store: verifierStore");
    expect(block).toContain("projectId: config.projectId");
  });

  it("scans a designBrief slice that can actually fail (positive control)", () => {
    const unwired = SOURCE.replace("designBrief: createDesignBriefResolver({", "");
    expect(unwired).not.toBe(SOURCE);
    expect(() => expect(wrapperCall(unwired))
      .toContain("designBrief: createDesignBriefResolver({")).toThrow();
  });

  it("passes the wrapper the STAFFING VIEW of the offer surface, never the raw port", () => {
    // `affordances,` sat BETWEEN the two moved closures; the extraction that made room for
    // designBrief deleted it once. An unwired offer surface staffs nothing at all -- and the RAW
    // port staffs too much: over it the binary spawned claude seats on the activation chain and
    // on plan.propose@run-live-1 (measured 2026-09-13, agent-staffing-surface.ts). The view's
    // BEHAVIOUR is proven next door; this arm proves the binary actually hands it over.
    const call = wrapperCall(SOURCE);
    expect(call).toMatch(/^\s+affordances: staffingSurfaceOf\(affordances\),\r?$/mu);
    expect(call).not.toMatch(/^\s+affordances,\r?$/mu);
  });

  it("hands the MCP host the RAW surface: the view is the wrapper's read, not the seats'", () => {
    const start = SOURCE.indexOf("createMcpHttpHost({");
    expect(start).toBeGreaterThan(-1);
    const host = SOURCE.slice(start, SOURCE.indexOf("    });", start));
    expect(host).toMatch(/^\s+affordances,\r?$/mu);
    expect(host).not.toContain("staffingSurfaceOf(");
  });

  it("scans a staffing-view slice that can actually fail (positive control)", () => {
    const unwired = SOURCE.replace("affordances: staffingSurfaceOf(affordances),", "affordances,");
    expect(unwired).not.toBe(SOURCE);
    expect(() => expect(wrapperCall(unwired))
      .toMatch(/^\s+affordances: staffingSurfaceOf\(affordances\),\r?$/mu)).toThrow();
  });

  it("contains a rejected staffing pass in loop mode: says so and takes the next interval", () => {
    // A DurableStoreError STORE_BUSY (a concurrent daemon commit during a ledger walk) rejected
    // runOnce; uncaught at the loop's own call it reached main().catch, whose finally tree-killed
    // every live seat and exited 1 (measured 2026-09-13). The wrapper contains its reads by code
    // now; this is the last line, pinned on the LOOP's call so a catch elsewhere cannot satisfy
    // it. A single MOE_WRAPPER_ONCE pass still fails loudly.
    const loop = SOURCE.slice(SOURCE.indexOf("for (;;) {"), SOURCE.indexOf("if (once) {"));
    expect(loop).toContain("wrapper.runOnce().catch(");
    expect(loop).toContain("[wrapper] pass failed:");
    expect(loop).toContain("if (once) throw error;");
  });

  it("scans a pass-containment slice that can actually fail (positive control)", () => {
    const bare = SOURCE.replace("wrapper.runOnce().catch(", "wrapper.runOnce().then(");
    expect(bare).not.toBe(SOURCE);
    const loop = bare.slice(bare.indexOf("for (;;) {"), bare.indexOf("if (once) {"));
    expect(() => expect(loop).toContain("wrapper.runOnce().catch(")).toThrow();
  });

  /**
   * THE COMMAND PLANE. `agent-wrapper-command-plane.test.ts` proves the plane-following value
   * WORKS over the shipped composition; these arms prove the binary PASSES it. Before this row
   * every `deps:` in the binary was a `provider.provide()` captured at start, and the seats'
   * host got neither plane reader nor /2 deps, so after `cutover.activate` the wrapper's own
   * session.open and every seat command answered V1_AUTHORITY_RETIRED.
   */
  const hostCall = (source: string): string => {
    const start = source.indexOf("createMcpHttpHost({");
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("    });", start));
  };
  const sliceOf = (source: string, marker: string, end: string): string => {
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf(end, start));
  };
  const assertPlaneWiring = (source: string): void => {
    // ONE /1 capture, feeding the plane-following value and the host; nothing else holds it.
    expect(source.split("provider.provide()").length - 1).toBe(1);
    expect(source).toContain("const v1Deps = provider.provide();");
    expect(source).toContain(
      "const deps = createPlaneFollowingDeps({ commandAuthorityPlane, deps: v1Deps, v2Deps });",
    );
    // The wrapper's own dispatches, the boot reclaim and the verifier all follow the plane.
    expect(wrapperCall(source)).toMatch(/^\s+deps,\r?$/mu);
    expect(sliceOf(source, "runReclaimPass({", "});")).toContain(" deps, ");
    expect(sliceOf(source, "verifier: {", "      },")).toContain(" deps, ");
    // The seats' host gets both planes and the reader, the shape mcp-http-main.ts passes.
    const host = hostCall(source);
    expect(host).toMatch(/^\s+commandAuthorityPlane,\r?$/mu);
    expect(host).toMatch(/^\s+v2Deps,\r?$/mu);
    expect(host).toContain("deps: v1Deps,");
  };

  it("builds one plane-following deps value from both shipped planes and hands it to every dispatcher", () => {
    assertPlaneWiring(SOURCE);
  });

  it.each([
    ["host plane reader", "      commandAuthorityPlane,\n", ""],
    ["host /2 deps", "      v2Deps,\n    });\n    const mcpStarted", "    });\n    const mcpStarted"],
    ["wrapper deps", "      deps,\n      maxAgents: knobs.maxAgents,", "      deps: v1Deps,\n      maxAgents: knobs.maxAgents,"],
    ["reclaim deps", "clock: () => Date.now(), deps, isProcessAlive", "clock: () => Date.now(), deps: v1Deps, isProcessAlive"],
    ["verifier deps", "        deps, mintId:", "        deps: v1Deps, mintId:"],
    ["plane-following construction", "createPlaneFollowingDeps({ commandAuthorityPlane, deps: v1Deps, v2Deps })", "v1Deps"],
  ])("rejects a binary that pins the %s to /1 (positive control)", (_name, from, to) => {
    const normalised = SOURCE.replaceAll("\r\n", "\n");
    const pinned = normalised.replace(from, to);
    expect(pinned).not.toBe(normalised);
    expect(() => assertPlaneWiring(pinned)).toThrow();

  // The per-pass log MOVED to ./wrapper-pass-log.ts to bring this file under the 400-line split
  // rail. The paused-line claim did not change, only where it is measured; the binary is still
  // asserted to route every pass report through that logger and nothing else.
  const PASS_LOG = readFileSync(
    new URL("./wrapper-pass-log.ts", import.meta.url), "utf8",
  );

  it("tells the operator which provider is paused and until when", () => {
    // The wrapper log is the operator's only view of a paused fleet; a paused pass that
    // printed the ordinary idle line would read as "nothing to do", not "parked".
    expect(PASS_LOG).toContain("[wrapper] provider paused:");
  });

  it("routes every pass report through the extracted logger, over the real stdout", () => {
    expect(SOURCE).toContain("const logPass = createPassLogger((line) => { process.stdout.write(line); });");
    expect(SOURCE.split("logPass(report);").length - 1).toBe(1);
    // The loop's own copy is gone: a second printer beside the logger would double every line.
    expect(SOURCE).not.toContain("for (const entry of report.spawned)");
    expect(SOURCE).not.toContain("lastIdle");
  });

  it("scans a logger slice that can actually fail (positive control)", () => {
    const unwired = SOURCE.replace("logPass(report);", "");
    expect(unwired).not.toBe(SOURCE);
    expect(() => expect(unwired.split("logPass(report);").length - 1).toBe(1)).toThrow();
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
