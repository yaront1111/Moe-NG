import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "@moe/store";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import type { RepositoryExecutionPort, RepositoryExecutionReleaseReason } from "../repository/repository-execution-contracts.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { VerifierProcessCancelledError } from "./process-runner-lifecycle.js";
import { createRepositoryContainmentLedger } from "./repository-containment-witness.js";
import type { RepositoryContainmentLedger } from "./repository-containment-witness.js";
import { createRepositoryDeliveryCoordinator } from "./repository-delivery-coordinator.js";
import type { RepositoryDeliveryFacts } from "./repository-delivery-contracts.js";

const roots: string[] = [];
const stores: SqliteEventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(root); return root;
}
function repository(): string {
  const root = temporary("moe-delivery-containment-");
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  return root;
}
function keptProofs(): RepositoryContainmentLedger {
  const store = SqliteEventStore.openForProject(join(temporary("moe-containment-store-"), "store.sqlite"), "project-a");
  stores.push(store);
  return createRepositoryContainmentLedger(store);
}
function request(workspace: string): SpawnRequest {
  return { credential: "secret", expiresAt: "2026-09-06T00:00:00.000Z", kind: "node.deliver",
    mission: "implement", sessionId: "session-node-a", workItemId: "node.deliver@node-a", workspace };
}
/** One controller over a shared checkout, with its own pid, liveness view, facts and retirement. */
function controller(workspace: string, controllerId: string, controllerPid: number, containment?: RepositoryContainmentLedger) {
  const port = createRepositoryExecutionPort();
  const releases: RepositoryExecutionReleaseReason[] = [];
  const recording: RepositoryExecutionPort = { ...port, release(root, owner, revision, reason, id) {
    releases.push(reason); return port.release(root, owner, revision, reason, id);
  } };
  let facts: RepositoryDeliveryFacts = "READY";
  let retired = false;
  const live = new Set([101, 102, 103, 201]);
  const verify = vi.fn(async () => { facts = "ACCEPTED"; });
  const land = vi.fn(async () => { facts = "LANDED"; });
  const coordinator = createRepositoryDeliveryCoordinator({ baseline: async () => "baseline-original",
    controller: { controllerId, controllerPid }, ...(containment === undefined ? {} : { containment }),
    facts: () => facts, isProcessAlive: (pid: number) => live.has(pid), land, port: recording, projectId: "project-a",
    retired: () => retired, storeId: "store-a", verify, workspaces: () => [workspace] });
  let finish!: () => void;
  const exit = new Promise<void>((resolve) => { finish = resolve; });
  const spawn = vi.fn(async () => ({ ok: true as const, pid: 201, exit }));
  return { coordinator, finish, live, port, releases, spawn, verify,
    setFacts: (value: RepositoryDeliveryFacts) => { facts = value; }, retire: () => { retired = true; live.delete(201); } };
}
async function exitedSeat(workspace: string, kept?: RepositoryContainmentLedger) {
  const a = controller(workspace, "controller-a", 101, kept);
  const started = await a.coordinator.start(request(workspace), a.spawn);
  if (!started.ok) throw new Error(started.code);
  a.finish(); await started.exit;
  return a;
}

/**
 * A stop no longer bricks the repository (addendum 2026-09-15). Every stop while a seat or a
 * verifier ran left the reservation BLOCKED once the controller restarted, and the recovery
 * commands need the original runtime alive, so nothing could release it again. The controller
 * that proved the closure now keeps that proof; the next one relies on it only while the
 * reservation is exactly as the prover left it.
 */
describe("a restarted controller and the proofs its predecessor kept", () => {
  it("resumes a seat whose closure the dead controller proved, instead of blocking it", async () => {
    const workspace = repository(); const kept = keptProofs();
    await exitedSeat(workspace, kept);

    const b = controller(workspace, "controller-b", 102, kept); b.live.delete(101); b.live.delete(201);
    await b.coordinator.advance();
    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "EXECUTING", controllerId: "controller-b" } });
    b.retire(); await b.coordinator.advance();

    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "RESERVED", sessionId: null, pid: null } });
  }, 120_000);

  it("still blocks a seat whose dead controller proved nothing", async () => {
    const workspace = repository(); const kept = keptProofs();
    const a = controller(workspace, "controller-a", 101, kept);
    const started = await a.coordinator.start(request(workspace), a.spawn);
    if (!started.ok) throw new Error(started.code);

    const b = controller(workspace, "controller-b", 102, kept); b.live.delete(101); b.retire();
    await b.coordinator.advance();

    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED", controllerId: "controller-b" } });
    a.finish(); await started.exit; // a late exit proves nothing for a reservation its controller lost
    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  }, 120_000);

  it("ignores a proof once another controller has claimed the reservation since", async () => {
    const workspace = repository(); const kept = keptProofs();
    await exitedSeat(workspace, kept);
    // A second runtime claimed it without keeping proofs, and died as well.
    const c = controller(workspace, "controller-c", 103); c.live.delete(101);
    await c.coordinator.advance();
    expect(c.port.inspect(workspace)).toMatchObject({ reservation: { phase: "EXECUTING", controllerId: "controller-c" } });

    const b = controller(workspace, "controller-b", 102, kept); b.live.delete(101); b.live.delete(103); b.retire();
    await b.coordinator.advance();

    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  }, 120_000);

  it("keeps a cancelled verification VERIFYING and lets the next controller run it again", async () => {
    const workspace = repository(); const kept = keptProofs();
    const a = await exitedSeat(workspace, kept); a.retire(); a.setFacts("SUBMITTED");
    a.verify.mockRejectedValueOnce(new VerifierProcessCancelledError());

    await expect(a.coordinator.advance()).rejects.toBeInstanceOf(VerifierProcessCancelledError);
    expect(a.port.inspect(workspace)).toMatchObject({ reservation: { phase: "VERIFYING", controllerId: "controller-a" } });

    const b = controller(workspace, "controller-b", 102, kept); b.live.delete(101); b.retire(); b.setFacts("SUBMITTED");
    await b.coordinator.advance();

    expect(b.verify).toHaveBeenCalledOnce();
    expect(b.releases).toEqual(["LANDED"]);
    expect(b.port.inspect(workspace)).toEqual({ ok: true, reservation: null });
  }, 120_000);

  it("still blocks a verification that failed for any other reason", async () => {
    const workspace = repository(); const kept = keptProofs();
    const a = await exitedSeat(workspace, kept); a.retire(); a.setFacts("SUBMITTED");
    a.verify.mockRejectedValueOnce(new Error("verifier crashed"));

    await expect(a.coordinator.advance()).rejects.toThrow("verifier crashed");

    expect(a.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  }, 120_000);

  it("blocks a cancelled verification on restart when its controller kept no proof", async () => {
    const workspace = repository();
    const a = await exitedSeat(workspace); a.retire(); a.setFacts("SUBMITTED");
    a.verify.mockRejectedValueOnce(new VerifierProcessCancelledError());
    await expect(a.coordinator.advance()).rejects.toBeInstanceOf(VerifierProcessCancelledError);

    const b = controller(workspace, "controller-b", 102, keptProofs()); b.live.delete(101); b.retire(); b.setFacts("SUBMITTED");
    await b.coordinator.advance();

    expect(b.verify).not.toHaveBeenCalled();
    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  }, 120_000);
});
