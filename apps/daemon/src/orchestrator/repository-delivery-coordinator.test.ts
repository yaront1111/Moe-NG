import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import type { RepositoryExecutionPort, RepositoryExecutionReleaseReason } from "../repository/repository-execution-contracts.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { AgentProcessContainmentError, AgentProcessFailureError } from "./agent-spawn-contract.js";
import { createRepositoryDeliveryCoordinator } from "./repository-delivery-coordinator.js";
import type { RepositoryDeliveryFacts } from "./repository-delivery-contracts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-delivery-coordinator-"))); roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  return root;
}
function request(workspace: string, nodeRef = "node-a"): SpawnRequest {
  return { credential: "secret", expiresAt: "2026-09-06T00:00:00.000Z", kind: "node.deliver",
    mission: "implement", sessionId: `session-${nodeRef}`, workItemId: `node.deliver@${nodeRef}`, workspace };
}
function fixture(workspace = repository(), controllerId = "controller-a", controllerPid = 101) {
  const port = createRepositoryExecutionPort();
  // The real port does the work; the wrapper only records the REASON, which the port does not keep.
  const releases: RepositoryExecutionReleaseReason[] = [];
  const recording: RepositoryExecutionPort = { ...port, release(root, owner, revision, reason, controller) {
    releases.push(reason); return port.release(root, owner, revision, reason, controller);
  } };
  let facts: RepositoryDeliveryFacts = "READY";
  let retired = false;
  const live = new Set([101, 102, 201]);
  const baseline = vi.fn(async () => "baseline-original");
  const verify = vi.fn(async () => { facts = "ACCEPTED"; });
  const land = vi.fn(async () => { facts = "LANDED"; });
  const coordinator = createRepositoryDeliveryCoordinator({ baseline, controller: { controllerId, controllerPid },
    facts: () => facts, isProcessAlive: (pid: number) => live.has(pid), land, port: recording, projectId: "project-a",
    retired: () => retired, storeId: "store-a", verify, workspaces: () => [workspace] });
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const exit = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const spawn = vi.fn(async () => ({ ok: true as const, pid: 201, exit }));
  return { baseline, coordinator, exit, fail, finish, land, live, port, releases, spawn, verify, workspace,
    setFacts: (value: RepositoryDeliveryFacts) => { facts = value; }, retire: () => { retired = true; live.delete(201); } };
}

