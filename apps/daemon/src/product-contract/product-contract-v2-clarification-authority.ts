import type { ProductContractRevisionV2Ref } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { encodeProductContractClarificationV2Value }
  from "./product-contract-v2-clarification-canonical.js";
import { compareProductContractV2CodeUnits }
  from "./product-contract-v2-clarification-contract.js";
import { readProductContractClarificationsV2ForContract }
  from "./product-contract-v2-clarification-reader.js";
import { readCurrentProductContractRevisionV2 }
  from "./product-contract-v2-reader.js";

export interface ProductContractClarificationV2Selection {
  readonly clarificationId: string;
  readonly contractId: string;
  readonly goalRef: string;
  readonly optionId: string;
  readonly projectionDigest: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
}

export type ProductContractClarificationV2Authority =
  | Readonly<{ readonly clarificationIds: readonly string[]; readonly status: "OPEN" }>
  | Readonly<{ readonly selection: ProductContractClarificationV2Selection;
    readonly status: "ANSWERED_PENDING" }>
  | Readonly<{ readonly status: "SATISFIED" }>
  | Readonly<{ readonly code: "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY_INVALID";
    readonly layer: "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY";
    readonly status: "INVALID" }>
  | Readonly<{ readonly code: string; readonly layer: string; readonly status: "UNREADABLE" }>;

const SATISFIED = Object.freeze({ status: "SATISFIED" as const });
const INVALID = Object.freeze({ code: "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY_INVALID" as const,
  layer: "PRODUCT_CONTRACT_V2_CLARIFICATION_AUTHORITY" as const,
  status: "INVALID" as const });

function sameSelection(
  left: ProductContractClarificationV2Selection,
  right: ProductContractClarificationV2Selection,
): boolean {
  const a = encodeProductContractClarificationV2Value({ contractId: left.contractId,
    goalRef: left.goalRef, projectionDigest: left.projectionDigest,
    revisionDigest: left.revisionDigest, revisionId: left.revisionId });
  const b = encodeProductContractClarificationV2Value({ contractId: right.contractId,
    goalRef: right.goalRef, projectionDigest: right.projectionDigest,
    revisionDigest: right.revisionDigest, revisionId: right.revisionId });
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

/** One durable clarification scan produces the complete fail-closed authority state. */
export function resolveProductContractClarificationV2Authority(
  store: SqliteEventStore,
  input: Readonly<{ readonly committedRefs: readonly ProductContractRevisionV2Ref[];
    readonly contractId: string; readonly goalRef: string | null; readonly projectId: string }>,
): ProductContractClarificationV2Authority {
  const read = readProductContractClarificationsV2ForContract(
    store, input.projectId, input.contractId,
  );
  if (read.kind === "INVALID") return INVALID;
  if (read.kind === "UNREADABLE") {
    return Object.freeze({ code: read.code, layer: read.layer, status: "UNREADABLE" as const });
  }
  const goals = new Set(read.rows.map((row) => row.goalRef));
  if ((input.goalRef !== null && [...goals].some((goal) => goal !== input.goalRef))
    || (input.goalRef === null && goals.size > 1)) return INVALID;
  const open = read.rows.filter((row) => row.answerDecision === null)
    .map((row) => row.clarificationId).sort(compareProductContractV2CodeUnits);
  if (open.length > 0) {
    return Object.freeze({ clarificationIds: Object.freeze(open), status: "OPEN" as const });
  }
  const pending: ProductContractClarificationV2Selection[] = [];
  for (const row of read.rows) {
    const answer = row.answerDecision;
    if (answer === null) return INVALID;
    if (input.committedRefs.some((reference) => reference.contractId === row.contractId
      && reference.revisionId === row.sharedIdentity.revisionId
      && reference.revisionDigest === answer.revisionDigest)) continue;
    pending.push(Object.freeze({ clarificationId: row.clarificationId,
      contractId: row.contractId, goalRef: row.goalRef, optionId: answer.optionId,
      projectionDigest: answer.projectionDigest, revisionDigest: answer.revisionDigest,
      revisionId: row.sharedIdentity.revisionId }));
  }
  if (pending.length === 0) return SATISFIED;
  const selected = pending[0]!;
  if (!pending.every((candidate) => sameSelection(candidate, selected))) return INVALID;
  return Object.freeze({ selection: selected, status: "ANSWERED_PENDING" as const });
}

/** Public self-contained authority read; committed references come only from the durable slot. */
export function readProductContractClarificationV2Authority(
  store: SqliteEventStore,
  input: Readonly<{ readonly contractId: string; readonly goalRef: string | null;
    readonly projectId: string }>,
): ProductContractClarificationV2Authority {
  const current = readCurrentProductContractRevisionV2(store, input);
  if (!current.ok && (current.code !== "PRODUCT_CONTRACT_V2_CURRENT_SLOT_ABSENT"
    || current.layer !== "PRODUCT_CONTRACT_V2_REVISION_READER")) {
    return Object.freeze({ code: current.code, layer: current.layer,
      status: "UNREADABLE" as const });
  }
  const committedRefs = current.ok
    ? Object.freeze([...current.slot.revisionHistory, current.slot.currentRevision])
    : Object.freeze([]);
  return resolveProductContractClarificationV2Authority(store, { committedRefs, ...input });
}
