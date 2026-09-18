import { describe, expect, it } from "vitest";

import { AgentProcessFailureError } from "./agent-spawn-contract.js";
import type { SeatExitReport } from "./agent-spawn-contract.js";
import { createAgentWrapperStaffing } from "./agent-wrapper-staffing.js";

/**
 * THE ORDER staffing drives the keepalive in. Started only once an admitted child exists;
 * stopped BEFORE the exit path's release, on the resolved and the rejected lifetime alike;
 * never started for a spawn that was refused or threw. A journal of every call, in order, is
 * the assertion: a refactor that moved `stop` after `cleanupAuthority` would show up as a
 * reordered journal, not as a flaky renewal in production.
 */

const REQUEST = {
  credential: "agent-secret-0001", expiresAt: "2026-09-18T00:00:00.000Z", kind: "project.register",
  mission: "dispatch it", sessionId: "sess-1", workItemId: "item-7", workspace: null,
} as const;

function deferred(): {
  promise: Promise<SeatExitReport | void>;
  reject: (error: unknown) => void;
  resolve: (value?: SeatExitReport) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value?: SeatExitReport) => void;
  const promise = new Promise<SeatExitReport | void>((res, rej) => {
    reject = rej;
    resolve = res;
  });
  return { promise, reject, resolve };
}

function journaled(exit: Promise<SeatExitReport | void>, spawnOk = true) {
  const journal: string[] = [];
  const staffing = createAgentWrapperStaffing(undefined);
  const start = staffing.start({
    claimAggregateVersion: 1,
    cleanupAuthority: (released) => { journal.push(`cleanup(${String(released)})`); return []; },
    keepalive: {
      start: () => { journal.push("keepalive.start"); },
      stop: () => { journal.push("keepalive.stop"); },
    },
    kind: "project.register",
    onExit: () => { journal.push("onExit"); return "FAILED"; },
    request: REQUEST,
    sessionId: "sess-1",
    spawnAgent: async () => {
      journal.push("spawn");
      return spawnOk
        ? { exit, ok: true as const, pid: 909_090 }
        : { code: "AGENT_SPAWNER_CLOSED", layer: "AGENT_SPAWNER", ok: false as const } as never;
    },
    workItemId: "item-7",
  });
  return { journal, staffing, start };
}

describe("staffing drives the claim keepalive", () => {
  it("starts it once the child exists and stops it before the release on a clean exit", async () => {
    const exit = deferred();
    const { journal, staffing, start } = journaled(exit.promise);
    expect((await start).outcome).toBe("SPAWNED");
    expect(journal).toEqual(["spawn", "keepalive.start"]);

    exit.resolve();
    await staffing.settle();
    expect(journal).toEqual(["spawn", "keepalive.start", "keepalive.stop", "onExit", "cleanup(true)"]);
  });

  it("stops it before the release on a failed exit too", async () => {
    const exit = deferred();
    const { journal, staffing, start } = journaled(exit.promise);
    expect((await start).outcome).toBe("SPAWNED");

    exit.reject(new AgentProcessFailureError("EXIT_NONZERO", 1, null));
    await staffing.settle();
    expect(journal).toEqual(["spawn", "keepalive.start", "keepalive.stop", "onExit", "cleanup(true)"]);
  });

  it("never starts it for a refused spawn", async () => {
    const { journal, start } = journaled(Promise.resolve(), false);
    expect((await start).outcome).toBe("AGENT_SPAWNER_CLOSED");
    expect(journal).toEqual(["spawn", "cleanup(true)"]);
  });

  it("stops it in order even when the child is already gone by the time it was started", async () => {
    // An instant exit: the lifetime settles before the staffing report reaches its caller.
    const { journal, staffing, start } = journaled(Promise.resolve());
    expect((await start).outcome).toBe("SPAWNED");
    await staffing.settle();
    expect(journal).toEqual(["spawn", "keepalive.start", "keepalive.stop", "onExit", "cleanup(true)"]);
  });
});
