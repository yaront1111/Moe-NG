import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { repositoryExecutionFailure } from "../repository/repository-execution-contracts.js";
import type { RepositoryExecutionHandle, RepositoryExecutionPhase, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { AgentProcessContainmentError } from "./agent-spawn-contract.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { createRepositoryDeliveryCoordinator } from "./repository-delivery-coordinator.js";
import type { RepositoryDeliveryConfig, RepositoryDeliveryFacts } from "./repository-delivery-contracts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const owner = { projectId: "project", storeId: "store", nodeRef: "node:scoped", ownershipToken: "a".repeat(64) };
const oldController = { controllerId: "old-controller", controllerPid: 100 };

function fixture(portOf: (actual: RepositoryExecutionPort) => RepositoryExecutionPort = (actual) => actual) {
  const workspace = mkdtempSync(join(tmpdir(), "moe-delivery-recovery-")); roots.push(workspace);
  execFileSync("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
  const actual = createRepositoryExecutionPort();
  const port = portOf(actual);
  let facts: RepositoryDeliveryFacts = "SUBMITTED";
  const live = new Set([100, 200]);
  const baseline = vi.fn(async () => "original-baseline");
  const verify = vi.fn(async () => { facts = "ACCEPTED"; });
  const land = vi.fn<RepositoryDeliveryConfig["land"]>(async (_nodeRef, _baselineId, root, handle) => {
    expect(actual.readOwned(root, owner.storeId, owner.projectId)).toEqual({ ok: true, handle });
    facts = "LANDED";
  });
  const coordinator = (controller = oldController) => createRepositoryDeliveryCoordinator({
    baseline, controller, facts: () => facts, isProcessAlive: (pid) => live.has(pid), land,
    port, projectId: owner.projectId, retired: () => true, storeId: owner.storeId, verify, workspaces: () => [workspace],
  });
  const request: SpawnRequest = { credential: "test-secret", expiresAt: "2026-09-06T00:00:00.000Z",
    kind: "node.deliver", mission: "build", sessionId: "seat", workItemId: `node.deliver@${owner.nodeRef}`, workspace };
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const exit = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const spawn = vi.fn(async (_request: SpawnRequest) => ({ ok: true as const, pid: 200, exit }));
  return { actual, port, workspace, coordinator, request, spawn, exit, finish, fail, live, baseline, verify, land,
    setFacts: (value: RepositoryDeliveryFacts) => { facts = value; } };
}

function seedPhase(f: ReturnType<typeof fixture>, phase: RepositoryExecutionPhase): RepositoryExecutionHandle {
  const acquired = f.actual.acquire(f.workspace, owner, oldController);
  if (!acquired.ok) throw new Error(acquired.code);
  let handle = acquired.handle;
  for (const nextPhase of ["EXECUTING", "VERIFYING", "AWAITING_LANDING", "LANDING"] as const) {
    const changed = f.actual.transition(f.workspace, owner, handle.reservation.revision, {
      ...oldController, phase: nextPhase, baselineId: "original-baseline", sessionId: "original-seat", pid: 200,
    });
    if (!changed.ok) throw new Error(changed.code);
    handle = changed.handle;
    if (nextPhase === phase) break;
  }
  f.live.delete(100);
  f.live.delete(200);
  return handle;
}

describe("repository delivery recovery", () => {
  it("passes the reserved checkout identity to every effect while preserving the child subdirectory", async () => {
    const f = fixture(); const coordinator = f.coordinator();
    const workspace = join(f.workspace, "package"); mkdirSync(workspace);
    const started = await coordinator.start({ ...f.request, workspace }, f.spawn);
    if (!started.ok) throw new Error(started.code);
    const executing = f.actual.readOwned(f.workspace, owner.storeId, owner.projectId);
    if (!executing.ok || executing.handle === null) throw new Error("owner missing");
    f.finish(); await started.exit;
    expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({ workspace });
    expect(f.baseline).toHaveBeenCalledExactlyOnceWith(owner.nodeRef, f.workspace);
    await coordinator.advance();
    expect(f.verify).toHaveBeenCalledExactlyOnceWith(owner.nodeRef, f.workspace);
    expect(f.land).toHaveBeenCalledExactlyOnceWith(owner.nodeRef, "original-baseline", f.workspace, {
      owner: executing.handle.owner,
      reservation: { ...executing.handle.reservation, phase: "LANDING", revision: executing.handle.reservation.revision + 3 },
    });
  });

  it("retries releasing a durable landing without repeating the Git effect", async () => {
    let releases = 0;
    const f = fixture((actual) => ({ ...actual, release: (...args) =>
      releases++ === 0 ? repositoryExecutionFailure("REPOSITORY_EXECUTION_BUSY") : actual.release(...args) }));
    const coordinator = f.coordinator();
    const started = await coordinator.start(f.request, f.spawn);
    if (!started.ok) throw new Error(started.code);
    f.finish(); await started.exit;
    await coordinator.advance();
    expect(f.actual.inspect(f.workspace)).toMatchObject({ reservation: { phase: "LANDING" } });
    await coordinator.advance();
    expect(f.actual.inspect(f.workspace)).toEqual({ ok: true, reservation: null });
    expect(f.land).toHaveBeenCalledOnce();
  });

  it("preserves a live startup lifetime when persisting its PID loses the compare-and-swap", async () => {
    const f = fixture((actual) => ({ ...actual, transition: (...args) => args[3].phase === "EXECUTING" && args[3].pid !== null
      ? repositoryExecutionFailure("REPOSITORY_EXECUTION_REVISION_CONFLICT") : actual.transition(...args) }));
    const started = await f.coordinator().start(f.request, f.spawn);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.code);
    const settled = vi.fn();
    void started.exit.catch(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    f.finish();
    await expect(started.exit).rejects.toThrow("REPOSITORY_EXECUTION_REVISION_CONFLICT");
    expect(f.actual.inspect(f.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  });

  it("persists unknown containment before an advance tick can be interrupted", async () => {
    const f = fixture();
    const started = await f.coordinator().start(f.request, f.spawn);
    if (!started.ok) throw new Error(started.code);
    f.fail(new AgentProcessContainmentError("TREE_KILL_FAILED"));
    await expect(started.exit).rejects.toThrow("AGENT_PROCESS_CONTAINMENT_FAILED");
    expect(f.actual.inspect(f.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  });

  it("keeps a local lifetime pending when its direct PID has died", async () => {
    const f = fixture(); const coordinator = f.coordinator();
    const started = await coordinator.start(f.request, f.spawn);
    if (!started.ok) throw new Error(started.code);
    f.live.delete(200);
    await coordinator.advance();
    expect(f.actual.inspect(f.workspace)).toMatchObject({ reservation: { phase: "EXECUTING" } });
    expect(f.verify).not.toHaveBeenCalled();
    f.finish(); await started.exit;
    await coordinator.advance();
    expect(f.land).toHaveBeenCalledOnce();
  });

  it("cannot block a replacement controller from an old lifetime callback", async () => {
    const f = fixture(); const started = await f.coordinator().start(f.request, f.spawn);
    if (!started.ok) throw new Error(started.code);
    const read = f.actual.readOwned(f.workspace, owner.storeId, owner.projectId);
    if (!read.ok || read.handle === null) throw new Error("owner missing");
    expect(f.actual.claimController(f.workspace, read.handle.owner, read.handle.reservation.revision,
      { controllerId: "replacement", controllerPid: 101 }).ok).toBe(true);
    f.fail(new AgentProcessContainmentError("TREE_KILL_FAILED"));
    await expect(started.exit).rejects.toThrow("AGENT_PROCESS_CONTAINMENT_FAILED");
    expect(f.actual.inspect(f.workspace)).toMatchObject({ reservation: { phase: "EXECUTING", controllerId: "replacement" } });
  });

  it("retries a known pre-effect refusal under the original baseline", async () => {
    const f = fixture(); const pending = seedPhase(f, "AWAITING_LANDING"); f.setFacts("ACCEPTED");
    f.land.mockResolvedValueOnce("RETRY");
    const controller = { controllerId: "replacement", controllerPid: 101 };
    const coordinator = f.coordinator(controller);
    await coordinator.advance();
    expect(f.actual.inspect(f.workspace)).toMatchObject({ reservation: { phase: "AWAITING_LANDING", baselineId: "original-baseline" } });
    await coordinator.advance();
    expect(f.actual.inspect(f.workspace)).toEqual({ ok: true, reservation: null });
    expect(f.land.mock.calls).toEqual([2, 4].map((revisionOffset) => [owner.nodeRef, "original-baseline", f.workspace, {
      owner: pending.owner,
      reservation: { ...pending.reservation, ...controller, phase: "LANDING", revision: pending.reservation.revision + revisionOffset },
    }]));
    expect(f.baseline).not.toHaveBeenCalled();
  });

  it("cannot infer recovered process containment from a dead PID when failure persistence was unavailable", async () => {
    let refuseBlock = true;
    const f = fixture((actual) => ({ ...actual, transition: (...args) => {
      if (refuseBlock && args[3].phase === "BLOCKED") {
        refuseBlock = false;
        return repositoryExecutionFailure("REPOSITORY_EXECUTION_BUSY");
      }
      return actual.transition(...args);
    } }));
    const started = await f.coordinator().start(f.request, f.spawn);
    if (!started.ok) throw new Error(started.code);
    f.fail(new AgentProcessContainmentError("TREE_KILL_FAILED"));
    await expect(started.exit).rejects.toThrow("AGENT_PROCESS_CONTAINMENT_FAILED");
    f.live.clear();
    await f.coordinator({ controllerId: "replacement", controllerPid: 101 }).advance();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.land).not.toHaveBeenCalled();
    expect(f.actual.inspect(f.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  });

  it("blocks a recovered verifier without re-running a possibly live verifier process", async () => {
    const f = fixture(); seedPhase(f, "VERIFYING");
    await f.coordinator({ controllerId: "replacement", controllerPid: 101 }).advance();
    expect(f.actual.inspect(f.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.land).not.toHaveBeenCalled();
  });

  it("blocks an interrupted landing without a durable committed receipt", async () => {
    const f = fixture(); seedPhase(f, "LANDING"); f.setFacts("ACCEPTED");
    await f.coordinator({ controllerId: "replacement", controllerPid: 101 }).advance();
    expect(f.actual.inspect(f.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
    expect(f.land).not.toHaveBeenCalled();
  });

  it("reconciles a recorded landing after controller death without duplicating the effect", async () => {
    const f = fixture(); seedPhase(f, "LANDING"); f.setFacts("LANDED");
    await f.coordinator({ controllerId: "replacement", controllerPid: 101 }).advance();
    expect(f.actual.inspect(f.workspace)).toEqual({ ok: true, reservation: null });
    expect(f.land).not.toHaveBeenCalled();
  });

  it("resumes an accepted pending landing under the original baseline after restart", async () => {
    const f = fixture(); const pending = seedPhase(f, "AWAITING_LANDING"); f.setFacts("ACCEPTED");
    const controller = { controllerId: "replacement", controllerPid: 101 };
    await f.coordinator(controller).advance();
    expect(f.actual.inspect(f.workspace)).toEqual({ ok: true, reservation: null });
    expect(f.land).toHaveBeenCalledExactlyOnceWith(owner.nodeRef, "original-baseline", f.workspace, {
      owner: pending.owner,
      reservation: { ...pending.reservation, ...controller, phase: "LANDING", revision: pending.reservation.revision + 2 },
    });
    expect(f.baseline).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });
});
