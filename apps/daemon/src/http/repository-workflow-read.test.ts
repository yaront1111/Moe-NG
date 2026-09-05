import { expect, it, vi } from "vitest";
import { authenticator, GOOD_CREDENTIAL } from "./http-test-fixtures.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { handleRepositoryWorkflowReadRequest } from "./repository-workflow-read.js";
const request = (body: unknown, credential: string | null = GOOD_CREDENTIAL) => ({
  body: new TextEncoder().encode(JSON.stringify(body)), credential, protocolVersion: WIRE_PROTOCOL_VERSION,
});
const criteria = vi.fn(() => ({ outcome: "REFUSED" as const, code: "CRITERION_CONTRACT_UNBOUND", layer: "CRITERION_EVIDENCE" as const }));
const recovery = vi.fn(() => ({ version: "moe-repository-recovery/1" as const, projectId: "project-1", reservations: [], code: null }));
const deps = () => ({ authenticator: authenticator(), repositoryWorkflows: { boundProjectId: "proj-0001", readCriteria: criteria, readRecovery: recovery } });
it("authenticates before either workflow reader", () => {
  criteria.mockClear(); recovery.mockClear();
  expect(handleRepositoryWorkflowReadRequest("CRITERIA", deps(), request({ goalRef: "goal-a" }, null))).toMatchObject({ kind: "REPLY", httpStatus: 401 });
  expect(criteria).not.toHaveBeenCalled(); expect(recovery).not.toHaveBeenCalled();
});
it("preserves criterion refusal provenance and exact goal selector", () => {
  expect(handleRepositoryWorkflowReadRequest("CRITERIA", deps(), request({ goalRef: "goal-a" }))).toEqual({ kind: "REPLY", httpStatus: 200,
    body: { outcome: "REFUSED", code: "CRITERION_CONTRACT_UNBOUND", layer: "CRITERION_EVIDENCE" } });
  expect(criteria).toHaveBeenLastCalledWith("goal-a");
});
it.each([{}, { goalRef: "" }, { goalRef: "goal-a", projectId: "forged" }, { goalRef: "goal-a", approval: "forged" }])("rejects malformed criterion selector %j", (body) => {
  criteria.mockClear();
  expect(handleRepositoryWorkflowReadRequest("CRITERIA", deps(), request(body))).toEqual({ kind: "LISTENER_REFUSAL", code: "LISTENER_CRITERIA_REQUEST_INVALID" });
  expect(criteria).not.toHaveBeenCalled();
});
it("recovery accepts only the empty object and never an owner supplied by the browser", () => {
  expect(handleRepositoryWorkflowReadRequest("RECOVERY", deps(), request({}))).toMatchObject({ kind: "REPLY", httpStatus: 200, body: { reservations: [] } });
  recovery.mockClear();
  expect(handleRepositoryWorkflowReadRequest("RECOVERY", deps(), request({ nodeRef: "forged" }))).toEqual({ kind: "LISTENER_REFUSAL", code: "LISTENER_REPOSITORY_RECOVERY_REQUEST_INVALID" });
  expect(recovery).not.toHaveBeenCalled();
});
it("refuses another project before invoking either reader", () => {
  const d = deps(); d.repositoryWorkflows.boundProjectId = "other"; criteria.mockClear();
  expect(handleRepositoryWorkflowReadRequest("CRITERIA", d, request({ goalRef: "goal-a" }))).toMatchObject({ body: { code: "REPOSITORY_WORKFLOW_READ_PROJECT_MISMATCH" } });
  expect(criteria).not.toHaveBeenCalled();
});
