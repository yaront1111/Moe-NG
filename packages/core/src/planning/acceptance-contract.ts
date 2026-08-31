import { isProxy } from "node:util/types";
import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { deepFreeze, exact, snapshotData, validHex64, validRef } from "./planning-snapshot.js";

export const ACCEPTANCE_CONTRACT_VERSION = "moe-acceptance-contract/1" as const;
export const ACCEPTANCE_CONTRACT_NODE_KINDS = Object.freeze([
  "LEAF", "INTEGRATION", "GLOBAL_VERIFICATION", "FINAL_REVIEW", "COMPOSITE_COMPLETION",
] as const);
export const ACCEPTANCE_CONTRACT_EVIDENCE_KINDS = Object.freeze([
  "VERIFICATION_RECEIPT", "ARTIFACT", "INTEGRATION", "REVIEW", "APPROVAL", "WITNESS",
] as const);
export const ACCEPTANCE_CONTRACT_CODES = Object.freeze([
  "ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_VERSION_UNSUPPORTED",
  "ACCEPTANCE_CONTRACT_EMPTY_OBLIGATIONS", "ACCEPTANCE_CONTRACT_CRITERION_CONTENT_REQUIRED",
  "ACCEPTANCE_CONTRACT_DUPLICATE_ID", "ACCEPTANCE_CONTRACT_LIMIT_EXCEEDED",
  "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_DUPLICATE_KEY",
  "ACCEPTANCE_CONTRACT_NONCANONICAL", "ACCEPTANCE_CONTRACT_DIGEST_MISMATCH",
] as const);
export const ACCEPTANCE_CONTRACT_LAYERS = Object.freeze([
  "ACCEPTANCE_CONTRACT_ADMISSION", "ACCEPTANCE_CONTRACT_VERSION", "ACCEPTANCE_CONTRACT_LIMITS",
  "ACCEPTANCE_CONTRACT_CODEC", "ACCEPTANCE_CONTRACT_CANONICALIZATION", "ACCEPTANCE_CONTRACT_DIGEST",
] as const);
export const ACCEPTANCE_CONTRACT_LIMITS = Object.freeze({
  maxAggregateEntries: 20_000, maxBytes: MAX_JSON_BODY_BYTES, maxCriterionBytes: 32_768,
  maxEvidenceRequirementsPerObligation: 64, maxIdBytes: 512, maxNodeIds: 512,
  maxObligations: 1_024, maxRecipeRefsPerObligation: 64,
});

export type AcceptanceContractNodeKind = (typeof ACCEPTANCE_CONTRACT_NODE_KINDS)[number];
export type AcceptanceContractEvidenceKind = (typeof ACCEPTANCE_CONTRACT_EVIDENCE_KINDS)[number];
export type AcceptanceContractCode = (typeof ACCEPTANCE_CONTRACT_CODES)[number];
export type AcceptanceContractLayer = (typeof ACCEPTANCE_CONTRACT_LAYERS)[number];
export interface AcceptanceContractApplicability {
  readonly graphContentHash: string; readonly graphRevisionRef: string;
  readonly nodeIds: readonly string[]; readonly nodeKind: AcceptanceContractNodeKind;
}
export interface AcceptanceEvidenceRequirement {
  readonly evidenceRef: string; readonly kind: AcceptanceContractEvidenceKind;
  readonly requirementId: string;
}
export interface AcceptanceCriterionObligation {
  readonly criterionId: string; readonly evidenceRequirements: readonly AcceptanceEvidenceRequirement[];
  readonly statement: string; readonly verificationRecipeRefs: readonly string[];
}
export interface AcceptanceContractDraft {
  readonly applicability: AcceptanceContractApplicability; readonly authorRef: string;
  readonly contractId: string; readonly obligations: readonly AcceptanceCriterionObligation[];
}
export interface AcceptanceContract extends AcceptanceContractDraft {
  readonly criteriaDigest: string; readonly version: typeof ACCEPTANCE_CONTRACT_VERSION;
}
export interface AcceptanceContractRefusal {
  readonly code: AcceptanceContractCode; readonly layer: AcceptanceContractLayer; readonly ok: false;
}
export type AcceptanceContractDraftAdmission =
  | Readonly<{ draft: AcceptanceContractDraft; ok: true }> | AcceptanceContractRefusal;
