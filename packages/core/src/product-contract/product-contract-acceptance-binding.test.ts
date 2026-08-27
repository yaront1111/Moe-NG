import { describe, expect, it } from "vitest";
import {
  grantHumanAuthority, type HumanAuthorityGate, type HumanAuthorityGrant,
} from "../planning/approval-authority.js";
import { createProductContractRevision } from "./product-contract-codec.js";
import { admitProductContractRevisionRef } from "./product-contract-admission.js";
import {
  productContractGate1Authority, validateProductAcceptanceBinding, validateProductContractGate1,
} from "./product-contract-acceptance-binding.js";
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
const withGrant = (
  gate: HumanAuthorityGate, patch: Partial<HumanAuthorityGrant>,
): HumanAuthorityGate => {
  const grant = gate.grant;
  if (grant === null) throw new Error("expected a granted gate");
  return { ...gate, grant: { ...grant, ...patch } };
};

/** The identity triple a runtime writer holds, taken from a REAL revision. */
const refOf = (revision = revisionOrThrow()) => ({
  contractId: revision.contractId,
  revisionDigest: revision.revisionDigest,
  revisionId: revision.revisionId,
});
const admittedRefOrThrow = (value: unknown) => {
  const admitted = admitProductContractRevisionRef(value);
  if (!admitted.ok) throw new Error(`${admitted.code}@${admitted.layer}`);
  return admitted.ref;
};

const graphBinding = () => ({ graphContentHash: hex("b"), graphRevisionRef: "graph-revision-1" });
const refusal = (result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
};

