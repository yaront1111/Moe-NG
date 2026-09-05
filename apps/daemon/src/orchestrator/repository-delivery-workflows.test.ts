import { describe, expect, it, vi } from "vitest";
import type { RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { createRepositoryDeliveryCoordinator } from "./repository-delivery-coordinator.js";

describe("repository workflow ownership", () => {
  it.each(["publish:decision-a", "criterion:v1:run-a"])("does not adopt or advance the %s owner", async (nodeRef) => {
    const handle: RepositoryExecutionHandle = {
      owner: { projectId: "project", nodeRef, ownershipToken: "a".repeat(64), storeId: "store" },
      reservation: { projectId: "project", nodeRef, storeId: "store", revision: 7,
        identity: { root: "repository", gitDirectory: "repository/.git" }, phase: "RESERVED",
        controllerId: "other-workflow", controllerPid: 123, baselineId: null, sessionId: null, pid: null },
    };
    const failure = { ok: false as const, code: "REPOSITORY_EXECUTION_BUSY" as const, detail: "busy" };
    const port: RepositoryExecutionPort = {
      acquire: vi.fn(() => failure), inspect: vi.fn(() => ({ ok: true as const, reservation: handle.reservation })),
      readOwned: vi.fn(() => ({ ok: true as const, handle })), claimController: vi.fn(() => ({ ok: true as const, handle })),
      transition: vi.fn(() => failure), release: vi.fn(() => failure),
    };
    const baseline = vi.fn(async () => "baseline"); const verify = vi.fn(async () => {}); const land = vi.fn(async () => {});
    const coordinator = createRepositoryDeliveryCoordinator({ port, projectId: "project", storeId: "store",
      controller: { controllerId: "node-controller", controllerPid: 456 }, isProcessAlive: () => false,
      facts: () => "LANDED", retired: () => true, workspaces: () => ["repository"], baseline, verify, land });
    await coordinator.advance();
    expect(port.claimController).not.toHaveBeenCalled();
    expect(port.transition).not.toHaveBeenCalled(); expect(port.release).not.toHaveBeenCalled();
    const spawn = vi.fn(async () => ({ ok: true as const, pid: 789, exit: Promise.resolve() }));
    expect(await coordinator.start({ credential: "seat", expiresAt: "2026-09-07T00:00:00Z", kind: "node.deliver",
      mission: "work", sessionId: "session", workItemId: "node.deliver@node-a", workspace: "repository" }, spawn))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
    expect(spawn).not.toHaveBeenCalled(); expect(baseline).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled(); expect(land).not.toHaveBeenCalled();
  });
});
