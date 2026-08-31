import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";

import { exactDataRecord } from "../documents/document-work-safe-value.js";

export const PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION =
  "moe-product-contract-goal-binding/1" as const;
export const PRODUCT_CONTRACT_V2_GOAL_BINDING_EVENT_TYPE =
  "ProductContractV2GoalBound" as const;
export const PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER =
  "PRODUCT_CONTRACT_V2_GOAL_BINDING" as const;

export const PRODUCT_CONTRACT_V2_GOAL_BINDING_CODES = Object.freeze([
  "PRODUCT_CONTRACT_V2_GOAL_BINDING_ABSENT",
  "PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID",
  "PRODUCT_CONTRACT_V2_GOAL_BINDING_MISMATCH",
] as const);

export type ProductContractV2GoalBindingCode =
  (typeof PRODUCT_CONTRACT_V2_GOAL_BINDING_CODES)[number];
export type ProductContractV2GoalBindingCause = Readonly<{
  commandId: string;
  kind: "CLARIFICATION" | "REVISION";
  ref: string;
}>;
export interface ProductContractV2GoalBinding {
  readonly cause: ProductContractV2GoalBindingCause;
  readonly contractId: string;
  readonly goalRef: string;
  readonly projectId: string;
  readonly schemaVersion: typeof PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION;
}

const BINDING_KEYS = Object.freeze([
  "cause", "contractId", "goalRef", "projectId", "schemaVersion",
]);
const CAUSE_KEYS = Object.freeze(["commandId", "kind", "ref"]);
const encoder = new TextEncoder();
const GOAL_DOMAIN = "moe/product-contract/goal-binding/goal/2";
const CONTRACT_DOMAIN = "moe/product-contract/goal-binding/contract/2";

function digest(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const part of parts) hash.update(Uint8Array.of(0)).update(part, "utf8");
  return hash.digest("hex");
}

export function validProductContractV2BindingId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && encoder.encode(value).byteLength <= 512 && value.trim() === value
    && !value.includes("\0") && value.isWellFormed() && value.normalize("NFC") === value;
}

export function deriveProductContractV2GoalBindingAggregateId(
  projectId: string, goalRef: string,
): string {
  return `product-contract-goal-binding.v2:${digest(GOAL_DOMAIN, [projectId, goalRef])}`;
}

export function deriveProductContractV2ContractBindingAggregateId(
  projectId: string, contractId: string,
): string {
  return `product-contract-contract-binding.v2:${digest(
    CONTRACT_DOMAIN, [projectId, contractId],
  )}`;
}

export function encodeProductContractV2GoalBinding(
  binding: ProductContractV2GoalBinding,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    cause: { commandId: binding.cause.commandId, kind: binding.cause.kind,
      ref: binding.cause.ref },
    contractId: binding.contractId,
    goalRef: binding.goalRef,
    projectId: binding.projectId,
    schemaVersion: PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION,
  }));
}

export function decodeProductContractV2GoalBinding(
  bytes: unknown,
): ProductContractV2GoalBinding | null {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) return null;
  const row = exactDataRecord(decoded.value, BINDING_KEYS);
  const cause = exactDataRecord(row?.["cause"], CAUSE_KEYS);
  if (row === null || cause === null
    || row["schemaVersion"] !== PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION
    || (cause["kind"] !== "CLARIFICATION" && cause["kind"] !== "REVISION")
    || !validProductContractV2BindingId(cause["commandId"])
    || !validProductContractV2BindingId(cause["ref"])
    || !validProductContractV2BindingId(row["contractId"])
    || !validProductContractV2BindingId(row["goalRef"])
    || !validProductContractV2BindingId(row["projectId"])) return null;
  return Object.freeze({
    cause: Object.freeze({ commandId: cause["commandId"], kind: cause["kind"],
      ref: cause["ref"] }),
    contractId: row["contractId"], goalRef: row["goalRef"], projectId: row["projectId"],
    schemaVersion: PRODUCT_CONTRACT_V2_GOAL_BINDING_VERSION,
  });
}

export function sameProductContractV2GoalBindingBytes(
  left: Uint8Array, right: Uint8Array,
): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}