describe("Gate 1 and graph-bound acceptance", () => {
  it("satisfies Gate 1 only from a production-minted human authority grant", () => {
    const revision = revisionOrThrow();
    const result = validateProductContractGate1(revision, humanGate(revision));
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

  it("refuses an absent Gate 1 authority at GATE_1", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductContractGate1(revision, null as never)))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_REQUIRED", "GATE_1"]);
    expect(refusal(validateProductContractGate1(revision, undefined as never)))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_REQUIRED", "GATE_1"]);
  });

  it("refuses an unsatisfied gate at HUMAN_AUTHORITY_GATE rather than at GATE_1", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductContractGate1(revision, productContractGate1Authority(revision))))
      .toEqual(["APPROVAL_HUMAN_AUTHORITY_REQUIRED", "HUMAN_AUTHORITY_GATE"]);
  });

  it("refuses an agent-authored grant at HUMAN_AUTHORITY_GATE", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductContractGate1(
      revision, withGrant(humanGate(revision), { principalKind: "AGENT" }),
    ))).toEqual(["APPROVAL_PRINCIPAL_NOT_HUMAN", "HUMAN_AUTHORITY_GATE"]);
    expect(refusal(validateProductContractGate1(
      revision, withGrant(humanGate(revision), { principalId: "   " }),
    ))).toEqual(["APPROVAL_PRINCIPAL_UNNAMED", "HUMAN_AUTHORITY_GATE"]);
    expect(refusal(validateProductContractGate1(
      revision, withGrant(humanGate(revision), { grantedAtEpochMs: Number.NaN }),
    ))).toEqual(["APPROVAL_GRANT_MOMENT_INVALID", "HUMAN_AUTHORITY_GATE"]);
  });

  it("refuses a grant carried from foreign work at HUMAN_AUTHORITY_GATE", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductContractGate1(
      revision, withGrant(humanGate(revision), { workRef: "product-contract:other-work" }),
    ))).toEqual(["APPROVAL_AUTHORITY_BINDING_MISMATCH", "HUMAN_AUTHORITY_GATE"]);
    expect(refusal(validateProductContractGate1(
      revision, withGrant(humanGate(revision), { gateId: "moe.product-contract.gate-2" }),
    ))).toEqual(["APPROVAL_AUTHORITY_BINDING_MISMATCH", "HUMAN_AUTHORITY_GATE"]);
    expect(refusal(validateProductContractGate1(revision, { ...humanGate(revision), workRef: "" })))
      .toEqual(["APPROVAL_AUTHORITY_BINDING_MISMATCH", "HUMAN_AUTHORITY_GATE"]);
  });

  it("refuses an internally valid grant transplanted onto this revision at GATE_1", () => {
    const revision = revisionOrThrow();
    const staleRevision = revisionOrThrow(twoRequirementDraft());
    expect(staleRevision.revisionDigest).not.toBe(revision.revisionDigest);
    expect(refusal(validateProductContractGate1(revision, humanGate(staleRevision))))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]);
    const otherGate = grantedGate({
      gateId: "moe.product-contract.gate-2", grant: null,
      workRef: productContractGate1Authority(revision).workRef,
    });
    expect(refusal(validateProductContractGate1(revision, otherGate)))
      .toEqual(["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]);
  });

  it("confers no downstream acceptance for any Gate 1 refusal class", () => {
    const revision = revisionOrThrow();
    const cases: readonly (readonly [unknown, readonly [string, string]])[] = [
      [null, ["PRODUCT_CONTRACT_GATE_1_REQUIRED", "GATE_1"]],
      [forgedApproval(revision), ["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]],
      [productContractGate1Authority(revision),
        ["APPROVAL_HUMAN_AUTHORITY_REQUIRED", "HUMAN_AUTHORITY_GATE"]],
      [withGrant(humanGate(revision), { principalKind: "AGENT" }),
        ["APPROVAL_PRINCIPAL_NOT_HUMAN", "HUMAN_AUTHORITY_GATE"]],
      [withGrant(humanGate(revision), { workRef: "product-contract:other-work" }),
        ["APPROVAL_AUTHORITY_BINDING_MISMATCH", "HUMAN_AUTHORITY_GATE"]],
      [humanGate(revisionOrThrow(twoRequirementDraft())),
        ["PRODUCT_CONTRACT_GATE_1_BINDING_INVALID", "GATE_1"]],
    ];
    expect(cases.length).toBe(6);
    for (const [gate1Approval, expected] of cases) {
      const result = validateProductAcceptanceBinding({
        acceptanceContract: acceptanceContract(), gate1Approval: gate1Approval as never,
        graphBinding: graphBinding(), productContractRevision: revision,
      });
      expect(refusal(result)).toEqual(expected);
      expect(Object.keys(result)).not.toContain("acceptanceCriteriaDigest");
    }
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
      acceptanceContract: acceptance, gate1Approval: humanGate(revision),
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
      acceptanceContract: acceptanceContract(), gate1Approval: humanGate(revision),
      graphBinding: { ...graphBinding(), graphContentHash: hex("c") },
      productContractRevision: revision,
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH", "ACCEPTANCE_BINDING"]);
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract(), gate1Approval: humanGate(revision),
      graphBinding: { ...graphBinding(), graphRevisionRef: "x".repeat(513) },
      productContractRevision: revision,
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING"]);
  });

  it("refuses criterion mutation even when the stable id is reused", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract({ statement: "An unrelated outcome." }),
      gate1Approval: humanGate(revision), graphBinding: graphBinding(),
      productContractRevision: revision,
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH", "ACCEPTANCE_BINDING"]);
  });

  it("refuses vacuous requirement coverage", () => {
    const revision = revisionOrThrow(twoRequirementDraft());
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: acceptanceContract(), gate1Approval: humanGate(revision),
      graphBinding: graphBinding(), productContractRevision: revision,
    }))).toEqual([
      "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS", "ACCEPTANCE_BINDING",
    ]);
  });

  it("refuses a forged acceptance digest through the production acceptance reader", () => {
    const revision = revisionOrThrow();
    expect(refusal(validateProductAcceptanceBinding({
      acceptanceContract: { ...acceptanceContract(), criteriaDigest: hex("f") },
      gate1Approval: humanGate(revision), graphBinding: graphBinding(),
      productContractRevision: revision,
    }))).toEqual(["PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "ACCEPTANCE_BINDING"]);
  });

  it("derives the same unsatisfied gate from the admitted ref as from the full revision", () => {
    const revision = revisionOrThrow();
    expect(productContractGate1Authority(admittedRefOrThrow(refOf(revision))))
      .toEqual(productContractGate1Authority(revision));
  });

  /**
   * The digest is what makes one grant usable on exactly one revision. Arm (c)
   * above stays GREEN if the digest is dropped from the derivation, because both
   * of its sides drop it together; only a ref that differs ONLY in the digest
   * can witness that the digest is read at all.
   */
  it("the digest participates in the work reference", () => {
    const revision = revisionOrThrow();
    const other = admittedRefOrThrow({ ...refOf(revision), revisionDigest: hex("f") });
    expect([other.contractId, other.revisionId]).toEqual([revision.contractId, revision.revisionId]);
    expect(other.revisionDigest).not.toBe(revision.revisionDigest);
    expect(productContractGate1Authority(other).workRef)
      .not.toBe(productContractGate1Authority(revision).workRef);
  });

  it("a grant minted on the ref satisfies Gate 1 for the full revision", () => {
    const revision = revisionOrThrow();
    const gate = grantedGate(productContractGate1Authority(admittedRefOrThrow(refOf(revision))));
    expect(validateProductContractGate1(revision, gate)).toEqual({
      advisoryOnly: true, gate: "GATE_1", ok: true, revisionDigest: revision.revisionDigest,
    });
  });
});