export type AcceptanceContractAdmission =
  | Readonly<{ contract: AcceptanceContract; ok: true }> | AcceptanceContractRefusal;

type ReadResult<T> = Readonly<{ ok: true; value: T }> | AcceptanceContractRefusal;
interface ParsedContract { readonly body: AcceptanceContractDraft; readonly criteriaDigest?: string; }
const encoder = new TextEncoder();
const FULL_KEYS = Object.freeze(["applicability", "authorRef", "contractId", "criteriaDigest", "obligations", "version"]);
const DRAFT_KEYS = Object.freeze(["applicability", "authorRef", "contractId", "obligations"]);
const APPLICABILITY_KEYS = Object.freeze(["graphContentHash", "graphRevisionRef", "nodeIds", "nodeKind"]);
const OBLIGATION_KEYS = Object.freeze(["criterionId", "evidenceRequirements", "statement", "verificationRecipeRefs"]);
const EVIDENCE_KEYS = Object.freeze(["evidenceRef", "kind", "requirementId"]);

export function acceptanceContractRefusal(
  code: AcceptanceContractCode, layer: AcceptanceContractLayer,
): AcceptanceContractRefusal { return Object.freeze({ code, layer, ok: false as const }); }
const malformed = (): AcceptanceContractRefusal =>
  acceptanceContractRefusal("ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION");
const exceeded = (): AcceptanceContractRefusal =>
  acceptanceContractRefusal("ACCEPTANCE_CONTRACT_LIMIT_EXCEEDED", "ACCEPTANCE_CONTRACT_LIMITS");
const duplicated = (): AcceptanceContractRefusal =>
  acceptanceContractRefusal("ACCEPTANCE_CONTRACT_DUPLICATE_ID", "ACCEPTANCE_CONTRACT_LIMITS");
const contentRequired = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_CRITERION_CONTENT_REQUIRED", "ACCEPTANCE_CONTRACT_ADMISSION",
);
const emptyObligations = (): AcceptanceContractRefusal => acceptanceContractRefusal(
  "ACCEPTANCE_CONTRACT_EMPTY_OBLIGATIONS", "ACCEPTANCE_CONTRACT_LIMITS",
);
const success = <T>(value: T): Readonly<{ ok: true; value: T }> =>
  Object.freeze({ ok: true as const, value });

function hostileObject(
  value: unknown, seen = new WeakSet<object>(),
): AcceptanceContractRefusal | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (isProxy(value)) return malformed();
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    const array = Array.isArray(value); const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) return malformed();
    if (array && value.length > ACCEPTANCE_CONTRACT_LIMITS.maxAggregateEntries) return exceeded();
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || property === undefined || !("value" in property)) {
        return malformed();
      }
      const nested = hostileObject(property.value, seen);
      if (nested !== undefined) return nested;
    }
    return undefined;
  } catch { return malformed(); } finally { seen.delete(value); }
}

