import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";

import {
  admitProductContractRevisionV2, admitProductContractRevisionV2Draft,
} from "./product-contract-v2-admission.js";
import {
  PRODUCT_CONTRACT_V2_DIGEST_DOMAIN,
  PRODUCT_CONTRACT_V2_LIMITS,
  PRODUCT_CONTRACT_V2_VERSION,
  productContractV2Refusal,
  type ProductContractRevisionV2,
  type ProductContractV2Refusal,
} from "./product-contract-v2-contract.js";

export {
  PRODUCT_CONTRACT_V2_BUDGET_KINDS,
  PRODUCT_CONTRACT_V2_CODES,
  PRODUCT_CONTRACT_V2_DIGEST_DOMAIN,
  PRODUCT_CONTRACT_V2_LAYERS,
  PRODUCT_CONTRACT_V2_PRIORITIES,
  PRODUCT_CONTRACT_V2_VERSION,
} from "./product-contract-v2-contract.js";
export type {
  ProductContractRevisionV2,
  ProductContractRevisionV2Draft,
  ProductContractV2Assumption,
  ProductContractV2Budget,
  ProductContractV2BudgetKind,
  ProductContractV2Code,
  ProductContractV2Criterion,
  ProductContractV2DecisionOption,
  ProductContractV2Journey,
  ProductContractV2Layer,
  ProductContractV2Lineage,
  ProductContractV2MaterialDecision,
  ProductContractV2NegativeScope,
  ProductContractV2Objective,
  ProductContractV2Priority,
  ProductContractV2ProductCompleteDefinition,
  ProductContractV2Refusal,
  ProductContractV2Requirement,
  ProductContractV2SuccessMetric,
  ProductContractV2UserJob,
} from "./product-contract-v2-contract.js";

export type ProductContractV2CreateResult =
  | Readonly<{ ok: true; revision: ProductContractRevisionV2 }>
  | ProductContractV2Refusal;
export type ProductContractV2EncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | ProductContractV2Refusal;
export type ProductContractV2DecodeResult =
  | Readonly<{ ok: true; revision: ProductContractRevisionV2 }>
  | ProductContractV2Refusal;
export type ProductContractV2DigestResult =
  | Readonly<{ ok: true; revisionDigest: string }>
  | ProductContractV2Refusal;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST_PLACEHOLDER = "0".repeat(64);

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(record[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("ProductContractRevision /2 canonicalization received unadmitted data");
}

function digestSource(revision: ProductContractRevisionV2): Readonly<Record<string, unknown>> {
  const { revisionDigest: _digest, ...source } = revision;
  return Object.freeze(source);
}

function digestOf(revision: ProductContractRevisionV2): string {
  return createHash("sha256")
    .update(PRODUCT_CONTRACT_V2_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(digestSource(revision))))
    .digest("hex");
}

const refuse = (code: Parameters<typeof productContractV2Refusal>[0]): ProductContractV2Refusal =>
  productContractV2Refusal(code, "PRODUCT_CONTRACT_V2_PROVENANCE");

function canonicalBytes(revision: ProductContractRevisionV2): ProductContractV2EncodeResult {
  const bytes = encoder.encode(canonicalText(revision));
  return bytes.byteLength > PRODUCT_CONTRACT_V2_LIMITS.maxBytes
    ? refuse("PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED")
    : Object.freeze({ bytes, ok: true as const });
}

export function createProductContractRevisionV2(value: unknown): ProductContractV2CreateResult {
  const admitted = admitProductContractRevisionV2Draft(value); if (!admitted.ok) return admitted;
  const provisional = admitProductContractRevisionV2({
    ...admitted.draft,
    advisoryOnly: true,
    revisionDigest: DIGEST_PLACEHOLDER,
    version: PRODUCT_CONTRACT_V2_VERSION,
  });
  if (!provisional.ok) return provisional;
  const final = admitProductContractRevisionV2({
    ...admitted.draft,
    advisoryOnly: true,
    revisionDigest: digestOf(provisional.revision),
    version: PRODUCT_CONTRACT_V2_VERSION,
  });
  if (!final.ok) return final;
  const bounded = canonicalBytes(final.revision);
  return bounded.ok ? Object.freeze({ ok: true as const, revision: final.revision }) : bounded;
}

export function encodeProductContractRevisionV2(value: unknown): ProductContractV2EncodeResult {
  const admitted = admitProductContractRevisionV2(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision); if (!bounded.ok) return bounded;
  return digestOf(admitted.revision) === admitted.revision.revisionDigest
    ? bounded : refuse("PRODUCT_CONTRACT_V2_DIGEST_MISMATCH");
}

export function deriveProductContractRevisionV2Digest(
  value: unknown,
): ProductContractV2DigestResult {
  const admitted = admitProductContractRevisionV2(value); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision); if (!bounded.ok) return bounded;
  return Object.freeze({ ok: true as const, revisionDigest: digestOf(admitted.revision) });
}

function decodeRefusal(code: string): ProductContractV2Refusal {
  if (code === "JSON_DUPLICATE_KEY") return refuse("PRODUCT_CONTRACT_V2_DUPLICATE_KEY");
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") return refuse("PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED");
  return refuse("PRODUCT_CONTRACT_V2_BYTES_INVALID");
}

export function decodeProductContractRevisionV2Bytes(bytes: unknown): ProductContractV2DecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes); if (!decoded.ok) return decodeRefusal(decoded.code);
  const source = new Uint8Array(bytes as Uint8Array);
  const admitted = admitProductContractRevisionV2(decoded.value); if (!admitted.ok) return admitted;
  if (digestOf(admitted.revision) !== admitted.revision.revisionDigest) {
    return refuse("PRODUCT_CONTRACT_V2_DIGEST_MISMATCH");
  }
  if (canonicalText(admitted.revision) !== decoder.decode(source)) {
    return refuse("PRODUCT_CONTRACT_V2_NONCANONICAL");
  }
  return Object.freeze({ ok: true as const, revision: admitted.revision });
}
