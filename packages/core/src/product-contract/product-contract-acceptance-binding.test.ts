import { describe, expect, it } from "vitest";
import { createProductContractRevision } from "./product-contract-codec.js";
import {
  validateProductAcceptanceBinding, validateProductContractGate1,
} from "./product-contract-acceptance-binding.js";
import {
  acceptanceContract, deeplyFrozen, hex, productContractDraft, twoRequirementDraft,
} from "./product-contract-test-fixtures.js";

const revisionOrThrow = (draft: unknown = productContractDraft()) => {
  const result = createProductContractRevision(draft);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
};
const approval = (revision = revisionOrThrow()) => ({
  approvalId: "approval-gate-1", approvedAtEpochMs: 1_787_516_800_000,
  contractId: revision.contractId, principalId: "human:yaron", principalKind: "HUMAN",
  revisionDigest: revision.revisionDigest, revisionId: revision.revisionId,
});
const graphBinding = () => ({ graphContentHash: hex("b"), graphRevisionRef: "graph-revision-1" });
const refusal = (result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
};

describe("Gate 1 and graph-bound acceptance", () => {
  it("validates an exact human Gate 1 binding without mutating advisory contract authority", () => {
    const revision = revisionOrThrow();
    const result = validateProductContractGate1(revision, approval(revision));
    expect(result).toEqual({
      advisoryOnly: true, gate: "GATE_1", ok: true, revisionDigest: revision.revisionDigest,
    });
    expect(revision.advisoryOnly).toBe(true);
    expect(deeplyFrozen(result)).toBe(true);
  });

  it("refuses absent and mismatched Gate 1 evidence at exact pairs", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductContractGate1(revision, null))).toEqual([
      "PRODUCT_CONTRACT_GATE_1_REQUIRED", "GATE_1",
    ]);
    expect(refusal(validateProductContractGate1(revision, {
      ...approval(revision), revisionDigest: hex("f"),
    }))).toEqual(["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]);
    expect(refusal(validateProductContractGate1(revision, {
      ...approval(revision), principalId: "x".repeat(513),
    }))).toEqual(["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]);
  });

  it("refuses a malformed binding request without invoking accessors", () => {
    expect(refusal(validateProductAcceptanceBinding(null as never))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING",
    ]);
    let hits = 0;
    const hostile = Object.defineProperty({}, "productContractRevision", {
      enumerable: true, get: () => { hits += 1; return revisionOrThrow(); },
    });
    expect(refusal(validateProductAcceptanceBinding(hostile as never))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING",
    ]);
    expect(hits).toBe(0);
  });

  it("binds Gate 1 product criteria and requirements to the current graph acceptance", () => {
    const revision = revisionOrThrow();
    const acceptance = acceptanceContract();
    const result = validateProductAcceptanceBinding({
      acceptanceContract: acceptance, gate1Approval: approval(revision),
      graphBinding: graphBinding(), productContractRevision: revision,
    });
    expect(result).toEqual({
      acceptanceCriteriaDigest: acceptance.criteriaDigest, advisoryOnly: true,
      graphBinding: graphBinding(), ok: true, productContractRevisionDigest: revision.revisionDigest,
    });
    expect(deeplyFrozen(result)).toBe(true);
    expect(Object.keys(result).sort()).not.toContain("activate");
  });

  it("refuses a stale graph binding", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract(), gate1Approval: approval(revision),
      graphBinding: { ...graphBinding(), graphContentHash: hex("c") },
      productContractRevision: revision,
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH", "ACCEPTANCE_BINDING"]);
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract(), gate1Approval: approval(revision),
      graphBinding: { ...graphBinding(), graphRevisionRef: "x".repeat(513) },
      productContractRevision: revision,
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING"]);
  });

  it("refuses criterion mutation even when the stable id is reused", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract({ statement: "An unrelated outcome." }),
      gate1Approval: approval(revision), graphBinding: graphBinding(),
      productContractRevision: revision,
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH", "ACCEPTANCE_BINDING"]);
  });

  it("refuses vacuous requirement coverage", () => {
    const revision = revisionOrThrow(twoRequirementDraft());
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract(), gate1Approval: approval(revision),
      graphBinding: graphBinding(), productContractRevision: revision,
    }))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS", "ACCEPTANCE_BINDING",
    ]);
  });

  it("refuses a forged acceptance digest through the production acceptance reader", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: { ...acceptanceContract(), criteriaDigest: hex("f") },
      gate1Approval: approval(revision), graphBinding: graphBinding(),
      productContractRevision: revision,
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING"]);
  });
});
