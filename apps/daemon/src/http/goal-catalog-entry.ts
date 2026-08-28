import { admitGoalBrief, decodeBoundedJsonBytes } from "@moe/contracts";
import type { StoredEvent } from "@moe/store";

import { documentSourceAggregateId } from "../documents/document-source-identifiers.js";

export const GOAL_CREATED_EVENT_TYPE = "GoalCreated" as const;

const LEGACY_GOAL_CREATED_KEYS = Object.freeze([
  "budgetAccountRef", "commandId", "goalId", "kind", "planningRunRef", "projectId",
  "version", "witness",
]);
const BRIEF_GOAL_CREATED_KEYS = Object.freeze(["brief", ...LEGACY_GOAL_CREATED_KEYS]);
const SOURCE_GOAL_CREATED_KEYS = Object.freeze(["binding", ...BRIEF_GOAL_CREATED_KEYS]);
const BINDING_KEYS = Object.freeze([
  "byteLength", "contentSha256", "sourceAggregateId", "sourceRef",
]);
const PROJECT_READY_KEYS = Object.freeze(["projectReadyRef", "truthClass"]);
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

type JsonRecord = Readonly<Record<string, unknown>>;
type ShapedEntry = Readonly<{
  brief: GoalCatalogEntry["brief"];
  fact: JsonRecord;
  sourceBound: boolean;
}>;

export interface GoalCatalogEntry {
  /** The normalized brief the writer stamped, or `null` for a legacy brief-unknown row. */
  readonly brief: { readonly instructions: string; readonly title: string } | null;
  readonly goalId: string;
  readonly planningRunRef: string;
}

type EntryCode = "GOAL_CATALOG_READ_MALFORMED" | "GOAL_CATALOG_READ_PROJECT_MISMATCH";

export type GoalCatalogEntryResult =
  | { readonly entry: GoalCatalogEntry; readonly ok: true }
  | { readonly code: EntryCode; readonly ok: false };

function refused(code: EntryCode): GoalCatalogEntryResult {
  return Object.freeze({ code, ok: false as const });
}

function recordOf(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null ? value as JsonRecord : null;
}

function exact(value: unknown, keys: readonly string[]): value is JsonRecord {
  const record = recordOf(value);
  return record !== null && Object.keys(record).length === keys.length
    && keys.every((key) => Object.hasOwn(record, key));
}

const nonEmptyRef = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function admittedBrief(value: unknown): GoalCatalogEntry["brief"] | undefined {
  const admitted = admitGoalBrief(value);
  if (!admitted.ok) return undefined;
  const stored = recordOf(value);
  if (stored === null || stored["instructions"] !== admitted.brief.instructions
    || stored["title"] !== admitted.brief.title) return undefined;
  return Object.freeze({
    instructions: admitted.brief.instructions, title: admitted.brief.title,
  });
}

function bindingIsValid(value: unknown, projectId: string): boolean {
  if (!exact(value, BINDING_KEYS)) return false;
  const byteLength = value["byteLength"];
  const contentSha256 = value["contentSha256"];
  const sourceAggregateId = value["sourceAggregateId"];
  const sourceRef = value["sourceRef"];
  return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0
    && typeof contentSha256 === "string" && LOWER_HEX_64.test(contentSha256)
    && nonEmptyRef(sourceAggregateId) && nonEmptyRef(sourceRef)
    && sourceAggregateId === documentSourceAggregateId(projectId, contentSha256, sourceRef);
}

function ordinaryShape(
  fact: unknown,
): ShapedEntry | null {
  const briefBearing = exact(fact, BRIEF_GOAL_CREATED_KEYS);
  if (!briefBearing && !exact(fact, LEGACY_GOAL_CREATED_KEYS)) return null;
  const brief = briefBearing ? admittedBrief(fact["brief"]) : null;
  return brief === undefined ? null : { brief, fact, sourceBound: false };
}

function sourceShape(fact: unknown): ShapedEntry | null {
  if (!exact(fact, SOURCE_GOAL_CREATED_KEYS)) return null;
  const brief = admittedBrief(fact["brief"]);
  return brief === undefined ? null : { brief, fact, sourceBound: true };
}

function shapeOf(
  fact: unknown, commandKind: string,
): ShapedEntry | null {
  const source = sourceShape(fact);
  if (source !== null) return commandKind === "goal.create_with_source" ? source : null;
  return commandKind === "goal.create" ? ordinaryShape(fact) : null;
}

function identityIsValid(event: StoredEvent, fact: JsonRecord): boolean {
  const witness = fact["witness"];
  return exact(witness, PROJECT_READY_KEYS)
    && nonEmptyRef(witness["projectReadyRef"])
    && (witness["truthClass"] === "DAEMON_VERIFIED"
      || witness["truthClass"] === "HUMAN_APPROVED")
    && nonEmptyRef(fact["budgetAccountRef"])
    && nonEmptyRef(fact["goalId"])
    && nonEmptyRef(fact["planningRunRef"])
    && nonEmptyRef(fact["projectId"])
    && fact["goalId"] === event.aggregateId;
}

export function decodeGoalCatalogEntry(
  event: StoredEvent, projectId: string,
): GoalCatalogEntryResult {
  const trace = event.decisionTrace;
  if (trace === undefined || event.aggregateSequence !== 1) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  if (trace.projectId !== projectId) return refused("GOAL_CATALOG_READ_PROJECT_MISMATCH");
  const decoded = decodeBoundedJsonBytes(event.payload);
  if (!decoded.ok || !Array.isArray(decoded.value) || decoded.value.length !== 1) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  const shaped = shapeOf(decoded.value[0], trace.commandKind);
  if (shaped === null || shaped.fact["kind"] !== GOAL_CREATED_EVENT_TYPE
    || shaped.fact["version"] !== 1 || shaped.fact["commandId"] !== trace.commandId
    || !identityIsValid(event, shaped.fact)) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  if (shaped.fact["projectId"] !== projectId) {
    return refused("GOAL_CATALOG_READ_PROJECT_MISMATCH");
  }
  if (shaped.sourceBound && !bindingIsValid(shaped.fact["binding"], projectId)) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  return Object.freeze({
    entry: Object.freeze({
      brief: shaped.brief,
      goalId: shaped.fact["goalId"] as string,
      planningRunRef: shaped.fact["planningRunRef"] as string,
    }),
    ok: true as const,
  });
}
