import {
  admitProductContractRevisionRef,
  validateProductContractGate1V2,
  type ProductContractRevisionRef,
  type ProductContractV2Gate1Result,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import {
  readProductContractGate1Approval,
  type ProductContractGate1ApprovalReadRefusal,
} from "./product-contract-gate-1-reader.js";
import {
  readCurrentProductContractRevisionV2,
  type ProductContractV2CurrentReadResult,
} from "./product-contract-v2-reader.js";
import { resolveProductContractClarificationV2Authority }
  from "./product-contract-v2-clarification-authority.js";
import { readProductContractV2WorkflowHead }
  from "./product-contract-v2-workflow-reader.js";
import { sameProductContractV2WorkflowRef }
  from "./product-contract-v2-workflow-contract.js";

const LAYER = "PRODUCT_CONTRACT_V2_GATE_1_RESOLVER" as const;

export interface ProductContractGate1V2ResolveInput {
  readonly projectId: string;
  readonly ref: ProductContractRevisionRef;
}

export type ProductContractGate1V2ResolveResult =
  | ProductContractV2Gate1Result
  | ProductContractGate1ApprovalReadRefusal
  | Exclude<ProductContractV2CurrentReadResult, { readonly ok: true }>
  | Readonly<{
    code: "PRODUCT_CONTRACT_V2_GATE_1_CURRENT_MISMATCH";
    layer: typeof LAYER;
    ok: false;
  }>
  | Readonly<{
    code: "PRODUCT_CONTRACT_V2_GATE_1_CLARIFICATION_OPEN";
    layer: typeof LAYER;
    ok: false;
  }>
  | Readonly<{
    code: "PRODUCT_CONTRACT_V2_GATE_1_CLARIFICATION_SELECTION_UNSATISFIED"
      | "PRODUCT_CONTRACT_V2_GATE_1_CLARIFICATION_STATE_INVALID";
    layer: typeof LAYER;
    ok: false;
  }>
  | Readonly<{
    code: string;
    layer: string;
    ok: false;
  }>;

/**
 * Resolves Gate 1 for the current `/2` Product Contract from durable state only.
 *
 * The approval event deliberately remains version-neutral: it binds the immutable
 * contract/revision/digest triple. The revision body does not. This resolver therefore
 * opens the body exclusively through the `/2` current-slot reader, proves that the
 * caller's admitted triple is exactly that current value, and only then asks the shared
 * approval reader for the daemon-authored human grant. No `/1` body reader or validator
 * is reachable from this seam.
 */
export function resolveProductContractGate1V2(
  store: SqliteEventStore,
  input: ProductContractGate1V2ResolveInput,
): ProductContractGate1V2ResolveResult {
  // Snapshot both outer members once. Core then snapshots and admits the triple,
  // so a changing caller proxy cannot select one ref for the slot and another for
  // the approval lookup.
  const projectId = input.projectId;
  const presentedRef = input.ref;
  const admitted = admitProductContractRevisionRef(presentedRef);
  if (!admitted.ok) return admitted;

  const current = readCurrentProductContractRevisionV2(store, {
    contractId: admitted.ref.contractId,
    projectId,
  });
  if (!current.ok) return current;
  if (current.revision.contractId !== admitted.ref.contractId
    || current.revision.revisionId !== admitted.ref.revisionId
    || current.revision.revisionDigest !== admitted.ref.revisionDigest) {
    return Object.freeze({
      code: "PRODUCT_CONTRACT_V2_GATE_1_CURRENT_MISMATCH" as const,
      layer: LAYER,
      ok: false as const,
    });
  }

  const currentRef = Object.freeze({
    contractId: current.revision.contractId,
    revisionDigest: current.revision.revisionDigest,
    revisionId: current.revision.revisionId,
  });
  const clarifications = resolveProductContractClarificationV2Authority(store, {
    committedRefs: Object.freeze([
      ...current.slot.revisionHistory, current.slot.currentRevision,
    ]),
    contractId: currentRef.contractId, goalRef: null, projectId,
  });
  if (clarifications.status === "OPEN") {
    return Object.freeze({
      code: "PRODUCT_CONTRACT_V2_GATE_1_CLARIFICATION_OPEN" as const,
      layer: LAYER,
      ok: false as const,
    });
  }
  if (clarifications.status === "ANSWERED_PENDING") {
    return Object.freeze({ code: "PRODUCT_CONTRACT_V2_GATE_1_CLARIFICATION_SELECTION_UNSATISFIED",
      layer: LAYER, ok: false as const });
  }
  if (clarifications.status === "INVALID") {
    return Object.freeze({ code: "PRODUCT_CONTRACT_V2_GATE_1_CLARIFICATION_STATE_INVALID",
      layer: LAYER, ok: false as const });
  }
  if (clarifications.status === "UNREADABLE") {
    return Object.freeze({ code: clarifications.code, layer: clarifications.layer, ok: false });
  }
  const workflow = readProductContractV2WorkflowHead(store, {
    contractId: currentRef.contractId, projectId,
  });
  if (!workflow.ok) return workflow;
  if (workflow.head.clarificationStatus !== "SATISFIED"
    || !sameProductContractV2WorkflowRef(workflow.head.currentRevision,
      current.slot.currentRevision)) {
    return Object.freeze({ code: "PRODUCT_CONTRACT_V2_GATE_1_CURRENT_MISMATCH",
      layer: LAYER, ok: false as const });
  }
  const approval = readProductContractGate1Approval(store, { projectId, ref: currentRef });
  if (!approval.ok) return approval;
  if (!sameProductContractV2WorkflowRef(workflow.head.effectiveGateRef,
    current.slot.currentRevision)) {
    return Object.freeze({ code: "PRODUCT_CONTRACT_V2_GATE_1_CURRENT_MISMATCH",
      layer: LAYER, ok: false as const });
  }
  return validateProductContractGate1V2(current.revision, approval.gate);
}
