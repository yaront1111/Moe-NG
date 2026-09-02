/**
 * The PRD COVERAGE read client: POST /documents/coverage/read with EXACTLY { goalRef } and
 * shape what the daemon says - verbatim - into COVERAGE / REFUSED / ERROR. READS ONLY.
 *
 * Discipline copied from live-planning-run.ts: exact-key snapshots of every frame level, a
 * refusal carried out at its OWN layer, and a nested body that drifts reddening the WHOLE
 * answer to ERROR rather than rendering a half-coverage a human might act on. The section
 * map is the daemon's ADVISORY derivation and is carried with that flag intact.
 */

const LIVE_COVERAGE_LAYER = "CONTROL_ROOM_LIVE_COVERAGE";
const INVALID_RESPONSE_CODE = "DOCUMENT_COVERAGE_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const DOCUMENT_COVERAGE_READ_PATH = "/documents/coverage/read";
const REQUEST_TIMEOUT_MS = 15_000;

export const CRITERION_COVERAGE_STATUSES = ["PLANNED", "UNPLANNED", "VERIFIED"] as const;
export type CriterionCoverageStatus = (typeof CRITERION_COVERAGE_STATUSES)[number];

export interface CoverageCriterionView {
  readonly criterionId: string;
  readonly nodeKey: string | null;
  readonly statement: string;
  readonly status: CriterionCoverageStatus;
}
export interface CoverageRequirementView {
  readonly criteria: readonly CoverageCriterionView[];
  readonly requirementId: string;
  readonly statement: string;
}
export interface CoverageContractView {
  readonly contractId: string;
  readonly gate1: "APPROVED" | "PENDING";
  readonly requirements: readonly CoverageRequirementView[];
  readonly revisionDigest: string;
  readonly revisionId: string;
}
export interface CoverageGoalView {
  readonly goalId: string;
  /** The latest committed decision on the goal, its run or one of its sealed nodes. */
  readonly lastActivityAt: string | null;
  readonly lifecycle: string | null;
  readonly planningRunRef: string | null;
  readonly title: string | null;
}
export interface CoverageSectionView {
  readonly cited: number;
  readonly heading: string;
  readonly number: string | null;
  readonly verified: number;
}
export interface CoverageTotals {
  readonly contracts: number;
  readonly criteria: number;
  readonly goals: number;
  readonly planned: number;
  readonly requirements: number;
  readonly verified: number;
}

export type DocumentCoverageOutcome =
  | {
    readonly status: "COVERAGE";
    readonly contracts: readonly CoverageContractView[];
    readonly document: {
      readonly byteLength: number | null;
      readonly contentSha256: string;
      readonly displayPath: string | null;
    };
    readonly goals: readonly CoverageGoalView[];
    /** The daemon's prose-derived section map; null when the document text was unreadable. */
    readonly sections: readonly CoverageSectionView[] | null;
    readonly totals: CoverageTotals;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

const VIEW_KEYS = ["contracts", "document", "goals", "outcome", "sections", "totals"] as const;
const TOTALS_KEYS = ["contracts", "criteria", "goals", "planned", "requirements", "verified"] as const;

function refused(code: string, layer: string): DocumentCoverageOutcome {
  return Object.freeze({ code, layer, status: "REFUSED" as const });
}
function errored(code: string, layer: string): DocumentCoverageOutcome {
  return Object.freeze({ code, layer, status: "ERROR" as const });
}
function invalidResponse(): DocumentCoverageOutcome {
  return errored(INVALID_RESPONSE_CODE, LIVE_COVERAGE_LAYER);
}

/** An own-enumerable EXACT-key snapshot (copied verbatim from live-planning-run.ts). */
function exactDataRecord(
  value: unknown, expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

/** The refusal envelopes this route can emit, each carried out at its own layer. */
function refusalFrom(response: unknown): DocumentCoverageOutcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED"
    && typeof route.code === "string" && typeof route.layer === "string") {
    return refused(route.code, route.layer);
  }
  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port.ok === false && port.outcome === "PORT_REFUSED"
    && typeof port.stage === "string") {
    const portCode = typeof port.refusal === "object" && port.refusal !== null
      ? Object.getOwnPropertyDescriptor(port.refusal, "code") : undefined;
    if (portCode !== undefined && "value" in portCode && typeof portCode.value === "string") {
      return refused(portCode.value, port.stage);
    }
  }
  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http === null || http.ok !== false || http.outcome !== "REFUSED"
    || typeof http.stage !== "string") return null;
  const runtimeError = typeof http.error === "object" && http.error !== null
    ? Object.getOwnPropertyDescriptor(http.error, "code") : undefined;
  return runtimeError !== undefined && "value" in runtimeError
    && typeof runtimeError.value === "string"
    ? refused(runtimeError.value, http.stage) : null;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Maps every item or returns null the moment one item fails its guard. */
function listOf<T>(value: unknown, itemOf: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const raw of value) {
    const item = itemOf(raw);
    if (item === null) return null;
    items.push(item);
  }
  return Object.freeze(items);
}

