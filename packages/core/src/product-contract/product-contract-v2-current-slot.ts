import { createHash } from "node:crypto";
import { decodeBoundedJsonBytes } from "@moe/contracts";

import { deepFreeze, exact, snapshotDataBounded, validHex64, validRef }
  from "../planning/planning-snapshot.js";
import { admitProductContractRevisionV2 } from "./product-contract-v2-admission.js";
import { encodeProductContractRevisionV2 } from "./product-contract-v2-codec.js";
import { validateProductContractV2Amendment } from "./product-contract-v2-lineage.js";
import {
  PRODUCT_CONTRACT_V2_LIMITS,
  productContractV2Refusal,
  type ProductContractRevisionV2,
  type ProductContractV2Refusal,
} from "./product-contract-v2-contract.js";

export const PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION =
  "moe-product-contract-current-revision-slot/2" as const;
export const PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_DIGEST_DOMAIN =
  "moe-product-contract-current-revision-slot-digest/2" as const;

export interface ProductContractRevisionV2Ref {
  readonly contractId: string;
  readonly revisionDigest: string;
  readonly revisionId: string;
  readonly version: ProductContractRevisionV2["version"];
}

export interface ProductContractCurrentRevisionSlotV2 {
  readonly contractId: string;
  readonly currentRevision: ProductContractRevisionV2Ref;
  readonly generation: number;
  readonly projectId: string;
  readonly revisionHistory: readonly ProductContractRevisionV2Ref[];
  readonly slotDigest: string;
  readonly version: typeof PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION;
}

export type ProductContractCurrentRevisionSlotV2Result =
  | Readonly<{ ok: true; slot: ProductContractCurrentRevisionSlotV2 }>
  | ProductContractV2Refusal;
export type ProductContractCurrentRevisionSlotV2EncodeResult =
  | Readonly<{ bytes: Uint8Array; ok: true }>
  | ProductContractV2Refusal;

