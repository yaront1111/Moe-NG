import { createHash } from "node:crypto";
import { exact, snapshotData, validRef } from "../planning/planning-snapshot.js";
import { admitProductContractRevisionDraft } from "./product-contract-admission.js";
import {
  PRODUCT_CONTRACT_LIMITS, PRODUCT_CONTRACT_VERSION, productContractRefusal,
  type ProductContractCriterion, type ProductContractRefusal,
  type ProductContractRequirement,
} from "./product-contract-contract.js";

export const PRODUCT_CONTRACT_PROJECTION_DIGEST_DOMAIN =
  "moe-product-contract-clarification-projection/1" as const;

export interface ProductContractProjection {
  readonly criteria: readonly ProductContractCriterion[];
  readonly requirements: readonly ProductContractRequirement[];
}
export interface ProductContractClarificationOption {
  readonly label: string;
  readonly optionId: string;
  readonly projection: ProductContractProjection;
}
export interface ProductContractClarification {
  readonly clarificationId: string;
  readonly options: readonly ProductContractClarificationOption[];
  readonly question: string;
}
export interface ProductContractProjectionDigest {
  readonly optionId: string;
  readonly projectionDigest: string;
}
export type ProductContractMaterialityResult =
  | Readonly<{
    material: true;
    ok: true;
    optionDigests: readonly ProductContractProjectionDigest[];
  }>
  | ProductContractRefusal;

const encoder = new TextEncoder();
const CLARIFICATION_KEYS = Object.freeze(["clarificationId", "options", "question"]);
const OPTION_KEYS = Object.freeze(["label", "optionId", "projection"]);
const PROJECTION_KEYS = Object.freeze(["criteria", "requirements"]);
const MAX_OPTIONS = 64;

const materialityRefusal = (
  code: "PRODUCT_CONTRACT_CLARIFICATION_INVALID"
    | "PRODUCT_CONTRACT_CLARIFICATION_VACUOUS"
    | "PRODUCT_CONTRACT_CLARIFICATION_IMMATERIAL",
): ProductContractRefusal => productContractRefusal(code, "MATERIALITY");

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`,
  ).join(",")}}`;
}

function validText(value: unknown): value is string {
  return validRef(value) && value.length <= PRODUCT_CONTRACT_LIMITS.maxStatementBytes
    && !value.includes("\0") && value.isWellFormed() && value.normalize("NFC") === value
    && encoder.encode(value).byteLength <= PRODUCT_CONTRACT_LIMITS.maxStatementBytes;
}

function readProjection(value: unknown): ProductContractProjection | undefined {
  if (!exact(value, PROJECTION_KEYS)) return undefined;
  const admitted = admitProductContractRevisionDraft({
    authorRef: "clarification-projection", contractId: "clarification-projection",
    criteria: value["criteria"], lineage: null, requirements: value["requirements"],
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "clarification-projection",
    sourceDocumentDigests: ["0".repeat(64)],
  });
  return admitted.ok ? Object.freeze({
    criteria: admitted.draft.criteria, requirements: admitted.draft.requirements,
  }) : undefined;
}

function digestProjection(projection: ProductContractProjection): string {
  return createHash("sha256")
    .update(PRODUCT_CONTRACT_PROJECTION_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText({
      criteria: projection.criteria, requirements: projection.requirements,
      version: PRODUCT_CONTRACT_VERSION,
    })))
    .digest("hex");
}

/**
 * A question is advisory and material only when two admitted answer projections differ.
 * Digests are always derived here; a caller has no digest field to assert.
 */
export function assessClarificationMateriality(value: unknown): ProductContractMaterialityResult {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, CLARIFICATION_KEYS)) {
    return materialityRefusal("PRODUCT_CONTRACT_CLARIFICATION_INVALID");
  }
  const record = snapshot.value;
  if (!validText(record["clarificationId"]) || !validText(record["question"])
    || !Array.isArray(record["options"])) {
    return materialityRefusal("PRODUCT_CONTRACT_CLARIFICATION_INVALID");
  }
  if (record["options"].length < 2) {
    return materialityRefusal("PRODUCT_CONTRACT_CLARIFICATION_VACUOUS");
  }
  if (record["options"].length > MAX_OPTIONS) {
    return materialityRefusal("PRODUCT_CONTRACT_CLARIFICATION_INVALID");
  }
  const ids = new Set<string>(); const optionDigests: ProductContractProjectionDigest[] = [];
  for (const candidate of record["options"]) {
    if (!exact(candidate, OPTION_KEYS) || !validText(candidate["optionId"])
      || !validText(candidate["label"]) || ids.has(candidate["optionId"])) {
      return materialityRefusal("PRODUCT_CONTRACT_CLARIFICATION_INVALID");
    }
    const projection = readProjection(candidate["projection"]);
    if (projection === undefined) {
      return materialityRefusal("PRODUCT_CONTRACT_CLARIFICATION_INVALID");
    }
    ids.add(candidate["optionId"]);
    optionDigests.push(Object.freeze({
      optionId: candidate["optionId"], projectionDigest: digestProjection(projection),
    }));
  }
  if (new Set(optionDigests.map((item) => item.projectionDigest)).size < 2) {
    return materialityRefusal("PRODUCT_CONTRACT_CLARIFICATION_IMMATERIAL");
  }
  return Object.freeze({
    material: true as const, ok: true as const, optionDigests: Object.freeze(optionDigests),
  });
}
