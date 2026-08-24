import {
  deepFreeze, exact, snapshotData, validHex64, validRef,
} from "../planning/planning-snapshot.js";
import {
  PRODUCT_CONTRACT_LIMITS, PRODUCT_CONTRACT_VERSION, productContractRefusal,
  type ProductContractAdmission, type ProductContractCriterion,
  type ProductContractDraftAdmission, type ProductContractLineage,
  type ProductContractRefusal, type ProductContractRequirement,
  type ProductContractRevisionDraft,
} from "./product-contract-contract.js";

type ReadResult<T> = Readonly<{ ok: true; value: T }> | ProductContractRefusal;
type ParsedRevision = Readonly<{
  body: ProductContractRevisionDraft;
  revisionDigest?: string;
}>;

const encoder = new TextEncoder();
const DRAFT_KEYS = Object.freeze([
  "authorRef", "contractId", "criteria", "lineage", "requirements", "retiredCriterionIds",
  "retiredRequirementIds", "revisionId", "sourceDocumentDigests",
]);
const FULL_KEYS = Object.freeze([
  "advisoryOnly", ...DRAFT_KEYS, "revisionDigest", "version",
]);
const LINEAGE_KEYS = Object.freeze(["parentRevisionDigest", "parentRevisionId"]);
const REQUIREMENT_KEYS = Object.freeze([
  "requirementId", "statement", "supersedesRequirementId",
]);
const CRITERION_KEYS = Object.freeze([
  "criterionId", "requirementId", "statement", "supersedesCriterionId",
]);

const invalid = (): ProductContractRefusal =>
  productContractRefusal("PRODUCT_CONTRACT_PROVENANCE_INVALID", "PROVENANCE");
const vacuous = (): ProductContractRefusal =>
  productContractRefusal("PRODUCT_CONTRACT_PROVENANCE_VACUOUS", "PROVENANCE");
const exceeded = (): ProductContractRefusal =>
  productContractRefusal("PRODUCT_CONTRACT_LIMIT_EXCEEDED", "PROVENANCE");
const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

function readText(
  value: unknown, maximum: number = PRODUCT_CONTRACT_LIMITS.maxIdBytes,
): ReadResult<string> {
  if (!validRef(value) || value.includes("\0") || !value.isWellFormed()
    || value.normalize("NFC") !== value) return invalid();
  return encoder.encode(value).byteLength <= maximum ? success(value) : exceeded();
}

function readNullableRef(value: unknown): ReadResult<string | null> {
  return value === null ? success(null) : readText(value);
}

function readSortedRefs(value: unknown, allowEmpty: boolean): ReadResult<readonly string[]> {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return vacuous();
  if (value.length > PRODUCT_CONTRACT_LIMITS.maxRequirements) return exceeded();
  const result: string[] = [];
  for (const candidate of value) {
    const item = readText(candidate); if (!item.ok) return item;
    if (result.at(-1) !== undefined && result.at(-1)! >= item.value) return invalid();
    result.push(item.value);
  }
  return success(Object.freeze(result));
}

function readSources(value: unknown): ReadResult<readonly string[]> {
  if (!Array.isArray(value) || value.length === 0) return vacuous();
  if (value.length > PRODUCT_CONTRACT_LIMITS.maxSourceDocuments) return exceeded();
  const result: string[] = [];
  for (const candidate of value) {
    if (!validHex64(candidate)) return invalid();
    if (result.at(-1) !== undefined && result.at(-1)! >= candidate) return invalid();
    result.push(candidate);
  }
  return success(Object.freeze(result));
}

function readLineage(value: unknown): ReadResult<ProductContractLineage | null> {
  if (value === null) return success(null);
  if (!exact(value, LINEAGE_KEYS) || !validHex64(value["parentRevisionDigest"])) return invalid();
  const parent = readText(value["parentRevisionId"]); if (!parent.ok) return parent;
  return success(Object.freeze({
    parentRevisionDigest: value["parentRevisionDigest"], parentRevisionId: parent.value,
  }));
}

function readRequirement(value: unknown): ReadResult<ProductContractRequirement> {
  if (!exact(value, REQUIREMENT_KEYS)) return invalid();
  const id = readText(value["requirementId"]);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_LIMITS.maxStatementBytes);
  const supersedes = readNullableRef(value["supersedesRequirementId"]);
  if (!id.ok) return id; if (!statement.ok) return statement; if (!supersedes.ok) return supersedes;
  if (supersedes.value === id.value) return invalid();
  return success(Object.freeze({
    requirementId: id.value, statement: statement.value,
    supersedesRequirementId: supersedes.value,
  }));
}