const SLOT_KEYS = Object.freeze([
  "contractId", "currentRevision", "generation", "projectId", "revisionHistory",
  "slotDigest", "version",
]);
const REF_KEYS = Object.freeze(["contractId", "revisionDigest", "revisionId", "version"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST_PLACEHOLDER = "0".repeat(64);

const refuse = (code: Parameters<typeof productContractV2Refusal>[0]): ProductContractV2Refusal =>
  productContractV2Refusal(code, "PRODUCT_CONTRACT_V2_CURRENT_SLOT");

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
  throw new TypeError("ProductContractCurrentRevisionSlot /2 received unadmitted data");
}

function validText(value: unknown): value is string {
  return validRef(value) && !value.includes("\0") && value.isWellFormed()
    && value.normalize("NFC") === value && value.trim() === value
    && value.length <= PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes
    && encoder.encode(value).byteLength <= PRODUCT_CONTRACT_V2_LIMITS.maxIdBytes;
}

function readRef(value: unknown): ProductContractRevisionV2Ref | undefined {
  if (!exact(value, REF_KEYS) || !validText(value["contractId"])
    || !validText(value["revisionId"]) || !validHex64(value["revisionDigest"])
    || value["version"] !== "moe-product-contract-revision/2") return undefined;
  return Object.freeze({
    contractId: value["contractId"], revisionDigest: value["revisionDigest"],
    revisionId: value["revisionId"], version: value["version"],
  });
}

function readHistory(
  value: unknown,
  contractId: string,
): readonly ProductContractRevisionV2Ref[] | undefined {
  if (!Array.isArray(value) || value.length > PRODUCT_CONTRACT_V2_LIMITS.maxRevisionHistory) {
    return undefined;
  }
  const history: ProductContractRevisionV2Ref[] = [];
  const revisionIds = new Set<string>();
  const revisionDigests = new Set<string>();
  for (const candidate of value) {
    const reference = readRef(candidate);
    if (reference === undefined || reference.contractId !== contractId
      || revisionIds.has(reference.revisionId) || revisionDigests.has(reference.revisionDigest)) {
      return undefined;
    }
    revisionIds.add(reference.revisionId);
    revisionDigests.add(reference.revisionDigest);
    history.push(reference);
  }
  return Object.freeze(history);
}

function refOf(revision: ProductContractRevisionV2): ProductContractRevisionV2Ref {
  return Object.freeze({
    contractId: revision.contractId,
    revisionDigest: revision.revisionDigest,
    revisionId: revision.revisionId,
    version: revision.version,
  });
}

function bindCurrentRevision(
  slot: ProductContractCurrentRevisionSlotV2,
  value: unknown,
): ProductContractRevisionV2 | ProductContractV2Refusal {
  const verified = encodeProductContractRevisionV2(value); if (!verified.ok) return verified;
  const admitted = admitProductContractRevisionV2(value); if (!admitted.ok) return admitted;
  const reference = refOf(admitted.revision);
  const expectedParent = slot.revisionHistory.at(-1);
  const lineageMatches = slot.generation === 1
    ? admitted.revision.lineage === null
    : admitted.revision.lineage !== null && expectedParent !== undefined
      && admitted.revision.lineage.parentRevisionId === expectedParent.revisionId
      && admitted.revision.lineage.parentRevisionDigest === expectedParent.revisionDigest;
  return lineageMatches
    && reference.contractId === slot.currentRevision.contractId
    && reference.revisionId === slot.currentRevision.revisionId
    && reference.revisionDigest === slot.currentRevision.revisionDigest
    && reference.version === slot.currentRevision.version
    ? admitted.revision
    : refuse("PRODUCT_CONTRACT_V2_SLOT_CURRENT_REVISION_MISMATCH");
}

function digestSource(
  slot: ProductContractCurrentRevisionSlotV2,
): Readonly<Record<string, unknown>> {
  const { slotDigest: _digest, ...source } = slot;
  return Object.freeze(source);
}

function digestOf(slot: ProductContractCurrentRevisionSlotV2): string {
  return createHash("sha256")
    .update(PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_DIGEST_DOMAIN, "utf8")
    .update(Uint8Array.of(0))
    .update(encoder.encode(canonicalText(digestSource(slot))))
    .digest("hex");
}

function seal(input: Omit<ProductContractCurrentRevisionSlotV2, "slotDigest">):
ProductContractCurrentRevisionSlotV2 {
  const provisional = deepFreeze({ ...input, slotDigest: DIGEST_PLACEHOLDER });
  return deepFreeze({ ...input, slotDigest: digestOf(provisional) });
}

function admitSlot(value: unknown): ProductContractCurrentRevisionSlotV2Result {
  const snapshot = snapshotDataBounded(value, {
    maxArrayLength: PRODUCT_CONTRACT_V2_LIMITS.maxRevisionHistory,
    maxDepth: 4,
    maxNodes: 8_192,
  });
  if (!snapshot.ok) {
    return snapshot.limitExceeded
      ? productContractV2Refusal(
        "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED", "PRODUCT_CONTRACT_V2_PROVENANCE",
      )
      : refuse("PRODUCT_CONTRACT_V2_SLOT_INVALID");
  }
  if (!exact(snapshot.value, SLOT_KEYS)) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_INVALID");
  }
  const record = snapshot.value;
  if (record["version"] !== PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_VERSION_UNSUPPORTED");
  }
  if (!validText(record["projectId"]) || !validText(record["contractId"])
    || !Number.isSafeInteger(record["generation"]) || (record["generation"] as number) <= 0
    || !validHex64(record["slotDigest"])) return refuse("PRODUCT_CONTRACT_V2_SLOT_INVALID");
  const current = readRef(record["currentRevision"]);
  const history = readHistory(record["revisionHistory"], record["contractId"]);
  if (current === undefined || history === undefined
    || current.contractId !== record["contractId"]
    || record["generation"] !== history.length + 1
    || history.some((reference) => reference.revisionId === current.revisionId
      || reference.revisionDigest === current.revisionDigest)) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_INVALID");
  }
  const slot = deepFreeze({
    contractId: record["contractId"],
    currentRevision: current,
    generation: record["generation"],
    projectId: record["projectId"],
    revisionHistory: history,
    slotDigest: record["slotDigest"],
    version: PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
  } as ProductContractCurrentRevisionSlotV2);
  if (digestOf(slot) !== slot.slotDigest) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_DIGEST_MISMATCH");
  }
  return acceptedSlot(slot);
}

function acceptedSlot(
  slot: ProductContractCurrentRevisionSlotV2,
): ProductContractCurrentRevisionSlotV2Result {
  return encoder.encode(canonicalText(slot)).byteLength <= PRODUCT_CONTRACT_V2_LIMITS.maxBytes
    ? Object.freeze({ ok: true as const, slot })
    : productContractV2Refusal(
      "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED", "PRODUCT_CONTRACT_V2_PROVENANCE",
    );
}

