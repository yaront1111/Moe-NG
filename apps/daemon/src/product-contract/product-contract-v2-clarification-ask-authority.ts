import type {
  ProductContractClarificationV2MaterialityResult,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { validateRevisionProvenance }
  from "./product-contract-provenance.js";
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
    // A committed revision identity is immutable. A material ASK necessarily contains
    // at least two different revision digests, so admitting alternatives under the
    // already-used id would let an answer select bytes that can never be published.
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_CURRENT_MISMATCH");
  }
  return identity.lineage?.parentRevisionId === current.revision.revisionId
    && identity.lineage.parentRevisionDigest === current.revision.revisionDigest
    ? Object.freeze({ ok: true as const })
    : refused("PRODUCT_CONTRACT_V2_CLARIFICATION_CURRENT_MISMATCH");
}
