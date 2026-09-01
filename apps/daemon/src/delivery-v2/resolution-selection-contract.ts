import { decodeBoundedJsonBytes } from "@moe/contracts";
import { PRODUCT_CONTRACT_V2_VERSION } from "@moe/core";

import { deliveryV2Digest } from "./addresses.js";
import {
  admitDeliveryV2AuthorityPrincipalBindings,
  admitDeliveryV2PrincipalId,
} from "./authority-admission.js";
import { admitDeliveryV2ResolutionMaterialRefs } from "./material-ref-admission.js";
import { admitDeliveryV2MaterialPublisherPrincipals }
  from "./material-publisher-admission.js";
import { snapshotDeliveryV2PlainData } from "./snapshot.js";
import type {
  DeliveryV2AuthorityPrincipalBindings,
  DeliveryV2MaterialPublisherPrincipalBindings,
  DeliveryV2ResolutionMaterialRefs,
} from "./contracts.js";

export const DELIVERY_V2_RESOLUTION_SELECTION_VERSION =
  "moe-delivery-v2-resolution-selection/1" as const;
export const DELIVERY_V2_RESOLUTION_SELECTION_REQUEST_VERSION =
  "moe-delivery-v2-resolution-selection-request/1" as const;
export const DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY = 128 as const;
export const DELIVERY_V2_RESOLUTION_SELECTION_LAYER =
  "DAEMON_DELIVERY_V2_RESOLUTION_SELECTION" as const;
export const DELIVERY_V2_RESOLUTION_SELECTION_COMMAND_KIND =
  "delivery_v2.resolution_selection.commit" as const;
export const DELIVERY_V2_RESOLUTION_SELECTION_EVENT_TYPE =
  "DeliveryV2ResolutionSelectionCommitted" as const;
export const DELIVERY_V2_RESOLUTION_SELECTION_ADDRESS_DOMAIN =
  "moe-delivery-v2-resolution-selection-address/1" as const;
export const DELIVERY_V2_RESOLUTION_SELECTION_EVENT_ID_DOMAIN =
  "moe-delivery-v2-resolution-selection-event-id/1" as const;

export const DELIVERY_V2_RESOLUTION_SELECTION_CODES = Object.freeze([
  "DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID",
  "DELIVERY_V2_RESOLUTION_SELECTION_ABSENT",
  "DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE",
  "DELIVERY_V2_RESOLUTION_SELECTION_SCOPE_MISMATCH",
  "DELIVERY_V2_RESOLUTION_SELECTION_CONTRACT_STALE",
  "DELIVERY_V2_RESOLUTION_SELECTION_QUALIFICATION_STALE",
  "DELIVERY_V2_RESOLUTION_SELECTION_LIMIT_EXCEEDED",
] as const);
export type DeliveryV2ResolutionSelectionCode =
  (typeof DELIVERY_V2_RESOLUTION_SELECTION_CODES)[number];

export interface DeliveryV2ResolutionSelectionProductContract {
  readonly revisionDigest: string;
  readonly revisionId: string;
  readonly revisionVersion: typeof PRODUCT_CONTRACT_V2_VERSION;
  readonly slotDigest: string;
  readonly slotGeneration: number;
  readonly workflowGeneration: number;
}

export interface DeliveryV2ResolutionSelectionQualificationStatus {
  readonly qualificationDigest: string;
  readonly qualificationId: string;
  readonly statusDigest: string;
  readonly statusRef: string;
}

export interface DeliveryV2ResolutionSelection {
  readonly contractId: string;
  readonly generation: number;
  readonly materialRefs: DeliveryV2ResolutionMaterialRefs;
  readonly productContract: DeliveryV2ResolutionSelectionProductContract;
  readonly projectId: string;
  readonly qualificationStatus: DeliveryV2ResolutionSelectionQualificationStatus;
  readonly selectionDigest: string;
  readonly version: typeof DELIVERY_V2_RESOLUTION_SELECTION_VERSION;
}

export interface DeliveryV2ResolutionSelectionDraft {
  readonly contractId: string;
  readonly generation: number;
  readonly materialRefs: DeliveryV2ResolutionMaterialRefs;
  readonly productContract: DeliveryV2ResolutionSelectionProductContract;
  readonly projectId: string;
  readonly qualificationStatus: DeliveryV2ResolutionSelectionQualificationStatus;
}

