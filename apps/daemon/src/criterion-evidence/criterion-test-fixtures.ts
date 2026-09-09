import { expect } from "vitest";
import { GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { approveGate1, approvePlan, boundWorld, committedRevision, OPERATOR, submit } from "../planning/plan-reject-test-fixtures.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createCriterionEvidenceService } from "./criterion-service.js";
import type { CriterionEvidenceOptions } from "./criterion-service.js";

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
