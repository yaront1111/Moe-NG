import { describe, expect, it } from "vitest";

import {
  decodeAcceptanceCriteriaContentBytes, encodeAcceptanceCriteriaContent,
} from "./acceptance-contract-codec.js";
import {
  decodePlanExecutionContentBytes, encodePlanExecutionContent,
} from "./plan-revision-codec.js";

const planDraft = () => ({
  affectedCriterionIds: ["criterion-a"], affectedNodeIds: ["node-a"],
  steps: [{ description: "Implement.", kind: "IMPLEMENTATION", stepId: "step-a" }],
  verificationRecipeRefs: ["verify-a"], version: "moe-plan-revision/1",
});
const acceptanceDraft = () => ({
  nodeKind: "LEAF", obligations: [{
    criterionId: "criterion-a",
    evidenceRequirements: [{
      evidenceRef: "evidence-a", kind: "ARTIFACT", requirementId: "requirement-a",
    }],
    statement: "The focused suite passes.", verificationRecipeRefs: ["verify-a"],
  }], version: "moe-acceptance-contract/1",
});

function expectRefusalWithoutThrow(
  run: () => unknown,
  expected: Readonly<Record<string, unknown>>,
): void {
  let outcome: unknown;
  expect(() => { outcome = run(); }).not.toThrow();
  expect(outcome).toStrictEqual(expected);
}

describe("graph-independent planning content codec hostility", () => {
  it("refuses hostile encoder objects without executing caller code", () => {
    let reads = 0;
    const accessor = Object.defineProperty(planDraft(), "steps", {
      enumerable: true, get: () => { reads += 1; return []; },
    });
    const cyclic = acceptanceDraft() as Record<string, unknown>;
    cyclic["cycle"] = cyclic;
    const planRefusal = {
      code: "PLAN_REVISION_MALFORMED", layer: "PLAN_REVISION_ADMISSION", ok: false,
    };
    const acceptanceRefusal = { code: "ACCEPTANCE_CONTRACT_MALFORMED",
      layer: "ACCEPTANCE_CONTRACT_ADMISSION", ok: false };
    expectRefusalWithoutThrow(() => encodePlanExecutionContent(accessor), planRefusal);
    expectRefusalWithoutThrow(
      () => encodePlanExecutionContent(new Proxy(planDraft(), {})), planRefusal,
    );
    expectRefusalWithoutThrow(() => encodeAcceptanceCriteriaContent(cyclic), acceptanceRefusal);
    expect(reads).toBe(0);
  });

  it("refuses hostile byte views without throwing", () => {
    for (const [decode, code, layer] of [
      [decodePlanExecutionContentBytes, "PLAN_REVISION_BYTES_INVALID", "PLAN_REVISION_CODEC"],
      [decodeAcceptanceCriteriaContentBytes,
        "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC"],
    ] as const) {
      expectRefusalWithoutThrow(() => decode("not bytes"), { code, layer, ok: false });
      const bytes = new TextEncoder().encode("{}");
      expectRefusalWithoutThrow(() => decode(new Proxy(bytes, {})), { code, layer, ok: false });
      structuredClone(bytes.buffer, { transfer: [bytes.buffer as ArrayBuffer] });
      expectRefusalWithoutThrow(() => decode(bytes), { code, layer, ok: false });
    }
  });
});
