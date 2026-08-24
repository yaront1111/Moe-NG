import { describe, expect, it } from "vitest";
import {
  PRODUCT_CONTRACT_PROJECTION_DIGEST_DOMAIN, assessClarificationMateriality,
} from "./product-contract-materiality.js";
import { deeplyFrozen, productContractDraft } from "./product-contract-test-fixtures.js";

const projection = () => ({
  criteria: productContractDraft().criteria,
  requirements: productContractDraft().requirements,
});
const clarification = () => ({
  clarificationId: "clarification-authentication-method",
  options: [
    { label: "Password", optionId: "option-password", projection: projection() },
    {
      label: "Passkey", optionId: "option-passkey",
      projection: {
        ...projection(),
        requirements: [{
          ...projection().requirements[0], statement: "Registered users sign in with a passkey.",
        }],
      },
    },
  ],
  question: "Which authentication method should the product require?",
});
const refusal = (result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
};

describe("mechanical clarification materiality", () => {
  it("is material only when admitted options produce at least two projection digests", () => {
    const draft = clarification();
    const result = assessClarificationMateriality(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
    expect(PRODUCT_CONTRACT_PROJECTION_DIGEST_DOMAIN)
      .toBe("moe-product-contract-clarification-projection/1");
    expect(result.material).toBe(true);
    expect(result.optionDigests).toHaveLength(2);
    expect(new Set(result.optionDigests.map((item) => item.projectionDigest)).size).toBe(2);
    const stable = structuredClone(result);
    draft.options[0]!.projection.requirements[0]!.statement = "caller mutation";
    expect(result).toEqual(stable);
    expect(deeplyFrozen(result)).toBe(true);
  });

  it("refuses label-only choices whose canonical product projections are identical", () => {
    const draft = clarification();
    draft.options[1]!.projection = projection();
    expect(refusal(assessClarificationMateriality(draft))).toEqual([
      "PRODUCT_CONTRACT_CLARIFICATION_IMMATERIAL", "MATERIALITY",
    ]);
  });

  it("refuses a one-option question as vacuous", () => {
    const draft = clarification();
    draft.options = [draft.options[0]!];
    expect(refusal(assessClarificationMateriality(draft))).toEqual([
      "PRODUCT_CONTRACT_CLARIFICATION_VACUOUS", "MATERIALITY",
    ]);
  });

  it("refuses caller-supplied projection digests instead of trusting them", () => {
    const draft = clarification();
    const hostile = {
      ...draft,
      options: draft.options.map((option) => ({ ...option, projectionDigest: "0".repeat(64) })),
    };
    expect(refusal(assessClarificationMateriality(hostile))).toEqual([
      "PRODUCT_CONTRACT_CLARIFICATION_INVALID", "MATERIALITY",
    ]);
  });
});
