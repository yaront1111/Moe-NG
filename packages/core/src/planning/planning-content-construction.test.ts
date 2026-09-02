import { describe, expect, it } from "vitest";

import { ACCEPTANCE_CONTRACT_VERSION } from "./acceptance-contract.js";
import {
  createAcceptanceContract, createAcceptanceCriterionContent,
  deriveAcceptanceCriterionContent,
} from "./acceptance-contract-codec.js";
import { PLAN_REVISION_VERSION } from "./plan-revision-contract.js";
import {
  createPlanExecutionContent, createPlanRevision, derivePlanExecutionContent,
} from "./plan-revision-codec.js";

const hex = (digit: string): string => digit.repeat(64);
const planContentDraft = () => ({
  affectedCriterionIds: ["criterion-a", "criterion-b"],
  affectedNodeIds: ["node-a", "node-b"],
  steps: [
    { description: "Analyse the graph.", kind: "ANALYSIS", stepId: "step-a" },
    { description: "Implement the change.", kind: "IMPLEMENTATION", stepId: "step-b" },
  ],
  verificationRecipeRefs: ["verify-a", "verify-b"],
});
const obligation = (id: string, statement: string, kind: string) => ({
  criterionId: `criterion-${id}`,
  evidenceRequirements: [{
    evidenceRef: `evidence-${id}`, kind, requirementId: `requirement-${id}`,
  }],
  statement,
  verificationRecipeRefs: [`recipe-${id}`],
});
const criterionContentDraft = () => ({
  nodeKind: "LEAF",
  obligations: [
    obligation("a", "The focused suite passes.", "ARTIFACT"),
    obligation("b", "The repository typecheck passes.", "VERIFICATION_RECEIPT"),
  ],
});
const refusalOf = (
  result: { readonly code?: string; readonly layer?: string; readonly ok: boolean },
) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
};
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Reflect.ownKeys(value).every(
    (key) => deeplyFrozen((value as Readonly<Record<PropertyKey, unknown>>)[key]),
  );
}

describe("graph-independent planning content construction", () => {
  it("constructs execution content and rederives the final graph-bound identity exactly", () => {
    const result = createPlanExecutionContent(planContentDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.content)).toStrictEqual([
      "affectedCriterionIds", "affectedNodeIds", "steps", "verificationRecipeRefs", "version",
    ]);
    expect(Object.keys(result.content)).not.toEqual(expect.arrayContaining([
      "authorRef", "graphBinding", "parentRevisionId", "revisionId",
    ]));
    expect(result.content.version).toBe(PLAN_REVISION_VERSION);
    const final = createPlanRevision({
      ...planContentDraft(), approvalState: "APPROVED", authorRef: "principal-a",
      graphBinding: { graphContentHash: hex("a"), graphRevisionRef: "graph-a" },
      parentRevisionId: null, rejectionRef: null, revisionId: "plan-a",
    });
    if (!final.ok) throw new Error(`${final.code}@${final.layer}`);
    const derived = derivePlanExecutionContent(final.revision);
    if (!derived.ok) throw new Error(`${derived.code}@${derived.layer}`);
    expect(result.planExecutionContentDigest).toBe(derived.digest);
    expect(createPlanExecutionContent(result.content)).toStrictEqual(result);
    expect(deeplyFrozen(result)).toBe(true);
  });

  it("refuses a caller identity or unsupported execution-content version", () => {
    const created = createPlanExecutionContent(planContentDraft());
    if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
    expect(refusalOf(createPlanExecutionContent({ ...created.content,
      version: "moe-plan-revision/2" }))).toStrictEqual([
      "PLAN_REVISION_VERSION_UNSUPPORTED", "PLAN_REVISION_VERSION",
    ]);
    expect(refusalOf(createPlanExecutionContent({ ...created.content,
      planExecutionContentDigest: hex("f") }))).toStrictEqual([
      "PLAN_REVISION_MALFORMED", "PLAN_REVISION_ADMISSION",
    ]);
  });

  it("constructs sorted criterion identities and rederives the final contract exactly", () => {
    const result = createAcceptanceCriterionContent(criterionContentDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.content)).toStrictEqual(["nodeKind", "obligations", "version"]);
    expect(Object.keys(result.content)).not.toEqual(expect.arrayContaining([
      "authorRef", "contractId", "graphContentHash", "graphRevisionRef", "nodeIds",
    ]));
    expect(result.content.version).toBe(ACCEPTANCE_CONTRACT_VERSION);
    expect(result.criteria.map(({ criterionId }) => criterionId))
      .toStrictEqual(["criterion-a", "criterion-b"]);
    const final = createAcceptanceContract({
      applicability: { graphContentHash: hex("a"), graphRevisionRef: "graph-a",
        nodeIds: ["node-a", "node-b"], nodeKind: "LEAF" },
      authorRef: "principal-a", contractId: "contract-a",
      obligations: criterionContentDraft().obligations,
    });
    if (!final.ok) throw new Error(`${final.code}@${final.layer}`);
    const derived = deriveAcceptanceCriterionContent(final.contract);
    if (!derived.ok) throw new Error(`${derived.code}@${derived.layer}`);
    expect(result.criteria).toStrictEqual(derived.criteria);
    expect(createAcceptanceCriterionContent(result.content)).toStrictEqual(result);
    expect(deeplyFrozen(result)).toBe(true);
  });

  it("refuses caller criterion identities or an unsupported content version", () => {
    const created = createAcceptanceCriterionContent(criterionContentDraft());
    if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
    expect(refusalOf(createAcceptanceCriterionContent({ ...created.content,
      version: "moe-acceptance-contract/2" }))).toStrictEqual([
      "ACCEPTANCE_CONTRACT_VERSION_UNSUPPORTED", "ACCEPTANCE_CONTRACT_VERSION",
    ]);
    expect(refusalOf(createAcceptanceCriterionContent({
      ...created.content, criteria: created.criteria,
    }))).toStrictEqual([
      "ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION",
    ]);
  });
});
