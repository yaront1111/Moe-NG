/**
 * Public `/2` Product Contract writer.
 *
 * The ingress contributes only a goal reference and an untrusted draft. Core first
 * snapshots and admits that draft, then this service joins the admitted source digests
 * to the goal's integrity-proven PRD, and only then may the durable `/2` writer advance
 * the immutable current slot. Every downstream refusal keeps its original code/layer.
 */
import {
  createProductContractRevisionV2,
  deriveProductContractClarificationProjectionDigestV2,
  type ProductContractRevisionV2,
  type ProductContractRevisionV2Draft,
  type ProductContractV2Refusal,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { exactDataRecord } from "../documents/document-work-safe-value.js";
import {
  validateRevisionProvenance,
  type ProvenanceRefused,
} from "./product-contract-provenance.js";
import { readProductContractClarificationV2Authority }
  from "./product-contract-v2-clarification-authority.js";
import {
  commitProductContractRevisionV2,
  type ProductContractRevisionV2CommitResult,
} from "./product-contract-v2-store.js";

export const PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND =
  "product_contract.propose_revision" as const;
export const PRODUCT_CONTRACT_PROPOSE_REVISION_V2_SCHEMA_VERSION =
  "moe-product-contract-propose/2" as const;
export const PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS = Object.freeze([
  "draft", "goalRef",
] as const);
export const PRODUCT_CONTRACT_PROPOSE_REVISION_V2_LAYER =
  "PRODUCT_CONTRACT_V2_PROPOSE" as const;
export const PRODUCT_CONTRACT_PROPOSE_REVISION_V2_CODES = Object.freeze([
  "PRODUCT_CONTRACT_V2_PROPOSE_AUTHOR_MISMATCH",
  "PRODUCT_CONTRACT_V2_PROPOSE_CLARIFICATION_OPEN",
  "PRODUCT_CONTRACT_V2_PROPOSE_CLARIFICATION_SELECTION_MISMATCH",
  "PRODUCT_CONTRACT_V2_PROPOSE_CLARIFICATION_STATE_INVALID",
  "PRODUCT_CONTRACT_V2_PROPOSE_MALFORMED",
  "PRODUCT_CONTRACT_V2_PROPOSE_TARGET_MISMATCH",
] as const);
export type ProductContractProposeRevisionV2Code =
  (typeof PRODUCT_CONTRACT_PROPOSE_REVISION_V2_CODES)[number];

export interface ProposeProductContractRevisionV2Input {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
  readonly targetAggregateId: string;
}

export interface ProposeProductContractRevisionV2Refused {
  readonly code: ProductContractProposeRevisionV2Code;
  readonly layer: typeof PRODUCT_CONTRACT_PROPOSE_REVISION_V2_LAYER;
  readonly ok: false;
}
export interface ProposeProductContractRevisionV2UpstreamRefusal {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
}

export type ProposeProductContractRevisionV2Result =
  | Extract<ProductContractRevisionV2CommitResult, { readonly ok: true }>
  | Exclude<ProductContractRevisionV2CommitResult, { readonly ok: true }>
  | ProductContractV2Refusal
  | ProvenanceRefused
  | ProposeProductContractRevisionV2UpstreamRefusal
  | ProposeProductContractRevisionV2Refused;

function refused(code: ProductContractProposeRevisionV2Code):
ProposeProductContractRevisionV2Refused {
  return Object.freeze({
    code,
    layer: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_LAYER,
    ok: false as const,
  });
}

/** Copies only core-admitted data, so a mutable caller object is never re-read at commit time. */
function admittedDraft(
  revision: ProductContractRevisionV2,
): ProductContractRevisionV2Draft {
  const {
    advisoryOnly: _advisoryOnly,
    revisionDigest: _revisionDigest,
    version: _version,
    ...draft
  } = revision;
  return Object.freeze(draft);
}

export function runProductContractProposeRevisionV2(
  store: SqliteEventStore,
  input: ProposeProductContractRevisionV2Input,
): ProposeProductContractRevisionV2Result {
  const payload = exactDataRecord(
    input.payload, PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
  );
  if (payload === null || typeof payload["draft"] !== "object"
    || payload["draft"] === null || Array.isArray(payload["draft"])
    || typeof payload["goalRef"] !== "string") {
    return refused("PRODUCT_CONTRACT_V2_PROPOSE_MALFORMED");
  }
  if (input.targetAggregateId !== payload["goalRef"]) {
    return refused("PRODUCT_CONTRACT_V2_PROPOSE_TARGET_MISMATCH");
  }

  // Core owns the complete, bounded `/2` draft grammar. Its admitted immutable value
  // is the only draft this function uses after this point.
  const created = createProductContractRevisionV2(payload["draft"]);
  if (!created.ok) return created;
  const draft = admittedDraft(created.revision);
  if (draft.authorRef !== input.principalId) {
    return refused("PRODUCT_CONTRACT_V2_PROPOSE_AUTHOR_MISMATCH");
  }

  const provenance = validateRevisionProvenance(
    store, input.projectId, payload["goalRef"], draft.sourceDocumentDigests,
  );
  if (!provenance.ok) return provenance;

  const clarifications = readProductContractClarificationV2Authority(store, {
    contractId: draft.contractId, goalRef: payload["goalRef"],
    projectId: input.projectId,
  });
  if (clarifications.status === "OPEN") {
    return refused("PRODUCT_CONTRACT_V2_PROPOSE_CLARIFICATION_OPEN");
  }
  if (clarifications.status === "INVALID") {
    return refused("PRODUCT_CONTRACT_V2_PROPOSE_CLARIFICATION_STATE_INVALID");
  }
  if (clarifications.status === "UNREADABLE") {
    return Object.freeze({ code: clarifications.code, layer: clarifications.layer, ok: false });
  }
  if (clarifications.status === "ANSWERED_PENDING") {
    const projection = deriveProductContractClarificationProjectionDigestV2(created.revision);
    if (!projection.ok) return projection;
    const selected = clarifications.selection;
    if (selected.contractId !== created.revision.contractId
      || selected.revisionId !== created.revision.revisionId
      || selected.revisionDigest !== created.revision.revisionDigest
      || selected.projectionDigest !== projection.projectionDigest) {
      return refused("PRODUCT_CONTRACT_V2_PROPOSE_CLARIFICATION_SELECTION_MISMATCH");
    }
  }

  return commitProductContractRevisionV2(store, {
    correlationId: input.correlationId,
    decidedAt: input.decidedAt,
    draft,
    principalId: input.principalId,
    projectId: input.projectId,
  });
}
