import type { AcceptanceContract } from "../planning/acceptance-contract.js";
import { createAcceptanceContract } from "../planning/acceptance-contract-codec.js";

export const hex = (digit: string): string => digit.repeat(64);

export const productContractDraft = () => ({
  authorRef: "principal-product",
  contractId: "product-contract-a",
  criteria: [{
    criterionId: "criterion-authentication",
    requirementId: "requirement-authentication",
    statement: "A registered user signs in with valid credentials.",
    supersedesCriterionId: null as string | null,
  }],
  lineage: null as null | { parentRevisionDigest: string; parentRevisionId: string },
  requirements: [{
    requirementId: "requirement-authentication",
    statement: "Registered users can sign in.",
    supersedesRequirementId: null as string | null,
  }],
  retiredCriterionIds: [] as string[],
  retiredRequirementIds: [] as string[],
  revisionId: "product-revision-1",
  sourceDocumentDigests: [hex("a")],
});

export const twoRequirementDraft = () => ({
  ...productContractDraft(),
  criteria: [
    ...productContractDraft().criteria,
    {
      criterionId: "criterion-profile",
      requirementId: "requirement-profile",
      statement: "A signed-in user reads their profile.",
      supersedesCriterionId: null as string | null,
    },
  ],
  requirements: [
    ...productContractDraft().requirements,
    {
      requirementId: "requirement-profile",
      statement: "Signed-in users can view their profile.",
      supersedesRequirementId: null as string | null,
    },
  ],
});

export const acceptanceContract = (
  options: { criterionId?: string; requirementId?: string; statement?: string } = {},
): AcceptanceContract => {
  const result = createAcceptanceContract({
    applicability: {
      graphContentHash: hex("b"), graphRevisionRef: "graph-revision-1",
      nodeIds: ["node-authentication"], nodeKind: "LEAF",
    },
    authorRef: "principal-planner",
    contractId: "acceptance-contract-a",
    obligations: [{
      criterionId: options.criterionId ?? "criterion-authentication",
      evidenceRequirements: [{
        evidenceRef: "verification-authentication", kind: "VERIFICATION_RECEIPT",
        requirementId: options.requirementId ?? "requirement-authentication",
      }],
      statement: options.statement ?? "A registered user signs in with valid credentials.",
      verificationRecipeRefs: ["recipe-authentication"],
    }],
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.contract;
};

export function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Reflect.ownKeys(value).every(
    (key) => deeplyFrozen((value as Readonly<Record<PropertyKey, unknown>>)[key]),
  );
}
