import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionHandle } from "../repository/repository-execution-contracts.js";
import { createRepositoryContainmentLedger } from "./repository-containment-witness.js";

const stores: SqliteEventStore[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function ledger() {
  const root = mkdtempSync(join(tmpdir(), "moe-containment-witness-")); roots.push(root);
  const store = SqliteEventStore.openForProject(join(root, "store.sqlite"), "project-a"); stores.push(store);
  return createRepositoryContainmentLedger(store);
}
const owner = { projectId: "project-a", nodeRef: "node-a", ownershipToken: "a".repeat(64), storeId: "store-a" };
function handle(patch: Record<string, unknown> = {}): RepositoryExecutionHandle {
  return { owner, reservation: { phase: "EXECUTING", baselineId: "baseline-a", sessionId: "session-a", pid: 201,
    controllerId: "controller-a", controllerPid: 101, revision: 7, projectId: owner.projectId, nodeRef: owner.nodeRef,
    storeId: owner.storeId, identity: { root: "C:\\repo", gitDirectory: "C:\\repo\\.git" }, ...patch } } as unknown as RepositoryExecutionHandle;
}

/** A proof names one exact reservation state (addendum 2026-09-15). */
describe("kept repository containment proofs", () => {
  it("proves exactly the state it recorded, for its own kind", () => {
    const kept = ledger();

    expect(kept.record("SEAT", handle())).toBe(true);

    expect(kept.proved("SEAT", handle())).toBe(true);
    expect(kept.proved("VERIFICATION", handle())).toBe(false);
  });

  it.each([
    ["a later claim", { controllerId: "controller-b", controllerPid: 102, revision: 8 }],
    ["a moved revision", { revision: 8 }],
    ["another seat", { sessionId: "session-b" }],
    ["another pid", { pid: 202 }],
    ["another phase", { phase: "VERIFYING" }],
    ["another baseline", { baselineId: "baseline-b" }],
  ])("stops counting after %s", (_label, patch) => {
    const kept = ledger();
    kept.record("SEAT", handle());

    expect(kept.proved("SEAT", handle(patch))).toBe(false);
  });

  it("counts only the latest proof", () => {
    const kept = ledger();
    kept.record("SEAT", handle());
    kept.record("VERIFICATION", handle({ phase: "VERIFYING", revision: 9 }));

    expect(kept.proved("SEAT", handle())).toBe(false);
    expect(kept.proved("VERIFICATION", handle({ phase: "VERIFYING", revision: 9 }))).toBe(true);
  });

  it("keeps each reservation's proofs apart", () => {
    const kept = ledger();
    kept.record("SEAT", handle());
    const other = { ...handle(), owner: { ...owner, ownershipToken: "b".repeat(64) } } as RepositoryExecutionHandle;

    expect(kept.proved("SEAT", other)).toBe(false);
  });

  it("reads a store it cannot use as unproved, never as proved", () => {
    const broken = createRepositoryContainmentLedger({
      commit: () => { throw new Error("disk full"); },
      getAggregateVersion: () => 0,
      readEvents: () => { throw new Error("unreadable"); },
    } as never);

    expect(broken.record("SEAT", handle())).toBe(false);
    expect(broken.proved("SEAT", handle())).toBe(false);
  });
});

/** Which runtime ran a hold's processes, and whether all of them are gone (owner decision 2026-09-16). */
describe("runtimes that ran a hold's processes", () => {
  function shared() {
    const root = mkdtempSync(join(tmpdir(), "moe-containment-runtimes-")); roots.push(root);
    const store = SqliteEventStore.openForProject(join(root, "store.sqlite"), "project-a"); stores.push(store);
    return { store, on: (brokerPid: number | null) => createRepositoryContainmentLedger(store, brokerPid) };
  }
  const aliveOnly = (...pids: number[]) => (pid: number): boolean => pids.includes(pid);

  it("infers only when every recorded runtime's broker is gone", () => {
    const { on } = shared();
    on(501).recordRuntime("SEAT", handle());
    on(502).recordRuntime("VERIFICATION", handle({ phase: "VERIFYING" }));

    expect(on(503).runtimesGone(handle(), aliveOnly())).toBe(true);
    expect(on(503).runtimesGone(handle(), aliveOnly(501))).toBe(false);
    expect(on(503).runtimesGone(handle(), aliveOnly(502))).toBe(false);
  });

  it("needs the hold's current seat on record", () => {
    const { on } = shared();
    on(501).recordRuntime("SEAT", handle({ sessionId: "session-b" }));

    expect(on(502).runtimesGone(handle(), aliveOnly())).toBe(false);
    expect(on(502).runtimesGone(handle({ sessionId: "session-b" }), aliveOnly())).toBe(true);
  });

  it("never infers from an unnamed runtime, an empty record, or a probe that throws", () => {
    const unnamed = shared();
    unnamed.on(null).recordRuntime("SEAT", handle());
    expect(unnamed.on(502).runtimesGone(handle(), aliveOnly())).toBe(false);

    expect(shared().on(502).runtimesGone(handle(), aliveOnly())).toBe(false);

    const named = shared();
    named.on(501).recordRuntime("SEAT", handle());
    expect(named.on(502).runtimesGone(handle(), () => { throw new Error("probe failed"); })).toBe(false);
  });

  /**
   * UnAI 2026-09-19: the recorded broker was pid 42564. After a restart Windows had handed that
   * pid to the new runtime's launcher, so "alive" stayed true and the hold stayed BLOCKED for
   * the whole run: the integrator never got the checkout and nothing merged.
   */
  it("does not take a reused pid for the broker, and takes an unanswerable OS for a live one", () => {
    const { store } = shared();
    const asked: number[] = [];
    const ledger = (image: boolean | null) => createRepositoryContainmentLedger(store, 503,
      (pid) => { asked.push(pid); return image; });
    createRepositoryContainmentLedger(store, 501).recordRuntime("SEAT", handle());

    // Alive, and the OS names another image there: the broker is gone, its Job closed with it.
    expect(ledger(false).runtimesGone(handle(), aliveOnly(501))).toBe(true);
    // Alive and still the broker image, or the OS could not say: never inferred.
    expect(ledger(true).runtimesGone(handle(), aliveOnly(501))).toBe(false);
    expect(ledger(null).runtimesGone(handle(), aliveOnly(501))).toBe(false);
    expect(asked).toEqual([501, 501, 501]);
    // A dead pid needs no second question, and a probe that throws still never infers.
    expect(ledger(true).runtimesGone(handle(), aliveOnly())).toBe(true);
    expect(asked).toEqual([501, 501, 501]);
    expect(createRepositoryContainmentLedger(store, 503, () => { throw new Error("tasklist failed"); })
      .runtimesGone(handle(), aliveOnly(501))).toBe(false);
  });

  it("records one run once and lets a later run void an earlier proof", () => {
    const { store, on } = shared();
    const kept = on(501);
    kept.recordRuntime("VERIFICATION", handle({ phase: "VERIFYING" }));
    kept.recordRuntime("VERIFICATION", handle({ phase: "VERIFYING" }));
    const runs = store.readEvents(`repository-containment/${createHash("sha256").update("a".repeat(64), "utf8").digest("hex")}`);
    expect(runs).toHaveLength(1);

    kept.record("VERIFICATION", handle({ phase: "VERIFYING" }));
    kept.recordRuntime("VERIFICATION", handle({ phase: "VERIFYING", revision: 8 }));
    expect(kept.proved("VERIFICATION", handle({ phase: "VERIFYING" }))).toBe(false);
  });
});
