import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "@moe/store";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import type { RepositoryExecutionPort, RepositoryExecutionReleaseReason } from "../repository/repository-execution-contracts.js";
import { AgentProcessContainmentError } from "./agent-spawn-contract.js";
import type { SpawnRequest } from "./agent-wrapper.js";
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
function world() {
  const workspace = temporary("moe-delivery-crash-");
  execFileSync("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
  const store = SqliteEventStore.openForProject(join(temporary("moe-crash-store-"), "store.sqlite"), "project-a");
  stores.push(store);
  /** One runtime's view of the shared store: its own Job broker. */
  const runtime = (brokerPid: number | null) => createRepositoryContainmentLedger(store, brokerPid);
  return { workspace, runtime };
}
function request(workspace: string): SpawnRequest {
  return { credential: "secret", expiresAt: "2026-09-06T00:00:00.000Z", kind: "node.deliver",
    mission: "implement", sessionId: "session-node-a", workItemId: "node.deliver@node-a", workspace };
}
/** A controller A (pid 101, broker 501) or B (pid 102, broker 502), with its own liveness view. */
function controller(workspace: string, controllerId: string, controllerPid: number, containment?: RepositoryContainmentLedger,
  clean?: (root: string) => Promise<boolean>) {
  const port = createRepositoryExecutionPort();
  const releases: RepositoryExecutionReleaseReason[] = [];
  const recording: RepositoryExecutionPort = { ...port, release(root, owner, revision, reason, id) {
    releases.push(reason); return port.release(root, owner, revision, reason, id);
  } };
  let facts: RepositoryDeliveryFacts = "READY";
  let retired = false;
  const live = new Set([101, 102, 201, 501, 502]);
  const verify = vi.fn(async () => { facts = "ACCEPTED"; });
  const land = vi.fn(async () => { facts = "LANDED"; });
  const coordinator = createRepositoryDeliveryCoordinator({ baseline: async () => "baseline-original",
    controller: { controllerId, controllerPid }, ...(containment === undefined ? {} : { containment }),
    ...(clean === undefined ? {} : { clean }),
    facts: () => facts, isProcessAlive: (pid: number) => live.has(pid), land, port: recording, projectId: "project-a",
    retired: () => retired, storeId: "store-a", verify, workspaces: () => [workspace] });
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const exit = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const spawn = vi.fn(async () => ({ ok: true as const, pid: 201, exit }));
  return { coordinator, fail, finish, live, port, releases, spawn, verify,
    setFacts: (value: RepositoryDeliveryFacts) => { facts = value; }, retire: () => { retired = true; live.delete(201); } };
}
/** After A's whole runtime died: its wrapper, its seat and its broker are gone from B's view. */
function afterCrash(workspace: string, containment: RepositoryContainmentLedger, brokerAlive = false) {
  const b = controller(workspace, "controller-b", 102, containment);
  b.live.delete(101); b.live.delete(201);
  if (!brokerAlive) b.live.delete(501);
  return b;
}

/**
 * Owner decision 2026-09-16: a hard stop (crash, power loss, taskkill /F) while a seat ran left a
 * BLOCKED hold that no command could release after the restart. A gone Job broker closed its
 * Job, which killed every process in it, so a hold whose every runtime is gone resumes itself.
 */
describe("a hold whose runtime was hard-stopped", () => {
  it("resumes a crashed seat's hold once that runtime's broker is gone", async () => {
    const { workspace, runtime } = world();
    const a = controller(workspace, "controller-a", 101, runtime(501));
    expect((await a.coordinator.start(request(workspace), a.spawn)).ok).toBe(true);

    const b = afterCrash(workspace, runtime(502));
    await b.coordinator.advance();
    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "EXECUTING", controllerId: "controller-b" } });
    b.retire(); await b.coordinator.advance();

    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "RESERVED", sessionId: null } });
  }, 120_000);

  it("still blocks when only the wrapper died and its runtime's broker lives on", async () => {
    const { workspace, runtime } = world();
    const a = controller(workspace, "controller-a", 101, runtime(501));
    expect((await a.coordinator.start(request(workspace), a.spawn)).ok).toBe(true);

    const b = afterCrash(workspace, runtime(502), true);
    b.retire(); await b.coordinator.advance();

    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  }, 120_000);

  it.each([
    ["READY", { phase: "RESERVED", sessionId: null }],
    ["REPLANNED", { phase: "RESERVED", sessionId: null }],
    ["SUBMITTED", { phase: "VERIFYING" }],
  ] as const)("resumes an already BLOCKED hold reading %s once every runtime that touched it is gone", async (facts, resumed) => {
    const { workspace, runtime } = world();
    const a = controller(workspace, "controller-a", 101, runtime(501));
    const started = await a.coordinator.start(request(workspace), a.spawn);
    if (!started.ok) throw new Error(started.code);
    a.fail(new AgentProcessContainmentError("TREE_KILL_FAILED"));
    await expect(started.exit).rejects.toThrow();
    expect(a.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });

    const b = afterCrash(workspace, runtime(502)); b.setFacts(facts);
    await b.coordinator.advance();

    expect(b.port.inspect(workspace)).toMatchObject({ reservation: resumed });
  }, 120_000);

  it("keeps a BLOCKED hold while any runtime that touched it lives", async () => {
    const { workspace, runtime } = world();
    const a = controller(workspace, "controller-a", 101, runtime(501));
    const started = await a.coordinator.start(request(workspace), a.spawn);
    if (!started.ok) throw new Error(started.code);
    a.fail(new AgentProcessContainmentError("TREE_KILL_FAILED"));
    await expect(started.exit).rejects.toThrow();

    const b = afterCrash(workspace, runtime(502), true);
    await b.coordinator.advance();

    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED", controllerId: "controller-b" } });
  }, 120_000);

  /**
   * UnAI 2026-09-19: a restart brought a dead seat's hold back RESERVED over a clean checkout, and
   * staffing ran before the NEXT pass could yield it. The holder was staffed right there, on a
   * project branch that lacked its dependencies, and the integrator could merge nothing.
   */
  it("gives an idle, clean checkout back in the same pass that resumed it", async () => {
    const { workspace, runtime } = world();
    const a = controller(workspace, "controller-a", 101, runtime(501));
    const started = await a.coordinator.start(request(workspace), a.spawn);
    if (!started.ok) throw new Error(started.code);
    a.fail(new AgentProcessContainmentError("TREE_KILL_FAILED"));
    await expect(started.exit).rejects.toThrow();

    const asked: string[] = [];
    const b = controller(workspace, "controller-b", 102, runtime(502), async (root) => { asked.push(root); return true; });
    b.live.delete(101); b.live.delete(201); b.live.delete(501); b.retire();
    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
    await b.coordinator.advance();

    expect(b.releases).toEqual(["YIELDED"]);
    expect(b.port.inspect(workspace)).toMatchObject({ ok: true, reservation: null });
    expect(asked).toHaveLength(1);

    // A checkout that still holds work is never given back: the hold stays, RESERVED.
    const dirty = world();
    const c = controller(dirty.workspace, "controller-a", 101, dirty.runtime(501));
    const again = await c.coordinator.start(request(dirty.workspace), c.spawn);
    if (!again.ok) throw new Error(again.code);
    c.fail(new AgentProcessContainmentError("TREE_KILL_FAILED"));
    await expect(again.exit).rejects.toThrow();
    const d = controller(dirty.workspace, "controller-b", 102, dirty.runtime(502), async () => false);
    d.live.delete(101); d.live.delete(201); d.live.delete(501); d.retire();
    await d.coordinator.advance();
    expect(d.releases).toEqual([]);
    expect(d.port.inspect(dirty.workspace)).toMatchObject({ reservation: { phase: "RESERVED", sessionId: null } });
  }, 120_000);

  it.each([
    ["no record at all", undefined],
    ["an unnamed runtime", null],
  ] as const)("never infers for a seat run by %s", async (_label, broker) => {
    const { workspace, runtime } = world();
    const a = controller(workspace, "controller-a", 101, broker === undefined ? undefined : runtime(broker));
    expect((await a.coordinator.start(request(workspace), a.spawn)).ok).toBe(true);

    const b = afterCrash(workspace, runtime(502));
    b.retire(); await b.coordinator.advance();

    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "BLOCKED" } });
  }, 120_000);

  it("does not start a verification whose runtime cannot be recorded", async () => {
    const { workspace, runtime } = world();
    const kept = runtime(501);
    const refusing: RepositoryContainmentLedger = { ...kept,
      recordRuntime: (kind, handle) => kind === "VERIFICATION" ? false : kept.recordRuntime(kind, handle) };
    const a = controller(workspace, "controller-a", 101, refusing);
    const started = await a.coordinator.start(request(workspace), a.spawn);
    if (!started.ok) throw new Error(started.code);
    a.finish(); await started.exit; a.retire(); a.setFacts("SUBMITTED");

    await a.coordinator.advance();

    expect(a.verify).not.toHaveBeenCalled();
    expect(a.port.inspect(workspace)).toMatchObject({ reservation: { phase: "VERIFYING" } });
  }, 120_000);

  it("does not wait on a reused seat pid once the seat's runtime is gone", async () => {
    const { workspace, runtime } = world();
    const a = controller(workspace, "controller-a", 101, runtime(501));
    expect((await a.coordinator.start(request(workspace), a.spawn)).ok).toBe(true);

    // Pid 201 now belongs to an unrelated process; the seat itself died with its runtime's Job.
    const b = afterCrash(workspace, runtime(502)); b.retire(); b.live.add(201);
    await b.coordinator.advance();

    expect(b.port.inspect(workspace)).toMatchObject({ reservation: { phase: "RESERVED", sessionId: null } });
  }, 120_000);

  it("verifies again after its runtime died mid-verification", async () => {
    const { workspace, runtime } = world();
    const a = controller(workspace, "controller-a", 101, runtime(501));
    const started = await a.coordinator.start(request(workspace), a.spawn);
    if (!started.ok) throw new Error(started.code);
    a.finish(); await started.exit; a.retire(); a.setFacts("SUBMITTED");
    a.verify.mockImplementationOnce(() => new Promise<void>(() => { /* the runtime dies mid-verification */ }));
    void a.coordinator.advance();
    await vi.waitFor(() => { expect(a.verify).toHaveBeenCalledOnce(); });

    const b = afterCrash(workspace, runtime(502)); b.retire(); b.setFacts("SUBMITTED");
    await b.coordinator.advance();

    expect(b.verify).toHaveBeenCalledOnce();
    expect(b.releases).toEqual(["LANDED"]);
  }, 120_000);
});
