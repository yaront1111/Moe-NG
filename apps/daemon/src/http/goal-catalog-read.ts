/** A bounded catalog of goals this daemon can prove from its own durable GoalCreated rows. */
import { admitGoalBrief, decodeBoundedJsonBytes } from "@moe/contracts";
import type { GoalBrief } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { isCanonicalText, isIngestMediaType } from "../documents/document-source-codec.js";
import {
  MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES,
} from "../documents/document-source-contract.js";
import type { DocumentIngestMediaType } from "../documents/document-source-contract.js";
import { goalDocumentSourceAggregateId } from "../goals/goal-document-identifiers.js";
import { authenticateHttpRequest } from "./http-adapter.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const GOAL_CATALOG_READ_PATH = "/goals/read" as const;
export const MAX_GOAL_CATALOG_ROWS = 256 as const;

const GOAL_CATALOG_READ_LAYER = "GOAL_CATALOG_READ" as const;
const GOAL_CATALOG_RESPONSE_ROWS = 32;
const GOAL_CATALOG_EVENT_BYTES = 1 * 1_024 * 1_024;
const GOAL_CREATED_EVENT_TYPE = "GoalCreated";
const LEGACY_GOAL_CREATED_KEYS = Object.freeze([
  "budgetAccountRef", "commandId", "goalId", "kind", "planningRunRef", "projectId",
  "version", "witness",
]);
const GOAL_CREATED_KEYS = Object.freeze([
  "brief", ...LEGACY_GOAL_CREATED_KEYS, "prd",
]);
const PROJECT_READY_KEYS = Object.freeze(["projectReadyRef", "truthClass"]);
const GOAL_PRD_KEYS = Object.freeze([
  "byteLength", "contentSha256", "displayPath", "mediaType", "sourceRef",
]);
const SHA256 = /^[0-9a-f]{64}$/u;

export const GOAL_CATALOG_READ_CODES = Object.freeze([
  "GOAL_CATALOG_READ_CAPABILITY_DENIED",
  "GOAL_CATALOG_READ_LIMIT_EXCEEDED",
  "GOAL_CATALOG_READ_MALFORMED",
  "GOAL_CATALOG_READ_PROJECT_MISMATCH",
  "GOAL_CATALOG_READ_UNREADABLE",
] as const);

export type GoalCatalogReadCode = (typeof GOAL_CATALOG_READ_CODES)[number];

export interface GoalCatalogEntry {
  readonly brief: GoalBrief | null;
  readonly goalId: string;
  readonly planningRunRef: string;
  readonly prd: GoalCatalogPrd | null;
}

export interface GoalCatalogPrd {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly displayPath: string;
  readonly mediaType: DocumentIngestMediaType;
  readonly sourceRef: string;
}

export interface GoalCatalogView {
  readonly goals: readonly GoalCatalogEntry[];
  readonly nextCursor: string | null;
  /** Last GoalCreated global position observed, including on a terminal page. */
  readonly observedCursor: string;
  readonly outcome: "GOALS";
}

export interface GoalCatalogRefused {
  readonly code: GoalCatalogReadCode;
  readonly layer: typeof GOAL_CATALOG_READ_LAYER;
  readonly outcome: "REFUSED";
}

export type GoalCatalogReadResult = GoalCatalogRefused | GoalCatalogView;

export interface GoalCatalogPageRequest {
  readonly after: bigint;
  readonly limit: number;
}

export interface GoalCatalogReadPort {
  readonly boundProjectId: string;
  readGoals(request: GoalCatalogPageRequest): GoalCatalogReadResult;
}

const DEFAULT_PAGE_REQUEST: GoalCatalogPageRequest = Object.freeze({
  after: 0n,
  limit: GOAL_CATALOG_RESPONSE_ROWS,
});
const MAX_GLOBAL_POSITION = 9_223_372_036_854_775_807n;
const CURSOR = /^(?:0|[1-9][0-9]{0,18})$/u;

