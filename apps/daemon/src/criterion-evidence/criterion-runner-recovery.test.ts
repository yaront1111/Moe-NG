import { afterEach, describe, expect, it, vi } from "vitest";
import type { CriterionCheckExecutor, CriterionCheckExecutionResult } from "@moe/runner";
import { GOAL_ID, PROJECT_ID, RUN_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import type { RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { criterionWorld } from "./criterion-test-fixtures.js";
import { createCriterionRunner } from "./criterion-runner.js";
import { readCriterionGoal } from "./criterion-goal.js";
import { readCriterionRuns } from "./criterion-run.js";
import { readCriterionReceipt } from "./criterion-receipt.js";
import { criterionHash } from "./criterion-codec.js";
import { criterionRunsId } from "./criterion-storage.js";

vi.mock("../repository/git-verified-workspace-port.js", () => ({ createVerifiedWorkspacePort: () => ({ capture: async (root: string) => ({
  ok: true, binding: { root, headSha: "a".repeat(40), treeSha: "b".repeat(40) },
}) }) }));
afterEach(() => { vi.restoreAllMocks(); closeStores(); });
const artifact = { root: "D:/criterion-recovery", sha: "a".repeat(40), treeSha: "b".repeat(40) };
const NOW = "2026-09-06T00:00:00.000Z";
const passed: CriterionCheckExecutionResult = { executorVersion: "moe-criterion-check-executor/1", containment: "PROVEN",
  exitCode: 0, outputSha256: "c".repeat(64), byteCount: 8, refusal: null };

function fence() {
  let held: RepositoryExecutionHandle | null = null; let permitRelease = true; let released = 0;
  const port: RepositoryExecutionPort = {
    acquire: (_workspace, owner, controller) => {
      if (held !== null) return { ok: false, code: "REPOSITORY_EXECUTION_BUSY", detail: "busy" };
      held = { owner, reservation: { ...owner, ...controller, identity: { root: artifact.root, gitDirectory: `${artifact.root}/.git` },
        phase: "RESERVED", baselineId: null, sessionId: null, pid: null, revision: 1 } };
      return { ok: true, handle: held };
    },
    inspect: () => ({ ok: true, reservation: held?.reservation ?? null }),
    readOwned: () => ({ ok: true, handle: held }),
    claimController: (_workspace, owner, revision, controller) => {
      if (held?.owner !== owner || held.reservation.revision !== revision) throw new Error("invalid claim");
      held = { ...held, reservation: { ...held.reservation, ...controller, revision: revision + 1 } };
      return { ok: true, handle: held };
    },
    transition: (_workspace, owner, revision, state) => {
      if (held?.owner !== owner || held.reservation.revision !== revision
        || held.reservation.controllerId !== state.controllerId) return { ok: false, code: "REPOSITORY_EXECUTION_CONTROLLER_MISMATCH", detail: "mismatch" };
      held = { ...held, reservation: { ...held.reservation, ...state, revision: revision + 1 } };
      return { ok: true, handle: held };
    },
    release: (_workspace, owner, revision, reason, controllerId) => {
      expect(reason).toBe("CRITERIA_COMPLETED"); expect(held?.owner).toBe(owner);
      expect(held?.reservation.revision).toBe(revision); expect(held?.reservation.controllerId).toBe(controllerId);
      if (!permitRelease) return { ok: false, code: "REPOSITORY_EXECUTION_UNKNOWN", detail: "blocked release" };
      released += 1; held = null; return { ok: true, released: true };
    },
  };
  return { port, held: () => held, released: () => released, permitRelease: (value: boolean) => { permitRelease = value; },
    replaceController: () => {
      if (held === null) throw new Error("no hold");
      held = { ...held, reservation: { ...held.reservation, controllerId: "replacement", controllerPid: 98765, revision: held.reservation.revision + 1 } };
    } };
}
function setup(executor: CriterionCheckExecutor) {
  const reservation = fence();
  const world = criterionWorld({ workspace: artifact.root, readIntegrated: () => artifact, executor, repository: reservation.port });
  world.approveAll(); expect(world.service.verify(world.verifyInput(artifact.sha))).toMatchObject({ ok: true });
  const goal = readCriterionGoal(world.store, PROJECT_ID, GOAL_ID); if (!goal.ok) throw new Error(goal.code);
  const run = () => { const value = readCriterionRuns(world.store, goal)?.at(-1); if (value === undefined) throw new Error("unreadable run"); return value; };
  const restarted = () => createCriterionRunner({ store: world.store, projectId: PROJECT_ID, storeId: "test-store", workspace: artifact.root,
    clock: () => NOW, artifactFor: () => artifact, executor, repository: reservation.port });
  return { ...world, reservation, run, restarted };
}
const deadController = () => vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });

