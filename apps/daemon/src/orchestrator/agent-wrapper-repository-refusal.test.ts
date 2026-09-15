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
      let now = Date.now();
      const wrapper = createAgentWrapper({ affordances, claimTtlMs: 60_000, clock: () => now,
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
        const mintsBeforeWaiting = minted;
        const claimBeforeWaiting = readWorkClaimLedger(reader, projectId).claims.get(workItemId);
        const waiting = await wrapper.runOnce();
        expect(waiting.spawned, "a repository refusal must not mint another identity on the next poll").toEqual([]);
        expect(waiting.repositoryWaiting).toEqual([{ code, retryAt: now + 15_000, workItemId }]);
        expect(minted).toBe(mintsBeforeWaiting);
        expect(readWorkClaimLedger(reader, projectId).claims.get(workItemId)).toEqual(claimBeforeWaiting);
        now += 15_000;
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

describe("repository admission before any durable step (addendum 2026-09-15)", () => {
  it("asks who holds the repository before opening a session or a claim", async () => {
    // UnAI: every retry while a sibling held the repository opened a session, claimed the node,
    // admitted staffing, then released and closed it again - 283 times, six events each.
    const sandbox = mkdtempSync(join(tmpdir(), "moe-wrapper-admission-"));
    const projectId = "project-repository-admission";
    const credential = "repository-admission-operator";
    const storePath = join(sandbox, "store.db");
    const provider = createStoreDependencies({ credential, principalId: "operator-local", projectId, storePath });
    const reader = SqliteEventStore.openForProject(storePath, projectId);
    try {
      const live = provider.affordances?.();
      if (live === undefined) throw new Error("affordances unavailable");
      const nodeRef = "node:v1:" + "c".repeat(64);
      const workItemId = `node.deliver@${nodeRef}`;
      const affordances: AffordancePort = { boundProjectId: projectId, readSurface: () => {
        const surface = live.readSurface();
        if (surface.outcome !== "SURFACE") return surface;
        const node: ChainStep = { aggregateId: nodeRef, claim: null, claimAggregateVersion: 0, kind: "node.deliver",
          missing: [], status: "READY", version: 1 };
        return { ...surface, steps: [node, ...surface.steps.filter((step) => step.kind.startsWith("session."))] };
      } };
      let minted = 0;
      let spawned = 0;
      const now = Date.now();
      const holder = "held by node uai-r2-evidence-runtime: it waits for your escalation decision in the control room";
      const wrapper = createAgentWrapper({ affordances, claimTtlMs: 60_000, clock: () => now,
        deps: provider.provide(), maxAgents: 1, maxItemAttempts: 1,
        mintSecret: () => `adm-${String(++minted).padStart(6, "0")}${"0".repeat(28)}`,
        nodeMission: () => ({ instructions: "build", test: "pnpm test", title: "Node", workspace: sandbox }),
        operatorCredential: credential,
        repositoryAdmission: (candidate, workspace) => candidate === nodeRef && workspace === sandbox
          ? deliveryRefusal("REPOSITORY_EXECUTION_BUSY", holder) : null,
        spawnAgent: async () => { spawned += 1; return { ok: true, pid: 909_091, exit: Promise.resolve() }; },
      });

      const report = await wrapper.runOnce();

      expect(report.spawned).toEqual([{ kind: "node.deliver", outcome: "REPOSITORY_EXECUTION_BUSY", sessionId: null, workItemId,
        refusal: { ok: false, code: "REPOSITORY_EXECUTION_BUSY", layer: "REPOSITORY_DELIVERY", detail: holder } }]);
      expect(minted).toBe(0);
      expect(spawned).toBe(0);
      expect(readWorkClaimLedger(reader, projectId).claims.get(workItemId)).toBeUndefined();
      expect([...readSessionLedger(reader, projectId).sessions.values()]).toEqual([]);
      const waiting = await wrapper.runOnce();
      expect(waiting.repositoryWaiting).toEqual([{ code: "REPOSITORY_EXECUTION_BUSY", detail: holder, retryAt: now + 15_000, workItemId }]);
    } finally {
      reader.close(); provider.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
