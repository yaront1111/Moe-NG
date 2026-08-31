import type {
  ProductContractClarificationV2MaterialityResult,
  ProductContractClarificationV2SharedIdentity,
  ProductContractRevisionV2,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { validateRevisionProvenance }
  from "./product-contract-provenance.js";
import { encodeProductContractClarificationV2Value }
  from "./product-contract-v2-clarification-canonical.js";
import type { ProductContractClarificationV2CommandInput }
  from "./product-contract-v2-clarification-contract.js";
import { readCurrentProductContractRevisionV2 }
  from "./product-contract-v2-reader.js";

type Material = Extract<ProductContractClarificationV2MaterialityResult, { readonly ok: true }>;
type Refusal = Readonly<{ readonly code: string; readonly layer: string; readonly ok: false }>;
export type ProductContractClarificationV2AskAuthority =
  | Readonly<{ readonly ok: true }>
  | Refusal;

function refused(code: "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHOR_MISMATCH"
  | "PRODUCT_CONTRACT_V2_CLARIFICATION_CURRENT_MISMATCH"):
Refusal {
  return Object.freeze({ code, layer: "PRODUCT_CONTRACT_V2_CLARIFICATION", ok: false });
}

function identityOf(revision: ProductContractRevisionV2): ProductContractClarificationV2SharedIdentity {
  return Object.freeze({
    authorRef: revision.authorRef, contractId: revision.contractId,
    lineage: revision.lineage, retiredCriterionIds: revision.retiredCriterionIds,
    retiredRequirementIds: revision.retiredRequirementIds, revisionId: revision.revisionId,
    sourceDocumentDigests: revision.sourceDocumentDigests,
  });
}

function sameIdentity(
  left: ProductContractClarificationV2SharedIdentity,
  right: ProductContractClarificationV2SharedIdentity,
): boolean {
  const a = encodeProductContractClarificationV2Value(left);
  const b = encodeProductContractClarificationV2Value(right);
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

/** Proves that a material ask belongs to its authenticated author and durable goal sources. */
export function validateProductContractClarificationV2AskIdentityAuthority(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
  goalRef: string,
  materiality: Material,
): ProductContractClarificationV2AskAuthority {
  const identity = materiality.sharedIdentity;
  if (identity.authorRef !== input.principalId) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHOR_MISMATCH");
  }
  const provenance = validateRevisionProvenance(
    store, input.projectId, goalRef, identity.sourceDocumentDigests,
  );
  if (!provenance.ok) return provenance;
  return Object.freeze({ ok: true as const });
}

export function validateProductContractClarificationV2AskCurrentAuthority(
  store: SqliteEventStore,
  input: ProductContractClarificationV2CommandInput,
  materiality: Material,
): ProductContractClarificationV2AskAuthority {
  const identity = materiality.sharedIdentity;
  const current = readCurrentProductContractRevisionV2(store, {
    contractId: identity.contractId, projectId: input.projectId,
  });
  if (!current.ok) {
    if (current.code === "PRODUCT_CONTRACT_V2_CURRENT_SLOT_ABSENT"
      && current.layer === "PRODUCT_CONTRACT_V2_REVISION_READER") {
      return identity.lineage === null ? Object.freeze({ ok: true as const })
        : refused("PRODUCT_CONTRACT_V2_CLARIFICATION_CURRENT_MISMATCH");
    }
    return current;
  }
  if (identity.revisionId === current.revision.revisionId) {
    const currentIsCandidate = materiality.optionDigests.some(
      (option) => option.revisionDigest === current.revision.revisionDigest,
    );
    return currentIsCandidate && sameIdentity(identity, identityOf(current.revision))
      ? Object.freeze({ ok: true as const })
      : refused("PRODUCT_CONTRACT_V2_CLARIFICATION_CURRENT_MISMATCH");
  }
  return identity.lineage?.parentRevisionId === current.revision.revisionId
    && identity.lineage.parentRevisionDigest === current.revision.revisionDigest
    ? Object.freeze({ ok: true as const })
    : refused("PRODUCT_CONTRACT_V2_CLARIFICATION_CURRENT_MISMATCH");
}
