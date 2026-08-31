import type { SqliteEventStore } from "@moe/store";

import { deriveProductContractClarificationV2Authority }
  from "./product-contract-v2-clarification-authority.js";
import type { ProductContractClarificationV2Row }
  from "./product-contract-v2-clarification-contract.js";
import { readProductContractClarificationsV2ForContract }
  from "./product-contract-v2-clarification-reader.js";
import { readCurrentProductContractRevisionV2 }
  from "./product-contract-v2-reader.js";

type Accepted = Readonly<{
  readonly ok: true;
  readonly status: "ANSWERED_PENDING" | "INVALID" | "OPEN" | "SATISFIED";
}>;
type Refused = Readonly<{ readonly code: string; readonly layer: string; readonly ok: false }>;
export type ProductContractClarificationV2ProjectedAuthority = Accepted | Refused;

const refused = (code: string, layer: string): Refused => Object.freeze({
  code, layer, ok: false as const,
});

/** Derives the aggregate authority that the proposed answer would commit. */
export function projectProductContractClarificationV2AnswerAuthority(
  store: SqliteEventStore,
  row: ProductContractClarificationV2Row,
  projectId: string,
): ProductContractClarificationV2ProjectedAuthority {
  const rows = readProductContractClarificationsV2ForContract(
    store, projectId, row.contractId,
  );
  if (rows.kind === "INVALID") {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY_INVALID",
      "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY");
  }
  if (rows.kind === "UNREADABLE") return refused(rows.code, rows.layer);
  let replaced = 0;
  const projected = rows.rows.map((candidate) => {
    if (candidate.clarificationId !== row.clarificationId) return candidate;
    replaced += 1;
    return row;
  });
  if (replaced !== 1) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY_INVALID",
      "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY");
  }
  const current = readCurrentProductContractRevisionV2(store, {
    contractId: row.contractId, projectId,
  });
  if (!current.ok && (current.code !== "PRODUCT_CONTRACT_V2_CURRENT_SLOT_ABSENT"
    || current.layer !== "PRODUCT_CONTRACT_V2_REVISION_READER")) {
    return refused(current.code, current.layer);
  }
  const committedRefs = current.ok
    ? Object.freeze([...current.slot.revisionHistory, current.slot.currentRevision])
    : Object.freeze([]);
  const authority = deriveProductContractClarificationV2Authority(projected, {
    committedRefs, contractId: row.contractId, goalRef: row.goalRef, projectId,
  });
  if (authority.status === "UNREADABLE") {
    return refused(authority.code, authority.layer);
  }
  return Object.freeze({ ok: true as const, status: authority.status });
}
