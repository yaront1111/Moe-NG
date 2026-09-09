import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";
import { readRepositoryRecoveryReservation, recoverRepositoryExecution } from "./repository-execution-recovery.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const port = createRepositoryExecutionPort();
const owner = { projectId: "project", nodeRef: "node", ownershipToken: "a".repeat(64), storeId: "store" };
const controller = { controllerId: "running-controller", controllerPid: process.pid };
function held(): RepositoryExecutionHandle {
  const root = mkdtempSync(join(tmpdir(), "moe-recovery-atomic-")); roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root, shell: false, windowsHide: true });
  const acquired = port.acquire(root, owner, controller); if (!acquired.ok) throw new Error(acquired.code); return acquired.handle;
}
const request = (handle: RepositoryExecutionHandle) => ({ handle, expectedRevision: handle.reservation.revision,
  commandId: "human-command", principalId: "operator", requestSha256: "b".repeat(64), proof: { kind: "ABORT_UNEXECUTED" as const } });
describe("atomic operator repository reconciliation", () => {
  it("aborts an unexecuted owner without adopting its controller and makes the losing start fail", () => {
    const handle = held(); const root = handle.reservation.identity.root;
    expect(readRepositoryRecoveryReservation(root, owner.storeId, owner.projectId)).toMatchObject({ ok: true, everExecuted: false });
    expect(recoverRepositoryExecution(request(handle))).toEqual({ ok: true, released: true, replayed: false });
    expect(port.transition(root, owner, handle.reservation.revision, { ...handle.reservation, phase: "EXECUTING", baselineId: "baseline", sessionId: "session" }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_OWNER_MISMATCH" });
  }, 60_000);
  it("replays an atomic release without touching a later owner and rejects changed request bytes", () => {
    const handle = held(); const root = handle.reservation.identity.root; const input = request(handle);
    expect(recoverRepositoryExecution(input).ok).toBe(true);
    const newer = port.acquire(root, { ...owner, nodeRef: "next", ownershipToken: "c".repeat(64) }, controller);
    expect(newer.ok).toBe(true); if (!newer.ok) throw new Error(newer.code);
    expect(recoverRepositoryExecution(input)).toEqual({ ok: true, released: true, replayed: true });
    expect(recoverRepositoryExecution({ ...input, requestSha256: "d".repeat(64) })).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT" });
    expect(port.inspect(root)).toEqual({ ok: true, reservation: newer.handle.reservation });
  }, 60_000);
  it("rolls back the release if its atomic recovery receipt cannot be written", () => {
    const handle = held(); const root = handle.reservation.identity.root;
    const db = new DatabaseSync(join(handle.reservation.identity.gitDirectory, "moe-repository-execution.sqlite"));
    db.exec("CREATE TABLE recovery_decisions (decision_key TEXT PRIMARY KEY, request_json TEXT NOT NULL, result_json TEXT NOT NULL)");
    db.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON recovery_decisions BEGIN SELECT RAISE(ABORT, 'test failure'); END"); db.close();
    expect(recoverRepositoryExecution(request(handle))).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_UNKNOWN" });
    expect(port.inspect(root)).toEqual({ ok: true, reservation: handle.reservation });
  }, 60_000);
  it("cannot turn execution history or ambiguous BLOCKED state into a preexecution abort", () => {
    const handle = held(); const root = handle.reservation.identity.root;
    const started = port.transition(root, owner, handle.reservation.revision,
      { ...handle.reservation, phase: "EXECUTING", baselineId: "baseline", sessionId: "session", pid: 98765 });
    expect(started.ok).toBe(true); if (!started.ok) throw new Error(started.code);
    const blocked = port.transition(root, owner, started.handle.reservation.revision, { ...started.handle.reservation, phase: "BLOCKED" });
    expect(blocked.ok).toBe(true); if (!blocked.ok) throw new Error(blocked.code);
    expect(recoverRepositoryExecution(request(handle))).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_REVISION_CONFLICT" });
    expect(recoverRepositoryExecution(request(blocked.handle))).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
    expect(recoverRepositoryExecution({ ...request(blocked.handle), proof: { kind: "LANDING_RECEIPT", id: "e".repeat(64) } }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
  }, 60_000);
});