describe("repository delivery lifetime", () => {
  it("holds one checkout through live submission, verification and durable landing", async () => {
    const f = fixture(); const started = await f.coordinator.start(request(f.workspace), f.spawn);
    expect(started.ok).toBe(true);
    f.setFacts("SUBMITTED");
    await f.coordinator.advance();
    expect(f.verify).not.toHaveBeenCalled();
    expect(await f.coordinator.start(request(f.workspace, "node-b"), f.spawn))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY", layer: "REPOSITORY_DELIVERY" });
    f.finish(); await f.exit;
    await f.coordinator.advance();
    expect(f.verify).not.toHaveBeenCalled(); // process exit is insufficient until authority is retired
    f.retire(); await f.coordinator.advance();
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.land).toHaveBeenCalledWith("node-a", "baseline-original", f.workspace, expect.objectContaining({
      owner: expect.objectContaining({ nodeRef: "node-a" }),
      reservation: expect.objectContaining({ phase: "LANDING", baselineId: "baseline-original", controllerId: "controller-a" }),
    }));
    expect(f.port.inspect(f.workspace)).toEqual({ ok: true, reservation: null });
  }, 120_000);

  it("reuses the first baseline across a contained failed attempt", async () => {
    const f = fixture(); const started = await f.coordinator.start(request(f.workspace), f.spawn);
    if (!started.ok) throw new Error(started.code);
    f.fail(new AgentProcessFailureError("EXIT_NONZERO", 1, null));
    await expect(started.exit).rejects.toThrow("AGENT_PROCESS_FAILED");
    f.retire(); await f.coordinator.advance();
    expect(f.port.inspect(f.workspace)).toMatchObject({ reservation: { phase: "RESERVED", baselineId: "baseline-original" } });
    f.spawn.mockResolvedValueOnce({ ok: true, pid: 201, exit: Promise.resolve() });
    const retry = await f.coordinator.start({ ...request(f.workspace), sessionId: "session-retry" }, f.spawn);
    if (!retry.ok) throw new Error(retry.code);
    await retry.exit;
    expect(f.baseline).toHaveBeenCalledOnce();
  }, 120_000);

  it("blocks accepted work when landing has no durable outcome", async () => {
    const f = fixture(); f.land.mockImplementation(async () => {});
    await f.coordinator.start(request(f.workspace), f.spawn);
    f.setFacts("ACCEPTED"); f.finish(); await f.exit; f.retire();
    await f.coordinator.advance();
    expect(f.port.inspect(f.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
    expect(await f.coordinator.start(request(f.workspace, "node-b"), f.spawn)).toMatchObject({ ok: false });
    f.setFacts("REFUSED"); await f.coordinator.advance();
    expect(f.port.inspect(f.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  }, 120_000);

  // DoD 1, against the REAL port. The reason is asserted, not just the absence of a refusal:
  // a second start could succeed for reasons that have nothing to do with this release.
  it("releases the checkout with LANDED_NOTHING when the landing refused before journaling anything", async () => {
    const f = fixture(); f.land.mockImplementation(async () => { f.setFacts("REFUSED_NO_EFFECT"); });
    await f.coordinator.start(request(f.workspace), f.spawn);
    f.setFacts("ACCEPTED"); f.finish(); await f.exit; f.retire();
    const released = f.port.readOwned(f.workspace, "store-a", "project-a");
    if (!released.ok || released.handle === null) throw new Error("expected the reservation about to land");
    await f.coordinator.advance();
    expect(f.land).toHaveBeenCalledOnce();
    expect(f.releases).toEqual(["LANDED_NOTHING"]);
    expect(f.port.inspect(f.workspace)).toEqual({ ok: true, reservation: null });
    const next = await f.coordinator.start(request(f.workspace, "node-b"), f.spawn);
    expect({ ok: next.ok, code: next.ok ? null : next.code }).toEqual({ ok: true, code: null });
    // The released node's own handle cannot reach across into node-b's fresh claim.
    expect(f.port.release(f.workspace, released.handle.owner, released.handle.reservation.revision, "LANDED_NOTHING", "controller-a"))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_OWNER_MISMATCH" });
    expect(f.port.inspect(f.workspace)).toMatchObject({ reservation: { nodeRef: "node-b" } });
    f.finish();
  }, 120_000);

  // The crash window the fix opens if it is careless: the controller dies between the refusal
  // receipt and the release, so the next pass finds the reservation sitting in LANDING.
  it("releases a reservation left in LANDING by a dead controller, on the same evidence", async () => {
    const f = fixture(); const started = await f.coordinator.start(request(f.workspace), f.spawn);
    if (!started.ok) throw new Error(started.code);
    f.finish(); await f.exit;
    // Walk to LANDING with the real port, standing in for a controller that died mid-landing.
    const owned = f.port.readOwned(f.workspace, "store-a", "project-a");
    if (!owned.ok || owned.handle === null) throw new Error("expected the executing reservation");
    let handle = owned.handle;
    const step = (patch: Record<string, unknown>) => {
      const next = f.port.transition(f.workspace, handle.owner, handle.reservation.revision, { ...handle.reservation, ...patch });
      if (!next.ok) throw new Error(next.code);
      handle = next.handle;
    };
    step({ phase: "VERIFYING" }); step({ phase: "AWAITING_LANDING" }); step({ phase: "LANDING" });
    f.setFacts("REFUSED_NO_EFFECT"); f.retire();
    await f.coordinator.advance();
    expect(f.land).not.toHaveBeenCalled(); // the landing already happened; it is never repeated
    expect(f.releases).toEqual(["LANDED_NOTHING"]);
    expect(f.port.inspect(f.workspace)).toEqual({ ok: true, reservation: null });
  }, 120_000);

  // The same window seen by a DIFFERENT wrapper: the old controller is gone, and the new one
  // adopts the reservation only to reconcile it.
  it("lets a restarted wrapper reconcile a LANDING orphan that journaled nothing", async () => {
    const f = fixture(); const started = await f.coordinator.start(request(f.workspace), f.spawn);
    if (!started.ok) throw new Error(started.code);
    f.finish(); await f.exit;
    const owned = f.port.readOwned(f.workspace, "store-a", "project-a");
    if (!owned.ok || owned.handle === null) throw new Error("expected the executing reservation");
    let handle = owned.handle;
    const step = (patch: Record<string, unknown>) => {
      const next = f.port.transition(f.workspace, handle.owner, handle.reservation.revision, { ...handle.reservation, ...patch });
      if (!next.ok) throw new Error(next.code);
      handle = next.handle;
    };
    step({ phase: "VERIFYING" }); step({ phase: "AWAITING_LANDING" }); step({ phase: "LANDING" });
    const other = fixture(f.workspace, "controller-b", 102);
    other.live.delete(101); other.setFacts("REFUSED_NO_EFFECT"); other.retire();
    await other.coordinator.advance();
    expect(other.releases).toEqual(["LANDED_NOTHING"]);
    expect(other.port.inspect(f.workspace)).toEqual({ ok: true, reservation: null });
  }, 120_000);

  // The new reason is a fence arm, not plumbing: it is admitted from LANDING and from nowhere else.
  it("refuses LANDED_NOTHING from any phase but LANDING", async () => {
    const f = fixture(); const started = await f.coordinator.start(request(f.workspace), f.spawn);
    if (!started.ok) throw new Error(started.code);
    const held = f.port.readOwned(f.workspace, "store-a", "project-a");
    if (!held.ok || held.handle === null) throw new Error("expected a live reservation");
    expect(held.handle.reservation.phase).toBe("EXECUTING");
    expect(f.port.release(f.workspace, held.handle.owner, held.handle.reservation.revision, "LANDED_NOTHING", "controller-a"))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
    expect(f.port.inspect(f.workspace)).toMatchObject({ reservation: { phase: "EXECUTING" } });
    f.finish(); await f.exit;
  }, 120_000);

  it("does not let a second wrapper restore a live controller's ownership", async () => {
    const f = fixture(); await f.coordinator.start(request(f.workspace), f.spawn);
    const other = fixture(f.workspace, "controller-b", 102); other.setFacts("SUBMITTED"); other.retire();
    await other.coordinator.advance();
    expect(other.verify).not.toHaveBeenCalled();
    expect(await other.coordinator.start(request(f.workspace), other.spawn)).toMatchObject({ ok: false });
    f.finish(); await f.exit;
  }, 120_000);

  it("a restarted wrapper retains a live orphan even after the controller dies", async () => {
    const f = fixture(); await f.coordinator.start(request(f.workspace), f.spawn);
    const other = fixture(f.workspace, "controller-b", 102); other.live.delete(101); other.setFacts("SUBMITTED");
    await other.coordinator.advance();
    expect(other.verify).not.toHaveBeenCalled();
    expect(other.port.inspect(f.workspace)).toMatchObject({ reservation: { phase: "EXECUTING", controllerId: "controller-b" } });
    other.retire(); await other.coordinator.advance();
    expect(other.verify).not.toHaveBeenCalled();
    expect(other.port.inspect(f.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
    f.finish(); await f.exit;
  }, 120_000);

  it("holds unknown child containment without verifying or retrying", async () => {
    const f = fixture(); const started = await f.coordinator.start(request(f.workspace), f.spawn);
    if (!started.ok) throw new Error(started.code);
    f.fail(new AgentProcessContainmentError("TREE_KILL_FAILED"));
    await expect(started.exit).rejects.toThrow("AGENT_PROCESS_CONTAINMENT_FAILED");
    f.retire(); await f.coordinator.advance();
    expect(f.port.inspect(f.workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
    expect(f.verify).not.toHaveBeenCalled();
  }, 120_000);

  it("independent checkouts can execute concurrently", async () => {
    const f = fixture(); const other = repository();
    expect((await f.coordinator.start(request(f.workspace), f.spawn)).ok).toBe(true);
    expect((await f.coordinator.start(request(other, "node-b"), f.spawn)).ok).toBe(true);
    f.finish(); await f.exit;
  }, 120_000);

  it("does not spawn when baseline recording fails", async () => {
    const f = fixture(); f.baseline.mockResolvedValue(null as never);
    expect(await f.coordinator.start(request(f.workspace), f.spawn))
      .toMatchObject({ ok: false, code: "REPOSITORY_DELIVERY_BASELINE_UNAVAILABLE" });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.port.inspect(f.workspace)).toEqual({ ok: true, reservation: null });
  }, 120_000);
});
