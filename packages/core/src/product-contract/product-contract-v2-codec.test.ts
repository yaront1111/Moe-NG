import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  PRODUCT_CONTRACT_V2_VERSION,
  createProductContractRevisionV2,
  decodeProductContractRevisionV2Bytes,
  deriveProductContractRevisionV2Digest,
  encodeProductContractRevisionV2,
} from "./product-contract-v2-codec.js";
import { PRODUCT_CONTRACT_V2_LIMITS } from "./product-contract-v2-contract.js";

const hex = (digit: string): string => digit.repeat(64);

const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies],
  priority: "MUST" as const,
  requirementId,
  statement: `${requirementId} must hold.`,
  supersedesRequirementId: null as string | null,
});

const criterion = (criterionId: string, requirementId: string) => ({
  criterionId,
  requirementId,
  statement: `${criterionId} is observable.`,
  supersedesCriterionId: null as string | null,
  verification: `Run the deterministic ${criterionId} verification recipe.`,
});

const CRITERION_IDS = Object.freeze([
  "criterion-deployment",
  "criterion-keyboard",
  "criterion-latency",
  "criterion-login",
  "criterion-runtime",
  "criterion-session",
]);

function draft(): Record<string, unknown> {
  return {
    assumptions: [{
      assumptionId: "assumption-browser",
      statement: "Users have a supported browser.",
      validationCriterionId: "criterion-runtime",
    }],
    authorRef: "principal-product",
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "product-contract-a",
    criteria: [
      criterion("criterion-deployment", "deployment-loopback"),
      criterion("criterion-keyboard", "ux-keyboard"),
      criterion("criterion-latency", "nfr-latency"),
      criterion("criterion-login", "requirement-login"),
      criterion("criterion-runtime", "technology-runtime"),
      criterion("criterion-session", "security-session"),
    ],
    deploymentRequirements: [requirement("deployment-loopback", ["technology-runtime"])],
    functionalRequirements: [requirement("requirement-login")],
    journeys: [{
      criterionIds: ["criterion-login", "criterion-session"],
      journeyId: "journey-login",
      statement: "A registered user signs in and reaches the product.",
      userJobId: "job-access",
    }],
    lineage: null,
    materialDecisions: [{
      decisionId: "decision-stack",
      options: [
        { optionId: "option-next", statement: "Use Next.js and TypeScript." },
        { optionId: "option-rust", statement: "Use Rust and Axum." },
      ],
      question: "Which qualified delivery profile is required?",
      selectedOptionId: "option-next",
    }],
    negativeScope: [{ scopeId: "scope-native", statement: "No native mobile client." }],
    nonFunctionalRequirements: [requirement("nfr-latency", ["requirement-login"])],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first-use success." }],
    productCompleteDefinition: {
      criterionIds: [...CRITERION_IDS],
      statement: "Every approved criterion is independently verified on the release candidate.",
    },
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId: "product-revision-2",
    securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
    sourceDocumentDigests: [hex("a")],
    successMetrics: [{
      measurement: "Count consented successful first sessions divided by eligible sessions.",
      metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"],
      statement: "Users complete their first session.",
      target: "At least 80 percent in a cohort of at least ten.",
    }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{
      job: "Reach the product with my registered identity.",
      user: "Registered operator",
      userJobId: "job-access",
    }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
  };
}

function created(value: unknown = draft()) {
  const result = createProductContractRevisionV2(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

describe("ProductContractRevision /2", () => {
  it("creates, freezes, canonically encodes, and byte-exactly decodes every v2 section", () => {
    const revision = created();
    expect(revision.version).toBe(PRODUCT_CONTRACT_V2_VERSION);
    expect(revision.advisoryOnly).toBe(true);
    expect(revision.revisionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.criteria)).toBe(true);
    expect(Object.isFrozen(revision.materialDecisions[0]?.options)).toBe(true);

    const encoded = encodeProductContractRevisionV2(revision);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(deriveProductContractRevisionV2Digest(revision)).toEqual({
      ok: true, revisionDigest: revision.revisionDigest,
    });
    const decoded = decodeProductContractRevisionV2Bytes(encoded.bytes);
    expect(decoded).toEqual({ ok: true, revision });
    expect({
      canonicalBytes: encoded.bytes.byteLength,
      canonicalBytesSha256: createHash("sha256").update(encoded.bytes).digest("hex"),
      revisionDigest: revision.revisionDigest,
    }).toEqual({
      canonicalBytes: 4_509,
      canonicalBytesSha256: "6c55c95830d573dbc0ebd596afd0faeaba329853015a01af6d62e21b653cf6bf",
      revisionDigest: "6d1a8c51bb33ce80e7fd0f4ae61d52078430bc5aae947e24a3e4f1fbac1826fb",
    });
    expect(new TextDecoder().decode(encoded.bytes)).toContain(
      `"version":"${PRODUCT_CONTRACT_V2_VERSION}"`,
    );
  });

  it.each([
    "objectives", "userJobs", "journeys", "functionalRequirements",
    "nonFunctionalRequirements", "uxAccessibilityRequirements",
    "securityPrivacyRequirements", "negativeScope", "budgets", "successMetrics",
    "technologyRequirements", "deploymentRequirements", "criteria",
  ])("refuses an empty material section: %s", (section) => {
    const value = draft();
    value[section] = [];
    expect(createProductContractRevisionV2(value)).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROVENANCE_VACUOUS",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });

  it("refuses unknown fields rather than silently discarding product choices", () => {
    expect(createProductContractRevisionV2({ ...draft(), inferredStack: "whatever" })).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROVENANCE_INVALID",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });

  it("distinguishes malformed collection shapes from structurally valid empty sections", () => {
    const malformed = draft();
    malformed["criteria"] = {};
    expect(createProductContractRevisionV2(malformed)).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROVENANCE_INVALID",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });

    const empty = draft();
    empty["criteria"] = [];
    expect(createProductContractRevisionV2(empty)).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROVENANCE_VACUOUS",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });

  it.each([
    ["author ref", (value: Record<string, unknown>) => { value["authorRef"] = " \t "; }],
    ["objective statement", (value: Record<string, unknown>) => {
      (value["objectives"] as Record<string, unknown>[])[0]!["statement"] = "   ";
    }],
    ["user", (value: Record<string, unknown>) => {
      (value["userJobs"] as Record<string, unknown>[])[0]!["user"] = "\n";
    }],
    ["job", (value: Record<string, unknown>) => {
      (value["userJobs"] as Record<string, unknown>[])[0]!["job"] = "\r\n";
    }],
    ["criterion verification", (value: Record<string, unknown>) => {
      (value["criteria"] as Record<string, unknown>[])[0]!["verification"] = "  ";
    }],
    ["budget unit", (value: Record<string, unknown>) => {
      (value["budgets"] as Record<string, unknown>[])[0]!["unit"] = "\t";
    }],
  ])("refuses whitespace-only material text: %s", (_label, mutate) => {
    const value = draft();
    mutate(value);
    expect(createProductContractRevisionV2(value)).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROVENANCE_VACUOUS",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });

  it("refuses an unresolved material choice at the semantic fence", () => {
    const value = draft();
    value["materialDecisions"] = [{
      decisionId: "decision-stack",
      options: [
        { optionId: "option-next", statement: "Use Next.js and TypeScript." },
        { optionId: "option-rust", statement: "Use Rust and Axum." },
      ],
      question: "Which qualified delivery profile is required?",
      selectedOptionId: null,
    }];
    expect(createProductContractRevisionV2(value)).toEqual({
      code: "PRODUCT_CONTRACT_V2_MATERIAL_DECISION_UNRESOLVED",
      layer: "PRODUCT_CONTRACT_V2_SEMANTICS",
      ok: false,
    });
  });

  it("refuses a material decision that offers no actual choice", () => {
    const value = draft();
    value["materialDecisions"] = [{
      decisionId: "decision-stack",
      options: [{ optionId: "option-next", statement: "Use Next.js and TypeScript." }],
      question: "Which qualified delivery profile is required?",
      selectedOptionId: "option-next",
    }];
    expect(createProductContractRevisionV2(value)).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROVENANCE_VACUOUS",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });

  it("refuses dangling cross-section references", () => {
    const value = draft();
    value["journeys"] = [{
      criterionIds: ["criterion-does-not-exist"],
      journeyId: "journey-login",
      statement: "A registered user signs in and reaches the product.",
      userJobId: "job-access",
    }];
    expect(createProductContractRevisionV2(value)).toEqual({
      code: "PRODUCT_CONTRACT_V2_REFERENCE_INVALID",
      layer: "PRODUCT_CONTRACT_V2_SEMANTICS",
      ok: false,
    });
  });

  it("requires every declared user job to be represented by a journey", () => {
    const value = draft();
    value["userJobs"] = [
      ...(value["userJobs"] as Record<string, unknown>[]),
      { job: "Export my data.", user: "Registered operator", userJobId: "job-export" },
    ];
    expect(createProductContractRevisionV2(value)).toEqual({
      code: "PRODUCT_CONTRACT_V2_COVERAGE_INCOMPLETE",
      layer: "PRODUCT_CONTRACT_V2_SEMANTICS",
      ok: false,
    });
  });

  it("requires every declared supersession to name a carried tombstone", () => {
    const value = draft();
    value["lineage"] = {
      parentRevisionDigest: hex("b"), parentRevisionId: "product-revision-1",
    };
    const [functional] = value["functionalRequirements"] as Record<string, unknown>[];
    if (functional === undefined) throw new Error("fixture lost functional requirement");
    value["functionalRequirements"] = [{
      ...functional, supersedesRequirementId: "ghost-requirement",
    }];
    expect(createProductContractRevisionV2(value)).toEqual({
      code: "PRODUCT_CONTRACT_V2_REFERENCE_INVALID",
      layer: "PRODUCT_CONTRACT_V2_SEMANTICS",
      ok: false,
    });
  });

  it("refuses requirement dependency cycles across section boundaries", () => {
    const value = draft();
    value["functionalRequirements"] = [requirement("requirement-login", ["nfr-latency"])];
    expect(createProductContractRevisionV2(value)).toEqual({
      code: "PRODUCT_CONTRACT_V2_REQUIREMENT_CYCLE",
      layer: "PRODUCT_CONTRACT_V2_SEMANTICS",
      ok: false,
    });
  });

  it("requires every requirement and product-complete criterion to be covered exactly", () => {
    const missingCriterion = draft();
    missingCriterion["criteria"] = (missingCriterion["criteria"] as unknown[])
      .filter((entry) => (entry as { criterionId: string }).criterionId !== "criterion-runtime");
    expect(createProductContractRevisionV2(missingCriterion)).toEqual({
      code: "PRODUCT_CONTRACT_V2_COVERAGE_INCOMPLETE",
      layer: "PRODUCT_CONTRACT_V2_SEMANTICS",
      ok: false,
    });

    const incompleteDefinition = draft();
    incompleteDefinition["productCompleteDefinition"] = {
      criterionIds: CRITERION_IDS.slice(1),
      statement: "Everything except one criterion is verified.",
    };
    expect(createProductContractRevisionV2(incompleteDefinition)).toEqual({
      code: "PRODUCT_CONTRACT_V2_COVERAGE_INCOMPLETE",
      layer: "PRODUCT_CONTRACT_V2_SEMANTICS",
      ok: false,
    });
  });

  it("does not upcast a /1 record into /2", () => {
    const revision = created();
    const encoded = encodeProductContractRevisionV2({
      ...revision,
      version: "moe-product-contract-revision/1",
    });
    expect(encoded).toEqual({
      code: "PRODUCT_CONTRACT_V2_VERSION_UNSUPPORTED",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });

  it("refuses duplicate-key, noncanonical, and digest-mutated bytes distinctly", () => {
    const duplicate = new TextEncoder().encode('{"advisoryOnly":true,"advisoryOnly":true}');
    expect(decodeProductContractRevisionV2Bytes(duplicate)).toEqual({
      code: "PRODUCT_CONTRACT_V2_DUPLICATE_KEY",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });

    const revision = created();
    const noncanonical = new TextEncoder().encode(JSON.stringify(revision, null, 2));
    expect(decodeProductContractRevisionV2Bytes(noncanonical)).toEqual({
      code: "PRODUCT_CONTRACT_V2_NONCANONICAL",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });

    const good = encodeProductContractRevisionV2(revision);
    if (!good.ok) throw new Error(`${good.code}@${good.layer}`);
    const mutated = new TextEncoder().encode(
      new TextDecoder().decode(good.bytes).replace(revision.revisionDigest, hex("f")),
    );
    expect(decodeProductContractRevisionV2Bytes(mutated)).toEqual({
      code: "PRODUCT_CONTRACT_V2_DIGEST_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });

  it("admits exact text/source/tombstone ceilings and refuses limit plus one", () => {
    const exactId = draft();
    exactId["authorRef"] = "a".repeat(PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes);
    expect(createProductContractRevisionV2(exactId).ok).toBe(true);
    const oversizedId = draft();
    oversizedId["authorRef"] = "a".repeat(PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes + 1);
    expect(createProductContractRevisionV2(oversizedId)).toEqual({
      code: "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });

    const exactStatement = draft();
    (exactStatement["objectives"] as Record<string, unknown>[])[0]!["statement"] =
      "s".repeat(PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes);
    expect(createProductContractRevisionV2(exactStatement).ok).toBe(true);
    const oversizedStatement = draft();
    (oversizedStatement["objectives"] as Record<string, unknown>[])[0]!["statement"] =
      "s".repeat(PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes + 1);
    expect(createProductContractRevisionV2(oversizedStatement)).toEqual({
      code: "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });

    const sources = Array.from(
      { length: PRODUCT_CONTRACT_V2_LIMITS.maxSourceDocuments + 1 },
      (_, index) => index.toString(16).padStart(64, "0"),
    );
    const exactSources = draft();
    exactSources["sourceDocumentDigests"] = sources.slice(0, -1);
    expect(createProductContractRevisionV2(exactSources).ok).toBe(true);
    const oversizedSources = draft();
    oversizedSources["sourceDocumentDigests"] = sources;
    expect(createProductContractRevisionV2(oversizedSources)).toEqual({
      code: "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });

    const tombstones = draft();
    tombstones["lineage"] = {
      parentRevisionDigest: hex("b"), parentRevisionId: "product-revision-1",
    };
    tombstones["retiredCriterionIds"] = Array.from(
      { length: 513 }, (_, index) => `retired-criterion-${index.toString().padStart(4, "0")}`,
    );
    tombstones["retiredRequirementIds"] = Array.from(
      { length: 513 }, (_, index) => `retired-requirement-${index.toString().padStart(4, "0")}`,
    );
    expect(createProductContractRevisionV2(tombstones).ok).toBe(true);
  });

  it("bounds hostile in-memory graphs before snapshot traversal", () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth <= PRODUCT_CONTRACT_V2_LIMITS.maxSnapshotDepth; depth += 1) {
      nested = { nested };
    }
    expect(createProductContractRevisionV2({ ...draft(), unexpected: nested })).toEqual({
      code: "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });

    const cyclic = draft();
    cyclic["unexpected"] = cyclic;
    expect(createProductContractRevisionV2(cyclic)).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROVENANCE_INVALID",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });

    const accessor = draft();
    Object.defineProperty(accessor, "unexpected", {
      enumerable: true,
      get: () => { throw new Error("accessor must never execute"); },
    });
    expect(() => createProductContractRevisionV2(accessor)).not.toThrow();
    expect(createProductContractRevisionV2(accessor)).toEqual({
      code: "PRODUCT_CONTRACT_V2_PROVENANCE_INVALID",
      layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
      ok: false,
    });
  });
});
