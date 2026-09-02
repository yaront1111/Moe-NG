import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";

import {
  ACCEPTANCE_CONTRACT_LIMITS, ACCEPTANCE_CONTRACT_VERSION, acceptanceContractRefusal,
  readAcceptanceNodeKind, readAcceptanceObligations,
} from "./acceptance-contract.js";
import { planningContentHostility } from "./planning-content-hostile.js";
import { deepFreeze, exact, snapshotData } from "./planning-snapshot.js";
import type {
  AcceptanceContractNodeKind, AcceptanceContractRefusal, AcceptanceCriterionObligation,
} from "./acceptance-contract.js";

export const ACCEPTANCE_CRITERION_CONTENT_DOMAIN =
  "@moe/core.acceptance-criterion-content/1" as const;
export interface AcceptanceCriterionContent {
  readonly contentDigest: string;
  readonly criterionId: string;
}
export interface AcceptanceCriterionContentDraft {
  readonly nodeKind: AcceptanceContractNodeKind;
  readonly obligations: readonly AcceptanceCriterionObligation[];
}
export interface AcceptanceCriteriaContent extends AcceptanceCriterionContentDraft {
  readonly version: typeof ACCEPTANCE_CONTRACT_VERSION;
}
export type AcceptanceCriterionContentCreateResult =
  | Readonly<{ content: AcceptanceCriteriaContent;
    criteria: readonly AcceptanceCriterionContent[]; ok: true }>
  | AcceptanceContractRefusal;
export type AcceptanceCriteriaContentEncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | AcceptanceContractRefusal;
export type AcceptanceCriteriaContentDecodeResult = AcceptanceCriterionContentCreateResult;

const DRAFT_KEYS = Object.freeze(["nodeKind", "obligations"]);
const CONTENT_KEYS = Object.freeze([...DRAFT_KEYS, "version"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

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
  throw new TypeError("acceptance criterion content received an unadmitted value");
}

const malformed = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION",
);
const exceeded = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_LIMIT_EXCEEDED", "ACCEPTANCE_CONTRACT_LIMITS",
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
function criterionDigestOf(
  content: AcceptanceCriteriaContent, obligation: AcceptanceCriterionObligation,
): string {
  const source = Object.freeze({
    evidenceRequirements: obligation.evidenceRequirements, nodeKind: content.nodeKind,
    statement: obligation.statement, verificationRecipeRefs: obligation.verificationRecipeRefs,
    version: content.version,
  });
  return createHash("sha256")
    .update(ACCEPTANCE_CRITERION_CONTENT_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(source)))
    .digest("hex");
}
const byCriterionId = (left: AcceptanceCriterionContent, right: AcceptanceCriterionContent) =>
  left.criterionId < right.criterionId ? -1 : left.criterionId > right.criterionId ? 1 : 0;

function admitAcceptanceCriteriaContent(
  input: unknown,
  allowDraft: boolean,
): AcceptanceCriterionContentCreateResult {
  const hostile = planningContentHostility(input, ACCEPTANCE_CONTRACT_LIMITS.maxAggregateEntries);
  if (hostile !== null) return hostile === "LIMIT_EXCEEDED" ? exceeded() : malformed();
  const snapshot = snapshotData(input);
  if (!snapshot.ok) return malformed();
  const full = exact(snapshot.value, CONTENT_KEYS);
  if (!full && (!allowDraft || !exact(snapshot.value, DRAFT_KEYS))) return malformed();
  if (full && snapshot.value["version"] !== ACCEPTANCE_CONTRACT_VERSION) {
    return acceptanceContractRefusal(
      "ACCEPTANCE_CONTRACT_VERSION_UNSUPPORTED", "ACCEPTANCE_CONTRACT_VERSION",
    );
  }
  const nodeKind = readAcceptanceNodeKind(snapshot.value["nodeKind"]);
  const obligations = readAcceptanceObligations(snapshot.value["obligations"]);
  if (!nodeKind.ok) return nodeKind; if (!obligations.ok) return obligations;
  const entries = obligations.value.reduce((sum, obligation) => sum + 1
    + obligation.evidenceRequirements.length + obligation.verificationRecipeRefs.length, 0);
  if (entries > ACCEPTANCE_CONTRACT_LIMITS.maxAggregateEntries) return exceeded();
  const content = deepFreeze<AcceptanceCriteriaContent>({
    nodeKind: nodeKind.value, obligations: obligations.value,
    version: ACCEPTANCE_CONTRACT_VERSION,
  });
  if (encoder.encode(canonicalText(content)).byteLength > ACCEPTANCE_CONTRACT_LIMITS.maxBytes) {
    return exceeded();
  }
  const criteria = content.obligations.map((obligation) => Object.freeze({
    contentDigest: criterionDigestOf(content, obligation), criterionId: obligation.criterionId,
  })).sort(byCriterionId);
  return Object.freeze({ content, criteria: Object.freeze(criteria), ok: true as const });
}

/** Admits only criterion semantics; graph, author, contract and node applicability do not exist. */
export function createAcceptanceCriterionContent(
  input: unknown,
): AcceptanceCriterionContentCreateResult {
  return admitAcceptanceCriteriaContent(input, true);
}

/** Encodes a complete, versioned criterion body as canonical UTF-8 JSON. */
export function encodeAcceptanceCriteriaContent(
  input: unknown,
): AcceptanceCriteriaContentEncodeResult {
  const admitted = admitAcceptanceCriteriaContent(input, false);
  if (!admitted.ok) return admitted;
  const bytes = encoder.encode(canonicalText(admitted.content));
  return bytes.byteLength > ACCEPTANCE_CONTRACT_LIMITS.maxBytes
    ? exceeded() : Object.freeze({ bytes, ok: true as const });
}

function mapDecodeFailure(code: string): AcceptanceContractRefusal {
  if (code === "JSON_DUPLICATE_KEY") return duplicateKey();
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") return exceeded();
  return bytesInvalid();
}

/** Decodes canonical bytes and returns the server-recomputed criterion identity roster. */
export function decodeAcceptanceCriteriaContentBytes(
  bytes: unknown,
): AcceptanceCriteriaContentDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) return mapDecodeFailure(decoded.code);
  const admitted = admitAcceptanceCriteriaContent(decoded.value, false);
  if (!admitted.ok) return admitted;
  let sourceText: string;
  try { sourceText = decoder.decode(new Uint8Array(bytes as Uint8Array)); }
  catch { return bytesInvalid(); }
  if (canonicalText(admitted.content) !== sourceText) return noncanonical();
  return admitted;
}