function refused(code: GoalCatalogReadCode): GoalCatalogRefused {
  return Object.freeze({ code, layer: GOAL_CATALOG_READ_LAYER, outcome: "REFUSED" as const });
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function exact(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  const record = objectOf(value);
  if (record === null) return false;
  return Object.keys(record).length === keys.length
    && keys.every((key) => Object.hasOwn(record, key));
}

const nonEmptyRef = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function goalPrd(
  store: SqliteEventStore,
  value: unknown,
  projectId: string,
  goalId: string,
): GoalCatalogPrd | null | GoalCatalogRefused {
  if (value === null) return null;
  if (!exact(value, GOAL_PRD_KEYS)) return refused("GOAL_CATALOG_READ_MALFORMED");
  const { byteLength, contentSha256, displayPath, mediaType, sourceRef } = value;
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 1
    || (byteLength as number) > MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES
    || !nonEmptyRef(contentSha256) || !SHA256.test(contentSha256)
    || !isCanonicalText(displayPath, true) || displayPath.length > 256
    || !isIngestMediaType(mediaType)
    || !nonEmptyRef(sourceRef)
    || sourceRef !== goalDocumentSourceAggregateId(projectId, goalId, contentSha256)) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  if (store.getAggregateVersion(sourceRef) !== 1) {
    return refused("GOAL_CATALOG_READ_UNREADABLE");
  }
  // GoalCreated and this goal-bound source were committed as decision legs in
  // one transaction. The aggregate-version check proves the immutable source
  // leg is still present. Materializing and re-hashing up to 128 KiB of source
  // text per card belongs to the dedicated source read, not to a metadata page.
  return Object.freeze({
    byteLength: byteLength as number,
    contentSha256,
    displayPath,
    mediaType,
    sourceRef,
  });
}

function goalEntry(
  store: SqliteEventStore, event: StoredEvent, projectId: string,
): GoalCatalogEntry | GoalCatalogRefused {
  const trace = event.decisionTrace;
  if (trace === undefined) return refused("GOAL_CATALOG_READ_MALFORMED");
  if (trace.projectId !== projectId) return refused("GOAL_CATALOG_READ_PROJECT_MISMATCH");
  if (trace.commandKind !== "goal.create" || event.aggregateSequence !== 1) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  const decoded = decodeBoundedJsonBytes(event.payload);
  if (!decoded.ok || !Array.isArray(decoded.value) || decoded.value.length !== 1) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  const fact = decoded.value[0];
  const current = exact(fact, GOAL_CREATED_KEYS);
  if ((!current && !exact(fact, LEGACY_GOAL_CREATED_KEYS))
    || fact["kind"] !== GOAL_CREATED_EVENT_TYPE
    || fact["version"] !== 1 || fact["commandId"] !== trace.commandId) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  const witness = fact["witness"];
  if (!exact(witness, PROJECT_READY_KEYS)
    || !nonEmptyRef(witness["projectReadyRef"])
    || (witness["truthClass"] !== "DAEMON_VERIFIED"
      && witness["truthClass"] !== "HUMAN_APPROVED")
    || !nonEmptyRef(fact["budgetAccountRef"]) || !nonEmptyRef(fact["goalId"])
    || !nonEmptyRef(fact["planningRunRef"]) || !nonEmptyRef(fact["projectId"])) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  if (fact["projectId"] !== projectId) return refused("GOAL_CATALOG_READ_PROJECT_MISMATCH");
  if (fact["goalId"] !== event.aggregateId) return refused("GOAL_CATALOG_READ_MALFORMED");
  if (!current) {
    return Object.freeze({
      brief: null, goalId: fact["goalId"], planningRunRef: fact["planningRunRef"], prd: null,
    });
  }
  const brief = admitGoalBrief(fact["brief"]);
  if (!brief.ok
    || (fact["brief"] as Readonly<Record<string, unknown>>)["title"] !== brief.brief.title
    || (fact["brief"] as Readonly<Record<string, unknown>>)["instructions"] !== brief.brief.instructions) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  const prd = goalPrd(store, fact["prd"], projectId, fact["goalId"]);
  if (prd !== null && "code" in prd) return prd;
  return Object.freeze({
    brief: brief.brief,
    goalId: fact["goalId"],
    planningRunRef: fact["planningRunRef"],
    prd,
  });
}

