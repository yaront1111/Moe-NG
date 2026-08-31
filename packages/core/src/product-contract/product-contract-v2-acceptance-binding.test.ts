import { describe, expect, it } from "vitest";

import {
  createAcceptanceContract,
} from "../planning/acceptance-contract-codec.js";
import { grantHumanAuthority } from "../planning/approval-authority.js";
import {
  productContractGate1Authority,
} from "./product-contract-acceptance-binding.js";
import { validateProductAcceptanceBindingV2 } from
  "./product-contract-v2-acceptance-binding.js";
import { snapshotProductAcceptanceData } from
  "./product-contract-v2-acceptance-snapshot.js";
import { createProductContractRevisionV2 } from "./product-contract-v2-codec.js";
import type {
  ProductContractRevisionV2, ProductContractV2Criterion,
} from "./product-contract-v2-contract.js";

const hex = (digit: string): string => digit.repeat(64);
const requirement = (requirementId: string, dependsOnRequirementIds: readonly string[] = []) => ({
  dependsOnRequirementIds, priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Verify ${criterionId}.`,
});

function revision(): ProductContractRevisionV2 {
  const criterionIds = ["c-deploy", "c-keyboard", "c-latency", "c-login", "c-runtime", "c-session"];
  const created = createProductContractRevisionV2({
    assumptions: [{ assumptionId: "a-browser", statement: "A browser exists.",
      validationCriterionId: "c-runtime" }],
    authorRef: "principal-product",
    budgets: [{ budgetId: "b-time", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "contract-v2",
    criteria: [criterion("c-deploy", "r-deploy"), criterion("c-keyboard", "r-ux"),
      criterion("c-latency", "r-nfr"), criterion("c-login", "r-login"),
      criterion("c-runtime", "r-tech"), criterion("c-session", "r-security")],
    deploymentRequirements: [requirement("r-deploy", ["r-tech"])],
    functionalRequirements: [requirement("r-login")],
    journeys: [{ criterionIds: ["c-login", "c-session"], journeyId: "j-login",
      statement: "A user signs in.", userJobId: "job-access" }],
    lineage: null,
    materialDecisions: [{ decisionId: "d-stack", options: [
      { optionId: "axum", statement: "Use Axum." },
      { optionId: "next", statement: "Use Next.js." },
    ], question: "Which qualified stack?", selectedOptionId: "next" }],
    negativeScope: [{ scopeId: "s-native", statement: "No native client." }],
    nonFunctionalRequirements: [requirement("r-nfr", ["r-login"])],
    objectives: [{ objectiveId: "o-use", statement: "Enable first use." }],
    productCompleteDefinition: { criterionIds, statement: "Verify every criterion." },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "revision-v2",
    securityPrivacyRequirements: [requirement("r-security", ["r-login"])],
    sourceDocumentDigests: [hex("a")],
    successMetrics: [{ measurement: "Count successful sessions.", metricId: "m-use",
      objectiveIds: ["o-use"], statement: "Users finish.", target: "At least 80 percent." }],
    technologyRequirements: [requirement("r-tech")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("r-ux", ["r-login"])],
  });
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.revision;
}

function revisionWithCriteria(count: number): ProductContractRevisionV2 {
  const base = revision();
  const { advisoryOnly: _advisory, revisionDigest: _digest, version: _version, ...draft } = base;
  const criteria = [
    ...base.criteria,
    ...Array.from({ length: count - base.criteria.length }, (_, index) => criterion(
      `c-extra-${String(index).padStart(4, "0")}`, "r-login",
    )),
  ].sort((left, right) => left.criterionId.localeCompare(right.criterionId));
  const created = createProductContractRevisionV2({
    ...draft, criteria,
    productCompleteDefinition: {
      criterionIds: criteria.map((item) => item.criterionId),
      statement: "Verify every criterion.",
    },
  });
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.revision;
}

const graphBinding = () => ({ graphContentHash: hex("b"), graphRevisionRef: "graph-revision-v2" });
const obligation = (item: ProductContractV2Criterion) => ({
  criterionId: item.criterionId,
  evidenceRequirements: [{ evidenceRef: `evidence:${item.requirementId}`,
    kind: "VERIFICATION_RECEIPT" as const, requirementId: item.requirementId }],
  statement: item.statement,
  verificationRecipeRefs: [`recipe:${item.criterionId}`],
});
function acceptance(
  value: ProductContractRevisionV2,
  obligations = value.criteria.map(obligation),
) {
  const created = createAcceptanceContract({
    applicability: { ...graphBinding(), nodeIds: ["node-global-verifier"],
      nodeKind: "GLOBAL_VERIFICATION" },
    authorRef: "principal-architect", contractId: "acceptance-v2", obligations,
  });
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.contract;
}
function gate(value: ProductContractRevisionV2) {
  const granted = grantHumanAuthority(
    productContractGate1Authority(value),
    { kind: "HUMAN", principalId: "human:operator" },
    1_788_000_000_000,
  );
  if (!granted.ok) throw new Error(`${granted.code}@${granted.layer}`);
  return granted.gate;
}
function request(value = revision()) {
  return { acceptanceContract: acceptance(value), gate1Approval: gate(value),
    graphBinding: graphBinding(), productContractRevision: value };
}
const refusal = (result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
};

describe("Product Contract /2 graph-bound acceptance", () => {
  it("rejects shared aliases and cycles in one bounded snapshot traversal", () => {
    const shared = { value: "once" };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const bounds = { maxArrayLength: 16, maxDepth: 8, maxNodes: 32 };
    expect(snapshotProductAcceptanceData({ left: shared, right: shared }, bounds))
      .toEqual({ ok: false });
    expect(snapshotProductAcceptanceData(cyclic, bounds)).toEqual({ ok: false });
  });

  it("binds every v2 requirement family and criterion to one exact graph", () => {
    const input = request();
    const result = validateProductAcceptanceBindingV2(input);
    expect(result).toEqual({
      acceptanceCriteriaDigest: input.acceptanceContract.criteriaDigest,
      advisoryOnly: true, graphBinding: graphBinding(), ok: true,
      productContractRevisionDigest: input.productContractRevision.revisionDigest,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).not.toContain("activate");
  });

  it("binds the full v2 criterion capacity without an acceptance dead-end", () => {
    const value = revisionWithCriteria(1_024);
    const input = request(value);
    expect(value.criteria).toHaveLength(1_024);
    expect(input.acceptanceContract.obligations).toHaveLength(1_024);
    expect(validateProductAcceptanceBindingV2(input)).toMatchObject({ ok: true });
  });

  it("refuses an uncovered requirement from any v2 requirement family", () => {
    const value = revision();
    for (const missing of ["r-deploy", "r-login", "r-nfr", "r-security", "r-tech", "r-ux"]) {
      const contract = acceptance(value, value.criteria.filter(
        (item) => item.requirementId !== missing,
      ).map(obligation));
      expect(refusal(validateProductAcceptanceBindingV2({ ...request(value),
        acceptanceContract: contract }))).toEqual([
        "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS", "ACCEPTANCE_BINDING",
      ]);
    }
  });

  it("refuses criterion content drift and evidence attached to a foreign requirement", () => {
    const value = revision();
    const [first, ...rest] = value.criteria;
    const drifted = acceptance(value, [{ ...obligation(first!), statement: "Different outcome." },
      ...rest.map(obligation)]);
    expect(refusal(validateProductAcceptanceBindingV2({ ...request(value),
      acceptanceContract: drifted }))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH", "ACCEPTANCE_BINDING",
    ]);
    const wrongEvidence = acceptance(value, [{ ...obligation(first!), evidenceRequirements: [{
      evidenceRef: "evidence:r-login", kind: "VERIFICATION_RECEIPT" as const,
      requirementId: "r-login",
    }] }, ...rest.map(obligation)]);
    expect(refusal(validateProductAcceptanceBindingV2({ ...request(value),
      acceptanceContract: wrongEvidence }))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS", "ACCEPTANCE_BINDING",
    ]);
    const swapped = acceptance(value, [
      { ...obligation(first!), evidenceRequirements: [{
        evidenceRef: "evidence:r-ux", kind: "VERIFICATION_RECEIPT" as const,
        requirementId: "r-ux",
      }] },
      { ...obligation(rest[0]!), evidenceRequirements: [{
        evidenceRef: "evidence:r-deploy", kind: "VERIFICATION_RECEIPT" as const,
        requirementId: "r-deploy",
      }] },
      ...rest.slice(1).map(obligation),
    ]);
    expect(refusal(validateProductAcceptanceBindingV2({ ...request(value),
      acceptanceContract: swapped }))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS", "ACCEPTANCE_BINDING",
    ]);
  });

  it("requires every criterion even when another criterion covers the same requirement", () => {
    const value = revisionWithCriteria(7);
    const contract = acceptance(value, value.criteria.filter(
      (item) => item.criterionId !== "c-extra-0000",
    ).map(obligation));
    expect(refusal(validateProductAcceptanceBindingV2({ ...request(value),
      acceptanceContract: contract }))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH", "ACCEPTANCE_BINDING",
    ]);
  });

  it("preserves exact Gate 1 and v2 provenance refusals", () => {
    const input = request();
    expect(refusal(validateProductAcceptanceBindingV2({ ...input,
      gate1Approval: productContractGate1Authority(input.productContractRevision) }))).toEqual([
      "APPROVAL_HUMAN_AUTHORITY_REQUIRED", "HUMAN_AUTHORITY_GATE",
    ]);
    expect(refusal(validateProductAcceptanceBindingV2({ ...input,
      productContractRevision: { ...input.productContractRevision, revisionDigest: hex("f") } })))
      .toEqual(["PRODUCT_CONTRACT_V2_DIGEST_MISMATCH", "PRODUCT_CONTRACT_V2_PROVENANCE"]);
  });

  it("refuses stale graph identity and malformed accessors without invoking them", () => {
    const input = request();
    expect(refusal(validateProductAcceptanceBindingV2({ ...input,
      graphBinding: { ...graphBinding(), graphRevisionRef: "other" } }))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH", "ACCEPTANCE_BINDING",
    ]);
    let hits = 0;
    const hostile = Object.defineProperty({}, "productContractRevision", {
      enumerable: true, get: () => { hits += 1; return input.productContractRevision; },
    });
    expect(refusal(validateProductAcceptanceBindingV2(hostile as never))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING",
    ]);
    expect(hits).toBe(0);
    let proxyTraps = 0;
    const proxied = new Proxy({}, {
      getOwnPropertyDescriptor: () => { proxyTraps += 1; return undefined; },
      getPrototypeOf: () => { proxyTraps += 1; return Object.prototype; },
      ownKeys: () => { proxyTraps += 1; return []; },
    });
    expect(refusal(validateProductAcceptanceBindingV2({
      ...input, acceptanceContract: proxied,
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING"]);
    expect(proxyTraps).toBe(0);
  });

  it("refuses forged acceptance content identity through the production codec", () => {
    const input = request();
    expect(refusal(validateProductAcceptanceBindingV2({
      ...input,
      acceptanceContract: { ...input.acceptanceContract, criteriaDigest: hex("f") },
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING"]);
  });
});
