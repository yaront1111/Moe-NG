import { describe, expect, it } from "vitest";
import * as model from "../index.js";
import type { ProductArtifact, ProductCheck, ProductRequirementsInput, ProductScope } from "./contracts.js";

const scope: ProductScope = { connectionId: "session-a", projectId: "project", goalId: "goal-a", plane: "V1" };
const contractRef = { plane: "V1", contractId: "contract-a", revisionId: "revision-a", revisionDigest: "digest-a" } as const;
const artifact = (id: string, patch: Partial<ProductArtifact> = {}): ProductArtifact => ({
  id, scope, kind: "PREVIEW", title: "Working preview", contractRef, planningRunRef: "run-a", sha: "sha-a",
  availability: "PRESENT", ...patch,
});
const check = (patch: Partial<ProductCheck> = {}): ProductCheck => ({
  scope, contractRef, planningRunRef: "run-a", graphContentHash: "graph-a", criterionId: "criterion-a",
  sha: "sha-a", receiptId: "receipt-a", status: "PASSED", ...patch,
});
const requirements = (patch: Partial<ProductRequirementsInput> = {}): ProductRequirementsInput => ({
  scope, contractRef, planningRunRef: "run-a", graphContentHash: "graph-a", sha: "sha-a", availability: "PRESENT",
  requirements: [{ requirementId: "requirement-a", statement: "Request an appointment", criteria: [
    { criterionId: "criterion-a", statement: "Request reaches the shop" },
  ] }], implementationLinks: [], checks: [], ...patch,
});

describe("product artifact selection", () => {
  it("exposes the pure artifact selector", () => { expect(model).toHaveProperty("selectProductArtifact", expect.any(Function)); });
  it("keeps the inspected candidate when a new candidate arrives", () => {
    const selected = model.selectProductArtifact({ scope, artifacts: [artifact("old"), artifact("new", { sha: "sha-b" })], selectedId: "old", preferredId: "new" });
    expect(selected.status).toBe("SELECTED");
    expect(selected.artifact?.id).toBe("old");
  });
  it("keeps an unavailable selection rather than silently opening another version", () => {
    const selected = model.selectProductArtifact({ scope, artifacts: [artifact("new")], selectedId: "old" });
    expect(selected).toMatchObject({ status: "UNAVAILABLE", selectedId: "old", artifact: null });
  });
  it.each(["connectionId", "projectId", "goalId", "plane"] as const)("does not borrow an artifact across %s", (key) => {
    const foreignScope = { ...scope, [key]: key === "plane" ? "V2" : "other" } as ProductScope;
    const selected = model.selectProductArtifact({ scope, artifacts: [artifact("other", { scope: foreignScope })], selectedId: "other" });
    expect(selected.status).toBe("UNAVAILABLE");
    expect(selected.artifact).toBeNull();
  });
  it("uses an explicit preferred artifact on first visit without inventing chronology", () => {
    expect(model.selectProductArtifact({ scope, artifacts: [artifact("a"), artifact("b")], preferredId: "a" }).artifact?.id).toBe("a");
  });
});

