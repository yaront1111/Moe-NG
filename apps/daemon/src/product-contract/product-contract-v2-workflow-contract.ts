import { createHash } from "node:crypto";

import { MAX_JSON_BODY_BYTES, decodeBoundedJsonBytes } from "@moe/contracts";
import { PRODUCT_CONTRACT_V2_LIMITS, type ProductContractRevisionV2Ref } from "@moe/core";

import { exactDataRecord } from "../documents/document-work-safe-value.js";
import { validProductContractV2BindingId }
  from "./product-contract-v2-goal-binding-contract.js";

export const PRODUCT_CONTRACT_V2_WORKFLOW_VERSION =
  "moe-product-contract-workflow/2" as const;
export const PRODUCT_CONTRACT_V2_WORKFLOW_EVENT_TYPE =
  "ProductContractV2WorkflowAdvanced" as const;
export const PRODUCT_CONTRACT_V2_WORKFLOW_LAYER =
  "PRODUCT_CONTRACT_V2_WORKFLOW" as const;
/** Revision + Gate plus ASK/ANSWER for every bounded material decision, per revision. */
export const PRODUCT_CONTRACT_V2_WORKFLOW_MAX_EVENTS =
  (PRODUCT_CONTRACT_V2_LIMITS.maxRevisionHistory + 1)
  * ((PRODUCT_CONTRACT_V2_LIMITS.maxDecisions * 2) + 2);
export const PRODUCT_CONTRACT_V2_WORKFLOW_CODES = Object.freeze([
  "PRODUCT_CONTRACT_V2_WORKFLOW_ABSENT",
  "PRODUCT_CONTRACT_V2_WORKFLOW_INVALID",
  "PRODUCT_CONTRACT_V2_WORKFLOW_BINDING_MISMATCH",
  "PRODUCT_CONTRACT_V2_WORKFLOW_CLARIFICATION_OPEN",
  "PRODUCT_CONTRACT_V2_WORKFLOW_CLARIFICATION_UNSATISFIED",
  "PRODUCT_CONTRACT_V2_WORKFLOW_GATE_1_ALREADY_APPROVED",
  "PRODUCT_CONTRACT_V2_WORKFLOW_CURRENT_MISMATCH",
  "PRODUCT_CONTRACT_V2_WORKFLOW_LIMIT_EXCEEDED",
] as const);

export type ProductContractV2WorkflowCauseKind = "ANSWER" | "ASK" | "GATE_1" | "REVISION";
export interface ProductContractV2WorkflowCause {
  readonly clarificationId: string | null;
  readonly commandId: string;
  readonly kind: ProductContractV2WorkflowCauseKind;
  readonly revisionRef: ProductContractRevisionV2Ref | null;
}
export interface ProductContractV2WorkflowHead {
  readonly cause: ProductContractV2WorkflowCause;
  readonly clarificationGeneration: number;
  readonly clarificationIds: readonly string[];
  readonly clarificationStatus: "ANSWERED_PENDING" | "INVALID" | "OPEN" | "SATISFIED";
  readonly contractId: string;
  readonly currentRevision: ProductContractRevisionV2Ref | null;
  readonly currentSlotDigest: string | null;
  readonly currentSlotGeneration: number;
  readonly effectiveGateRef: ProductContractRevisionV2Ref | null;
  readonly generation: number;
  readonly goalRef: string;
  readonly projectId: string;
  readonly schemaVersion: typeof PRODUCT_CONTRACT_V2_WORKFLOW_VERSION;
}

const HEAD_KEYS = Object.freeze(["cause", "clarificationGeneration", "clarificationIds",
  "clarificationStatus", "contractId", "currentRevision", "currentSlotDigest",
  "currentSlotGeneration", "effectiveGateRef", "generation", "goalRef", "projectId",
  "schemaVersion"]);
