import type { ProductContractRevisionV2, ProductContractV2Requirement } from "@moe/core";

import {
  exactGate1Row, gate1Digest, type Gate1DataRow,
} from "./gate1-data-snapshot.js";

const MAX_ID = 512;
const MAX_STATEMENT = 32_768;
const MAX_ITEMS = 512;
const encoder = new TextEncoder();

const REVISION_KEYS = Object.freeze([
  "advisoryOnly", "assumptions", "authorRef", "budgets", "contractId", "criteria",
  "deploymentRequirements", "functionalRequirements", "journeys", "lineage",
  "materialDecisions", "negativeScope", "nonFunctionalRequirements", "objectives",
  "productCompleteDefinition", "retiredCriterionIds", "retiredRequirementIds",
  "revisionDigest", "revisionId", "securityPrivacyRequirements", "sourceDocumentDigests",
  "successMetrics", "technologyRequirements", "userJobs", "uxAccessibilityRequirements",
  "version",
]);
const REQUIREMENT_KEYS = Object.freeze([
  "dependsOnRequirementIds", "priority", "requirementId", "statement",
  "supersedesRequirementId",
]);

function text(value: unknown, maximum: number = MAX_ID): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !value.includes("\0") && value.isWellFormed() && value.normalize("NFC") === value
    && value.trim() === value && encoder.encode(value).byteLength <= maximum;
}

function sortedTexts(
  value: unknown, allowEmpty: boolean, maximum: number = MAX_ITEMS,
  guard: (candidate: unknown) => candidate is string = text,
): value is readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum) {
    return false;
  }
  return value.every((item, index) => guard(item)
    && (index === 0 || String(value[index - 1]) < item));
}

function sortedRows(
  value: unknown, allowEmpty: boolean, maximum: number, idKey: string,
  guard: (candidate: unknown) => boolean,
): value is readonly Gate1DataRow[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum) {
    return false;
  }
  let previous: string | null = null;
  for (const candidate of value) {
    if (!guard(candidate)) return false;
    const id = (candidate as Gate1DataRow)[idKey];
    if (!text(id) || (previous !== null && previous >= id)) return false;
    previous = id;
  }
  return true;
}

function statement(value: unknown, idKey: string): boolean {
  const row = exactGate1Row(value, [idKey, "statement"]);
  return row !== null && text(row[idKey]) && text(row["statement"], MAX_STATEMENT);
}

function userJob(value: unknown): boolean {
  const row = exactGate1Row(value, ["job", "user", "userJobId"]);
  return row !== null && text(row["userJobId"])
    && text(row["job"], MAX_STATEMENT) && text(row["user"], MAX_STATEMENT);
}

function journey(value: unknown): boolean {
  const row = exactGate1Row(value, ["criterionIds", "journeyId", "statement", "userJobId"]);
  return row !== null && text(row["journeyId"]) && text(row["userJobId"])
    && text(row["statement"], MAX_STATEMENT)
    && sortedTexts(row["criterionIds"], false, 1_024);
}

function requirement(value: unknown): boolean {
  const row = exactGate1Row(value, REQUIREMENT_KEYS);
  if (row === null || !text(row["requirementId"])
    || !text(row["statement"], MAX_STATEMENT)
    || !sortedTexts(row["dependsOnRequirementIds"], true)
    || !["MUST", "SHOULD", "COULD"].includes(String(row["priority"]))) return false;
  const supersedes = row["supersedesRequirementId"];
  return (supersedes === null || text(supersedes))
    && supersedes !== row["requirementId"]
    && !row["dependsOnRequirementIds"].includes(row["requirementId"] as string);
}

function criterion(value: unknown): boolean {
  const row = exactGate1Row(value, [
    "criterionId", "requirementId", "statement", "supersedesCriterionId", "verification",
  ]);
  if (row === null || !text(row["criterionId"]) || !text(row["requirementId"])
    || !text(row["statement"], MAX_STATEMENT)
    || !text(row["verification"], MAX_STATEMENT)) return false;
  return row["supersedesCriterionId"] === null
    || (text(row["supersedesCriterionId"])
      && row["supersedesCriterionId"] !== row["criterionId"]);
}

function assumption(value: unknown): boolean {
  const row = exactGate1Row(value, ["assumptionId", "statement", "validationCriterionId"]);
  return row !== null && text(row["assumptionId"]) && text(row["validationCriterionId"])
    && text(row["statement"], MAX_STATEMENT);
}

