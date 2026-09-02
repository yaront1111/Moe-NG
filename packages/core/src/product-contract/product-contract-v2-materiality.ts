import { createHash } from "node:crypto";
import { types } from "node:util";

import { exact, snapshotDataBounded, validRef } from "../planning/planning-snapshot.js";
import {
  createProductContractRevisionV2,
  encodeProductContractRevisionV2,
} from "./product-contract-v2-codec.js";
import {
  PRODUCT_CONTRACT_V2_LIMITS,
  type ProductContractRevisionV2,
  type ProductContractRevisionV2Draft,
  type ProductContractV2Refusal,
} from "./product-contract-v2-contract.js";

export const PRODUCT_CONTRACT_V2_CLARIFICATION_PROJECTION_DIGEST_DOMAIN =
  "moe-product-contract-clarification-projection/2" as const;
export const PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER =
  "PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY" as const;
export const PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_CODES = Object.freeze([
  "PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_VACUOUS",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_IMMATERIAL",
  "PRODUCT_CONTRACT_V2_CLARIFICATION_IDENTITY_MISMATCH",
] as const);

export type ProductContractV2ClarificationMaterialityCode =
  (typeof PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_CODES)[number];

export interface ProductContractClarificationV2Option {
  readonly candidateDraft: ProductContractRevisionV2Draft;
  readonly label: string;
  readonly optionId: string;
}

export interface ProductContractClarificationV2 {
  readonly options: readonly ProductContractClarificationV2Option[];
  readonly question: string;
}

export interface ProductContractClarificationV2OptionDigest {
  readonly label: string;
  readonly optionId: string;
  readonly projectionDigest: string;
  readonly revisionDigest: string;
}

export interface ProductContractClarificationV2SharedIdentity {
  readonly authorRef: string;
  readonly contractId: string;
  readonly lineage: ProductContractRevisionV2["lineage"];
  readonly retiredCriterionIds: readonly string[];
  readonly retiredRequirementIds: readonly string[];
  readonly revisionId: string;
  readonly sourceDocumentDigests: readonly string[];
}

export interface ProductContractClarificationV2MaterialityRefusal {
  readonly code: ProductContractV2ClarificationMaterialityCode;
  readonly layer: typeof PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER;
  readonly ok: false;
}

export type ProductContractClarificationV2MaterialityResult =
  | Readonly<{
    readonly contractId: string;
    readonly material: true;
    readonly ok: true;
    readonly optionDigests: readonly ProductContractClarificationV2OptionDigest[];
    readonly sharedIdentity: ProductContractClarificationV2SharedIdentity;
  }>
  | ProductContractClarificationV2MaterialityRefusal
  | ProductContractV2Refusal;

const CLARIFICATION_KEYS = Object.freeze(["options", "question"]);
const OPTION_KEYS = Object.freeze(["candidateDraft", "label", "optionId"]);
const encoder = new TextEncoder();

/** Detects nested proxies without invoking any of their traps or any accessor value. */
function containsProxy(value: unknown): boolean {
  const seen = new WeakSet<object>();
  let remaining = PRODUCT_CONTRACT_V2_LIMITS.maxSnapshotNodes;
  const visit = (candidate: unknown): boolean => {
    remaining -= 1;
    if (remaining < 0) return true;
    if (candidate === null || typeof candidate !== "object") return false;
    if (types.isProxy(candidate)) return true;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    try {
      for (const key of Reflect.ownKeys(candidate)) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor !== undefined && "value" in descriptor && visit(descriptor.value)) return true;
      }
      return false;
    } catch {
      return true;
    }
  };
  return visit(value);
}

function refused(
  code: ProductContractV2ClarificationMaterialityCode,
): ProductContractClarificationV2MaterialityRefusal {
  return Object.freeze({
    code,
    layer: PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER,
    ok: false as const,
  });
}

