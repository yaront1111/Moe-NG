import { describe, expect, it } from "vitest";

import { grantHumanAuthority } from "../planning/approval-authority.js";
import {
  productContractGate1Authority,
} from "./product-contract-acceptance-binding.js";
import { createProductContractRevisionV2 } from "./product-contract-v2-codec.js";
import { validateProductContractGate1V2 } from "./product-contract-v2-gate-1.js";

const hex = (digit: string): string => digit.repeat(64);
const requirement = (requirementId: string, dependsOnRequirementIds: readonly string[] = []) => ({
  dependsOnRequirementIds, priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Verify ${criterionId}.`,
});

function revision(revisionId = "revision-v2-a") {
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
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId,
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

function granted(revisionValue = revision()) {
  const outcome = grantHumanAuthority(
    productContractGate1Authority(revisionValue),
    { kind: "HUMAN", principalId: "human:operator" },
    1_788_000_000_000,
  );
  if (!outcome.ok) throw new Error(`${outcome.code}@${outcome.layer}`);
  return outcome.gate;
}

function changingRevision(first: object, second: object): object {
  let current = first;
  let snapshots = 0;
  return new Proxy(Object.create(null) as object, {
    get: (_target, property) => Reflect.get(current, property),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
    ownKeys: () => {
      current = snapshots++ === 0 ? first : second;
      return Reflect.ownKeys(current);
    },
  });
}

describe("Product Contract /2 Gate 1", () => {
  it("derives the human gate verdict from exact admitted /2 bytes", () => {
    const value = revision();
    expect(validateProductContractGate1V2(value, granted(value))).toEqual({
      advisoryOnly: true, gate: "GATE_1", ok: true, revisionDigest: value.revisionDigest,
    });
  });

  it("refuses a transplanted grant and a forged /2 digest at their owning layers", () => {
    const value = revision();
    expect(validateProductContractGate1V2(value, granted(revision("revision-v2-b"))))
      .toEqual({ code: "PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", layer: "GATE_1", ok: false });
    expect(validateProductContractGate1V2({ ...value, revisionDigest: hex("f") }, granted(value)))
      .toEqual({
        code: "PRODUCT_CONTRACT_V2_DIGEST_MISMATCH",
        layer: "PRODUCT_CONTRACT_V2_PROVENANCE",
        ok: false,
      });
  });

  it("snapshots a changing caller once before digest and Gate 1 binding checks", () => {
    const first = revision("revision-v2-first");
    const second = { ...revision("revision-v2-second"), revisionDigest: hex("f") };
    expect(validateProductContractGate1V2(
      changingRevision(first, second), granted(second),
    )).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", layer: "GATE_1", ok: false,
    });
  });
});
