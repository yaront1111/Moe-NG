import type { JsonValue } from "@moe/contracts";
import type { ReviewLineage, ReviewRouting } from "@moe/review";
import { ref as isRef } from "../json-record-shape.js";
import { DELTA_CLASSIFICATIONS, isPlainJsonObject } from "./review-contracts.js";
import type { DeltaNodeClassification } from "./review-contracts.js";
import { parseStoredPackageItems } from "./review-round-items.js";
import type { AcceptanceRecord, DeltaRecord, ReviewRoundRecord } from "./review-read-model.js";

const CLASSIFICATION_SET: ReadonlySet<string> = new Set<string>(DELTA_CLASSIFICATIONS);

function isStringArray(value: JsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** A stored attribution is the kernel's inert copy: a node key and a non-empty criterion list. */
function validAttribution(value: JsonValue | undefined): boolean {
  if (value === undefined) return true;
  if (!isPlainJsonObject(value)) return false;
  const criterionIds = value["criterionIds"];
  return isRef(value["nodeKey"]) && Array.isArray(criterionIds) && criterionIds.length > 0
    && criterionIds.every((entry) => isRef(entry));
}

function validRecord(value: JsonValue): boolean {
  if (!isPlainJsonObject(value)) return false;
  const finding = value["finding"];
  if (!isPlainJsonObject(finding)) return false;
  const subject = finding["subject"];
  return (
    validAttribution(finding["attributedTo"]) &&
    isRef(value["fingerprint"])
    && typeof value["round"] === "number"
    && isRef(finding["ruleId"])
    && typeof finding["detail"] === "string"
    && isRef(finding["severity"])
    && isPlainJsonObject(subject)
    && isRef(subject["kind"])
    && typeof subject["locator"] === "string"
  );
}

/**
 * Structural validation only, and it returns undefined rather than an empty lineage on failure.
 * Treating unparseable bytes as "no rounds yet" would silently reset `unsuccessfulRounds` and
 * lift the escalation cap, so the caller has to fail closed instead.
 */
function parseLineage(value: JsonValue | undefined): ReviewLineage | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const records = value["records"];
  if (!isRef(value["digest"]) || typeof value["unsuccessfulRounds"] !== "number") return undefined;
  // `highestRound` is required: a stored lineage without it predates the
  // append-only frontier and cannot be trusted to report it, so fail closed
  // rather than defaulting a value the digest never covered.
  if (typeof value["highestRound"] !== "number") return undefined;
  if (!Array.isArray(records) || !records.every(validRecord)) return undefined;
  return value as unknown as ReviewLineage;
}

function parseRouting(value: JsonValue | undefined): ReviewRouting | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  if (!isRef(value["layer"]) || !isRef(value["route"])) return undefined;
  if (!isStringArray(value["reasonCodes"]) || !isStringArray(value["repeatFingerprints"])) {
    return undefined;
  }
  return value as unknown as ReviewRouting;
}

function parseClassification(value: JsonValue): DeltaNodeClassification | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const classification = value["classification"];
  if (typeof classification !== "string" || !CLASSIFICATION_SET.has(classification)) {
    return undefined;
  }
  if (!isRef(value["nodeRef"]) || !isStringArray(value["reasonCodes"])) return undefined;
  if (typeof value["sourceHash"] !== "string" || typeof value["targetHash"] !== "string") {
    return undefined;
  }
  return value as unknown as DeltaNodeClassification;
}

export function parseDelta(result: JsonValue): DeltaRecord | undefined {
  if (!isPlainJsonObject(result)) return undefined;
  const classifications = result["classifications"];
  if (!isRef(result["successorPlanRef"])) return undefined;
  if (!Array.isArray(classifications) || classifications.length === 0) return undefined;
  if (!classifications.every((entry) => parseClassification(entry) !== undefined)) return undefined;
  return result as unknown as DeltaRecord;
}

export function parseAcceptance(result: JsonValue): AcceptanceRecord | undefined {
  if (!isPlainJsonObject(result)) return undefined;
  if (!isRef(result["policyDecision"]) || !isRef(result["reviewInputDigest"])) return undefined;
  if (!isRef(result["reviewerCalibrationDigest"])) return undefined;
  if (!isRef(result["verifierReceiptId"]) || !isRef(result["verifierReceiptSha256"])) {
    return undefined;
  }
  return result as unknown as AcceptanceRecord;
}

export function parseRound(
  result: JsonValue,
  storeFacts: Readonly<{
    aggregateVersion: number;
    decisionId: string;
    principalId: string;
    resultSha256: string;
  }>,
): ReviewRoundRecord | undefined {
  if (!isPlainJsonObject(result)) return undefined;
  const lineage = parseLineage(result["lineage"]);
  const routing = parseRouting(result["routing"]);
  // A malformed items key makes the whole round unreadable rather than partly trusted: binding
  // an item set nobody validated would put bytes the stored digest never covered in front of a
  // caller that has no way left to tell.
  const packageItems = parseStoredPackageItems(result["packageItems"]);
  const round = result["round"];
  if (lineage === undefined || routing === undefined || packageItems === undefined) return undefined;
  if (typeof round !== "number" || !isRef(result["reviewInputDigest"])) return undefined;
  return {
    ...storeFacts,
    lineage,
    packageItems,
    reviewInputDigest: result["reviewInputDigest"],
    round,
    routing,
  };
}