export function readGoalCatalog(
  store: SqliteEventStore,
  projectId: string,
  request: GoalCatalogPageRequest = DEFAULT_PAGE_REQUEST,
): GoalCatalogReadResult {
  try {
    if (typeof request.after !== "bigint" || request.after < 0n
      || request.after > MAX_GLOBAL_POSITION
      || !Number.isSafeInteger(request.limit) || request.limit < 1
      || request.limit > MAX_GOAL_CATALOG_ROWS) {
      return refused("GOAL_CATALOG_READ_LIMIT_EXCEEDED");
    }
    if (store.getHealth().projectId !== projectId) {
      return refused("GOAL_CATALOG_READ_PROJECT_MISMATCH");
    }
    const effectiveLimit = Math.min(request.limit, GOAL_CATALOG_RESPONSE_ROWS);
    const page = store.readEventsByTypeAfter(
      GOAL_CREATED_EVENT_TYPE, request.after, effectiveLimit, GOAL_CATALOG_EVENT_BYTES,
    );
    if (page.items.length > effectiveLimit) return refused("GOAL_CATALOG_READ_UNREADABLE");
    let observedPosition = request.after;
    for (const event of page.items) {
      if (event.globalPosition <= observedPosition) {
        return refused("GOAL_CATALOG_READ_UNREADABLE");
      }
      observedPosition = event.globalPosition;
    }
    if (page.hasMore && (page.items.length === 0 || page.nextCursor !== observedPosition)) {
      return refused("GOAL_CATALOG_READ_UNREADABLE");
    }
    const goals: GoalCatalogEntry[] = [];
    const goalIds = new Set<string>();
    for (const event of page.items) {
      const entry = goalEntry(store, event, projectId);
      if ("code" in entry) return entry;
      if (goalIds.has(entry.goalId)) return refused("GOAL_CATALOG_READ_MALFORMED");
      goalIds.add(entry.goalId);
      goals.push(entry);
    }
    return Object.freeze({
      goals: Object.freeze(goals),
      nextCursor: page.hasMore ? observedPosition.toString() : null,
      observedCursor: observedPosition.toString(),
      outcome: "GOALS" as const,
    });
  } catch {
    return refused("GOAL_CATALOG_READ_UNREADABLE");
  }
}

export function createGoalCatalogReadPort(config: {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): GoalCatalogReadPort {
  return Object.freeze({
    boundProjectId: config.projectId,
    readGoals: (request: GoalCatalogPageRequest): GoalCatalogReadResult =>
      readGoalCatalog(config.store, config.projectId, request),
  });
}

type GoalCatalogListenerCode =
  | "LISTENER_GOAL_CATALOG_REQUEST_INVALID"
  | "LISTENER_GOAL_CATALOG_UNAVAILABLE";

export type GoalCatalogReadDispatch =
  | { readonly body: HttpPortRefused | HttpRefused | GoalCatalogReadResult;
      readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: GoalCatalogListenerCode; readonly kind: "LISTENER_REFUSAL" };

function pageRequest(body: unknown): GoalCatalogPageRequest | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return null;
  const record = objectOf(decoded.value);
  if (record === null) return null;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "after" && key !== "limit")) return null;
  const afterValue = record["after"];
  const limitValue = record["limit"];
  if (afterValue !== undefined && (typeof afterValue !== "string" || !CURSOR.test(afterValue))) {
    return null;
  }
  if (limitValue !== undefined && (!Number.isSafeInteger(limitValue)
    || (limitValue as number) < 1 || (limitValue as number) > MAX_GOAL_CATALOG_ROWS)) {
    return null;
  }
  const after = afterValue === undefined ? 0n : BigInt(afterValue as string);
  if (after > MAX_GLOBAL_POSITION) return null;
  return Object.freeze({
    after,
    limit: limitValue === undefined ? GOAL_CATALOG_RESPONSE_ROWS : limitValue as number,
  });
}

export function handleGoalCatalogReadRequest(
  dependencies: { readonly authenticator: Authenticator;
    readonly goalCatalog?: GoalCatalogReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null;
    readonly protocolVersion: unknown },
): GoalCatalogReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  }
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({ body: refused("GOAL_CATALOG_READ_CAPABILITY_DENIED"),
      httpStatus: 200, kind: "REPLY" });
  }
  if (dependencies.goalCatalog === undefined) {
    return Object.freeze({ code: "LISTENER_GOAL_CATALOG_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  if (access.principal.projectId !== dependencies.goalCatalog.boundProjectId) {
    return Object.freeze({ body: refused("GOAL_CATALOG_READ_PROJECT_MISMATCH"),
      httpStatus: 200, kind: "REPLY" });
  }
  const page = pageRequest(request.body);
  if (page === null) {
    return Object.freeze({ code: "LISTENER_GOAL_CATALOG_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  return Object.freeze({
    body: dependencies.goalCatalog.readGoals(page), httpStatus: 200, kind: "REPLY",
  });
}
