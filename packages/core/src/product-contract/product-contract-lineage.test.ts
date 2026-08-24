import { describe, expect, it } from "vitest";
import { createProductContractRevision } from "./product-contract-codec.js";
import { validateProductContractAmendment } from "./product-contract-lineage.js";
import { productContractDraft, twoRequirementDraft } from "./product-contract-test-fixtures.js";

const revisionOrThrow = (draft: unknown) => {
  const result = createProductContractRevision(draft);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
};
const current = () => revisionOrThrow(productContractDraft());
const amendmentDraft = () => {
  const parent = current();
  return {
    ...productContractDraft(),
    criteria: [{
      criterionId: "criterion-authentication-v2", requirementId: "requirement-authentication-v2",
      statement: "A registered user signs in with valid credentials and a second factor.",
      supersedesCriterionId: "criterion-authentication" as string | null,
    }],
    lineage: { parentRevisionDigest: parent.revisionDigest, parentRevisionId: parent.revisionId },
    requirements: [{
      requirementId: "requirement-authentication-v2",
      statement: "Registered users sign in with a second factor.",
      supersedesRequirementId: "requirement-authentication" as string | null,
    }],
    retiredCriterionIds: ["criterion-authentication"],
    retiredRequirementIds: ["requirement-authentication"],
    revisionId: "product-revision-2",
  };
};
const refusal = (result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
};

describe("explicit amendment lineage", () => {
  it("accepts a replacement whose parent and item lineage bind the current revision", () => {
    const before = current();
    const candidate = revisionOrThrow({
      ...amendmentDraft(),
      lineage: { parentRevisionDigest: before.revisionDigest, parentRevisionId: before.revisionId },
    });
    expect(validateProductContractAmendment(before, candidate)).toEqual({
      advisoryOnly: true, ok: true,
      parentRevisionDigest: before.revisionDigest,
      revisionDigest: candidate.revisionDigest,
    });
  });

  it("refuses a candidate whose declared parent is not the current revision", () => {
    const before = current();
    const candidate = revisionOrThrow({
      ...amendmentDraft(),
      lineage: { parentRevisionDigest: "f".repeat(64), parentRevisionId: before.revisionId },
    });
    expect(refusal(validateProductContractAmendment(before, candidate))).toEqual([
      "PRODUCT_CONTRACT_LINEAGE_PARENT_NOT_CURRENT", "LINEAGE",
    ]);
  });

  it("refuses changing requirement or criterion meaning while reusing its stable id", () => {
    const before = current();
    const draft = amendmentDraft();
    draft.requirements = [{
      requirementId: "requirement-authentication", statement: "A different product requirement.",
      supersedesRequirementId: null,
    }];
    draft.criteria = [{
      criterionId: "criterion-authentication", requirementId: "requirement-authentication",
      statement: "A different acceptance outcome.", supersedesCriterionId: null,
    }];
    draft.lineage = {
      parentRevisionDigest: before.revisionDigest, parentRevisionId: before.revisionId,
    };
    draft.retiredCriterionIds = [];
    draft.retiredRequirementIds = [];
    expect(refusal(validateProductContractAmendment(before, revisionOrThrow(draft)))).toEqual([
      "PRODUCT_CONTRACT_LINEAGE_ID_REUSED", "LINEAGE",
    ]);
  });

  it("refuses replacing identical content under a needless new id", () => {
    const before = current();
    const draft = amendmentDraft();
    draft.requirements[0]!.statement = before.requirements[0]!.statement;
    draft.criteria[0]!.statement = before.criteria[0]!.statement;
    draft.lineage = {
      parentRevisionDigest: before.revisionDigest, parentRevisionId: before.revisionId,
    };
    expect(refusal(validateProductContractAmendment(before, revisionOrThrow(draft)))).toEqual([
      "PRODUCT_CONTRACT_LINEAGE_ID_UNSTABLE", "LINEAGE",
    ]);
  });

  it("refuses silently dropping an id without superseding or retiring it", () => {
    const before = revisionOrThrow(twoRequirementDraft());
    const draft = productContractDraft();
    draft.lineage = {
      parentRevisionDigest: before.revisionDigest, parentRevisionId: before.revisionId,
    };
    draft.revisionId = "product-revision-2";
    expect(refusal(validateProductContractAmendment(before, revisionOrThrow(draft)))).toEqual([
      "PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED", "LINEAGE",
    ]);
  });

  it("refuses disguising an unchanged item as one retirement plus one addition", () => {
    const before = revisionOrThrow(twoRequirementDraft());
    const draft = twoRequirementDraft();
    draft.lineage = {
      parentRevisionDigest: before.revisionDigest, parentRevisionId: before.revisionId,
    };
    draft.revisionId = "product-revision-2";
    draft.requirements[1] = {
      ...draft.requirements[1]!, requirementId: "requirement-profile-v2",
    };
    draft.criteria[1] = {
      ...draft.criteria[1]!, criterionId: "criterion-profile-v2",
      requirementId: "requirement-profile-v2",
    };
    draft.retiredRequirementIds = ["requirement-profile"];
    draft.retiredCriterionIds = ["criterion-profile"];
    expect(refusal(validateProductContractAmendment(before, revisionOrThrow(draft)))).toEqual([
      "PRODUCT_CONTRACT_LINEAGE_ID_UNSTABLE", "LINEAGE",
    ]);
  });

  it("carries tombstones forward and refuses reuse of a historically retired id", () => {
    const prior = revisionOrThrow(productContractDraft());
    const currentDraft = productContractDraft();
    currentDraft.lineage = {
      parentRevisionDigest: prior.revisionDigest, parentRevisionId: prior.revisionId,
    };
    currentDraft.revisionId = "product-revision-2";
    currentDraft.retiredRequirementIds = ["requirement-historical"];
    currentDraft.retiredCriterionIds = ["criterion-historical"];
    const before = revisionOrThrow(currentDraft);
    const candidateDraft = twoRequirementDraft();
    candidateDraft.lineage = {
      parentRevisionDigest: before.revisionDigest, parentRevisionId: before.revisionId,
    };
    candidateDraft.revisionId = "product-revision-3";
    candidateDraft.requirements[1] = {
      ...candidateDraft.requirements[1]!, requirementId: "requirement-historical",
    };
    candidateDraft.criteria[1] = {
      ...candidateDraft.criteria[1]!, criterionId: "criterion-historical",
      requirementId: "requirement-historical",
    };
    expect(refusal(validateProductContractAmendment(
      before, revisionOrThrow(candidateDraft),
    ))).toEqual(["PRODUCT_CONTRACT_LINEAGE_ID_REUSED", "LINEAGE"]);

    const droppedTombstones = productContractDraft();
    droppedTombstones.lineage = {
      parentRevisionDigest: before.revisionDigest, parentRevisionId: before.revisionId,
    };
    droppedTombstones.revisionId = "product-revision-3";
    expect(refusal(validateProductContractAmendment(
      before, revisionOrThrow(droppedTombstones),
    ))).toEqual(["PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED", "LINEAGE"]);
  });
});