export function createProductContractCurrentRevisionSlotV2(
  projectId: unknown,
  revisionValue: unknown,
): ProductContractCurrentRevisionSlotV2Result {
  if (!validText(projectId)) return refuse("PRODUCT_CONTRACT_V2_SLOT_INVALID");
  const verified = encodeProductContractRevisionV2(revisionValue); if (!verified.ok) return verified;
  const admitted = admitProductContractRevisionV2(revisionValue); if (!admitted.ok) return admitted;
  if (admitted.revision.lineage !== null) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_PARENT_NOT_CURRENT");
  }
  const slot = seal({
    contractId: admitted.revision.contractId,
    currentRevision: refOf(admitted.revision),
    generation: 1,
    projectId,
    revisionHistory: Object.freeze([]),
    version: PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
  });
  return acceptedSlot(slot);
}

export function advanceProductContractCurrentRevisionSlotV2(
  slotValue: unknown,
  currentRevisionValue: unknown,
  candidateValue: unknown,
): ProductContractCurrentRevisionSlotV2Result {
  const current = admitSlot(slotValue); if (!current.ok) return current;
  const currentRevision = bindCurrentRevision(current.slot, currentRevisionValue);
  if ("ok" in currentRevision) return currentRevision;
  const verified = encodeProductContractRevisionV2(candidateValue); if (!verified.ok) return verified;
  const candidate = admitProductContractRevisionV2(candidateValue); if (!candidate.ok) return candidate;
  if (candidate.revision.contractId !== current.slot.contractId) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_CONTRACT_MISMATCH");
  }
  if (candidate.revision.revisionId === current.slot.currentRevision.revisionId
    || candidate.revision.revisionDigest === current.slot.currentRevision.revisionDigest
    || current.slot.revisionHistory.some((reference) =>
      reference.revisionId === candidate.revision.revisionId
      || reference.revisionDigest === candidate.revision.revisionDigest)) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_REVISION_REUSED");
  }
  const parent = candidate.revision.lineage;
  if (parent === null
    || parent.parentRevisionId !== current.slot.currentRevision.revisionId
    || parent.parentRevisionDigest !== current.slot.currentRevision.revisionDigest) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_PARENT_NOT_CURRENT");
  }
  if (current.slot.revisionHistory.length >= PRODUCT_CONTRACT_V2_LIMITS.maxRevisionHistory) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_GENERATION_OVERFLOW");
  }
  const amendment = validateProductContractV2Amendment(
    currentRevision, candidate.revision,
  );
  if (!amendment.ok) return amendment;
  const slot = seal({
    contractId: current.slot.contractId,
    currentRevision: refOf(candidate.revision),
    generation: current.slot.generation + 1,
    projectId: current.slot.projectId,
    revisionHistory: Object.freeze([
      ...current.slot.revisionHistory, current.slot.currentRevision,
    ]),
    version: PRODUCT_CONTRACT_CURRENT_REVISION_SLOT_V2_VERSION,
  });
  return acceptedSlot(slot);
}

export function encodeProductContractCurrentRevisionSlotV2(
  value: unknown,
): ProductContractCurrentRevisionSlotV2EncodeResult {
  const admitted = admitSlot(value); if (!admitted.ok) return admitted;
  const bytes = encoder.encode(canonicalText(admitted.slot));
  return bytes.byteLength > PRODUCT_CONTRACT_V2_LIMITS.maxBytes
    ? productContractV2Refusal("PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED", "PRODUCT_CONTRACT_V2_PROVENANCE")
    : Object.freeze({ bytes, ok: true as const });
}

function decodeRefusal(code: string): ProductContractV2Refusal {
  if (code === "JSON_DUPLICATE_KEY") return refuse("PRODUCT_CONTRACT_V2_SLOT_DUPLICATE_KEY");
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") {
    return productContractV2Refusal(
      "PRODUCT_CONTRACT_V2_LIMIT_EXCEEDED", "PRODUCT_CONTRACT_V2_PROVENANCE",
    );
  }
  return refuse("PRODUCT_CONTRACT_V2_SLOT_BYTES_INVALID");
}

export function decodeProductContractCurrentRevisionSlotV2Bytes(
  bytes: unknown,
  currentRevisionValue: unknown,
): ProductContractCurrentRevisionSlotV2Result {
  const decoded = decodeBoundedJsonBytes(bytes); if (!decoded.ok) return decodeRefusal(decoded.code);
  const admitted = admitSlot(decoded.value); if (!admitted.ok) return admitted;
  const source = new Uint8Array(bytes as Uint8Array);
  if (canonicalText(admitted.slot) !== decoder.decode(source)) {
    return refuse("PRODUCT_CONTRACT_V2_SLOT_NONCANONICAL");
  }
  const currentRevision = bindCurrentRevision(admitted.slot, currentRevisionValue);
  if ("ok" in currentRevision) return currentRevision;
  return admitted;
}