function budget(value: unknown): boolean {
  const row = exactGate1Row(value, ["budgetId", "kind", "limit", "unit"]);
  return row !== null && text(row["budgetId"]) && text(row["unit"])
    && ["MONEY", "TIME", "TOKEN", "COMPUTE"].includes(String(row["kind"]))
    && Number.isSafeInteger(row["limit"]) && Number(row["limit"]) > 0;
}

function metric(value: unknown): boolean {
  const row = exactGate1Row(value, [
    "measurement", "metricId", "objectiveIds", "statement", "target",
  ]);
  return row !== null && text(row["metricId"])
    && sortedTexts(row["objectiveIds"], false)
    && text(row["measurement"], MAX_STATEMENT) && text(row["statement"], MAX_STATEMENT)
    && text(row["target"], MAX_STATEMENT);
}

function option(value: unknown): boolean {
  return statement(value, "optionId");
}

function decision(value: unknown): boolean {
  const row = exactGate1Row(value, ["decisionId", "options", "question", "selectedOptionId"]);
  return row !== null && text(row["decisionId"]) && text(row["question"], MAX_STATEMENT)
    && (row["selectedOptionId"] === null || text(row["selectedOptionId"]))
    && sortedRows(row["options"], false, 64, "optionId", option)
    && row["options"].length >= 2;
}

function lineage(value: unknown): boolean {
  if (value === null) return true;
  const row = exactGate1Row(value, ["parentRevisionDigest", "parentRevisionId"]);
  return row !== null && gate1Digest(row["parentRevisionDigest"])
    && text(row["parentRevisionId"]);
}

function complete(value: unknown): boolean {
  const row = exactGate1Row(value, ["criterionIds", "statement"]);
  return row !== null && sortedTexts(row["criterionIds"], false, 1_024)
    && text(row["statement"], MAX_STATEMENT);
}

const section = (
  row: Gate1DataRow, key: string, id: string, guard: (value: unknown) => boolean,
  allowEmpty = false, maximum = MAX_ITEMS,
): boolean => sortedRows(row[key], allowEmpty, maximum, id, guard);

export function validGate1RevisionShape(value: unknown): value is ProductContractRevisionV2 {
  const row = exactGate1Row(value, REVISION_KEYS);
  return row !== null && row["advisoryOnly"] === true
    && row["version"] === "moe-product-contract-revision/2"
    && text(row["authorRef"]) && text(row["contractId"]) && text(row["revisionId"])
    && gate1Digest(row["revisionDigest"]) && lineage(row["lineage"])
    && sortedTexts(row["sourceDocumentDigests"], false, 64, gate1Digest)
    && sortedTexts(row["retiredRequirementIds"], true, 8_192)
    && sortedTexts(row["retiredCriterionIds"], true, 8_192)
    && section(row, "objectives", "objectiveId", (item) => statement(item, "objectiveId"))
    && section(row, "userJobs", "userJobId", userJob)
    && section(row, "journeys", "journeyId", journey)
    && section(row, "functionalRequirements", "requirementId", requirement)
    && section(row, "nonFunctionalRequirements", "requirementId", requirement)
    && section(row, "securityPrivacyRequirements", "requirementId", requirement)
    && section(row, "technologyRequirements", "requirementId", requirement)
    && section(row, "uxAccessibilityRequirements", "requirementId", requirement)
    && section(row, "deploymentRequirements", "requirementId", requirement)
    && section(row, "criteria", "criterionId", criterion, false, 1_024)
    && section(row, "negativeScope", "scopeId", (item) => statement(item, "scopeId"))
    && section(row, "assumptions", "assumptionId", assumption, true)
    && section(row, "budgets", "budgetId", budget, false, 64)
    && section(row, "successMetrics", "metricId", metric)
    && section(row, "materialDecisions", "decisionId", decision, true, 256)
    && complete(row["productCompleteDefinition"]);
}

export function gate1Requirements(revision: ProductContractRevisionV2): readonly ProductContractV2Requirement[] {
  return [
    ...revision.deploymentRequirements, ...revision.functionalRequirements,
    ...revision.nonFunctionalRequirements, ...revision.securityPrivacyRequirements,
    ...revision.technologyRequirements, ...revision.uxAccessibilityRequirements,
  ];
}
