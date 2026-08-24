import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import {
  admitProductContractRevision, admitProductContractRevisionDraft,
} from "./product-contract-admission.js";
import {
  PRODUCT_CONTRACT_LIMITS, PRODUCT_CONTRACT_VERSION, productContractRefusal,
  type ProductContractRefusal, type ProductContractRevision,
} from "./product-contract-contract.js";

export {
  PRODUCT_CONTRACT_CODES, PRODUCT_CONTRACT_LAYERS, PRODUCT_CONTRACT_VERSION,
} from "./product-contract-contract.js";
export type {
  ProductContractAdmission, ProductContractCode, ProductContractCriterion,
  ProductContractDraftAdmission, ProductContractLayer, ProductContractLineage,
  ProductContractRefusal, ProductContractRequirement, ProductContractRevision,
  ProductContractRevisionDraft,
} from "./product-contract-contract.js";

export const PRODUCT_CONTRACT_DIGEST_DOMAIN =
  "moe-product-contract-revision-digest/1" as const;

export type ProductContractCreateResult =
  | Readonly<{ ok: true; revision: ProductContractRevision }>
  | ProductContractRefusal;
export type ProductContractDigestResult =
  | Readonly<{ ok: true; revisionDigest: string }>
  | ProductContractRefusal;
export type ProductContractEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | ProductContractRefusal;
export type ProductContractDecodeResult =
  | Readonly<{ ok: true; revision: ProductContractRevision }>
  | ProductContractRefusal;

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
  throw new TypeError("product contract canonicalization received an unadmitted value");
}

function digestSource(revision: ProductContractRevision): Readonly<Record<string, unknown>> {
  const { revisionDigest: _digest, ...source } = revision;
  return Object.freeze(source);
}

function digestOf(revision: ProductContractRevision): string {
  return createHash("sha256")
    .update(PRODUCT_CONTRACT_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(digestSource(revision))))
    .digest("hex");
}

const refuse = (code: Parameters<typeof productContractRefusal>[0]): ProductContractRefusal =>
  productContractRefusal(code, "PROVENANCE");

function canonicalBytes(revision: ProductContractRevision): ProductContractEncodeResult {
  const bytes = encoder.encode(canonicalText(revision));
  return bytes.byteLength > PRODUCT_CONTRACT_LIMITS.maxBytes
    ? refuse("PRODUCT_CONTRACT_LIMIT_EXCEEDED")
    : Object.freeze({ bytes, ok: true as const });
}

export function createProductContractRevision(draft: unknown): ProductContractCreateResult {
  const admitted = admitProductContractRevisionDraft(draft); if (!admitted.ok) return admitted;
  const provisional = admitProductContractRevision({
    ...admitted.draft, advisoryOnly: true, revisionDigest: DIGEST_PLACEHOLDER,
    version: PRODUCT_CONTRACT_VERSION,
  });
  if (!provisional.ok) return provisional;
  const final = admitProductContractRevision({
    ...admitted.draft, advisoryOnly: true, revisionDigest: digestOf(provisional.revision),
    version: PRODUCT_CONTRACT_VERSION,
  });
  if (!final.ok) return final;
  const bounded = canonicalBytes(final.revision);
  return bounded.ok ? Object.freeze({ ok: true as const, revision: final.revision }) : bounded;
}

export function deriveProductContractRevisionDigest(
  revision: unknown,
): ProductContractDigestResult {
  const admitted = admitProductContractRevision(revision); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision); if (!bounded.ok) return bounded;
  return Object.freeze({ ok: true as const, revisionDigest: digestOf(admitted.revision) });
}

export function encodeProductContractRevision(revision: unknown): ProductContractEncodeResult {
  const admitted = admitProductContractRevision(revision); if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.revision); if (!bounded.ok) return bounded;
  return digestOf(admitted.revision) === admitted.revision.revisionDigest
    ? bounded : refuse("PRODUCT_CONTRACT_DIGEST_MISMATCH");
}

function decodeRefusal(code: string): ProductContractRefusal {
  if (code === "JSON_DUPLICATE_KEY") return refuse("PRODUCT_CONTRACT_DUPLICATE_KEY");
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") return refuse("PRODUCT_CONTRACT_LIMIT_EXCEEDED");
  return refuse("PRODUCT_CONTRACT_BYTES_INVALID");
}

export function decodeProductContractRevisionBytes(bytes: unknown): ProductContractDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes); if (!decoded.ok) return decodeRefusal(decoded.code);
  const source = new Uint8Array(bytes as Uint8Array);
  const admitted = admitProductContractRevision(decoded.value); if (!admitted.ok) return admitted;
  if (digestOf(admitted.revision) !== admitted.revision.revisionDigest) {
    return refuse("PRODUCT_CONTRACT_DIGEST_MISMATCH");
  }
  if (canonicalText(admitted.revision) !== decoder.decode(source)) {
    return refuse("PRODUCT_CONTRACT_NONCANONICAL");
  }
  return Object.freeze({ ok: true as const, revision: admitted.revision });
}