function readCriterion(value: unknown): ReadResult<ProductContractCriterion> {
  if (!exact(value, CRITERION_KEYS)) return invalid();
  const id = readText(value["criterionId"]); const requirement = readText(value["requirementId"]);
  const statement = readText(value["statement"], PRODUCT_CONTRACT_LIMITS.maxStatementBytes);
  const supersedes = readNullableRef(value["supersedesCriterionId"]);
  if (!id.ok) return id; if (!requirement.ok) return requirement;
  if (!statement.ok) return statement; if (!supersedes.ok) return supersedes;
  if (supersedes.value === id.value) return invalid();
  return success(Object.freeze({
    criterionId: id.value, requirementId: requirement.value, statement: statement.value,
    supersedesCriterionId: supersedes.value,
  }));
}

function readSortedItems<T>(
  value: unknown, maximum: number, read: (candidate: unknown) => ReadResult<T>, idOf: (item: T) => string,
): ReadResult<readonly T[]> {
  if (!Array.isArray(value) || value.length === 0) return vacuous();
  if (value.length > maximum) return exceeded();
  const result: T[] = [];
  for (const candidate of value) {
    const item = read(candidate); if (!item.ok) return item;
    if (result.at(-1) !== undefined && idOf(result.at(-1)!) >= idOf(item.value)) return invalid();
    result.push(item.value);
  }
  return success(Object.freeze(result));
}

function validateCoverage(body: ProductContractRevisionDraft): ProductContractRefusal | undefined {
  const requirements = new Set(body.requirements.map((item) => item.requirementId));
  if (body.retiredRequirementIds.some((id) => requirements.has(id))) return invalid();
  const criterionIds = new Set(body.criteria.map((item) => item.criterionId));
  if (body.retiredCriterionIds.some((id) => criterionIds.has(id))) return invalid();
  const covered = new Set<string>();
  for (const criterion of body.criteria) {
    if (!requirements.has(criterion.requirementId)) return invalid();
    covered.add(criterion.requirementId);
  }
  return body.requirements.every((item) => covered.has(item.requirementId)) ? undefined : vacuous();
}

function parseRevision(value: unknown, full: boolean): ReadResult<ParsedRevision> {
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, full ? FULL_KEYS : DRAFT_KEYS)) return invalid();
  const record = snapshot.value;
  if (full && record["version"] !== PRODUCT_CONTRACT_VERSION) {
    return productContractRefusal("PRODUCT_CONTRACT_VERSION_UNSUPPORTED", "PROVENANCE");
  }
  if (full && record["advisoryOnly"] !== true) return invalid();
  const author = readText(record["authorRef"]); const contract = readText(record["contractId"]);
  const revision = readText(record["revisionId"]); const lineage = readLineage(record["lineage"]);
  const sources = readSources(record["sourceDocumentDigests"]);
  const retiredRequirements = readSortedRefs(record["retiredRequirementIds"], true);
  const retiredCriteria = readSortedRefs(record["retiredCriterionIds"], true);
  const requirements = readSortedItems(record["requirements"], PRODUCT_CONTRACT_LIMITS.maxRequirements,
    readRequirement, (item) => item.requirementId);
  const criteria = readSortedItems(record["criteria"], PRODUCT_CONTRACT_LIMITS.maxCriteria,
    readCriterion, (item) => item.criterionId);
  if (!author.ok) return author; if (!contract.ok) return contract;
  if (!revision.ok) return revision; if (!lineage.ok) return lineage;
  if (!sources.ok) return sources; if (!retiredRequirements.ok) return retiredRequirements;
  if (!retiredCriteria.ok) return retiredCriteria; if (!requirements.ok) return requirements;
  if (!criteria.ok) return criteria;
  const body = Object.freeze({
    authorRef: author.value, contractId: contract.value, criteria: criteria.value,
    lineage: lineage.value, requirements: requirements.value,
    retiredCriterionIds: retiredCriteria.value, retiredRequirementIds: retiredRequirements.value,
    revisionId: revision.value, sourceDocumentDigests: sources.value,
  });
  if (body.lineage === null && (body.retiredCriterionIds.length > 0
    || body.retiredRequirementIds.length > 0
    || body.criteria.some((item) => item.supersedesCriterionId !== null)
    || body.requirements.some((item) => item.supersedesRequirementId !== null))) return invalid();
  const coverage = validateCoverage(body); if (coverage !== undefined) return coverage;
  if (!full) return success({ body });
  return validHex64(record["revisionDigest"])
    ? success({ body, revisionDigest: record["revisionDigest"] }) : invalid();
}

export function admitProductContractRevisionDraft(value: unknown): ProductContractDraftAdmission {
  const parsed = parseRevision(value, false);
  return parsed.ok
    ? Object.freeze({ draft: deepFreeze({ ...parsed.value.body }), ok: true as const }) : parsed;
}

export function admitProductContractRevision(value: unknown): ProductContractAdmission {
  const parsed = parseRevision(value, true); if (!parsed.ok) return parsed;
  return Object.freeze({ ok: true as const, revision: deepFreeze({
    ...parsed.value.body, advisoryOnly: true as const,
    revisionDigest: parsed.value.revisionDigest!, version: PRODUCT_CONTRACT_VERSION,
  }) });
}
