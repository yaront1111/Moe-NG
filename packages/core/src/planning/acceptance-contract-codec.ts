import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";
import { createAcceptanceCriterionContent } from "./acceptance-criterion-content.js";
import type { AcceptanceCriterionContent } from "./acceptance-criterion-content.js";
import {
  ACCEPTANCE_CONTRACT_LIMITS,
  ACCEPTANCE_CONTRACT_VERSION,
  acceptanceContractRefusal,
  admitAcceptanceContract,
  admitAcceptanceContractDraft,
  type AcceptanceContract,
  type AcceptanceContractApplicability,
  type AcceptanceContractRefusal,
  type AcceptanceCriterionObligation,
} from "./acceptance-contract.js";

export const ACCEPTANCE_CONTRACT_DIGEST_DOMAIN = "moe-acceptance-contract-digest/1" as const;
export {
  ACCEPTANCE_CRITERION_CONTENT_DOMAIN, createAcceptanceCriterionContent,
} from "./acceptance-criterion-content.js";
export type {
  AcceptanceCriteriaContent, AcceptanceCriterionContent,
  AcceptanceCriterionContentCreateResult, AcceptanceCriterionContentDraft,
} from "./acceptance-criterion-content.js";
export type AcceptanceContractCreateResult =
  | Readonly<{ contract: AcceptanceContract; ok: true }> | AcceptanceContractRefusal;
export type AcceptanceContractDigestResult =
  | Readonly<{ criteriaDigest: string; ok: true }> | AcceptanceContractRefusal;
export type AcceptanceCriterionContentResult =
  | Readonly<{ criteria: readonly AcceptanceCriterionContent[]; ok: true }>
  | AcceptanceContractRefusal;
export type AcceptanceContractEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }> | AcceptanceContractRefusal;
export type AcceptanceContractDecodeResult =
  | Readonly<{ contract: AcceptanceContract; ok: true }> | AcceptanceContractRefusal;

interface AcceptanceContractDigestSource {
  readonly applicability: AcceptanceContractApplicability;
  readonly authorRef: string;
  readonly contractId: string;
  readonly obligations: readonly AcceptanceCriterionObligation[];
  readonly version: typeof ACCEPTANCE_CONTRACT_VERSION;
}

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
  throw new TypeError("acceptance contract canonicalization received an unadmitted value");
}

function digestSource(contract: AcceptanceContract): AcceptanceContractDigestSource {
  return Object.freeze({
    applicability: contract.applicability,
    authorRef: contract.authorRef,
    contractId: contract.contractId,
    obligations: contract.obligations,
    version: contract.version,
  });
}

function digestOf(contract: AcceptanceContract): string {
  return createHash("sha256")
    .update(ACCEPTANCE_CONTRACT_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(digestSource(contract))))
    .digest("hex");
}

const digestMismatch = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_DIGEST_MISMATCH", "ACCEPTANCE_CONTRACT_DIGEST",
);
const bytesInvalid = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC",
);
const duplicateKey = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_DUPLICATE_KEY", "ACCEPTANCE_CONTRACT_CODEC",
);
const noncanonical = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_NONCANONICAL", "ACCEPTANCE_CONTRACT_CANONICALIZATION",
);
const limitExceeded = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_LIMIT_EXCEEDED", "ACCEPTANCE_CONTRACT_LIMITS",
);

function canonicalBytes(contract: AcceptanceContract): AcceptanceContractEncodeResult {
  const bytes = encoder.encode(canonicalText(contract));
  return bytes.byteLength > ACCEPTANCE_CONTRACT_LIMITS.maxBytes
    ? limitExceeded() : Object.freeze({ bytes, ok: true as const });
}

export function createAcceptanceContract(draft: unknown): AcceptanceContractCreateResult {
  const admitted = admitAcceptanceContractDraft(draft);
  if (!admitted.ok) return admitted;
  const provisional = admitAcceptanceContract({
    ...admitted.draft, criteriaDigest: DIGEST_PLACEHOLDER, version: ACCEPTANCE_CONTRACT_VERSION,
  });
  if (!provisional.ok) return provisional;
  const final = admitAcceptanceContract({
    ...admitted.draft, criteriaDigest: digestOf(provisional.contract),
    version: ACCEPTANCE_CONTRACT_VERSION,
  });
  if (!final.ok) return final;
  const bounded = canonicalBytes(final.contract);
  return bounded.ok ? Object.freeze({ contract: final.contract, ok: true as const }) : bounded;
}

export function deriveAcceptanceContractDigest(contract: unknown): AcceptanceContractDigestResult {
  const admitted = admitAcceptanceContract(contract);
  if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.contract);
  return bounded.ok ? Object.freeze({ criteriaDigest: digestOf(admitted.contract), ok: true as const })
    : bounded;
}

/** Admits through the existing reader first, so refusal code and layer pass through verbatim. */
export function deriveAcceptanceCriterionContent(
  contract: unknown,
): AcceptanceCriterionContentResult {
  const admitted = admitAcceptanceContract(contract);
  if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.contract);
  if (!bounded.ok) return bounded;
  const content = createAcceptanceCriterionContent({
    nodeKind: admitted.contract.applicability.nodeKind,
    obligations: admitted.contract.obligations,
  });
  return content.ok
    ? Object.freeze({ criteria: content.criteria, ok: true as const }) : content;
}

export function encodeAcceptanceContract(contract: unknown): AcceptanceContractEncodeResult {
  const admitted = admitAcceptanceContract(contract);
  if (!admitted.ok) return admitted;
  const bounded = canonicalBytes(admitted.contract);
  if (!bounded.ok) return bounded;
  return digestOf(admitted.contract) === admitted.contract.criteriaDigest ? bounded : digestMismatch();
}

function mapDecodeFailure(code: string): AcceptanceContractRefusal {
  if (code === "JSON_DUPLICATE_KEY") return duplicateKey();
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") return limitExceeded();
  return bytesInvalid();
}

export function decodeAcceptanceContractBytes(bytes: unknown): AcceptanceContractDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) return mapDecodeFailure(decoded.code);
  const source = new Uint8Array(bytes as Uint8Array);
  const admitted = admitAcceptanceContract(decoded.value);
  if (!admitted.ok) return admitted;
  if (digestOf(admitted.contract) !== admitted.contract.criteriaDigest) return digestMismatch();
  if (canonicalText(admitted.contract) !== decoder.decode(source)) return noncanonical();
  return Object.freeze({ contract: admitted.contract, ok: true as const });
}