describe("requirement evidence applicability", () => {
  it("exposes the pure requirement model", () => { expect(model).toHaveProperty("buildProductRequirements", expect.any(Function)); });
  it("counts only exact candidate criterion checks and names that denominator", () => {
    const result = model.buildProductRequirements(requirements({ checks: [check()] }));
    expect(result.requirements[0]?.state).toBe("PASSED");
    expect(result.readiness).toMatchObject({ passed: 1, total: 1, failed: 0, label: "1 of 1 criterion checks passed for this candidate" });
    expect(Object.isFrozen(result.requirements[0]?.criteria)).toBe(true);
  });
  it.each([
    { scope: { ...scope, goalId: "goal-b" } }, { scope: { ...scope, connectionId: "session-b" } },
    { planningRunRef: "run-b" }, { graphContentHash: "graph-b" },
    { contractRef: { ...contractRef, revisionDigest: "digest-b" } },
    { contractRef: { ...contractRef, plane: "V2" as const } },
  ])("does not credit foreign scope, contract or run: %j", (patch) => {
    const result = model.buildProductRequirements(requirements({ checks: [check(patch)] }));
    expect(result.readiness.passed).toBe(0);
    expect(result.requirements[0]?.state).not.toBe("PASSED");
  });
  it("marks a check on older bytes as needing checking again", () => {
    const result = model.buildProductRequirements(requirements({ sha: "sha-b", checks: [check()] }));
    expect(result.requirements[0]?.state).toBe("NEEDS_CHECKING_AGAIN");
    expect(result.readiness.passed).toBe(0);
  });
  it("never infers success when no candidate is identified", () => {
    const result = model.buildProductRequirements(requirements({ sha: null, checks: [check()] }));
    expect(result.readiness.passed).toBe(0);
    expect(result.readiness.label).toBe("No candidate selected; 1 criterion checks defined");
  });
  it("distinguishes failed, unknown, planned and implemented unchecked work", () => {
    expect(model.buildProductRequirements(requirements({ checks: [check({ status: "FAILED" })] })).requirements[0]?.state).toBe("FAILED");
    expect(model.buildProductRequirements(requirements({ checks: [check({ status: "UNKNOWN" })] })).requirements[0]?.state).toBe("UNKNOWN");
    const link = { scope, contractRef, planningRunRef: "run-a", graphContentHash: "graph-a", criterionId: "criterion-a", nodeKey: "node-a", state: "PLANNED" as const };
    expect(model.buildProductRequirements(requirements({ implementationLinks: [link] })).requirements[0]?.state).toBe("IN_PROGRESS");
    expect(model.buildProductRequirements(requirements({ implementationLinks: [{ ...link, state: "IMPLEMENTED" }] })).requirements[0]?.state).toBe("IMPLEMENTED_UNCHECKED");
    expect(model.buildProductRequirements(requirements()).requirements[0]?.state).toBe("NOT_IMPLEMENTED");
  });
  it("retains read failure instead of presenting a clean empty result", () => {
    const result = model.buildProductRequirements(requirements({ availability: "UNREADABLE", checks: [check()] }));
    expect(result.readiness.passed).toBe(0);
    expect(result.readiness.state).toBe("UNKNOWN");
    expect(result.requirements[0]?.state).toBe("UNKNOWN");
  });
  it("does not pass an empty contract or an unchecked criterion", () => {
    expect(model.buildProductRequirements(requirements({ requirements: [] })).readiness.state).toBe("UNKNOWN");
    const result = model.buildProductRequirements(requirements({ requirements: [{ requirementId: "empty", statement: "Undefined", criteria: [] }] }));
    expect(result.requirements[0]?.state).toBe("UNKNOWN");
  });
  it("keeps implementation unknown when no exact run or graph is available", () => {
    expect(model.buildProductRequirements(requirements({ planningRunRef: null })).requirements[0]?.state).toBe("UNKNOWN");
    expect(model.buildProductRequirements(requirements({ graphContentHash: null })).requirements[0]?.state).toBe("UNKNOWN");
  });
  it("does not count repeated criterion identities as separate checks", () => {
    const row = requirements().requirements[0]!;
    const result = model.buildProductRequirements(requirements({ requirements: [row, { ...row, requirementId: "duplicate" }], checks: [check()] }));
    expect(result.readiness.total).toBe(1);
    expect(result.readiness.passed).toBe(0);
    expect(result.requirements.map((item) => item.state)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });
  it("refuses to choose between conflicting receipts by array order", () => {
    const result = model.buildProductRequirements(requirements({ checks: [check(), check({ receiptId: "receipt-b", status: "FAILED" })] }));
    expect(result.requirements[0]?.state).toBe("FAILED");
    expect(result.readiness.passed).toBe(0);
  });
});