export interface DeliveryV2ResolutionSelectionConfig {
  readonly authorityPrincipals: DeliveryV2AuthorityPrincipalBindings;
  readonly configuredOperatorPrincipalId: string;
  readonly materialPublishers: DeliveryV2MaterialPublisherPrincipalBindings;
}

export interface DeliveryV2ResolutionSelectionCommitInput {
  readonly commandId: string;
  readonly contractId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly materialRefs: DeliveryV2ResolutionMaterialRefs;
  readonly principalId: string;
  readonly projectId: string;
}

export interface DeliveryV2ResolutionSelectionReadInput {
  readonly contractId: string;
  readonly projectId: string;
}

export interface DeliveryV2ResolutionSelectionRefusal {
  readonly code: DeliveryV2ResolutionSelectionCode;
  readonly layer: typeof DELIVERY_V2_RESOLUTION_SELECTION_LAYER;
  readonly ok: false;
}
export type DeliveryV2ResolutionSelectionResult = Readonly<{
  ok: true;
  selection: DeliveryV2ResolutionSelection;
}> | DeliveryV2ResolutionSelectionRefusal;
export type DeliveryV2ResolutionSelectionEncodeResult = Readonly<{
  bytes: Uint8Array;
  ok: true;
}> | DeliveryV2ResolutionSelectionRefusal;

const RECORD_KEYS = Object.freeze([
  "contractId", "generation", "materialRefs", "productContract", "projectId",
  "qualificationStatus", "selectionDigest", "version",
]);
const DRAFT_KEYS = Object.freeze(RECORD_KEYS.filter((key) => key !== "selectionDigest"
  && key !== "version"));
const PRODUCT_CONTRACT_KEYS = Object.freeze([
  "revisionDigest", "revisionId", "revisionVersion", "slotDigest", "slotGeneration",
  "workflowGeneration",
]);
const QUALIFICATION_STATUS_KEYS = Object.freeze([
  "qualificationDigest", "qualificationId", "statusDigest", "statusRef",
]);
const CONFIG_KEYS = Object.freeze([
  "authorityPrincipals", "configuredOperatorPrincipalId", "materialPublishers",
]);
const COMMIT_INPUT_KEYS = Object.freeze([
  "commandId", "contractId", "correlationId", "decidedAt", "materialRefs", "principalId",
  "projectId",
]);
const READ_INPUT_KEYS = Object.freeze(["contractId", "projectId"]);
const HEX64 = /^[a-f0-9]{64}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST_DOMAIN = "moe-delivery-v2-resolution-selection-digest/1";
const DIGEST_PLACEHOLDER = "0".repeat(64);

type RecordValue = Readonly<Record<string, unknown>>;
const exact = (value: unknown, keys: readonly string[]): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value !== ""
  && value.length <= 512 && encoder.encode(value).byteLength <= 512
  && value.isWellFormed() && !value.includes("\0") && value.normalize("NFC") === value
  && value.trim() === value;
const digest = (value: unknown): value is string => typeof value === "string" && HEX64.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value)
  && (value as number) > 0 && !Object.is(value, -0);

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
  throw new TypeError("Resolution selection received unadmitted data");
}

function refusal(code: DeliveryV2ResolutionSelectionCode): DeliveryV2ResolutionSelectionRefusal {
  return Object.freeze({ code, layer: DELIVERY_V2_RESOLUTION_SELECTION_LAYER, ok: false });
}

export function deriveDeliveryV2ResolutionSelectionAggregateId(
  projectId: string,
  contractId: string,
): string {
  return `delivery-v2:resolution-selection:${deliveryV2Digest(
    DELIVERY_V2_RESOLUTION_SELECTION_ADDRESS_DOMAIN, projectId, contractId,
  )}`;
}

export function deriveDeliveryV2ResolutionSelectionEventId(
  projectId: string,
  principalId: string,
  commandId: string,
): string {
  return `delivery-v2:resolution-selection-event:${deliveryV2Digest(
    DELIVERY_V2_RESOLUTION_SELECTION_EVENT_ID_DOMAIN, projectId, principalId, commandId,
  )}`;
}

