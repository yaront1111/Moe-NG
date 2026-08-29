import { describe, expect, it } from "vitest";
import {
  grantHumanAuthority, type HumanAuthorityGate, type HumanAuthorityGrant,
} from "../planning/approval-authority.js";
import { createProductContractRevision } from "./product-contract-codec.js";
import {
  issueProductContractGate1Authority, productContractGate1Authority,
  validateProductAcceptanceBinding, validateProductContractGate1,
} from "./product-contract-acceptance-binding.js";
import type { ProductContractGate1Authority } from "./product-contract-acceptance-binding.js";
import {
  acceptanceContract, deeplyFrozen, hex, productContractDraft, twoRequirementDraft,
} from "./product-contract-test-fixtures.js";

const revisionOrThrow = (draft: unknown = productContractDraft()) => {
  const result = createProductContractRevision(draft);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
};

/**
 * THE FORGERY THIS ROW CLOSES: caller bytes that merely SAY a human approved.
 * A negative fixture on purpose, and it must never satisfy anything.
 */
const forgedApproval = (revision = revisionOrThrow()) => ({
  approvalId: "approval-gate-1", approvedAtEpochMs: 1_787_516_800_000,
  contractId: revision.contractId, principalId: "human:yaron", principalKind: "HUMAN",
  revisionDigest: revision.revisionDigest, revisionId: revision.revisionId,
});

/** The ONLY satisfying gate is minted by the production authority, never hand-written. */
const grantedGate = (gate: HumanAuthorityGate): HumanAuthorityGate => {
  const granted = grantHumanAuthority(
    gate, { kind: "HUMAN", principalId: "human:yaron" }, 1_787_516_800_000,
  );
  if (!granted.ok) throw new Error(`${granted.code}@${granted.layer}`);
  return granted.gate;
};
const humanGate = (revision = revisionOrThrow()): HumanAuthorityGate =>
  grantedGate(productContractGate1Authority(revision));
const opaqueAuthority = (
  revision = revisionOrThrow(), gate: unknown = humanGate(revision),
): ProductContractGate1Authority => {
  const issued = issueProductContractGate1Authority(revision, gate);
  if (!issued.ok) throw new Error(`${issued.code}@${issued.layer}`);
  return issued.authority;
};
const withGrant = (
  gate: HumanAuthorityGate, patch: Partial<HumanAuthorityGrant>,
): HumanAuthorityGate => {
  const grant = gate.grant;
  if (grant === null) throw new Error("expected a granted gate");
  return { ...gate, grant: { ...grant, ...patch } };
};

const graphBinding = () => ({ graphContentHash: hex("b"), graphRevisionRef: "graph-revision-1" });
const refusal = (result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
};