const CAUSE_KEYS = Object.freeze(["clarificationId", "commandId", "kind", "revisionRef"]);
const REF_KEYS = Object.freeze(["contractId", "revisionDigest", "revisionId", "version"]);
const HEX64 = /^[0-9a-f]{64}$/u;
const CLARIFICATION_ID = /^clar-v2-[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

function digest(projectId: string, contractId: string): string {
  return createHash("sha256").update("moe/product-contract/workflow/2", "utf8")
    .update(Uint8Array.of(0)).update(projectId, "utf8")
    .update(Uint8Array.of(0)).update(contractId, "utf8").digest("hex");
}
export function deriveProductContractV2WorkflowAggregateId(
  projectId: string, contractId: string,
): string {
  return `product-contract-workflow.v2:${digest(projectId, contractId)}`;
}
function refOf(value: unknown, contractId: string): ProductContractRevisionV2Ref | null {
  if (value === null) return null;
  const ref = exactDataRecord(value, REF_KEYS);
  return ref !== null && ref["contractId"] === contractId
    && validProductContractV2BindingId(ref["revisionId"])
    && typeof ref["revisionDigest"] === "string" && HEX64.test(ref["revisionDigest"])
    && ref["version"] === "moe-product-contract-revision/2"
    ? Object.freeze({ contractId, revisionDigest: ref["revisionDigest"],
      revisionId: ref["revisionId"], version: ref["version"] }) : null;
}
function sameRef(a: ProductContractRevisionV2Ref | null,
  b: ProductContractRevisionV2Ref | null): boolean {
  return a === null || b === null ? a === b : a.contractId === b.contractId
    && a.revisionDigest === b.revisionDigest && a.revisionId === b.revisionId
    && a.version === b.version;
}
function sortedUniqueIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > PRODUCT_CONTRACT_V2_LIMITS.maxDecisions
    || value.some((id) => typeof id !== "string"
    || !CLARIFICATION_ID.test(id))) return null;
  const copy = [...value] as string[];
  return new Set(copy).size === copy.length
    && copy.every((id, index) => index === 0 || copy[index - 1]! < id)
    ? Object.freeze(copy) : null;
}
export function encodeProductContractV2WorkflowHead(
  head: ProductContractV2WorkflowHead,
): Uint8Array {
  const ref = (value: ProductContractRevisionV2Ref | null) => value === null ? null : ({
    contractId: value.contractId, revisionDigest: value.revisionDigest,
    revisionId: value.revisionId, version: value.version,
  });
  return encoder.encode(JSON.stringify({ cause: {
    clarificationId: head.cause.clarificationId, commandId: head.cause.commandId,
    kind: head.cause.kind, revisionRef: ref(head.cause.revisionRef),
  }, clarificationGeneration: head.clarificationGeneration,
  clarificationIds: head.clarificationIds, clarificationStatus: head.clarificationStatus,
  contractId: head.contractId, currentRevision: ref(head.currentRevision),
  currentSlotDigest: head.currentSlotDigest,
  currentSlotGeneration: head.currentSlotGeneration,
  effectiveGateRef: ref(head.effectiveGateRef), generation: head.generation,
  goalRef: head.goalRef, projectId: head.projectId,
  schemaVersion: PRODUCT_CONTRACT_V2_WORKFLOW_VERSION }));
}
export function productContractV2WorkflowHeadWithinLimits(
  head: ProductContractV2WorkflowHead,
): boolean {
  return head.clarificationIds.length <= PRODUCT_CONTRACT_V2_LIMITS.maxDecisions
    && encodeProductContractV2WorkflowHead(head).byteLength <= MAX_JSON_BODY_BYTES;
}
export function decodeProductContractV2WorkflowHead(
  bytes: unknown,
): ProductContractV2WorkflowHead | null {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) return null;
  const row = exactDataRecord(decoded.value, HEAD_KEYS);
  const cause = exactDataRecord(row?.["cause"], CAUSE_KEYS);
  if (row === null || cause === null
    || row["schemaVersion"] !== PRODUCT_CONTRACT_V2_WORKFLOW_VERSION
    || !validProductContractV2BindingId(row["projectId"])
    || !validProductContractV2BindingId(row["contractId"])
    || !validProductContractV2BindingId(row["goalRef"])
    || !validProductContractV2BindingId(cause["commandId"])
    || !Number.isSafeInteger(row["generation"]) || (row["generation"] as number) < 1
    || !Number.isSafeInteger(row["clarificationGeneration"])
    || (row["clarificationGeneration"] as number) < 0
    || !Number.isSafeInteger(row["currentSlotGeneration"])
    || (row["currentSlotGeneration"] as number) < 0) return null;
  const contractId = row["contractId"] as string;
  const ids = sortedUniqueIds(row["clarificationIds"]);
  const current = refOf(row["currentRevision"], contractId);
  const gate = refOf(row["effectiveGateRef"], contractId);
  const causeRef = refOf(cause["revisionRef"], contractId);
  const kind = cause["kind"];
  const clarificationId = cause["clarificationId"];
  const status = row["clarificationStatus"];
  const slotDigest = row["currentSlotDigest"];
  if (ids === null || (kind !== "ANSWER" && kind !== "ASK" && kind !== "GATE_1"
    && kind !== "REVISION") || (clarificationId !== null
      && (typeof clarificationId !== "string" || !CLARIFICATION_ID.test(clarificationId)))
    || (status !== "ANSWERED_PENDING" && status !== "INVALID"
      && status !== "OPEN" && status !== "SATISFIED")
    || (status === "OPEN") !== (ids.length > 0)
    || (current === null) !== (row["currentRevision"] === null)
    || (gate === null) !== (row["effectiveGateRef"] === null)
    || (causeRef === null) !== (cause["revisionRef"] === null)
    || (current === null ? slotDigest !== null || row["currentSlotGeneration"] !== 0
      : typeof slotDigest !== "string" || !HEX64.test(slotDigest)
        || (row["currentSlotGeneration"] as number) < 1)
    || (gate !== null && !sameRef(gate, current))) return null;
  const head = Object.freeze({ cause: Object.freeze({ clarificationId,
    commandId: cause["commandId"] as string, kind, revisionRef: causeRef }),
  clarificationGeneration: row["clarificationGeneration"] as number,
  clarificationIds: ids, clarificationStatus: status, contractId, currentRevision: current,
  currentSlotDigest: slotDigest as string | null,
  currentSlotGeneration: row["currentSlotGeneration"] as number,
  effectiveGateRef: gate, generation: row["generation"] as number,
  goalRef: row["goalRef"] as string, projectId: row["projectId"] as string,
  schemaVersion: PRODUCT_CONTRACT_V2_WORKFLOW_VERSION });
  return productContractV2WorkflowHeadWithinLimits(head) ? head : null;
}
export function sameProductContractV2WorkflowRef(
  a: ProductContractRevisionV2Ref | null, b: ProductContractRevisionV2Ref | null,
): boolean { return sameRef(a, b); }
