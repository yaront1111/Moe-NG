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
