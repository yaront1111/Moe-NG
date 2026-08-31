import { describe, expect, it } from "vitest";

import * as core from "../index.js";

type Assessment = (value: unknown) => Readonly<Record<string, unknown>>;
const assess = (core as unknown as {
  assessProductContractClarificationMaterialityV2?: Assessment;
}).assessProductContractClarificationMaterialityV2;
const projectionDigest = (core as unknown as {
  deriveProductContractClarificationProjectionDigestV2?: Assessment;
}).deriveProductContractClarificationProjectionDigestV2;

const hex = (digit: string): string => digit.repeat(64);

const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Run deterministic ${criterionId} verification.`,
});
const CRITERIA = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.",
      validationCriterionId: "criterion-runtime" }],
    authorRef: "product-agent-v2",
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "contract-v2-product",
    criteria: [criterion("criterion-deployment", "deployment-loopback"),
      criterion("criterion-keyboard", "ux-keyboard"),
      criterion("criterion-latency", "nfr-latency"),
      criterion("criterion-login", "requirement-login"),
      criterion("criterion-runtime", "technology-runtime"),
      criterion("criterion-session", "security-session")],
    deploymentRequirements: [requirement("deployment-loopback", ["technology-runtime"])],
    functionalRequirements: [requirement("requirement-login")],
    journeys: [{ criterionIds: ["criterion-login", "criterion-session"],
      journeyId: "journey-login", statement: "A user signs in.", userJobId: "job-access" }],
    lineage: null,
    materialDecisions: [{ decisionId: "decision-stack", options: [
      { optionId: "option-next", statement: "Use Next.js." },
      { optionId: "option-rust", statement: "Use Axum." },
    ], question: "Which qualified profile?", selectedOptionId: "option-next" }],
    negativeScope: [{ scopeId: "scope-native", statement: "No native client." }],
    nonFunctionalRequirements: [requirement("nfr-latency", ["requirement-login"])],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first use." }],
    productCompleteDefinition: { criterionIds: [...CRITERIA],
      statement: "Every criterion is independently verified." },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "revision-v2-choice",
    securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
    sourceDocumentDigests: [hex("a")],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
    technologyRequirements: [requirement("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
    ...overrides,
  };
}

function clarification(
  left: Record<string, unknown> = candidate(),
  right: Record<string, unknown> = candidate({
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 45, unit: "days" }],
  }),
): Record<string, unknown> {
  return {
    options: [
      { candidateDraft: right, label: "Forty-five days", optionId: "a-option" },
      { candidateDraft: left, label: "Thirty days", optionId: "Z-option" },
    ],
    question: "Which complete v2 product definition should govern delivery?",
  };
}

function requireAssessment(): Assessment {
  expect(typeof assess).toBe("function");
  if (typeof assess !== "function") return () => ({ ok: false });
  return assess;
}

describe("ProductContractRevision /2 clarification materiality", () => {
  it("admits complete v2 candidates and orders server-derived digests by UTF-16 code unit", () => {
    const result = requireAssessment()(clarification());
    expect(result).toMatchObject({ material: true, ok: true });
    const options = result["optionDigests"] as readonly Record<string, unknown>[];
    expect(options.map((option) => option["optionId"])).toEqual(["Z-option", "a-option"]);
    expect(options.map((option) => option["label"])).toEqual(["Thirty days", "Forty-five days"]);
    expect(options.map((option) => option["projectionDigest"])).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/u), expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(options.map((option) => option["revisionDigest"])).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/u), expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(result["sharedIdentity"]).toEqual({
      authorRef: "product-agent-v2",
      contractId: "contract-v2-product",
      lineage: null,
      retiredCriterionIds: [],
      retiredRequirementIds: [],
      revisionId: "revision-v2-choice",
      sourceDocumentDigests: [hex("a")],
    });
    expect(new Set(options.map((option) => option["projectionDigest"])).size).toBe(2);
    expect(core.PRODUCT_CONTRACT_V2_CLARIFICATION_PROJECTION_DIGEST_DOMAIN)
      .toBe("moe-product-contract-clarification-projection/2");
  });

  it("publishes one exact projection digest helper for proposal and Gate 1 binding", () => {
    expect(typeof projectionDigest).toBe("function");
    if (projectionDigest === undefined) return;
    const created = core.createProductContractRevisionV2(candidate());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const direct = projectionDigest(created.revision);
    const assessed = requireAssessment()(clarification());
    const selected = (assessed["optionDigests"] as readonly Record<string, unknown>[])
      .find((option) => option["optionId"] === "Z-option");
    expect(direct).toEqual({ ok: true, projectionDigest: selected?.["projectionDigest"] });
  });

  it("is independent of presentation order while preserving code-unit canonical order", () => {
    const forward = clarification();
    const reverse = structuredClone(forward);
    (reverse["options"] as unknown[]).reverse();
    expect(requireAssessment()(reverse)).toEqual(requireAssessment()(forward));
  });

  it("refuses identical and duplicate candidate choices as immaterial", () => {
    const same = candidate();
    expect(requireAssessment()(clarification(same, structuredClone(same)))).toEqual({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_IMMATERIAL",
      layer: "PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY",
      ok: false,
    });
    const three = clarification();
    (three["options"] as unknown[]).push({
      candidateDraft: candidate(), label: "Duplicate thirty days", optionId: "z-option",
    });
    expect(requireAssessment()(three)).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_IMMATERIAL", ok: false,
    });
  });

  it("refuses vacuous, duplicate-id, inexact, and caller-digest shapes", () => {
    const one = clarification();
    (one["options"] as unknown[]).pop();
    expect(requireAssessment()(one)).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_VACUOUS", ok: false,
    });
    const duplicateId = clarification();
    (duplicateId["options"] as Record<string, unknown>[])[1]!["optionId"] = "a-option";
    for (const invalid of [
      { ...clarification(), extra: true },
      { ...clarification(), options: [
        ...(clarification()["options"] as unknown[]),
        { candidateDraft: candidate(), label: "Forged", optionId: "x",
          projectionDigest: hex("f") },
      ] },
      duplicateId,
    ]) {
      expect(requireAssessment()(invalid)).toMatchObject({
        code: "PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID", ok: false,
      });
    }
  });

  it.each([
    ["authorRef", "another-author"],
    ["contractId", "another-contract"],
    ["revisionId", "another-revision"],
    ["sourceDocumentDigests", [hex("b")]],
  ])("refuses a %s-only difference as unstable identity/provenance", (field, changed) => {
    expect(requireAssessment()(clarification(candidate(), candidate({ [field]: changed })))).toEqual({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_IDENTITY_MISMATCH",
      layer: "PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY",
      ok: false,
    });
  });

  it("requires lineage and tombstone provenance to stay stable", () => {
    const lineage = { parentRevisionDigest: hex("b"), parentRevisionId: "revision-v2-parent" };
    const left = candidate({ lineage, retiredCriterionIds: ["criterion-retired"] });
    const right = candidate({ lineage: { ...lineage, parentRevisionDigest: hex("c") },
      retiredCriterionIds: ["criterion-retired"],
      budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 45, unit: "days" }] });
    expect(requireAssessment()(clarification(left, right))).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_IDENTITY_MISMATCH", ok: false,
    });
    expect(requireAssessment()(clarification(
      left,
      candidate({ lineage, retiredCriterionIds: ["another-retired"],
        budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 45, unit: "days" }] }),
    ))).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_IDENTITY_MISMATCH", ok: false,
    });
  });

  it("forwards v2 codec semantics and never falls back to the v1 projection", () => {
    const invalid = candidate({ materialDecisions: [{ decisionId: "decision-stack", options: [
      { optionId: "option-next", statement: "Use Next.js." },
      { optionId: "option-rust", statement: "Use Axum." },
    ], question: "Which qualified profile?", selectedOptionId: null }] });
    expect(requireAssessment()(clarification(candidate(), invalid))).toEqual({
      code: "PRODUCT_CONTRACT_V2_MATERIAL_DECISION_UNRESOLVED",
      layer: "PRODUCT_CONTRACT_V2_SEMANTICS",
      ok: false,
    });
    expect(requireAssessment()({
      options: [{ label: "v1", optionId: "one", projection: { criteria: [], requirements: [] } },
        { label: "v1 again", optionId: "two",
          projection: { criteria: [{}], requirements: [{}] } }],
      question: "Can a v1 projection cross this boundary?",
    })).toMatchObject({ code: "PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID", ok: false });
  });

  it("rejects a hostile changing proxy and never executes accessors", () => {
    const stable = clarification(candidate(), structuredClone(candidate()));
    const material = clarification();
    let optionReads = 0;
    const changing = new Proxy(stable, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "options") {
          optionReads += 1;
          return { configurable: true, enumerable: true,
            value: optionReads === 1 ? target["options"] : material["options"], writable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(requireAssessment()(changing)).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID", ok: false,
    });
    expect(optionReads).toBe(0);

    const accessor = clarification();
    Object.defineProperty(accessor, "extra", {
      enumerable: true, get: () => { throw new Error("must not execute"); },
    });
    expect(() => requireAssessment()(accessor)).not.toThrow();
    expect(requireAssessment()(accessor)).toMatchObject({
      code: "PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID", ok: false,
    });
  });
});
