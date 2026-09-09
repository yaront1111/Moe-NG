import { describe, expect, it } from "vitest";
import { repositoryExecutionFailure } from "./repository-execution-contracts.js";
import { decodeExecutionRecord, executionHandle, sameExecutionOwner, validExecutionController, validExecutionOwner, validExecutionState } from "./repository-execution-record.js";

const owner = { projectId: "project-a", nodeRef: "graph-a:node-a", ownershipToken: "a".repeat(64), storeId: "store-a" };
const controller = { controllerId: "controller-a", controllerPid: process.pid };
const state = { ...controller, phase: "EXECUTING" as const, baselineId: "baseline-a", sessionId: "session-a", pid: 123 };
const row = { owner_json: JSON.stringify(owner), state_json: JSON.stringify(state), revision: 2, ever_executed: 1 };

describe("repository reservation persistence boundary", () => {
  it.each([
    ["missing owner", { ...row, owner_json: null }],
    ["unknown owner field", { ...row, owner_json: JSON.stringify({ ...owner, pid: 123 }) }],
    ["malformed token", { ...row, owner_json: JSON.stringify({ ...owner, ownershipToken: "visible-id" }) }],
    ["missing state", { ...row, state_json: null }],
    ["unknown phase", { ...row, state_json: JSON.stringify({ ...state, phase: "FUTURE" }) }],
    ["unknown state field", { ...row, state_json: JSON.stringify({ ...state, ttl: 0 }) }],
    ["bad JSON", { ...row, state_json: "{" }],
    ["missing baseline", { ...row, state_json: JSON.stringify({ ...state, baselineId: null }) }],
    ["missing session", { ...row, state_json: JSON.stringify({ ...state, sessionId: null }) }],
    ["negative pid", { ...row, state_json: JSON.stringify({ ...state, pid: -1 }) }],
    ["missing controller identity", { ...row, state_json: JSON.stringify({ ...state, controllerId: null }) }],
    ["missing controller process", { ...row, state_json: JSON.stringify({ ...state, controllerPid: null }) }],
    ["unknown execution history", { ...row, ever_executed: 2 }],
    ["contradictory execution history", { ...row, ever_executed: 0 }],
    ["invalid revision", { ...row, revision: 0 }],
    ["imprecise revision", { ...row, revision: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s", (_name, value) => {
    expect(decodeExecutionRecord(value)).toBeNull();
  });

  it("decodes exact durable owner/state and freezes a token-free observation", () => {
    const record = decodeExecutionRecord(row);
    expect(record).toEqual({ owner, state, revision: 2, everExecuted: true });
    if (record === null) throw new Error("expected record");
    const identity = Object.freeze({ root: "/repo", gitDirectory: "/repo/.git" });
    const handle = executionHandle(record, identity);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.owner)).toBe(true);
    expect(Object.isFrozen(handle.reservation)).toBe(true);
    expect(handle.owner).not.toBe(record.owner);
    expect(JSON.stringify(handle.reservation)).not.toContain(owner.ownershipToken);
    expect(handle.reservation).toEqual({ ...state, revision: 2, identity, projectId: owner.projectId, nodeRef: owner.nodeRef, storeId: owner.storeId });
  });

  it("accepts RESERVED before spawn but rejects an attached child", () => {
    expect(validExecutionState({ ...controller, phase: "RESERVED", baselineId: null, sessionId: null, pid: null })).toBe(true);
    expect(validExecutionState({ ...controller, phase: "RESERVED", baselineId: "baseline", sessionId: "session", pid: 123 })).toBe(false);
    expect(validExecutionState({ ...state, pid: null })).toBe(true);
    expect(validExecutionState(null)).toBe(false);
  });

  it("requires all four owner dimensions and emits input-free stable refusals", () => {
    expect(validExecutionOwner(owner)).toBe(true);
    expect(validExecutionOwner({ ...owner, projectId: "" })).toBe(false);
    expect(validExecutionOwner({ ...owner, storeId: "control\ncharacter" })).toBe(false);
    expect(sameExecutionOwner(owner, { ...owner })).toBe(true);
    for (const key of ["projectId", "nodeRef", "ownershipToken", "storeId"] as const) {
      expect(sameExecutionOwner(owner, { ...owner, [key]: "other" })).toBe(false);
    }
    expect(repositoryExecutionFailure("REPOSITORY_EXECUTION_BUSY"))
      .toEqual({ ok: false, code: "REPOSITORY_EXECUTION_BUSY", detail: "REPOSITORY_EXECUTION_BUSY" });
  });

  it("requires a real controller identity with a positive integral process id", () => {
    expect(validExecutionController(controller)).toBe(true);
    expect(validExecutionController({ ...controller, controllerId: "" })).toBe(false);
    expect(validExecutionController({ ...controller, controllerPid: 0 })).toBe(false);
    expect(validExecutionController({ ...controller, controllerPid: 1.5 })).toBe(false);
    expect(validExecutionController(null)).toBe(false);
  });
});
