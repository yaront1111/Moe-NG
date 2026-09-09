import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { readWorkClaimLedger } from "../work/work-claim-services.js";
import { AgentProcessContainmentError, AgentProcessFailureError } from "./agent-spawn-contract.js";
import type { SeatExitReading } from "./agent-spawn-contract.js";
import { createAgentWrapperStaffing } from "./agent-wrapper-staffing.js";
import { createAgentWrapper } from "./agent-wrapper.js";

describe("contained attempt failure recovery", () => {
  it.each([false, true])("retries without losing the attempt bound (always fails: %s)", async (alwaysFails) => {
    const sandbox = mkdtempSync(join(tmpdir(), "moe-wrapper-retry-"));
    const projectId = "proj-wrapper-retry";
    const credential = "wrapper-retry-operator";
    const storePath = join(sandbox, "store.db");
    const provider = createStoreDependencies({
      credential, principalId: "operator-local", projectId, storePath,
    });
    const reader = SqliteEventStore.openForProject(storePath, projectId);
    try {
      const affordances = provider.affordances?.();
      if (affordances === undefined) throw new Error("affordances unavailable");
      const counts = new Map<string, number>();
      let minted = 0;
      const wrapper = createAgentWrapper({
        affordances, claimTtlMs: 60_000, clock: () => Date.now(), deps: provider.provide(),
        maxAgents: 1, maxItemAttempts: 2,
        mintSecret: () => `retry-${String(++minted).padStart(6, "0")}${"0".repeat(28)}`,
        operatorCredential: credential,
        spawnAgent: async (request) => {
          const count = (counts.get(request.workItemId) ?? 0) + 1;
          counts.set(request.workItemId, count);
          return {
            exit: count === 1 || alwaysFails
              ? Promise.reject(new AgentProcessFailureError("EXIT_NONZERO", 1, null, ["failed attempt"]))
              : Promise.resolve(),
            ok: true, pid: 909_090,
          };
        },
      });
      const first = await wrapper.runOnce();
      expect(first.spawned[0]?.outcome).toBe("SPAWNED");
      await expect(wrapper.settle()).resolves.toBeUndefined();
      const seat = first.spawned[0];
      expect(readWorkClaimLedger(reader, projectId).claims.get(seat!.workItemId)?.status).toBe("RELEASED");
      expect(readSessionLedger(reader, projectId).sessions.get(seat!.sessionId!)?.status).toBe("CLOSED");

      const retry = await wrapper.runOnce();
      expect(retry.surfaceOutcome).toBe("SURFACE");
      expect(retry.spawned[0]).toMatchObject({ outcome: "SPAWNED", workItemId: seat!.workItemId });
      await expect(wrapper.settle()).resolves.toBeUndefined();
      expect(counts.get(seat!.workItemId)).toBe(2);

      const exhausted = await wrapper.runOnce();
      expect(exhausted.spawned).toContainEqual({
        kind: seat!.kind, outcome: "STAFFING_ATTEMPTS_EXHAUSTED", refusal: null,
        sessionId: null, workItemId: seat!.workItemId,
      });
      expect(counts.get(seat!.workItemId)).toBe(2);
      await wrapper.settle();
    } finally {
      reader.close();
      provider.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it.each([
    ["containment", new AgentProcessContainmentError("CLOSE_NOT_OBSERVED"), "PROVIDER_LIMIT", []],
    ["unknown child failure", new Error("UNKNOWN_CHILD_FAILURE"), "PROVIDER_LIMIT", []],
    ["cleanup", new AgentProcessFailureError("EXIT_NONZERO", 1, null), "FAILED",
      [new Error("AGENT_CLEANUP_FAILED:work.release:EXPECTED_VERSION_CONFLICT")]],
  ] as const)("retains %s failure as a permanent staffing stop", async (_name, error, reading, cleanup) => {
    const staffing = createAgentWrapperStaffing(undefined);
    let cleanups = 0;
    const started = await staffing.start({
      claimAggregateVersion: 1,
      cleanupAuthority: () => { cleanups += 1; return cleanup; },
      kind: "project.register", onExit: (): SeatExitReading => reading,
      request: {
        credential: "agent", expiresAt: "2099-01-01T00:00:00.000Z", kind: "project.register",
        mission: "work", sessionId: "session", workItemId: "work", workspace: null,
      },
      sessionId: "session", spawnAgent: async () => ({ exit: Promise.reject(error), ok: true, pid: 90 }),
      workItemId: "work",
    });
    expect(started.outcome).toBe("SPAWNED");
    const fatal = cleanup[0]?.message ?? error.message;
    await expect(staffing.settle()).rejects.toThrow(fatal);
    expect(staffing.failureOutcome()).toBe(fatal);
    expect(staffing.activeCount()).toBe(0);
    expect(cleanups).toBe(1);
  });
});