/** Locale-independent UTF-16 code-unit order, matching ECMAScript canonical key order. */
function compareCodeUnits(left: string, right: string): number {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(source).sort(compareCodeUnits).map(
      (key) => `${JSON.stringify(key)}:${canonicalText(source[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("Product Contract /2 clarification canonicalization received unadmitted data");
}

function validText(value: unknown, maximum: number): value is string {
  return validRef(value) && value.trim() === value && value.trim().length > 0
    && value.isWellFormed() && value.normalize("NFC") === value && !value.includes("\0")
    && value.length <= maximum && encoder.encode(value).byteLength <= maximum;
}

function identitySource(
  revision: ProductContractRevisionV2,
): ProductContractClarificationV2SharedIdentity {
  return Object.freeze({
    authorRef: revision.authorRef,
    contractId: revision.contractId,
    lineage: revision.lineage,
    retiredCriterionIds: revision.retiredCriterionIds,
    retiredRequirementIds: revision.retiredRequirementIds,
    revisionId: revision.revisionId,
    sourceDocumentDigests: revision.sourceDocumentDigests,
  });
}

export function deriveProductContractClarificationProjectionDigestV2(
  revision: unknown,
): ProductContractV2Refusal
  | Readonly<{ readonly ok: true; readonly projectionDigest: string }> {
  // The `/2` encoder is deliberately the byte authority. This module never reconstructs
  // a partial v1-style criteria/requirements projection.
  const encoded = encodeProductContractRevisionV2(revision);
  if (!encoded.ok) return encoded;
  return Object.freeze({
    ok: true as const,
    projectionDigest: createHash("sha256")
      .update(PRODUCT_CONTRACT_V2_CLARIFICATION_PROJECTION_DIGEST_DOMAIN, "utf8")
      .update(Uint8Array.of(0))
      .update(encoded.bytes)
      .digest("hex"),
  });
}

/**
 * Admits complete candidate drafts through the ProductContractRevision `/2` codec and
 * compares their canonical full-revision bytes. Identity and provenance cannot masquerade
 * as a product choice: every option must share them exactly.
 */
export function assessProductContractClarificationMaterialityV2(
  value: unknown,
): ProductContractClarificationV2MaterialityResult {
  if (containsProxy(value)) return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID");
  const snapshot = snapshotDataBounded(value, {
    maxArrayLength: PRODUCT_CONTRACT_V2_LIMITS.maxRetiredIds,
    maxDepth: PRODUCT_CONTRACT_V2_LIMITS.maxSnapshotDepth + 4,
    maxNodes: PRODUCT_CONTRACT_V2_LIMITS.maxSnapshotNodes,
  });
  if (!snapshot.ok || !exact(snapshot.value, CLARIFICATION_KEYS)) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID");
  }
  const record = snapshot.value;
  if (!validText(record["question"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes)
    || !Array.isArray(record["options"])) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID");
  }
  if (record["options"].length < 2) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_VACUOUS");
  }
  if (record["options"].length > PRODUCT_CONTRACT_V2_LIMITS.maxOptionsPerDecision) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID");
  }

  const ids = new Set<string>();
  const optionDigests: ProductContractClarificationV2OptionDigest[] = [];
  let contractId: string | undefined;
  let admittedIdentity: ProductContractClarificationV2SharedIdentity | undefined;
  let sharedIdentity: string | undefined;
  for (const option of record["options"]) {
    if (!exact(option, OPTION_KEYS)
      || !validText(option["optionId"], PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes)
      || !validText(option["label"], PRODUCT_CONTRACT_V2_LIMITS.maxStatementBytes)
      || ids.has(option["optionId"])) {
      return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID");
    }
    const created = createProductContractRevisionV2(option["candidateDraft"]);
    if (!created.ok) return created;
    const candidateIdentity = identitySource(created.revision);
    const identity = canonicalText(candidateIdentity);
    if (sharedIdentity !== undefined && sharedIdentity !== identity) {
      return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_IDENTITY_MISMATCH");
    }
    sharedIdentity = identity;
    admittedIdentity = candidateIdentity;
    contractId = created.revision.contractId;
    const digest = deriveProductContractClarificationProjectionDigestV2(created.revision);
    if (!digest.ok) return digest;
    ids.add(option["optionId"]);
    optionDigests.push(Object.freeze({
      label: option["label"],
      optionId: option["optionId"],
      projectionDigest: digest.projectionDigest,
      revisionDigest: created.revision.revisionDigest,
    }));
  }
  if (new Set(optionDigests.map((option) => option.projectionDigest)).size
    !== optionDigests.length) {
    return refused("PRODUCT_CONTRACT_V2_CLARIFICATION_IMMATERIAL");
  }
  optionDigests.sort((left, right) => compareCodeUnits(left.optionId, right.optionId));
  return Object.freeze({
    contractId: contractId!,
    material: true as const,
    ok: true as const,
    optionDigests: Object.freeze(optionDigests),
    sharedIdentity: admittedIdentity!,
  });
}