function criterionOf(value: unknown): CoverageCriterionView | null {
  const record = exactDataRecord(value, ["criterionId", "nodeKey", "statement", "status"]);
  if (record === null || !nonEmptyString(record.criterionId) || !nullableString(record.nodeKey)
    || typeof record.statement !== "string" || typeof record.status !== "string"
    || !(CRITERION_COVERAGE_STATUSES as readonly string[]).includes(record.status)) return null;
  return Object.freeze({
    criterionId: record.criterionId, nodeKey: record.nodeKey, statement: record.statement,
    status: record.status as CriterionCoverageStatus,
  });
}

function requirementOf(value: unknown): CoverageRequirementView | null {
  const record = exactDataRecord(value, ["criteria", "requirementId", "statement"]);
  if (record === null || !nonEmptyString(record.requirementId)
    || typeof record.statement !== "string") return null;
  const criteria = listOf(record.criteria, criterionOf);
  if (criteria === null) return null;
  return Object.freeze({ criteria, requirementId: record.requirementId, statement: record.statement });
}

function contractOf(value: unknown): CoverageContractView | null {
  const record = exactDataRecord(value, [
    "contractId", "gate1", "requirements", "revisionDigest", "revisionId",
  ]);
  if (record === null || !nonEmptyString(record.contractId) || !nonEmptyString(record.revisionId)
    || !nonEmptyString(record.revisionDigest)
    || (record.gate1 !== "APPROVED" && record.gate1 !== "PENDING")) return null;
  const requirements = listOf(record.requirements, requirementOf);
  if (requirements === null) return null;
  return Object.freeze({
    contractId: record.contractId, gate1: record.gate1, requirements,
    revisionDigest: record.revisionDigest, revisionId: record.revisionId,
  });
}

function goalOf(value: unknown): CoverageGoalView | null {
  const record = exactDataRecord(value, [
    "goalId", "lastActivityAt", "lifecycle", "planningRunRef", "title",
  ]);
  if (record === null || !nonEmptyString(record.goalId) || !nullableString(record.lifecycle)
    || !nullableString(record.lastActivityAt) || !nullableString(record.planningRunRef)
    || !nullableString(record.title)) return null;
  return Object.freeze({
    goalId: record.goalId, lastActivityAt: record.lastActivityAt, lifecycle: record.lifecycle,
    planningRunRef: record.planningRunRef, title: record.title,
  });
}

function sectionOf(value: unknown): CoverageSectionView | null {
  const record = exactDataRecord(value, ["cited", "heading", "number", "verified"]);
  if (record === null || !count(record.cited) || !count(record.verified)
    || typeof record.heading !== "string" || !nullableString(record.number)) return null;
  return Object.freeze({
    cited: record.cited, heading: record.heading, number: record.number, verified: record.verified,
  });
}

function totalsOf(value: unknown): CoverageTotals | null {
  const record = exactDataRecord(value, TOTALS_KEYS);
  if (record === null || !TOTALS_KEYS.every((key) => count(record[key]))) return null;
  return Object.freeze({
    contracts: record.contracts as number, criteria: record.criteria as number,
    goals: record.goals as number, planned: record.planned as number,
    requirements: record.requirements as number, verified: record.verified as number,
  });
}

/** Maps only an exact daemon COVERAGE frame; every other answer is REFUSED or ERROR. PURE. */
export function mapDocumentCoverageAnswer(status: number, response: unknown): DocumentCoverageOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, VIEW_KEYS);
  if (record === null || record.outcome !== "COVERAGE") return invalidResponse();
  const document = exactDataRecord(record.document, ["byteLength", "contentSha256", "displayPath"]);
  if (document === null || !nonEmptyString(document.contentSha256)
    || !(document.byteLength === null || count(document.byteLength))
    || !nullableString(document.displayPath)) return invalidResponse();
  const contracts = listOf(record.contracts, contractOf);
  const goals = listOf(record.goals, goalOf);
  const totals = totalsOf(record.totals);
  if (contracts === null || goals === null || totals === null) return invalidResponse();
  let sections: readonly CoverageSectionView[] | null;
  if (record.sections === null) {
    sections = null;
  } else {
    const advisory = exactDataRecord(record.sections, ["advisoryOnly", "entries"]);
    if (advisory === null || advisory.advisoryOnly !== true) return invalidResponse();
    sections = listOf(advisory.entries, sectionOf);
    if (sections === null) return invalidResponse();
  }
  return Object.freeze({
    contracts,
    document: Object.freeze({
      byteLength: document.byteLength as number | null,
      contentSha256: document.contentSha256,
      displayPath: document.displayPath,
    }),
    goals,
    sections,
    status: "COVERAGE" as const,
    totals,
  });
}

/** POSTs exactly { goalRef } and maps the answer; `post` is injectable for tests. */
export async function readDocumentCoverage(
  headers: Readonly<Record<string, string>>,
  goalRef: string,
  post?: (body: string) => Promise<Response>,
): Promise<DocumentCoverageOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(DOCUMENT_COVERAGE_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send(JSON.stringify({ goalRef }));
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_COVERAGE_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapDocumentCoverageAnswer(response.status, body);
}
