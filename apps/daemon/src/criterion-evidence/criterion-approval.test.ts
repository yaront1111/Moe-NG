import { afterEach, describe, expect, it } from "vitest";
import { closeStores, GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { approveGate1, approvePlan, boundWorld, committedRevision, OPERATOR, submit } from "../planning/plan-reject-test-fixtures.js";
import { createCriterionEvidenceService } from "./criterion-service.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";

afterEach(closeStores);
function world() {
  const store = boundWorld(); const ref = committedRevision(store);
  approveGate1(store, ref); expect(submit(store, ref).ok).toBe(true); approvePlan(store, RUN_ID);
  const human = createOperatorSessionHandshakePort({ store, projectId: PROJECT_ID, operatorPrincipalId: OPERATOR,
    capabilities: OPERATOR_CAPABILITIES, clock: () => Date.parse("2026-09-06T00:00:00.000Z"), sessionTtlMs: 60000 }).mint();
  if (!human.ok) throw new Error(human.code);
  const service = createCriterionEvidenceService({ store, projectId: PROJECT_ID, storeId: "test-store",
    workspace: null, clock: () => "2026-09-06T00:00:00.000Z" });
  const input = { commandId: "approve-api", correlationId: "criterion", expectedVersion: 0, principalId: human.principalId,
    payload: { goalRef: GOAL_ID, planningRunRef: RUN_ID, contractRef: ref, criterionId: "crit-api",
      check: { checkId: "api-contract", checkVersion: "1", program: process.execPath, args: ["--version"], timeoutMs: 10000 } } };
  return { store, ref, service, input };
}
describe("operator criterion check approval", () => {
  it("records exact check approval durably and replays without appending", () => {
    const { service, input } = world();
    expect(service.approve(input)).toMatchObject({ ok: true, disposition: "DECIDED", resultCode: "CRITERION_CHECK_APPROVED" });
    expect(service.approve(input)).toMatchObject({ ok: true, disposition: "REPLAYED" });
  });
  it("refuses a caller without a durable HUMAN principal", () => {
    const { service, input } = world();
    expect(service.approve({ ...input, principalId: "agent-unknown" })).toMatchObject({
      ok: false, code: "CRITERION_CHECK_HUMAN_REQUIRED", layer: "CRITERION_EVIDENCE",
    });
  });
  it("a check cannot cross a contract revision or goal scope", () => {
    const { service, input } = world();
    expect(service.approve({ ...input, payload: { ...input.payload, contractRef: {
      ...input.payload.contractRef, revisionDigest: "f".repeat(64),
    } } })).toMatchObject({ ok: false, code: "CRITERION_CHECK_SCOPE_MISMATCH" });
    expect(service.approve({ ...input, payload: { ...input.payload, goalRef: "goal-other" } })).toMatchObject({ ok: false });
  });
  it("rejects caller-authored executor digest and criterion verdicts before storing approval", () => {
    const { service, input } = world();
    for (const extra of [{ proof: "PASSED" }, { executorDigest: "e".repeat(64) }]) {
      expect(service.approve({ ...input, payload: { ...input.payload, ...extra } })).toMatchObject({
        ok: false, code: "CRITERION_CHECK_MALFORMED",
      });
    }
  });
});
