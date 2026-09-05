import { randomBytes } from "node:crypto";
import { createCriterionCheckExecutor } from "@moe/runner";
import type { CriterionCheckExecutor } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { readCriterionGoal } from "./criterion-goal.js";
import type { CriterionGoal } from "./criterion-goal.js";
import { readCriterionRuns } from "./criterion-run.js";
import { recordCriterionReceipt, readCriterionReceipt } from "./criterion-receipt.js";
import { measureCriterionProgram } from "./criterion-approval.js";
import { criterionHash, sameCriterionBinding } from "./criterion-codec.js";
import { commitCriterionRecord, criterionReceiptId, criterionRunsId } from "./criterion-storage.js";
import { CRITERION_PRINCIPAL, CRITERION_SCHEMA_VERSION } from "./criterion-contracts.js";
import type { CriterionRun, IntegratedCriterionArtifact } from "./criterion-contracts.js";
import { sameCriterionArtifact } from "./criterion-artifact.js";

export interface CriterionRunnerOptions {
  readonly store: SqliteEventStore;
  readonly projectId: string;
  readonly storeId: string;
  readonly workspace: string | null;
  readonly clock: () => string;
  readonly artifactFor: (goal: CriterionGoal) => IntegratedCriterionArtifact | null;
  readonly executor?: CriterionCheckExecutor;
  readonly repository?: RepositoryExecutionPort;
}
export const criterionExecutionRef = (run: CriterionRun): string => `criterion:v1:${criterionHash([
  run.binding.projectId, run.binding.goalRef, run.binding.planningRunRef, run.runRef,
])}`;

