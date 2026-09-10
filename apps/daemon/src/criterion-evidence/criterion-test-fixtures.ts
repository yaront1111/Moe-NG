import { expect } from "vitest";
import type { SqliteEventStore } from "@moe/store";
import { GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { approveGate1, approvePlan, boundWorld, committedRevision, OPERATOR, submit } from "../planning/plan-reject-test-fixtures.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { CRITERION_EXECUTOR_VERSION } from "./criterion-approval.js";
import { CRITERION_PRINCIPAL, CRITERION_SCHEMA_VERSION } from "./criterion-contracts.js";
import type { IntegratedCriterionArtifact } from "./criterion-contracts.js";
import { readCriterionGoal } from "./criterion-goal.js";
import { recordCriterionReceipt } from "./criterion-receipt.js";
import { readCriterionRuns } from "./criterion-run.js";
import { createCriterionEvidenceService } from "./criterion-service.js";
import type { CriterionEvidenceOptions } from "./criterion-service.js";
import { commitCriterionRecord, criterionCatalogId, criterionReceiptId, criterionRunsId } from "./criterion-storage.js";

export function criterionWorld(overrides: Partial<Omit<CriterionEvidenceOptions, "store" | "projectId">> = {}) {
  const store = boundWorld(); const ref = committedRevision(store);
  approveGate1(store, ref); expect(submit(store, ref).ok).toBe(true); approvePlan(store, RUN_ID);
  const human = createOperatorSessionHandshakePort({ store, projectId: PROJECT_ID, operatorPrincipalId: OPERATOR,
    capabilities: OPERATOR_CAPABILITIES, clock: () => Date.parse("2026-09-06T00:00:00.000Z"), sessionTtlMs: 60000 }).mint();
  if (!human.ok) throw new Error(human.code);
  const service = createCriterionEvidenceService({ store, projectId: PROJECT_ID, storeId: "test-store",
    workspace: null, clock: () => "2026-09-06T00:00:00.000Z", ...overrides });
  const approvalInput = (criterionId: string, expectedVersion: number, args: readonly string[] = ["--version"]) => ({
    commandId: `approve-${criterionId}`, correlationId: "criterion", expectedVersion, principalId: human.principalId,
    payload: { goalRef: GOAL_ID, planningRunRef: RUN_ID, contractRef: ref, criterionId,
      check: { checkId: `${criterionId}-check`, checkVersion: "1", program: process.execPath, args, timeoutMs: 30000 } },
  });
  const approveAll = (args: readonly string[] = ["--version"]) => {
    expect(service.approve(approvalInput("crit-api", 0, args))).toMatchObject({ ok: true });
    expect(service.approve(approvalInput("crit-ui", 1, args))).toMatchObject({ ok: true });
  };
  const verifyInput = (sha: string, expectedVersion = 0) => ({ commandId: `verify-${expectedVersion}`, correlationId: "criterion",
    expectedVersion, principalId: human.principalId,
    payload: { goalRef: GOAL_ID, planningRunRef: RUN_ID, contractRef: ref, integratedSha: sha,
      approvals: ["crit-api", "crit-ui"].map((criterionId) => ({ criterionId, approvalId: `approve-${criterionId}` })) },
  });
  return { store, ref, service, human, approvalInput, approveAll, verifyInput };
}

/**
 * A COMPLETED criterion run whose every approved check PASSED at `artifact` — the durable state a
 * goal reaches once its criterion checks are approved and verified, and the state the release
 * dossier now demands before it will call a criterion verified.
 *
 * PRODUCTION WRITERS THROUGHOUT: `approveCriterionCheck` through the service, the production
 * queue, and `recordCriterionReceipt`. The run's RUNNING/COMPLETED records are committed exactly
 * the way `criterion-runner.ts`'s module-private `mark` commits them — the recipe
 * `criterion-read.test.ts` already uses. NO CHECK IS EXECUTED here: driving `advance()` needs a
 * repository reservation and a git-backed verified-workspace capture, which is a different
 * subsystem's fixture, and every consumer of this helper is testing a READER.
 *
 * Answers the criterion ids that now carry a PASSED receipt, so a caller asserts against what was
 * actually seeded rather than against a transcribed list.
 */
export function seedPassedCriterionReceipts(store: SqliteEventStore, options: {
  readonly artifact: IntegratedCriterionArtifact;
  readonly decidedAt: string;
  readonly goalRef: string;
  readonly projectId: string;
}): readonly string[] {
  const { artifact, decidedAt, goalRef, projectId } = options;
  const goal = readCriterionGoal(store, projectId, goalRef);
  if (!goal.ok) throw new Error(`criterion goal unreadable: ${goal.code}`);
  const human = createOperatorSessionHandshakePort({ store, projectId, operatorPrincipalId: OPERATOR,
    capabilities: OPERATOR_CAPABILITIES, clock: () => Date.parse(decidedAt), sessionTtlMs: 60_000 }).mint();
  if (!human.ok) throw new Error(`criterion approver unmintable: ${human.code}`);
  const service = createCriterionEvidenceService({ store, projectId, storeId: "criterion-seed",
    workspace: artifact.root, clock: () => decidedAt, readIntegrated: () => artifact });
  const { planningRunRef } = goal.binding;
  const catalog = criterionCatalogId(projectId, goalRef, planningRunRef);
  const approvalId = (criterionId: string): string => `seed-approve-${criterionId}`;
  for (const criterion of goal.criteria) {
    // The expected version is READ, never counted: a hard-coded index breaks the moment a goal
    // carries a different number of criteria.
    const approved = service.approve({ commandId: approvalId(criterion.criterionId),
      correlationId: "criterion-seed", expectedVersion: store.getAggregateVersion(catalog),
      principalId: human.principalId,
      payload: { goalRef, planningRunRef, contractRef: goal.binding.contractRef,
        criterionId: criterion.criterionId,
        check: { args: ["--version"], checkId: `${criterion.criterionId}-check`, checkVersion: "1",
          program: process.execPath, timeoutMs: 30_000 } } });
    if (!approved.ok) throw new Error(`criterion approval refused: ${approved.code}`);
  }
  const runs = criterionRunsId(projectId, goalRef, planningRunRef);
  const queued = service.verify({ commandId: "seed-verify", correlationId: "criterion-seed",
    expectedVersion: store.getAggregateVersion(runs), principalId: human.principalId,
    payload: { approvals: goal.criteria.map((criterion) => ({ approvalId: approvalId(criterion.criterionId),
      criterionId: criterion.criterionId })), contractRef: goal.binding.contractRef, goalRef,
    integratedSha: artifact.sha, planningRunRef } });
  if (!queued.ok) throw new Error(`criterion verification queue refused: ${queued.code}`);
  const run = readCriterionRuns(store, goal)?.at(-1);
  if (run === undefined) throw new Error("the criterion queue left no run to complete");
  const mark = (status: "RUNNING" | "COMPLETED"): void => {
    const committed = commitCriterionRecord(store, projectId, "internal.criterion.run", {
      commandId: `${run.runRef}-${status}`, correlationId: run.runRef, principalId: CRITERION_PRINCIPAL,
      expectedVersion: store.getAggregateVersion(runs), payload: { runRef: run.runRef, status },
    }, runs, `CriterionVerification${status}`, { ...run, status }, decidedAt);
    if (!committed.ok) throw new Error(`criterion run ${status} refused: ${committed.code}`);
  };
  mark("RUNNING");
  for (const approved of run.approvals) {
    const recorded = recordCriterionReceipt(store, { version: CRITERION_SCHEMA_VERSION,
      approved, artifact: run.artifact, binding: run.binding, executorVersion: CRITERION_EXECUTOR_VERSION,
      result: { byteCount: approved.criterionId.length, exitCode: 0, finishedAt: decidedAt,
        outputSha256: "0".repeat(64), receiptId: criterionReceiptId(run.runRef, approved.criterionId),
        runRef: run.runRef, sha: run.artifact.sha, status: "PASSED", treeSha: run.artifact.treeSha } });
    if (!recorded.ok) throw new Error(`criterion receipt refused: ${recorded.code}`);
  }
  mark("COMPLETED");
  return goal.criteria.map((criterion) => criterion.criterionId);
}