export function admitDeliveryV2ResolutionSelectionConfig(
  value: unknown,
): DeliveryV2ResolutionSelectionConfig | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  if (!exact(safe, CONFIG_KEYS)) return undefined;
  const operator = admitDeliveryV2PrincipalId(safe["configuredOperatorPrincipalId"]);
  const authorityPrincipals = admitDeliveryV2AuthorityPrincipalBindings(
    safe["authorityPrincipals"],
  );
  const materialPublishers = admitDeliveryV2MaterialPublisherPrincipals(
    safe["materialPublishers"],
  );
  if (operator === undefined || !operator.isWellFormed() || operator.includes("\0")
    || authorityPrincipals === undefined || materialPublishers === undefined
    || authorityPrincipals.operatorApprovalPrincipalId !== operator
    || authorityPrincipals.qualificationStatusPrincipalId !== operator) return undefined;
  return Object.freeze({ authorityPrincipals, configuredOperatorPrincipalId: operator,
    materialPublishers });
}

export function admitDeliveryV2ResolutionSelectionCommitInput(
  value: unknown,
): DeliveryV2ResolutionSelectionCommitInput | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  if (!exact(safe, COMMIT_INPUT_KEYS) || !text(safe["commandId"])
    || !text(safe["contractId"]) || !text(safe["correlationId"])
    || !text(safe["principalId"]) || !text(safe["projectId"])
    || typeof safe["decidedAt"] !== "string" || !CANONICAL_TIMESTAMP.test(safe["decidedAt"])
    || Number.isNaN(Date.parse(safe["decidedAt"]))
    || new Date(safe["decidedAt"]).toISOString() !== safe["decidedAt"]) return undefined;
  const materialRefs = admitDeliveryV2ResolutionMaterialRefs(safe["materialRefs"]);
  if (materialRefs === undefined || materialRefs.projectId !== safe["projectId"]) return undefined;
  return Object.freeze({
    commandId: safe["commandId"], contractId: safe["contractId"],
    correlationId: safe["correlationId"], decidedAt: safe["decidedAt"], materialRefs,
    principalId: safe["principalId"], projectId: safe["projectId"],
  });
}

export function admitDeliveryV2ResolutionSelectionReadInput(
  value: unknown,
): DeliveryV2ResolutionSelectionReadInput | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  return exact(safe, READ_INPUT_KEYS) && text(safe["contractId"]) && text(safe["projectId"])
    ? Object.freeze({ contractId: safe["contractId"], projectId: safe["projectId"] })
    : undefined;
}

function readProductContract(value: unknown):
DeliveryV2ResolutionSelectionProductContract | undefined {
  if (!exact(value, PRODUCT_CONTRACT_KEYS) || !digest(value["revisionDigest"])
    || !text(value["revisionId"]) || value["revisionVersion"] !== PRODUCT_CONTRACT_V2_VERSION
    || !digest(value["slotDigest"]) || !positive(value["slotGeneration"])
    || !positive(value["workflowGeneration"])) return undefined;
  return value as unknown as DeliveryV2ResolutionSelectionProductContract;
}

function readQualificationStatus(value: unknown):
DeliveryV2ResolutionSelectionQualificationStatus | undefined {
  if (!exact(value, QUALIFICATION_STATUS_KEYS) || !digest(value["qualificationDigest"])
    || !text(value["qualificationId"]) || !digest(value["statusDigest"])
    || !text(value["statusRef"])) return undefined;
  return value as unknown as DeliveryV2ResolutionSelectionQualificationStatus;
}

function digestSource(selection: DeliveryV2ResolutionSelection): Readonly<Record<string, unknown>> {
  const { selectionDigest: _selectionDigest, ...source } = selection;
  return Object.freeze(source);
}

function selectionDigest(selection: DeliveryV2ResolutionSelection): string {
  return deliveryV2Digest(DIGEST_DOMAIN, canonicalText(digestSource(selection)));
}

function admitSelection(value: unknown): DeliveryV2ResolutionSelection | undefined {
  const safe = snapshotDeliveryV2PlainData(value);
  if (!exact(safe, RECORD_KEYS) || safe["version"] !== DELIVERY_V2_RESOLUTION_SELECTION_VERSION
    || !text(safe["projectId"]) || !text(safe["contractId"])
    || !positive(safe["generation"])
    || (safe["generation"] as number) > DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY
    || !digest(safe["selectionDigest"])) return undefined;
  const materialRefs = admitDeliveryV2ResolutionMaterialRefs(safe["materialRefs"]);
  const productContract = readProductContract(safe["productContract"]);
  const qualificationStatus = readQualificationStatus(safe["qualificationStatus"]);
  if (materialRefs === undefined || productContract === undefined
    || qualificationStatus === undefined || materialRefs.projectId !== safe["projectId"]
    || materialRefs.qualification.qualificationId !== qualificationStatus.qualificationId
    || materialRefs.qualification.qualificationDigest !== qualificationStatus.qualificationDigest) {
    return undefined;
  }
  const selection = safe as unknown as DeliveryV2ResolutionSelection;
  return selectionDigest(selection) === selection.selectionDigest ? selection : undefined;
}