function readText(value: unknown, maximum: number): ReadResult<string> {
  if (!validRef(value)) return malformed();
  if (value.length > maximum) return exceeded();
  if (value.includes("\0") || !value.isWellFormed()
    || value.normalize("NFC") !== value) return malformed();
  return encoder.encode(value).byteLength > maximum ? exceeded() : success(value);
}
function readStatement(value: unknown): ReadResult<string> {
  if (typeof value !== "string" || value.length === 0) return contentRequired();
  return readText(value, ACCEPTANCE_CONTRACT_LIMITS.maxCriterionBytes);
}
function readSortedIds(value: unknown, maximum: number): ReadResult<readonly string[]> {
  if (!Array.isArray(value) || value.length === 0) return malformed();
  if (value.length > maximum) return exceeded();
  const items: string[] = []; const ids = new Set<string>();
  for (const candidate of value) {
    const item = readText(candidate, ACCEPTANCE_CONTRACT_LIMITS.maxIdBytes);
    if (!item.ok) return item;
    if (ids.has(item.value)) return duplicated();
    if (items.at(-1) !== undefined && items.at(-1)! > item.value) return malformed();
    ids.add(item.value); items.push(item.value);
  }
  return success(Object.freeze(items));
}
function readEvidence(value: unknown): ReadResult<AcceptanceEvidenceRequirement> {
  if (!exact(value, EVIDENCE_KEYS)) return malformed();
  const evidenceRef = readText(value["evidenceRef"], ACCEPTANCE_CONTRACT_LIMITS.maxIdBytes);
  const requirementId = readText(value["requirementId"], ACCEPTANCE_CONTRACT_LIMITS.maxIdBytes);
  if (!evidenceRef.ok) return evidenceRef; if (!requirementId.ok) return requirementId;
  const kind = value["kind"];
  if (typeof kind !== "string"
    || !ACCEPTANCE_CONTRACT_EVIDENCE_KINDS.includes(kind as AcceptanceContractEvidenceKind)) {
    return malformed();
  }
  return success(Object.freeze({ evidenceRef: evidenceRef.value,
    kind: kind as AcceptanceContractEvidenceKind, requirementId: requirementId.value }));
}
function readEvidenceList(value: unknown): ReadResult<readonly AcceptanceEvidenceRequirement[]> {
  if (!Array.isArray(value) || value.length === 0) return malformed();
  if (value.length > ACCEPTANCE_CONTRACT_LIMITS.maxEvidenceRequirementsPerObligation) return exceeded();
  const items: AcceptanceEvidenceRequirement[] = []; const ids = new Set<string>();
  for (const candidate of value) {
    const item = readEvidence(candidate); if (!item.ok) return item;
    if (ids.has(item.value.requirementId)) return duplicated();
    if (items.at(-1)?.requirementId !== undefined
      && items.at(-1)!.requirementId > item.value.requirementId) return malformed();
    ids.add(item.value.requirementId); items.push(item.value);
  }
  return success(Object.freeze(items));
}
function readObligation(value: unknown): ReadResult<AcceptanceCriterionObligation> {
  const statementProperty = value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "statement") : undefined;
  if (statementProperty === undefined || !("value" in statementProperty)
    || statementProperty.value === "") return contentRequired();
  if (!exact(value, OBLIGATION_KEYS)) return malformed();
  const criterionId = readText(value["criterionId"], ACCEPTANCE_CONTRACT_LIMITS.maxIdBytes);
  const statement = readStatement(value["statement"]);
  const recipes = readSortedIds(value["verificationRecipeRefs"],
    ACCEPTANCE_CONTRACT_LIMITS.maxRecipeRefsPerObligation);
  const evidence = readEvidenceList(value["evidenceRequirements"]);
  if (!criterionId.ok) return criterionId; if (!statement.ok) return statement;
  if (!recipes.ok) return recipes; if (!evidence.ok) return evidence;
  return success(Object.freeze({ criterionId: criterionId.value,
    evidenceRequirements: evidence.value, statement: statement.value,
    verificationRecipeRefs: recipes.value }));
}
function readObligations(value: unknown): ReadResult<readonly AcceptanceCriterionObligation[]> {
  if (!Array.isArray(value)) return malformed();
  if (value.length === 0) return emptyObligations();
  if (value.length > ACCEPTANCE_CONTRACT_LIMITS.maxObligations) return exceeded();
  const items: AcceptanceCriterionObligation[] = []; const ids = new Set<string>();
  for (const candidate of value) {
    const item = readObligation(candidate); if (!item.ok) return item;
    if (ids.has(item.value.criterionId)) return duplicated();
    if (items.at(-1)?.criterionId !== undefined
      && items.at(-1)!.criterionId > item.value.criterionId) return malformed();
    ids.add(item.value.criterionId); items.push(item.value);
  }
  return success(Object.freeze(items));
}
function readApplicability(value: unknown): ReadResult<AcceptanceContractApplicability> {
  if (!exact(value, APPLICABILITY_KEYS) || !validHex64(value["graphContentHash"])) return malformed();
  const revision = readText(value["graphRevisionRef"], ACCEPTANCE_CONTRACT_LIMITS.maxIdBytes);
  const nodes = readSortedIds(value["nodeIds"], ACCEPTANCE_CONTRACT_LIMITS.maxNodeIds);
  if (!revision.ok) return revision; if (!nodes.ok) return nodes;
  const kind = value["nodeKind"];
  if (typeof kind !== "string"
    || !ACCEPTANCE_CONTRACT_NODE_KINDS.includes(kind as AcceptanceContractNodeKind)) return malformed();
  return success(Object.freeze({ graphContentHash: value["graphContentHash"],
    graphRevisionRef: revision.value, nodeIds: nodes.value,
    nodeKind: kind as AcceptanceContractNodeKind }));
}
function aggregateEntries(body: AcceptanceContractDraft): number {
  return body.applicability.nodeIds.length + body.obligations.reduce(
    (sum, item) => sum + 1 + item.verificationRecipeRefs.length + item.evidenceRequirements.length, 0,
  );
}
function parseContract(value: unknown, full: boolean): ReadResult<ParsedContract> {
  const hostile = hostileObject(value); if (hostile !== undefined) return hostile;
  const snapshot = snapshotData(value);
  if (!snapshot.ok || !exact(snapshot.value, full ? FULL_KEYS : DRAFT_KEYS)) return malformed();
  const record = snapshot.value;
  if (full && record["version"] !== ACCEPTANCE_CONTRACT_VERSION) return acceptanceContractRefusal(
    "ACCEPTANCE_CONTRACT_VERSION_UNSUPPORTED", "ACCEPTANCE_CONTRACT_VERSION",
  );
  const contractId = readText(record["contractId"], ACCEPTANCE_CONTRACT_LIMITS.maxIdBytes);
  const authorRef = readText(record["authorRef"], ACCEPTANCE_CONTRACT_LIMITS.maxIdBytes);
  const applicability = readApplicability(record["applicability"]);
  const obligations = readObligations(record["obligations"]);
  if (!contractId.ok) return contractId; if (!authorRef.ok) return authorRef;
  if (!applicability.ok) return applicability; if (!obligations.ok) return obligations;
  const body = Object.freeze({ applicability: applicability.value, authorRef: authorRef.value,
    contractId: contractId.value, obligations: obligations.value });
  if (aggregateEntries(body) > ACCEPTANCE_CONTRACT_LIMITS.maxAggregateEntries) return exceeded();
  if (!full) return success({ body });
  return validHex64(record["criteriaDigest"])
    ? success({ body, criteriaDigest: record["criteriaDigest"] }) : malformed();
}
export function admitAcceptanceContractDraft(value: unknown): AcceptanceContractDraftAdmission {
  const parsed = parseContract(value, false);
  return parsed.ok ? Object.freeze({ draft: deepFreeze({ ...parsed.value.body }), ok: true as const }) : parsed;
}
export function admitAcceptanceContract(value: unknown): AcceptanceContractAdmission {
  const parsed = parseContract(value, true); if (!parsed.ok) return parsed;
  return Object.freeze({ contract: deepFreeze({ ...parsed.value.body,
    criteriaDigest: parsed.value.criteriaDigest!, version: ACCEPTANCE_CONTRACT_VERSION }), ok: true as const });
}
