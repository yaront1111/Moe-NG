import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import type { AffordancePort, ChainStep } from "../http/affordance-contract.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { readWorkClaimLedger } from "../work/work-claim-services.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import { deliveryRefusal, REPOSITORY_DELIVERY_REFUSAL_CODES } from "./repository-delivery-contracts.js";

describe("repository admission refusal through the wrapper", () => {
  it("cleans each node identity and claim without spending attempts or poisoning later staffing", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "moe-wrapper-repository-"));
    const projectId = "project-repository-refusal";
    const credential = "repository-refusal-operator";
    const storePath = join(sandbox, "store.db");
    const provider = createStoreDependencies({ credential, principalId: "operator-local", projectId, storePath });
    const reader = SqliteEventStore.openForProject(storePath, projectId);
    try {
      const live = provider.affordances?.();
      if (live === undefined) throw new Error("affordances unavailable");
      const nodeRef = "node:v1:" + "b".repeat(64);
      const workItemId = `node.deliver@${nodeRef}`;
      const affordances: AffordancePort = { boundProjectId: projectId, readSurface: () => {
        const surface = live.readSurface();
        if (surface.outcome !== "SURFACE") return surface;
        const claim = readWorkClaimLedger(reader, projectId).claims.get(workItemId);
        const node: ChainStep = { aggregateId: nodeRef, claim: claim?.status === "OPEN"
          ? { claimedBy: claim.claimedBy, expiresAt: claim.expiresAt, version: claim.version } : null,
          claimAggregateVersion: claim?.version ?? 0, kind: "node.deliver", missing: [], status: "READY", version: 1 };
        return { ...surface, steps: [node, ...surface.steps.filter((step) => step.kind.startsWith("session."))] };
      } };
      let minted = 0;
      let attempted = 0;
      const wrapper = createAgentWrapper({ affordances, claimTtlMs: 60_000, clock: () => Date.now(),
        deps: provider.provide(), maxAgents: 1, maxItemAttempts: 1,
        mintSecret: () => `repo-${String(++minted).padStart(6, "0")}${"0".repeat(28)}`,
        nodeMission: () => ({ instructions: "build", test: "pnpm test", title: "Node", workspace: sandbox }),
        operatorCredential: credential,
        spawnAgent: async () => {
          const refusal = REPOSITORY_DELIVERY_REFUSAL_CODES[attempted++];
          return refusal === undefined ? { ok: true, pid: 909_090, exit: Promise.resolve() } : deliveryRefusal(refusal);
        },
      });
      for (const code of REPOSITORY_DELIVERY_REFUSAL_CODES) {
        const report = await wrapper.runOnce();
        expect(report.surfaceOutcome).toBe("SURFACE");
        expect(report.spawned).toHaveLength(1);
        const seat = report.spawned[0]!;
        expect(seat).toMatchObject({ kind: "node.deliver", outcome: code, workItemId,
          refusal: { code, layer: "REPOSITORY_DELIVERY" } });
        await expect(wrapper.settle()).resolves.toBeUndefined();
        expect(wrapper.activeCount()).toBe(0);
        expect(readWorkClaimLedger(reader, projectId).claims.get(workItemId)?.status).toBe("RELEASED");
        expect(readSessionLedger(reader, projectId).sessions.get(seat.sessionId!)?.status).toBe("CLOSED");
      }
      const accepted = await wrapper.runOnce();
      expect(accepted.spawned[0]).toMatchObject({ outcome: "SPAWNED", workItemId });
      await wrapper.settle();
      const exhausted = await wrapper.runOnce();
      expect(exhausted.spawned[0]).toMatchObject({ outcome: "STAFFING_ATTEMPTS_EXHAUSTED", workItemId });
      expect(attempted).toBe(REPOSITORY_DELIVERY_REFUSAL_CODES.length + 1);
    } finally {
      reader.close(); provider.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