describe("Gate 1 and graph-bound acceptance", () => {
  it("satisfies Gate 1 only from a server-issued opaque authority", () => {
    const revision = revisionOrThrow();
    const result = validateProductContractGate1(revision, opaqueAuthority(revision));
    expect(result).toEqual({
      advisoryOnly: true, gate: "GATE_1", ok: true, revisionDigest: revision.revisionDigest,
    });
    expect(revision.advisoryOnly).toBe(true);
    expect(deeplyFrozen(result)).toBe(true);
  });

  it("refuses a caller-shaped human approval record at GATE_1", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductContractGate1(revision, forgedApproval(revision) as never)))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]);
  });

  it("refuses a Gate 1 grant minted entirely from caller-shaped HUMAN data", () => {
    const revision = revisionOrThrow();
    const callerMinted = grantHumanAuthority(
      productContractGate1Authority(revision),
      { kind: "HUMAN", principalId: "caller:forged-human" },
      1_787_516_800_000,
    );
    if (!callerMinted.ok) throw new Error(`${callerMinted.code}@${callerMinted.layer}`);
    expect(refusal(validateProductContractGate1(revision, callerMinted.gate as never)))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]);
  });

  it("refuses an absent Gate 1 authority at GATE_1", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductContractGate1(revision, null as never)))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_REQUIRED", "GATE_1"]);
    expect(refusal(validateProductContractGate1(revision, undefined as never)))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_REQUIRED", "GATE_1"]);
  });

  it("refuses an unsatisfied gate at HUMAN_AUTHORITY_GATE rather than at GATE_1", () => {
    const revision = revisionOrThrow();
    expect(refusal(issueProductContractGate1Authority(
      revision, productContractGate1Authority(revision),
    )))
      .toEqual(["APPROVAL_HUMAN_AUTHORITY_REQUIRED", "HUMAN_AUTHORITY_GATE"]);
  });

  it("refuses an agent-authored grant at HUMAN_AUTHORITY_GATE", () => {
    const revision = revisionOrThrow();
    expect(refusal(issueProductContractGate1Authority(
      revision, withGrant(humanGate(revision), { principalKind: "AGENT" }),
    ))).toEqual(["APPROVAL_PRINCIPAL_NOT_HUMAN", "HUMAN_AUTHORITY_GATE"]);
    expect(refusal(issueProductContractGate1Authority(
      revision, withGrant(humanGate(revision), { principalId: "   " }),
    ))).toEqual(["APPROVAL_PRINCIPAL_UNNAMED", "HUMAN_AUTHORITY_GATE"]);
    expect(refusal(issueProductContractGate1Authority(
      revision, withGrant(humanGate(revision), { grantedAtEpochMs: Number.NaN }),
    ))).toEqual(["APPROVAL_GRANT_MOMENT_INVALID", "HUMAN_AUTHORITY_GATE"]);
  });

  it("refuses a grant carried from foreign work at HUMAN_AUTHORITY_GATE", () => {
    const revision = revisionOrThrow();
    expect(refusal(issueProductContractGate1Authority(
      revision, withGrant(humanGate(revision), { workRef: "product-contract:other-work" }),
    ))).toEqual(["APPROVAL_AUTHORITY_BINDING_MISMATCH", "HUMAN_AUTHORITY_GATE"]);
    expect(refusal(issueProductContractGate1Authority(
      revision, withGrant(humanGate(revision), { gateId: "moe.product-contract.gate-2" }),
    ))).toEqual(["APPROVAL_AUTHORITY_BINDING_MISMATCH", "HUMAN_AUTHORITY_GATE"]);
    expect(refusal(issueProductContractGate1Authority(
      revision, { ...humanGate(revision), workRef: "" },
    )))
      .toEqual(["APPROVAL_AUTHORITY_BINDING_MISMATCH", "HUMAN_AUTHORITY_GATE"]);
  });

  it("refuses an internally valid grant transplanted onto this revision at GATE_1", () => {
    const revision = revisionOrThrow();
    const staleRevision = revisionOrThrow(twoRequirementDraft());
    expect(staleRevision.revisionDigest).not.toBe(revision.revisionDigest);
    expect(refusal(issueProductContractGate1Authority(revision, humanGate(staleRevision))))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]);
    const otherGate = grantedGate({
      gateId: "moe.product-contract.gate-2", grant: null,
      workRef: productContractGate1Authority(revision).workRef,
    });
    expect(refusal(issueProductContractGate1Authority(revision, otherGate)))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]);
  });

  it("confers no downstream acceptance for any unissued caller value", () => {
    const revision = revisionOrThrow();
    const cases: readonly (readonly [unknown, readonly [string, string]])[] = [
      [null, ["PRODUCT_CONTRACT_GATE_1_REQUIRED", "GATE_1"]],
      [forgedApproval(revision), ["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]],
      [productContractGate1Authority(revision),
        ["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]],
      [withGrant(humanGate(revision), { principalKind: "AGENT" }),
        ["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]],
      [withGrant(humanGate(revision), { workRef: "product-contract:other-work" }),
        ["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]],
      [humanGate(revisionOrThrow(twoRequirementDraft())),
        ["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]],
    ];
    expect(cases.length).toBe(6);
    for (const [gate1Approval, expected] of cases) {
      const result = validateProductAcceptanceBinding({
        acceptanceContract: acceptanceContract(),
        graphBinding: graphBinding(), productContractRevision: revision,
      }, gate1Approval as never);
      expect(refusal(result)).toEqual(expected);
      expect(Object.keys(result)).not.toContain("acceptanceCriteriaDigest");
    }
  });

  it("refuses a malformed binding request without invoking accessors", () => {
    expect(refusal(validateProductAcceptanceBinding(null as never, null as never))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING",
    ]);
    let hits = 0;
    const hostile = Object.defineProperty({}, "productContractRevision", {
      enumerable: true, get: () => { hits += 1; return revisionOrThrow(); },
    });
    expect(refusal(validateProductAcceptanceBinding(hostile as never, null as never))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING",
    ]);
    expect(hits).toBe(0);
  });

  it("binds Gate 1 product criteria and requirements to the current graph acceptance", () => {
    const revision = revisionOrThrow();
    const acceptance = acceptanceContract();
    const result = validateProductAcceptanceBinding({
      acceptanceContract: acceptance,
      graphBinding: graphBinding(), productContractRevision: revision,
    }, opaqueAuthority(revision));
    expect(result).toEqual({
      acceptanceCriteriaDigest: acceptance.criteriaDigest, advisoryOnly: true,
      graphBinding: graphBinding(), ok: true, productContractRevisionDigest: revision.revisionDigest,
    });
    expect(deeplyFrozen(result)).toBe(true);
    expect(Object.keys(result).sort()).not.toContain("activate");
  });

  it("refuses a stale graph binding", () => {
    const revision = revisionOrThrow();
    const authority = opaqueAuthority(revision);
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract(),
      graphBinding: { ...graphBinding(), graphContentHash: hex("c") },
      productContractRevision: revision,
    }, authority))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH", "ACCEPTANCE_BINDING"]);
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract(),
      graphBinding: { ...graphBinding(), graphRevisionRef: "x".repeat(513) },
      productContractRevision: revision,
    }, authority))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING"]);
  });

  it("refuses criterion mutation even when the stable id is reused", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract({ statement: "An unrelated outcome." }),
      graphBinding: graphBinding(),
      productContractRevision: revision,
    }, opaqueAuthority(revision))))
      .toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH", "ACCEPTANCE_BINDING"]);
  });

  it("refuses vacuous requirement coverage", () => {
    const revision = revisionOrThrow(twoRequirementDraft());
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract(),
      graphBinding: graphBinding(), productContractRevision: revision,
    }, opaqueAuthority(revision)))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS", "ACCEPTANCE_BINDING",
    ]);
  });

  it("refuses a forged acceptance digest through the production acceptance reader", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: { ...acceptanceContract(), criteriaDigest: hex("f") },
      graphBinding: graphBinding(),
      productContractRevision: revision,
    }, opaqueAuthority(revision))))
      .toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING"]);
  });
});