export function createCriterionRunner(options: CriterionRunnerOptions) {
  const { store, projectId } = options;
  const controller = { controllerId: randomBytes(32).toString("hex"), controllerPid: process.pid };
  const repository = options.repository ?? createRepositoryExecutionPort();
  const executor = options.executor ?? createCriterionCheckExecutor();
  const verifiedWorkspace = createVerifiedWorkspacePort();
  const contained = new Set<string>();
  let advancing: Promise<void> | null = null; let closed = false;
  const stillOwned = (handle: RepositoryExecutionHandle): boolean => {
    const read = repository.readOwned(handle.reservation.identity.root, options.storeId, projectId);
    return read.ok && read.handle !== null && read.handle.reservation.controllerId === controller.controllerId
      && read.handle.owner.ownershipToken === handle.owner.ownershipToken
      && read.handle.owner.nodeRef === handle.owner.nodeRef && read.handle.reservation.revision === handle.reservation.revision;
  };
  const transition = (handle: RepositoryExecutionHandle, phase: "CRITERION_VERIFYING" | "BLOCKED", run: CriterionRun) =>
    repository.transition(handle.reservation.identity.root, handle.owner, handle.reservation.revision,
      { ...handle.reservation, ...controller, phase, baselineId: criterionHash(run.artifact), sessionId: run.runRef, pid: null });
  const mark = (run: CriterionRun, status: CriterionRun["status"]): boolean => {
    const aggregate = criterionRunsId(projectId, run.binding.goalRef, run.binding.planningRunRef);
    return commitCriterionRecord(store, projectId, "internal.criterion.run", {
      commandId: `${run.runRef}-${status}`, correlationId: run.runRef, principalId: CRITERION_PRINCIPAL,
      expectedVersion: store.getAggregateVersion(aggregate), payload: { runRef: run.runRef, status },
    }, aggregate, `CriterionVerification${status}`, { ...run, status }, options.clock()).ok;
  };
  const block = (handle: RepositoryExecutionHandle, run: CriterionRun): void => {
    if (!stillOwned(handle)) return;
    const blocked = transition(handle, "BLOCKED", run);
    if (blocked.ok && run.status !== "COMPLETED" && run.status !== "BLOCKED") mark(run, "BLOCKED");
  };
  const release = (handle: RepositoryExecutionHandle) => repository.release(handle.reservation.identity.root,
    handle.owner, handle.reservation.revision, "CRITERIA_COMPLETED", controller.controllerId);
  const captureMatches = async (run: CriterionRun): Promise<boolean> => {
    const captured = await verifiedWorkspace.capture(run.artifact.root);
    return captured.ok && captured.binding.root === run.artifact.root && captured.binding.headSha === run.artifact.sha
      && captured.binding.treeSha === run.artifact.treeSha;
  };

  const execute = async (goal: CriterionGoal, run: CriterionRun, handle: RepositoryExecutionHandle): Promise<void> => {
    let currentRun = run;
    try {
      if (!sameCriterionArtifact(run.artifact, options.artifactFor(goal)) || !await captureMatches(run)) { block(handle, run); return; }
      const changed = transition(handle, "CRITERION_VERIFYING", run);
      if (!changed.ok) return;
      handle = changed.handle;
      if (!mark(run, "RUNNING")) { block(handle, run); return; }
      currentRun = { ...run, status: "RUNNING" };
      for (const approved of run.approvals) {
        if (!stillOwned(handle)) return;
        const program = measureCriterionProgram(approved.approval.program);
        if (program === null || program.sha256 !== approved.programSha256 || program.program !== approved.approval.program) {
          block(handle, currentRun); return;
        }
        const result = await executor.run({ program: program.program, programSha256: approved.programSha256, args: approved.approval.args,
          cwd: run.artifact.root, timeoutMs: approved.approval.timeoutMs }, (pid) => {
          if (!stillOwned(handle)) throw new Error("CRITERION_CONTROLLER_CHANGED");
          const attemptId = `criterion-attempt/${criterionHash([run.runRef, approved.criterionId])}`;
          const committed = commitCriterionRecord(store, projectId, "internal.criterion.started", {
            commandId: attemptId, correlationId: run.runRef, expectedVersion: 0, principalId: CRITERION_PRINCIPAL,
            payload: { runRef: run.runRef, criterionId: approved.criterionId, pid, controllerId: controller.controllerId },
          }, attemptId, "CriterionCheckStarted", { runRef: run.runRef, criterionId: approved.criterionId,
            pid, controllerId: controller.controllerId }, options.clock());
          if (!committed.ok) throw new Error(committed.code);
        });
        if (!stillOwned(handle)) return;
        const artifactCurrent = sameCriterionArtifact(run.artifact, options.artifactFor(goal)) && await captureMatches(run);
        const programAfter = measureCriterionProgram(approved.approval.program);
        const valid = artifactCurrent && programAfter?.sha256 === approved.programSha256;
        const status = result.containment !== "PROVEN" || !valid || result.exitCode === null || result.refusal !== null
          ? "UNKNOWN" : result.exitCode === 0 ? "PASSED" : "FAILED";
        if (!stillOwned(handle)) return;
        const receipt = recordCriterionReceipt(store, { version: CRITERION_SCHEMA_VERSION, binding: run.binding,
          artifact: run.artifact, approved, executorVersion: result.executorVersion,
          result: { receiptId: criterionReceiptId(run.runRef, approved.criterionId), runRef: run.runRef,
            sha: run.artifact.sha, treeSha: run.artifact.treeSha, status, exitCode: result.exitCode,
            outputSha256: result.outputSha256, byteCount: result.byteCount, finishedAt: options.clock() } });
        if (!receipt.ok || result.containment !== "PROVEN" || !valid || result.refusal?.code === "CRITERION_EXECUTOR_PID_BIND_FAILED") {
          block(handle, currentRun); return;
        }
      }
      const refreshed = readCriterionGoal(store, projectId, goal.binding.goalRef);
      if (!stillOwned(handle)) return;
      if (!refreshed.ok || !sameCriterionBinding(refreshed.binding, run.binding)
        || !sameCriterionArtifact(run.artifact, options.artifactFor(refreshed))) { block(handle, currentRun); return; }
      contained.add(run.runRef);
      if (!mark(currentRun, "COMPLETED")) { block(handle, currentRun); return; }
      release(handle);
    } catch { block(handle, currentRun); }
  };

  const advance = async (): Promise<void> => {
    if (closed || options.workspace === null) return;
    const graphs = activeCompiledGraphs(store, projectId, new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]));
    for (const graph of graphs) {
      const goal = readCriterionGoal(store, projectId, graph.goalRef); if (!goal.ok) continue;
      const runs = readCriterionRuns(store, goal); const run = runs?.at(-1); if (run === undefined) continue;
      const owned = repository.readOwned(options.workspace, options.storeId, projectId); if (!owned.ok) continue;
      let handle = owned.handle;
      if (handle !== null) {
        if (handle.owner.nodeRef !== criterionExecutionRef(run) || handle.reservation.phase === "BLOCKED") continue;
        if (handle.reservation.controllerId !== controller.controllerId) {
          try { process.kill(handle.reservation.controllerPid, 0); continue; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
          }
          const claimed = repository.claimController(options.workspace, handle.owner, handle.reservation.revision, controller);
          if (!claimed.ok) continue; handle = claimed.handle;
          if (run.status === "COMPLETED" && run.approvals.every((row) => readCriterionReceipt(store, run, row.criterionId) !== null)) {
            release(handle); continue;
          }
          block(handle, run); continue;
        }
        if (run.status === "COMPLETED" && contained.has(run.runRef)) { release(handle); continue; }
        // A running batch is never resumed from historical child PIDs or partial receipts.
        if (run.status !== "QUEUED") { block(handle, run); continue; }
      } else {
        if (run.status !== "QUEUED") continue;
        const acquired = repository.acquire(options.workspace, { projectId, storeId: options.storeId,
          nodeRef: criterionExecutionRef(run), ownershipToken: randomBytes(32).toString("hex") }, controller);
        if (!acquired.ok) continue; handle = acquired.handle;
      }
      if (handle.reservation.identity.root !== run.artifact.root) { block(handle, run); continue; }
      await execute(goal, run, handle);
    }
  };
  return {
    advance(): Promise<void> {
      advancing ??= advance().finally(() => { advancing = null; }); return advancing;
    },
    async close(): Promise<void> { closed = true; await executor.close(); await advancing; },
  };
}
