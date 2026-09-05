import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryExecutionPort } from "./repository-execution-port.js";
import { decodeExecutionRecord } from "./repository-execution-record.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const controller = { controllerId: "controller-a", controllerPid: process.pid };
const owner = { projectId: "project-a", nodeRef: "publish:approved-a", ownershipToken: "a".repeat(64), storeId: "store-a" };
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-reserved-workflow-")); roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root, shell: false, windowsHide: true }); return root;
}

describe("separate publication and criterion repository workflows", () => {
  it.each([
    { phase: "PUBLISHING" as const, nodeRef: "publish:approved-a", reason: "PUBLISHED" as const, baselineId: null, sessionId: null },
    { phase: "CRITERION_VERIFYING" as const, nodeRef: "criterion:v1:run-a", reason: "CRITERIA_COMPLETED" as const,
      baselineId: "integrated-sha-tree", sessionId: "criterion-run-a" },
  ])("holds $phase separately through controller restart and releases only its exact outcome", (workflow) => {
    const root = repository(); const port = createRepositoryExecutionPort(); const scoped = { ...owner, nodeRef: workflow.nodeRef };
    const acquired = port.acquire(root, scoped, controller); expect(acquired.ok).toBe(true); if (!acquired.ok) throw new Error(acquired.code);
    const state = { ...acquired.handle.reservation, phase: workflow.phase, baselineId: workflow.baselineId, sessionId: workflow.sessionId };
    const began = port.transition(root, scoped, acquired.handle.reservation.revision, state);
    expect(began.ok, JSON.stringify(began)).toBe(true); if (!began.ok) throw new Error(began.code);
    expect(createRepositoryExecutionPort().readOwned(root, scoped.storeId, scoped.projectId)).toEqual({ ok: true, handle: began.handle });
    expect(port.acquire(root, { ...scoped, nodeRef: "graph:node" }, controller)).toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_BUSY" });
    for (const reason of ["ABORTED_BEFORE_EXECUTION", "LANDED"] as const) {
      expect(port.release(root, scoped, began.handle.reservation.revision, reason, controller.controllerId))
        .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
    }
    expect(port.transition(root, scoped, began.handle.reservation.revision,
      { ...began.handle.reservation, phase: "RESERVED", baselineId: workflow.baselineId, sessionId: null, pid: null }))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID" });
    expect(port.release(root, scoped, began.handle.reservation.revision, workflow.reason, "another-controller"))
      .toMatchObject({ ok: false, code: "REPOSITORY_EXECUTION_CONTROLLER_MISMATCH" });
    expect(port.release(root, scoped, began.handle.reservation.revision, workflow.reason, controller.controllerId)).toEqual({ ok: true, released: true });
  }, 60_000);

  it("refuses publication state carrying execution witnesses and mismatched history", () => {
    const state = { ...controller, phase: "PUBLISHING", baselineId: null, sessionId: null, pid: null };
    const row = { owner_json: JSON.stringify(owner), state_json: JSON.stringify(state), revision: 2, ever_executed: 1 };
    expect(decodeExecutionRecord(row)).toMatchObject({ state, everExecuted: true });
    expect(decodeExecutionRecord({ ...row, ever_executed: 0 })).toBeNull();
    expect(decodeExecutionRecord({ ...row, state_json: JSON.stringify({ ...state, sessionId: "invented-child" }) })).toBeNull();
    expect(decodeExecutionRecord({ ...row, state_json: JSON.stringify({ ...state, baselineId: "invented-baseline" }) })).toBeNull();
    expect(decodeExecutionRecord({ ...row, state_json: JSON.stringify({ ...state, pid: 17 }) })).toBeNull();
  });
});
