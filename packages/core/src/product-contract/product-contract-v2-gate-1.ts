import type { ApprovalAuthorityRefusal, HumanAuthorityGate } from
  "../planning/approval-authority.js";
import type { ProductContractGate1Result } from
  "./product-contract-acceptance-binding.js";
import { validateProductContractGate1Ref } from
  "./product-contract-acceptance-binding.js";
import { admitProductContractRevisionV2 } from "./product-contract-v2-admission.js";
import { encodeProductContractRevisionV2 } from "./product-contract-v2-codec.js";
import type { ProductContractRefusal } from "./product-contract-contract.js";
import type { ProductContractV2Refusal } from "./product-contract-v2-contract.js";

export type ProductContractV2Gate1Result =
  | Extract<ProductContractGate1Result, { readonly ok: true }>
  | ApprovalAuthorityRefusal
  | ProductContractRefusal
  | ProductContractV2Refusal;

/**
 * Revalidates exact `/2` content bytes before consulting the shared human Gate 1 authority.
 * The grant binds only the common immutable identity triple; no `/1` revision decoder is used.
 */
export function validateProductContractGate1V2(
  revisionValue: unknown,
  gate: HumanAuthorityGate,
): ProductContractV2Gate1Result;
export function validateProductContractGate1V2(
  revisionValue: unknown,
  gateValue: unknown,
): ProductContractV2Gate1Result {
  const encoded = encodeProductContractRevisionV2(revisionValue);
  if (!encoded.ok) return encoded;
  const admitted = admitProductContractRevisionV2(revisionValue);
  if (!admitted.ok) return admitted;
  return validateProductContractGate1Ref({
    contractId: admitted.revision.contractId,
    revisionDigest: admitted.revision.revisionDigest,
    revisionId: admitted.revision.revisionId,
  }, gateValue);
}
