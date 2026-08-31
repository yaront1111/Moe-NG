import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createProductContractRevisionV2 } from "./product-contract-v2-codec.js";
import { validateProductContractV2Amendment } from "./product-contract-v2-lineage.js";
import {
  PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_DIGEST_DOMAIN,
  advanceProductContractCurrentRevisionSlotV2,
  createProductContractCurrentRevisionSlotV2,
  decodeProductContractCurrentRevisionSlotV2Bytes,
  encodeProductContractCurrentRevisionSlotV2,
} from "./product-contract-v2-current-slot.js";
import type { ProductContractCurrentRevisionSlotV2 }
  from "./product-contract-v2-current-slot.js";

const hex = (digit: string): string => digit.repeat(64);

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`,
  ).join(",")}}`;
}

function resealSlot(
  value: Omit<ProductContractCurrentRevisionSlotV2, "slotDigest">,
): ProductContractCurrentRevisionSlotV2 {
  const slotDigest = createHash("sha256")
    .update(PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(new TextEncoder().encode(canonicalText(value)))
    .digest("hex");
  return { ...value, slotDigest };
}

function revisionDraft(
  revisionId: string,
  lineage: null | { parentRevisionDigest: string; parentRevisionId: string } = null,
  contractId = "contract-a",
): Record<string, unknown> {
  const requirements = [
    "requirement-deploy", "requirement-functional", "requirement-nfr",
    "requirement-security", "requirement-tech", "requirement-ux",
  ];
  const criteria = requirements.map((requirementId) => ({
    criterionId: requirementId.replace("requirement", "criterion"),
    requirementId,
    statement: `${requirementId} is observed.`,
    supersedesCriterionId: null,
    verification: `Verify ${requirementId} through a deterministic recipe.`,
  }));
  const requirement = (requirementId: string) => ({
    dependsOnRequirementIds: [], priority: "MUST", requirementId,
    statement: `${requirementId} must hold.`, supersedesRequirementId: null,
  });
  return {
    assumptions: [], authorRef: "principal-product",
    budgets: [{ budgetId: "budget-a", kind: "TIME", limit: 30, unit: "days" }],
    contractId, criteria,
    deploymentRequirements: [requirement("requirement-deploy")],
    functionalRequirements: [requirement("requirement-functional")],
    journeys: [{
      criterionIds: ["criterion-functional"], journeyId: "journey-a",
      statement: "The operator completes the workflow.", userJobId: "job-a",
    }],
    lineage,
    materialDecisions: [],
    negativeScope: [{ scopeId: "scope-a", statement: "No native client." }],
    nonFunctionalRequirements: [requirement("requirement-nfr")],
    objectives: [{ objectiveId: "objective-a", statement: "Complete the workflow." }],
    productCompleteDefinition: {
      criterionIds: criteria.map(({ criterionId }) => criterionId),
      statement: "Every criterion is independently verified.",
    },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId,
    securityPrivacyRequirements: [requirement("requirement-security")],
    sourceDocumentDigests: [hex("a")],
    successMetrics: [{
      measurement: "Measure consented completed workflows.", metricId: "metric-a",
      objectiveIds: ["objective-a"], statement: "The workflow is completed.",
      target: "At least eighty percent in a cohort of ten or more.",
    }],
    technologyRequirements: [requirement("requirement-tech")],
    userJobs: [{ job: "Complete the workflow.", user: "Operator", userJobId: "job-a" }],
    uxAccessibilityRequirements: [requirement("requirement-ux")],
  };
}

function revision(
  revisionId: string,
  lineage: null | { parentRevisionDigest: string; parentRevisionId: string } = null,
  contractId = "contract-a",
) {
  const result = createProductContractRevisionV2(revisionDraft(revisionId, lineage, contractId));
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

describe("ProductContractCurrentRevisionSlot /2", () => {
  it("creates and canonically round-trips an immutable initial current slot", () => {
    const current = revision("revision-1");
    const created = createProductContractCurrentRevisionSlotV2("project-a", current);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.slot).toMatchObject({
      contractId: current.contractId,
      generation: 1,
      revisionHistory: [],
      projectId: "project-a",
      version: "moe-product-contract-current-revision-slot/2",
    });
    expect(created.slot.currentRevision).toEqual({
      contractId: current.contractId,
      revisionDigest: current.revisionDigest,
      revisionId: current.revisionId,
      version: "moe-product-contract-revision/2",
    });
    expect(Object.isFrozen(created.slot)).toBe(true);

    const encoded = encodeProductContractCurrentRevisionSlotV2(created.slot);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect({
      canonicalBytes: encoded.bytes.byteLength,
      canonicalBytesSha256: createHash("sha256").update(encoded.bytes).digest("hex"),
      slotDigest: created.slot.slotDigest,
    }).toEqual({
      canonicalBytes: 424,
      canonicalBytesSha256: "533258cd6f9604d1dafe4362cecdcd45ea804dd7f45d6c2649f447a93d1e3506",
      slotDigest: "574134d9754e7993755435a5b6c8d6b9d80965192c255be7b95b1d2b811c8093",
    });
    expect(decodeProductContractCurrentRevisionSlotV2Bytes(encoded.bytes, current)).toEqual({
      ok: true, slot: created.slot,
    });
    expect(decodeProductContractCurrentRevisionSlotV2Bytes(
      encoded.bytes, revision("revision-other"),
    )).toEqual({
      code: "PRODUCT_CONTRACT_V2_SLOT_CURRENT_REVISION_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_CURRENT_SLOT",
      ok: false,
    });
  });

  it("advances only through an exact successor lineage and retains the prior ref", () => {
    const current = revision("revision-1");
    const initial = createProductContractCurrentRevisionSlotV2("project-a", current);
    if (!initial.ok) throw new Error(`${initial.code}@${initial.layer}`);
    const successor = revision("revision-2", {
      parentRevisionDigest: current.revisionDigest,
      parentRevisionId: current.revisionId,
    });
    const advanced = advanceProductContractCurrentRevisionSlotV2(initial.slot, current, successor);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.slot.generation).toBe(2);
    expect(advanced.slot.revisionHistory).toEqual([initial.slot.currentRevision]);
    expect(advanced.slot.currentRevision.revisionId).toBe("revision-2");
    expect(advanced.slot.slotDigest).not.toBe(initial.slot.slotDigest);
  });

  it("cannot advance a candidate whose amendment lineage is invalid", () => {
    const current = revision("revision-1");
    const initial = createProductContractCurrentRevisionSlotV2("project-a", current);
    if (!initial.ok) throw new Error(`${initial.code}@${initial.layer}`);
    const candidateDraft = revisionDraft("revision-2", {
      parentRevisionDigest: current.revisionDigest,
      parentRevisionId: current.revisionId,
    });
    const [functional] = candidateDraft["functionalRequirements"] as Record<string, unknown>[];
    if (functional === undefined) throw new Error("fixture lost its functional requirement");
    candidateDraft["functionalRequirements"] = [{
      ...functional,
      statement: "Changed meaning under the same immutable requirement id.",
    }];
    const candidate = createProductContractRevisionV2(candidateDraft);
    if (!candidate.ok) throw new Error(`${candidate.code}@${candidate.layer}`);
    expect(validateProductContractV2Amendment(current, candidate.revision)).toEqual({
      code: "PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED",
      layer: "PRODUCT_CONTRACT_V2_LINEAGE",
      ok: false,
    });

    expect(advanceProductContractCurrentRevisionSlotV2(
      initial.slot, current, candidate.revision,
    )).toEqual({
      code: "PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED",
      layer: "PRODUCT_CONTRACT_V2_LINEAGE",
      ok: false,
    });
  });

  it("never reuses a revision id or digest from durable slot history", () => {
    const first = revision("revision-1");
    const initial = createProductContractCurrentRevisionSlotV2("project-a", first);
    if (!initial.ok) throw new Error(`${initial.code}@${initial.layer}`);
    const second = revision("revision-2", {
      parentRevisionDigest: first.revisionDigest,
      parentRevisionId: first.revisionId,
    });
    const advanced = advanceProductContractCurrentRevisionSlotV2(initial.slot, first, second);
    if (!advanced.ok) throw new Error(`${advanced.code}@${advanced.layer}`);
    const reused = revision("revision-1", {
      parentRevisionDigest: second.revisionDigest,
      parentRevisionId: second.revisionId,
    });

    expect(advanceProductContractCurrentRevisionSlotV2(advanced.slot, second, reused)).toEqual({
      code: "PRODUCT_CONTRACT_V2_SLOT_REVISION_REUSED",
      layer: "PRODUCT_CONTRACT_V2_CURRENT_SLOT",
      ok: false,
    });
  });

  it("binds a decoded current body to the exact last durable lineage link", () => {
    const first = revision("revision-1");
    const initial = createProductContractCurrentRevisionSlotV2("project-a", first);
    if (!initial.ok) throw new Error(`${initial.code}@${initial.layer}`);
    const second = revision("revision-2", {
      parentRevisionDigest: first.revisionDigest,
      parentRevisionId: first.revisionId,
    });
    const advanced = advanceProductContractCurrentRevisionSlotV2(initial.slot, first, second);
    if (!advanced.ok) throw new Error(`${advanced.code}@${advanced.layer}`);
    const { slotDigest: _slotDigest, ...source } = advanced.slot;
    const forged = resealSlot({
      ...source,
      revisionHistory: [{
        ...source.revisionHistory[0]!,
        revisionDigest: hex("f"),
        revisionId: "unrelated-revision",
      }],
    });
    const encoded = encodeProductContractCurrentRevisionSlotV2(forged);
    if (!encoded.ok) throw new Error(`${encoded.code}@${encoded.layer}`);

    expect(decodeProductContractCurrentRevisionSlotV2Bytes(encoded.bytes, second)).toEqual({
      code: "PRODUCT_CONTRACT_V2_SLOT_CURRENT_REVISION_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_CURRENT_SLOT",
      ok: false,
    });
  });

  it("refuses hostile proxies and slots whose valid shape exceeds the byte ceiling", () => {
    const current = revision("revision-1");
    const initial = createProductContractCurrentRevisionSlotV2("project-a", current);
    if (!initial.ok) throw new Error(`${initial.code}@${initial.layer}`);
    const hostile = new Proxy(initial.slot, {
      getOwnPropertyDescriptor: () => { throw new Error("caller trap must not escape"); },
    });
    expect(() => encodeProductContractCurrentRevisionSlotV2(hostile)).not.toThrow();
    expect(encodeProductContractCurrentRevisionSlotV2(hostile)).toEqual({
      code: "PRODUCT_CONTRACT_V2_SLOT_INVALID",
      layer: "PRODUCT_CONTRACT_V2_CURRENT_SLOT",
      ok: false,
    });

    const contractId = "c".repeat(512);
    const revisionHistory = Array.from({ length: 1_024 }, (_, index) => ({
      contractId,
      revisionDigest: index.toString(16).padStart(64, "0"),
      revisionId: `r${index}`.padEnd(512, "x"),
      version: "moe-product-contract-revision/2" as const,
    }));
    const oversized = resealSlot({
      contractId,
      currentRevision: {
        contractId, revisionDigest: hex("f"), revisionId: "z".repeat(512),
        version: "moe-product-contract-revision/2",
      },
      generation: 1_025,
      projectId: "p".repeat(512),
      revisionHistory,
      version: "moe-product-contract-current-revision-slot/2",
    });
    expect(encodeProductContractCurrentRevisionSlotV2(oversized)).toEqual({
      code: "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });

  it("refuses stale lineage, foreign contracts, reused revisions, and /1 impersonation distinctly", () => {
    const current = revision("revision-1");
    const initial = createProductContractCurrentRevisionSlotV2("project-a", current);
    if (!initial.ok) throw new Error(`${initial.code}@${initial.layer}`);
    const successor = revision("revision-2", {
      parentRevisionDigest: current.revisionDigest,
      parentRevisionId: current.revisionId,
    });
    const advanced = advanceProductContractCurrentRevisionSlotV2(initial.slot, current, successor);
    if (!advanced.ok) throw new Error(`${advanced.code}@${advanced.layer}`);

    const stale = revision("revision-3", {
      parentRevisionDigest: current.revisionDigest,
      parentRevisionId: current.revisionId,
    });
    expect(advanceProductContractCurrentRevisionSlotV2(
      advanced.slot, successor, stale,
    )).toEqual({
      code: "PRODUCT_CONTRACT_V2_SLOT_PARENT_NOT_CURRENT",
      layer: "PRODUCT_CONTRACT_V2_CURRENT_SLOT",
      ok: false,
    });

    const foreign = revision("revision-foreign", null, "contract-b");
    expect(advanceProductContractCurrentRevisionSlotV2(initial.slot, current, foreign)).toEqual({
      code: "PRODUCT_CONTRACT_V2_SLOT_CONTRACT_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_CURRENT_SLOT",
      ok: false,
    });

    expect(advanceProductContractCurrentRevisionSlotV2(initial.slot, current, current)).toEqual({
      code: "PRODUCT_CONTRACT_V2_SLOT_REVISION_REUSED",
      layer: "PRODUCT_CONTRACT_V2_CURRENT_SLOT",
      ok: false,
    });
    expect(advanceProductContractCurrentRevisionSlotV2(initial.slot, current, {
      ...successor, version: "moe-product-contract-revision/1",
    })).toEqual({
      code: "PRODUCT_CONTRACT_V2_VERSION_UNSUPPORTED",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });

    const [firstFunctional] = successor.functionalRequirements;
    if (firstFunctional === undefined) throw new Error("fixture lost its functional requirement");
    expect(advanceProductContractCurrentRevisionSlotV2(initial.slot, current, {
      ...successor,
      functionalRequirements: [{
        ...firstFunctional, statement: "Mutated after the revision digest was sealed.",
      }],
    })).toEqual({
      code: "PRODUCT_CONTRACT_V2_DIGEST_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });

  it("refuses a slot whose content no longer matches its digest", () => {
    const initial = createProductContractCurrentRevisionSlotV2("project-a", revision("revision-1"));
    if (!initial.ok) throw new Error(`${initial.code}@${initial.layer}`);
    expect(encodeProductContractCurrentRevisionSlotV2({
      ...initial.slot, projectId: "project-b",
    })).toEqual({
      code: "PRODUCT_CONTRACT_V2_SLOT_DIGEST_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_CURRENT_SLOT",
      ok: false,
    });
  });
});

describe("ProductContractRevision /2 amendment lineage", () => {
  it("accepts an explicitly superseded requirement and criterion", () => {
    const current = revision("revision-1");
    const value = revisionDraft("revision-2", {
      parentRevisionDigest: current.revisionDigest,
      parentRevisionId: current.revisionId,
    });
    const requirements = value["functionalRequirements"] as Record<string, unknown>[];
    requirements[0] = {
      ...requirements[0],
      requirementId: "requirement-functional-v2",
      statement: "The revised functional requirement must hold.",
      supersedesRequirementId: "requirement-functional",
    };
    const criteria = value["criteria"] as Record<string, unknown>[];
    criteria[1] = {
      ...criteria[1],
      criterionId: "criterion-functional-v2",
      requirementId: "requirement-functional-v2",
      statement: "The revised functional requirement is observed.",
      supersedesCriterionId: "criterion-functional",
      verification: "Verify the revised functional requirement deterministically.",
    };
    value["journeys"] = [{
      criterionIds: ["criterion-functional-v2"], journeyId: "journey-a",
      statement: "The operator completes the workflow.", userJobId: "job-a",
    }];
    value["productCompleteDefinition"] = {
      criterionIds: [
        "criterion-deploy", "criterion-functional-v2", "criterion-nfr",
        "criterion-security", "criterion-tech", "criterion-ux",
      ],
      statement: "Every criterion is independently verified.",
    };
    value["retiredCriterionIds"] = ["criterion-functional"];
    value["retiredRequirementIds"] = ["requirement-functional"];
    const candidateResult = createProductContractRevisionV2(value);
    if (!candidateResult.ok) throw new Error(`${candidateResult.code}@${candidateResult.layer}`);

    expect(validateProductContractV2Amendment(current, candidateResult.revision)).toEqual({
      advisoryOnly: true,
      ok: true,
      parentRevisionDigest: current.revisionDigest,
      revisionDigest: candidateResult.revision.revisionDigest,
    });
  });

  it("refuses changing meaning, priority, or dependencies under a reused requirement id", () => {
    const current = revision("revision-1");
    const value = revisionDraft("revision-2", {
      parentRevisionDigest: current.revisionDigest,
      parentRevisionId: current.revisionId,
    });
    const requirements = value["functionalRequirements"] as Record<string, unknown>[];
    requirements[0] = {
      ...requirements[0], priority: "SHOULD", statement: "Changed without a successor id.",
    };
    const candidateResult = createProductContractRevisionV2(value);
    if (!candidateResult.ok) throw new Error(`${candidateResult.code}@${candidateResult.layer}`);

    expect(validateProductContractV2Amendment(current, candidateResult.revision)).toEqual({
      code: "PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED",
      layer: "PRODUCT_CONTRACT_V2_LINEAGE",
      ok: false,
    });
  });

  it("requires criterion supersession for verification or requirement-binding changes", () => {
    const current = revision("revision-1");
    const verificationDraft = revisionDraft("revision-2", {
      parentRevisionDigest: current.revisionDigest,
      parentRevisionId: current.revisionId,
    });
    const verificationCriteria = verificationDraft["criteria"] as Record<string, unknown>[];
    verificationCriteria[1] = {
      ...verificationCriteria[1], verification: "Changed verification under a reused id.",
    };
    const verificationCandidate = createProductContractRevisionV2(verificationDraft);
    if (!verificationCandidate.ok) {
      throw new Error(`${verificationCandidate.code}@${verificationCandidate.layer}`);
    }
    expect(validateProductContractV2Amendment(
      current, verificationCandidate.revision,
    )).toEqual({
      code: "PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED",
      layer: "PRODUCT_CONTRACT_V2_LINEAGE",
      ok: false,
    });

    const bindingDraft = revisionDraft("revision-2", {
      parentRevisionDigest: current.revisionDigest,
      parentRevisionId: current.revisionId,
    });
    const bindingRequirements = bindingDraft["functionalRequirements"] as Record<string, unknown>[];
    bindingRequirements[0] = {
      ...bindingRequirements[0], requirementId: "requirement-functional-v2",
      statement: "The revised functional requirement must hold.",
      supersedesRequirementId: "requirement-functional",
    };
    const bindingCriteria = bindingDraft["criteria"] as Record<string, unknown>[];
    bindingCriteria[1] = {
      ...bindingCriteria[1], requirementId: "requirement-functional-v2",
    };
    bindingDraft["retiredRequirementIds"] = ["requirement-functional"];
    const bindingCandidate = createProductContractRevisionV2(bindingDraft);
    if (!bindingCandidate.ok) throw new Error(`${bindingCandidate.code}@${bindingCandidate.layer}`);
    expect(validateProductContractV2Amendment(current, bindingCandidate.revision)).toEqual({
      code: "PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED",
      layer: "PRODUCT_CONTRACT_V2_LINEAGE",
      ok: false,
    });
  });

  it("refuses an undeclared deletion from the current revision", () => {
    const currentDraft = revisionDraft("revision-1");
    const functional = currentDraft["functionalRequirements"] as Record<string, unknown>[];
    functional.push({
      dependsOnRequirementIds: [], priority: "MUST",
      requirementId: "requirement-functional-extra",
      statement: "The extra requirement must hold.", supersedesRequirementId: null,
    });
    const criteria = currentDraft["criteria"] as Record<string, unknown>[];
    criteria.splice(2, 0, {
      criterionId: "criterion-functional-extra",
      requirementId: "requirement-functional-extra",
      statement: "The extra requirement is observable.", supersedesCriterionId: null,
      verification: "Verify the extra requirement deterministically.",
    });
    (currentDraft["productCompleteDefinition"] as Record<string, unknown>)["criterionIds"] =
      criteria.map((item) => item["criterionId"]);
    const currentResult = createProductContractRevisionV2(currentDraft);
    if (!currentResult.ok) throw new Error(`${currentResult.code}@${currentResult.layer}`);
    const candidate = revision("revision-2", {
      parentRevisionDigest: currentResult.revision.revisionDigest,
      parentRevisionId: currentResult.revision.revisionId,
    });

    expect(validateProductContractV2Amendment(currentResult.revision, candidate)).toEqual({
      code: "PRODUCT_CONTRACT_V2_LINEAGE_CHANGE_UNDECLARED",
      layer: "PRODUCT_CONTRACT_V2_LINEAGE",
      ok: false,
    });
  });

  it("carries historical tombstones and refuses their reuse", () => {
    const first = revision("revision-1");
    const middleValue = revisionDraft("revision-2", {
      parentRevisionDigest: first.revisionDigest, parentRevisionId: first.revisionId,
    });
    middleValue["retiredCriterionIds"] = ["criterion-historical"];
    middleValue["retiredRequirementIds"] = ["requirement-historical"];
    const middleResult = createProductContractRevisionV2(middleValue);
    if (!middleResult.ok) throw new Error(`${middleResult.code}@${middleResult.layer}`);

    const nextValue = revisionDraft("revision-3", {
      parentRevisionDigest: middleResult.revision.revisionDigest,
      parentRevisionId: middleResult.revision.revisionId,
    });
    const requirements = nextValue["functionalRequirements"] as Record<string, unknown>[];
    requirements[0] = {
      ...requirements[0], requirementId: "requirement-historical",
    };
    const criteria = nextValue["criteria"] as Record<string, unknown>[];
    criteria[1] = {
      ...criteria[1], criterionId: "criterion-historical",
      requirementId: "requirement-historical",
    };
    nextValue["journeys"] = [{
      criterionIds: ["criterion-historical"], journeyId: "journey-a",
      statement: "The operator completes the workflow.", userJobId: "job-a",
    }];
    nextValue["productCompleteDefinition"] = {
      criterionIds: [
        "criterion-deploy", "criterion-historical", "criterion-nfr",
        "criterion-security", "criterion-tech", "criterion-ux",
      ],
      statement: "Every criterion is independently verified.",
    };
    nextValue["retiredCriterionIds"] = [];
    nextValue["retiredRequirementIds"] = [];
    const candidateResult = createProductContractRevisionV2(nextValue);
    if (!candidateResult.ok) throw new Error(`${candidateResult.code}@${candidateResult.layer}`);

    expect(validateProductContractV2Amendment(
      middleResult.revision, candidateResult.revision,
    )).toEqual({
      code: "PRODUCT_CONTRACT_V2_LINEAGE_ID_REUSED",
      layer: "PRODUCT_CONTRACT_V2_LINEAGE",
      ok: false,
    });
  });
});