export function createDeliveryV2ResolutionSelection(
  value: unknown,
): DeliveryV2ResolutionSelectionResult {
  const safe = snapshotDeliveryV2PlainData(value);
  if (!exact(safe, DRAFT_KEYS) || !text(safe["projectId"]) || !text(safe["contractId"])
    || !positive(safe["generation"])
    || (safe["generation"] as number) > DELIVERY_V2_RESOLUTION_SELECTION_MAX_HISTORY) {
    return refusal("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  const materialRefs = admitDeliveryV2ResolutionMaterialRefs(safe["materialRefs"]);
  const productContract = readProductContract(safe["productContract"]);
  const qualificationStatus = readQualificationStatus(safe["qualificationStatus"]);
  if (materialRefs === undefined || productContract === undefined
    || qualificationStatus === undefined || materialRefs.projectId !== safe["projectId"]
    || materialRefs.qualification.qualificationId !== qualificationStatus.qualificationId
    || materialRefs.qualification.qualificationDigest !== qualificationStatus.qualificationDigest) {
    return refusal("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  const provisional = Object.freeze({
    contractId: safe["contractId"], generation: safe["generation"], materialRefs,
    productContract, projectId: safe["projectId"], qualificationStatus,
    selectionDigest: DIGEST_PLACEHOLDER,
    version: DELIVERY_V2_RESOLUTION_SELECTION_VERSION,
  }) as DeliveryV2ResolutionSelection;
  const selection = snapshotDeliveryV2PlainData(Object.freeze({
    ...provisional, selectionDigest: selectionDigest(provisional),
  })) as DeliveryV2ResolutionSelection | undefined;
  if (selection === undefined) {
    return refusal("DELIVERY_V2_RESOLUTION_SELECTION_LIMIT_EXCEEDED");
  }
  return Object.freeze({ ok: true as const, selection });
}

export function encodeDeliveryV2ResolutionSelection(
  value: unknown,
): DeliveryV2ResolutionSelectionEncodeResult {
  const selection = admitSelection(value);
  if (selection === undefined) {
    return refusal("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  return Object.freeze({ bytes: encoder.encode(canonicalText(selection)), ok: true as const });
}

export function decodeDeliveryV2ResolutionSelection(
  bytes: unknown,
): DeliveryV2ResolutionSelectionResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) {
    return refusal(decoded.code.includes("LIMIT_EXCEEDED")
      ? "DELIVERY_V2_RESOLUTION_SELECTION_LIMIT_EXCEEDED"
      : "DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  const selection = admitSelection(decoded.value);
  if (selection === undefined) {
    return refusal("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  try {
    const source = new Uint8Array(bytes as Uint8Array);
    if (decoder.decode(source) !== canonicalText(selection)) {
      return refusal("DELIVERY_V2_RESOLUTION_SELECTION_UNREADABLE");
    }
  } catch {
    return refusal("DELIVERY_V2_RESOLUTION_SELECTION_INPUT_INVALID");
  }
  return Object.freeze({ ok: true as const, selection });
}

export function encodeDeliveryV2ResolutionSelectionRequest(
  projectId: string,
  contractId: string,
  materialRefs: DeliveryV2ResolutionMaterialRefs,
): Uint8Array | undefined {
  const safe = snapshotDeliveryV2PlainData({
    contractId, materialRefs, projectId,
    version: DELIVERY_V2_RESOLUTION_SELECTION_REQUEST_VERSION,
  });
  if (!exact(safe, ["contractId", "materialRefs", "projectId", "version"])
    || !text(safe["projectId"]) || !text(safe["contractId"])
    || safe["version"] !== DELIVERY_V2_RESOLUTION_SELECTION_REQUEST_VERSION) return undefined;
  const admittedRefs = admitDeliveryV2ResolutionMaterialRefs(safe["materialRefs"]);
  if (admittedRefs === undefined || admittedRefs.projectId !== safe["projectId"]) return undefined;
  return encoder.encode(canonicalText(Object.freeze({
    contractId: safe["contractId"], materialRefs: admittedRefs, projectId: safe["projectId"],
    version: DELIVERY_V2_RESOLUTION_SELECTION_REQUEST_VERSION,
  })));
}
