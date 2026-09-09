import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryExecutionHandle, RepositoryExecutionPort, RepositoryExecutionState } from "./repository-execution-contracts.js";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-repository-execution-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root, shell: false, windowsHide: true });
  mkdirSync(join(root, "src"));
  return root;
}
const owner = { projectId: "project-a", nodeRef: "graph-a:node-a", ownershipToken: "a".repeat(64), storeId: "store-a" };
const controller = { controllerId: "controller-a", controllerPid: process.pid };
function held(port: RepositoryExecutionPort, root: string): RepositoryExecutionHandle {
  const acquired = port.acquire(root, owner, controller);
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error(acquired.code);
  return acquired.handle;
}
function change(port: RepositoryExecutionPort, root: string, handle: RepositoryExecutionHandle, state: Partial<RepositoryExecutionState>) {
  return port.transition(root, handle.owner, handle.reservation.revision, { ...handle.reservation, ...state });
}
function executing(port: RepositoryExecutionPort, root: string): RepositoryExecutionHandle {
  const original = held(port, root);
  const result = change(port, root, original, { baselineId: "baseline-original", phase: "EXECUTING", sessionId: "session-a" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.handle;
}
const databasePath = (root: string) => join(root, ".git", "moe-repository-execution.sqlite");

describe("physical repository execution reservation", () => {
  it("preserves a physical separate git-dir whose name ends in Unicode whitespace", () => {
    const parent = mkdtempSync(join(tmpdir(), "moe-execution-unicode-")); roots.push(parent);
    const root = join(parent, "checkout"); const metadata = join(parent, "metadata\u00a0"); mkdirSync(root);
    execFileSync("git", ["init", "--quiet", "--separate-git-dir", metadata], { cwd: root, shell: false, windowsHide: true });
    expect(held(createRepositoryExecutionPort(), root).reservation.identity.gitDirectory).toBe(realpathSync.native(metadata));
  });

  it("does not create persistence on idle inspection", () => {
    const root = repository();
    expect(createRepositoryExecutionPort().inspect(root)).toEqual({ ok: true, reservation: null });
    expect(() => readFileSync(databasePath(root))).toThrow();
  });

  it("excludes another project store through root, subdirectory and physical aliases", () => {
    const root = repository();
    const port = createRepositoryExecutionPort();
    const handle = held(port, root);
    expect(handle.reservation.identity.root).toBe(realpathSync.native(root));
    expect(handle.reservation.identity.gitDirectory).toBe(realpathSync.native(join(root, ".git")));
    expect(port.acquire(join(root, "src"), { ...owner, projectId: "project-b", storeId: "store-b" }, controller))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
    const parent = mkdtempSync(join(tmpdir(), "moe-execution-alias-")); roots.push(parent);
    const alias = join(parent, "alias"); symlinkSync(root, alias, "junction");
    expect(port.acquire(alias, { ...owner, nodeRef: "graph-b:node-b" }, controller))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
    expect(port.acquire(root, owner, controller)).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
  });

  it("preserves original ownership across restart without exposing its token in observations", () => {
    const root = repository();
    const handle = executing(createRepositoryExecutionPort(), root);
    const restarted = createRepositoryExecutionPort();
    expect(restarted.readOwned(root, owner.storeId, owner.projectId)).toEqual({ ok: true, handle });
    expect(restarted.readOwned(root, "other-store", owner.projectId))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_OWNER_MISMATCH" });
    expect(restarted.inspect(root)).toEqual({ ok: true, reservation: handle.reservation });
    expect(JSON.stringify(restarted.inspect(root))).not.toContain(owner.ownershipToken);
    expect(JSON.stringify(restarted.acquire(root, { ...owner, nodeRef: "other" }, controller))).not.toContain(owner.ownershipToken);
  });

  it("requires exact ownership and CAS revision for transitions", () => {
    const root = repository(); const port = createRepositoryExecutionPort(); const handle = executing(port, root);
    expect(port.transition(root, { ...owner, ownershipToken: "b".repeat(64) }, handle.reservation.revision, handle.reservation))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_OWNER_MISMATCH" });
    expect(port.transition(root, owner, handle.reservation.revision - 1, handle.reservation))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT" });
    const changed = change(port, root, handle, { pid: 43210 });
    expect(changed).toMatchObject({ ok: true, handle: { reservation: { revision: 3, pid: 43210 } } });
    expect(change(port, root, handle, { pid: 43211 }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT" });
  });

  it("retains immutable baseline through a same-owner retry and forbids pre-execution abort after it ran", () => {
    const root = repository(); const port = createRepositoryExecutionPort(); const handle = executing(port, root);
    expect(change(port, root, handle, { baselineId: "new-baseline" }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BASELINE_MISMATCH" });
    const retry = change(port, root, handle, { phase: "RESERVED", sessionId: null, pid: null });
    expect(retry).toMatchObject({ ok: true, handle: { reservation: { baselineId: "baseline-original", phase: "RESERVED" } } });
    if (!retry.ok) throw new Error(retry.code);
    expect(port.release(root, owner, retry.handle.reservation.revision, "ABORTED_BEFORE_EXECUTION", controller.controllerId))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
  });

  it("retains reservation through child exit, verification and accepted-but-unlanded phases", () => {
    const root = repository(); const port = createRepositoryExecutionPort(); let handle = executing(port, root);
    for (const phase of ["VERIFYING", "AWAITING_LANDING", "LANDING"] as const) {
      const changed = change(port, root, handle, { phase });
      expect(changed.ok).toBe(true); if (!changed.ok) throw new Error(changed.code); handle = changed.handle;
      expect(port.acquire(root, { ...owner, nodeRef: "next-node" }, controller))
        .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
      if (phase !== "LANDING") expect(port.release(root, owner, handle.reservation.revision, "LANDED", controller.controllerId))
        .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
    }
    expect(port.release(root, owner, handle.reservation.revision, "LANDED", controller.controllerId)).toEqual({ ok: true, released: true });
    expect(port.acquire(root, { ...owner, nodeRef: "next-node" }, controller)).toMatchObject({ ok: true });
  });

  it("only releases an unexecuted reservation with exact ownership and revision", () => {
    const root = repository(); const port = createRepositoryExecutionPort(); const handle = held(port, root);
    expect(port.release(root, { ...owner, projectId: "other" }, 1, "ABORTED_BEFORE_EXECUTION", controller.controllerId))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_OWNER_MISMATCH" });
    expect(port.release(root, owner, 0, "ABORTED_BEFORE_EXECUTION", controller.controllerId))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT" });
    expect(port.release(root, owner, handle.reservation.revision, "ABORTED_BEFORE_EXECUTION", "another-controller"))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_CONTROLLER_MISMATCH" });
    expect(port.release(root, owner, handle.reservation.revision, "ABORTED_BEFORE_EXECUTION", controller.controllerId))
      .toEqual({ ok: true, released: true });
  });

  it("allows the controller to retry a landing with a proven no-effect refusal", () => {
    const root = repository(); const port = createRepositoryExecutionPort(); let handle = executing(port, root);
    for (const phase of ["VERIFYING", "AWAITING_LANDING", "LANDING"] as const) {
      const result = change(port, root, handle, { phase });
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code); handle = result.handle;
    }
    const retry = change(port, root, handle, { phase: "AWAITING_LANDING" });
    expect(retry).toMatchObject({ ok: true, handle: { reservation: { phase: "AWAITING_LANDING", baselineId: "baseline-original" } } });
    expect(port.acquire(root, { ...owner, nodeRef: "other-node" }, controller))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
  });

  it("rejects an old revision after release and reacquisition even if the caller reuses its token", () => {
    const root = repository(); const port = createRepositoryExecutionPort(); const previous = held(port, root);
    expect(port.release(root, owner, previous.reservation.revision, "ABORTED_BEFORE_EXECUTION", controller.controllerId))
      .toEqual({ ok: true, released: true });
    const next = held(port, root);
    expect(next.reservation.revision).toBeGreaterThan(previous.reservation.revision);
    expect(port.release(root, owner, previous.reservation.revision, "ABORTED_BEFORE_EXECUTION", controller.controllerId))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT" });
    expect(port.inspect(root)).toEqual({ ok: true, reservation: next.reservation });
  });

  it("requires an explicit controller takeover and fences stale wrapper updates", () => {
    const root = repository(); const port = createRepositoryExecutionPort(); const previous = executing(port, root);
    const replacement = { controllerId: "replacement-controller", controllerPid: process.pid + 1 };
    expect(change(port, root, previous, replacement))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_CONTROLLER_MISMATCH" });
    expect(port.claimController(root, { ...owner, projectId: "other-project" }, previous.reservation.revision, replacement))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_OWNER_MISMATCH" });
    expect(port.claimController(root, owner, previous.reservation.revision - 1, replacement))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT" });
    const restored = port.claimController(root, owner, previous.reservation.revision, replacement);
    expect(restored).toMatchObject({ ok: true, handle: { reservation: { ...replacement, baselineId: "baseline-original", sessionId: "session-a" } } });
    if (!restored.ok) throw new Error(restored.code);
    expect(change(port, root, previous, { phase: "VERIFYING" }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT" });
    expect(port.transition(root, owner, restored.handle.reservation.revision, { ...previous.reservation, phase: "VERIFYING" }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_CONTROLLER_MISMATCH" });
    expect(change(port, root, restored.handle, { phase: "VERIFYING" })).toMatchObject({ ok: true });
  });

  it("keeps BLOCKED terminal and rejects illegal transitions or execution without baseline/session", () => {
    const root = repository(); const port = createRepositoryExecutionPort(); const handle = held(port, root);
    expect(change(port, root, handle, { phase: "EXECUTING" }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
    expect(change(port, root, handle, { phase: "LANDING" }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
    const blocked = change(port, root, handle, { phase: "BLOCKED" });
    expect(blocked.ok).toBe(true); if (!blocked.ok) throw new Error(blocked.code);
    expect(change(port, root, blocked.handle, { phase: "RESERVED" }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
    expect(port.release(root, owner, blocked.handle.reservation.revision, "ABORTED_BEFORE_EXECUTION", controller.controllerId))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
  });

  it("fails closed for a nonrepository and corrupted persisted reservation", () => {
    const outside = mkdtempSync(join(tmpdir(), "moe-execution-outside-")); roots.push(outside);
    expect(createRepositoryExecutionPort().acquire(outside, owner, controller))
      .toMatchObject({ ok: false, code: "REPOSITORY_IDENTITY_UNKNOWN" });
    const root = repository(); writeFileSync(databasePath(root), "corrupt-state");
    const port = createRepositoryExecutionPort();
    for (const result of [port.inspect(root), port.acquire(root, owner, controller), port.readOwned(root, owner.storeId, owner.projectId)]) {
      expect(result).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_UNKNOWN" });
    }
    expect(readFileSync(databasePath(root), "utf8")).toBe("corrupt-state");
  });

  it("fails closed for malformed stored state and unknown schema version", () => {
    const root = repository(); const port = createRepositoryExecutionPort(); held(port, root);
    const db = new DatabaseSync(databasePath(root));
    try { db.prepare("UPDATE reservation SET state_json = ? WHERE singleton = 1").run('{"phase":"FUTURE"}'); }
    finally { db.close(); }
    expect(port.inspect(root)).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_UNKNOWN" });
    expect(port.acquire(root, owner, controller)).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_UNKNOWN" });
    const fresh = repository(); held(port, fresh);
    const changed = new DatabaseSync(databasePath(fresh));
    try { changed.exec("PRAGMA user_version = 999"); } finally { changed.close(); }
    expect(port.inspect(fresh)).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_UNKNOWN" });
  });
});