describe("criterion runner recovery authority", () => {
  it("retries release after durable completion without executing checks again, including a replacement controller", async () => {
    let calls = 0; const executor: CriterionCheckExecutor = { async run(_input, started) { calls += 1; started(1234); return passed; }, async close() {} };
    const w = setup(executor); w.reservation.permitRelease(false);
    await w.service.advance(); expect(w.run().status).toBe("COMPLETED"); expect(calls).toBe(2);
    expect(w.reservation.held()?.reservation.phase).toBe("CRITERION_VERIFYING");
    w.reservation.permitRelease(true); deadController(); await w.restarted().advance();
    expect(w.reservation.released()).toBe(1); expect(calls).toBe(2); expect(w.run().status).toBe("COMPLETED");
  });
  it("records unknown containment and retains the repository even when exit status is zero", async () => {
    let calls = 0; const w = setup({ async run(_input, started) { calls += 1; started(1234); return { ...passed, containment: "UNKNOWN" }; }, async close() {} });
    await w.service.advance(); expect(w.run().status).toBe("BLOCKED"); expect(calls).toBe(1);
    expect(readCriterionReceipt(w.store, w.run(), "crit-api")?.result.status).toBe("UNKNOWN");
    expect(w.reservation.held()?.reservation.phase).toBe("BLOCKED"); expect(w.reservation.released()).toBe(0);
  });
  it("executes the immutable queued approval despite a later approved command replacing the catalog entry", async () => {
    const arguments_: readonly string[][] = [];
    const w = setup({ async run(input, started) { (arguments_ as string[][]).push([...input.args]); started(1234); return passed; }, async close() {} });
    expect(w.service.approve({ ...w.approvalInput("crit-api", 2, ["--help"]), commandId: "new-api-approval" })).toMatchObject({ ok: true });
    await w.service.advance(); expect(arguments_).toEqual([["--version"], ["--version"]]);
    expect(w.run().status).toBe("COMPLETED"); expect(w.reservation.released()).toBe(1);
  });
  it("blocks after the durable onStarted CAS fails and does not execute the next criterion", async () => {
    let calls = 0; let bindingFailed = false;
    const w = setup({ async run(_input, started) { calls += 1;
      try { started(1234); } catch { bindingFailed = true; }
      return { ...passed, exitCode: null,
        refusal: { code: "CRITERION_EXECUTOR_PID_BIND_FAILED", layer: "CRITERION_EXECUTOR" } };
    }, async close() {} });
    const attemptId = `criterion-attempt/${criterionHash([w.run().runRef, "crit-api"])}`;
    w.store.commitExpectedVersionDecision({ commandKind: "internal.criterion.started", committedResultBytes: new TextEncoder().encode("{}"),
      correlationId: "competing-attempt", decidedAt: NOW, expectedVersion: 0, targetAggregateId: attemptId,
      key: { projectId: PROJECT_ID, principalId: "daemon:criterion-verifier", commandId: "competing-attempt" },
      requestBytes: new TextEncoder().encode("{}"), events: [{ eventId: "competing-attempt", eventType: "CriterionCheckStarted", payload: new TextEncoder().encode("{}") }] });
    await w.service.advance(); expect(bindingFailed).toBe(true); expect(calls).toBe(1); expect(w.run().status).toBe("BLOCKED");
    expect(w.reservation.held()?.reservation.phase).toBe("BLOCKED"); expect(w.reservation.released()).toBe(0);
  });
  it("blocks a dead controller's partial batch instead of treating historical PIDs and one receipt as completion", async () => {
    let calls = 0; let finish: ((result: CriterionCheckExecutionResult) => void) | undefined;
    let reachedPartial: (() => void) | undefined; const partial = new Promise<void>((resolve) => { reachedPartial = resolve; });
    const w = setup({ async run(_input, started) {
      calls += 1; started(1234);
      if (calls === 1) return passed;
      reachedPartial?.(); return new Promise((resolve) => { finish = resolve; });
    }, async close() {} });
    const advancing = w.service.advance(); await partial;
    expect(w.run().status).toBe("RUNNING");
    expect(readCriterionReceipt(w.store, w.run(), "crit-api")?.result.status).toBe("PASSED");
    expect(readCriterionReceipt(w.store, w.run(), "crit-ui")).toBeNull();
    deadController(); await w.restarted().advance();
    expect(w.run().status).toBe("BLOCKED"); expect(w.reservation.held()?.reservation.phase).toBe("BLOCKED");
    expect(w.reservation.released()).toBe(0); expect(calls).toBe(2);
    finish?.({ ...passed, containment: "UNKNOWN" }); await advancing;
    expect(w.reservation.released()).toBe(0); expect(calls).toBe(2);
  });
  it("does not adopt a live controller's running batch", async () => {
    let calls = 0; let finish: ((result: CriterionCheckExecutionResult) => void) | undefined;
    let startedWork: (() => void) | undefined; const began = new Promise<void>((resolve) => { startedWork = resolve; });
    const w = setup({ async run(_input, started) {
      calls += 1; started(1234); if (calls !== 1) return passed;
      startedWork?.(); return new Promise((resolve) => { finish = resolve; });
    }, async close() {} });
    const advancing = w.service.advance(); await began;
    const owner = w.reservation.held()?.reservation.controllerId;
    vi.spyOn(process, "kill").mockImplementation(() => true); await w.restarted().advance();
    expect(w.reservation.held()?.reservation.controllerId).toBe(owner); expect(w.run().status).toBe("RUNNING");
    expect(calls).toBe(1); expect(w.reservation.released()).toBe(0);
    finish?.(passed); await advancing;
    expect(w.run().status).toBe("COMPLETED"); expect(w.reservation.released()).toBe(1); expect(calls).toBe(2);
  });
  it("does not let an old callback mark or block the run after its reservation controller was replaced", async () => {
    let finish: ((result: CriterionCheckExecutionResult) => void) | undefined;
    let startedWork: (() => void) | undefined;
    const began = new Promise<void>((resolve) => { startedWork = resolve; });
    const w = setup({ async run(_input, started) { started(1234); startedWork?.(); return new Promise((resolve) => { finish = resolve; }); }, async close() {} });
    const advancing = w.service.advance(); await began;
    const before = w.store.getAggregateVersion(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID));
    w.reservation.replaceController(); finish?.({ ...passed, containment: "UNKNOWN" }); await advancing;
    expect(w.reservation.held()?.reservation.controllerId).toBe("replacement");
    expect(w.reservation.held()?.reservation.phase).toBe("CRITERION_VERIFYING");
    expect(w.store.getAggregateVersion(criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID))).toBe(before);
    expect(w.run().status).toBe("RUNNING");
  });
});
