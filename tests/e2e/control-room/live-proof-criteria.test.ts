import { describe, expect, it } from "vitest";
import { criterionEvidenceSettled, criterionQueueIdentity } from "./live-proof-criteria.js";

const receipt = (status: string) => ({ criterionId: "crit-a1", evidence: { status } });
const expected = { goalRef: "goal", planningRunRef: "plan", integratedSha: "sha", runRef: "verify-command" };
const view = (status: string, criteria = [receipt("PASSED")]) => ({
  goalRef: expected.goalRef, planningRunRef: expected.planningRunRef,
  integratedArtifact: { sha: expected.integratedSha }, criteria,
  run: { runRef: expected.runRef, integratedSha: expected.integratedSha, status },
});

describe("live criterion wrapper stop boundary", () => {
  it("keeps the wrapper alive after the last receipt until the run completes", () => {
    const criteria = [receipt("PASSED")];
    expect(criterionEvidenceSettled(view("RUNNING", criteria), expected)).toBe(false);
    expect(criterionEvidenceSettled(view("COMPLETED", criteria), expected)).toBe(true);
  });

  it("does not treat missing run or missing receipt as durable completion", () => {
    expect(criterionEvidenceSettled({ ...view("COMPLETED"), run: null }, expected)).toBe(false);
    expect(criterionEvidenceSettled({ ...view("COMPLETED"), criteria: [{ criterionId: "crit-a1" }] }, expected)).toBe(false);
    expect(criterionEvidenceSettled({ ...view("COMPLETED"), criteria: [{ evidence: null }] }, expected)).toBe(false);
    expect(criterionEvidenceSettled(view("COMPLETED", []), expected)).toBe(false);
  });

  it("returns a completed failed run promptly for the caller's exact pass assertion", () => {
    expect(criterionEvidenceSettled(view("COMPLETED", [receipt("FAILED")]), expected)).toBe(true);
  });

  it("rejects old completed evidence for another run, goal, plan, or source", () => {
    for (const key of ["runRef", "goalRef", "planningRunRef", "integratedSha"] as const) {
      expect(criterionEvidenceSettled(view("COMPLETED"), { ...expected, [key]: "different" }), key).toBe(false);
    }
    expect(criterionEvidenceSettled({ ...view("COMPLETED"), integratedArtifact: { sha: "different" } }, expected)).toBe(false);
  });

  it("requires the submitted verify command's accepted queue decision before inspecting prior evidence", () => {
    const ready = view("COMPLETED");
    const accepted = { ok: true, outcome: "ACCEPTED", decision: { commandId: "verify-command",
      disposition: "DECIDED", resultCode: "CRITERION_CHECK_QUEUED" } };
    expect(criterionQueueIdentity(ready, accepted, "verify-command")).toEqual(expected);
    expect(() => criterionQueueIdentity(ready, { ok: false, outcome: "PORT_REFUSED",
      refusal: { code: "CRITERION_CHECK_RUN_PENDING", layer: "CRITERION_EVIDENCE" } }, "verify-command"))
      .toThrow("CRITERION_CHECK_RUN_PENDING");
    expect(() => criterionQueueIdentity(ready, accepted, "another-command")).toThrow("not accepted");
  });

  it("reports blocked runs and refused reads immediately with their diagnostic identity", () => {
    expect(() => criterionEvidenceSettled(view("BLOCKED"), expected)).toThrow("BLOCKED");
    expect(() => criterionEvidenceSettled({ outcome: "REFUSED", code: "CRITERION_CHECK_UNREADABLE",
      layer: "CRITERION_EVIDENCE" }, expected)).toThrow("CRITERION_CHECK_UNREADABLE");
  });
});
