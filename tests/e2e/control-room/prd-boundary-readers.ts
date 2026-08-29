/**
 * The PRODUCTION read-back surfaces the PRD-boundary journey is graded against.
 *
 * WHY A SIBLING MODULE. `prd-persistence-boundary.spec.ts` already carries its
 * QA-verified select/Cancel arms and their zero-write counter; the atomic-bind
 * arms need three READERS that none of those arms needed. Keeping the readers
 * here leaves every delivered byte of that spec untouched while the new arms
 * stay where the reviewer asked for them.
 *
 * NOTHING HERE RE-DERIVES A DURABLE IDENTIFIER. The source aggregate id, the
 * source ref and the content digest are all taken from what the PRODUCTION goal
 * reader RETURNED and handed straight back to the PRODUCTION document reader. A
 * helper that recomputed `documentSourceRef` would be asserting a property
 * against its own reimplementation, and would stay green against a producer and
 * a reader that had drifted apart together.
 */
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import { readWireProtocolVersion } from "./daemon-scratch.js";

/** One durable event, reduced to the facts the atomicity claim rests on. */
export interface DecisionBoundEvent {
  readonly aggregateId: string;
  readonly commandId: string;
  /** The wire kind on the decision trace, or null for an untraced row. */
  readonly commandKind: string | null;
  readonly eventType: string;
}

/** The binding the PRODUCTION goal catalog projects for a source-bound goal. */
export interface CatalogBinding {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly sourceAggregateId: string;
  readonly sourceRef: string;
}

export interface CatalogGoal {
  readonly binding: CatalogBinding | null;
  readonly brief: { readonly instructions: string; readonly title: string } | null;
  readonly goalId: string;
}

/** `/goals/read`'s answer, kept in its two shapes so a refusal is never read as an empty page. */
export type CatalogAnswer =
  | { readonly goals: readonly CatalogGoal[]; readonly outcome: "GOALS" }
  | { readonly code: string; readonly layer: string; readonly outcome: "REFUSED" }
  | { readonly outcome: "UNREADABLE"; readonly detail: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bindingOf(value: unknown): CatalogBinding | null {
  if (!isRecord(value)) return null;
  const { byteLength, contentSha256, sourceAggregateId, sourceRef } = value;
  return typeof byteLength === "number" && typeof contentSha256 === "string"
    && typeof sourceAggregateId === "string" && typeof sourceRef === "string"
    ? { byteLength, contentSha256, sourceAggregateId, sourceRef }
    : null;
}

function briefOf(value: unknown): CatalogGoal["brief"] {
  if (!isRecord(value)) return null;
  const { instructions, title } = value;
  return typeof instructions === "string" && typeof title === "string"
    ? { instructions, title }
    : null;
}

function goalsOf(value: unknown): readonly CatalogGoal[] {
  if (!isRecord(value) || !Array.isArray(value["goals"])) return [];
  return (value["goals"] as readonly unknown[]).flatMap((row): CatalogGoal[] => {
    if (!isRecord(row) || typeof row["goalId"] !== "string") return [];
    return [{
      binding: bindingOf(row["binding"]),
      brief: briefOf(row["brief"]),
      goalId: row["goalId"],
    }];
  });
}

/**
 * Reads the goal catalog through the daemon's REAL `/goals/read` route, with the
 * operator credential the lane started the daemon under.
 *
 * The answer is classified, never coerced: a REFUSED body keeps its exact code
 * and layer so an arm can pin them, and an unreadable answer is its own outcome.
 * Collapsing either into an empty page would let a dark catalog read as "this
 * goal is simply not there".
 */
export async function readGoalCatalogOverHttp(
  origin: string, repositoryRoot: string, credential: string, csrfToken: string,
): Promise<CatalogAnswer> {
  const protocolVersion = await readWireProtocolVersion(repositoryRoot);
  if (protocolVersion === null) {
    return { detail: "E2E_WIRE_PROTOCOL_VERSION_UNREADABLE", outcome: "UNREADABLE" };
  }
  // `origin` is not optional decoration: `checkHeaders` refuses an ABSENT Origin
  // exactly as it refuses a foreign one (LISTENER_ORIGIN_INVALID -> 403), because
  // a missing Origin is not a safe default for a state-changing request. A Node
  // fetch sends none unless it is stated here.
  const response = await fetch(`${origin}/goals/read`, {
    body: "{}",
    headers: {
      "content-type": "application/json",
      origin,
      "x-moe-csrf": csrfToken,
      "x-moe-protocol-version": protocolVersion,
      "x-moe-session-credential": credential,
    },
    method: "POST",
  });
  if (response.status !== 200) {
    return { detail: `E2E_GOAL_CATALOG_HTTP_${String(response.status)}`, outcome: "UNREADABLE" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { detail: "E2E_GOAL_CATALOG_BODY_UNREADABLE", outcome: "UNREADABLE" };
  }
  if (!isRecord(body)) {
    return { detail: "E2E_GOAL_CATALOG_BODY_NOT_A_RECORD", outcome: "UNREADABLE" };
  }
  if (body["outcome"] === "REFUSED") {
    return {
      code: String(body["code"] ?? ""), layer: String(body["layer"] ?? ""), outcome: "REFUSED",
    };
  }
  if (body["outcome"] !== "GOALS") {
    return { detail: `E2E_GOAL_CATALOG_OUTCOME_${String(body["outcome"])}`, outcome: "UNREADABLE" };
  }
  return { goals: goalsOf(body), outcome: "GOALS" };
}

/**
 * The durable rows appended strictly after `afterPosition`, with the decision
 * identity each one was committed under.
 *
 * The commandId is read off the STORED EVENT, not recomputed, so "these two rows
 * are the same decision" is the store's own answer rather than this file's.
 */
export function eventsCommittedAfter(
  storePath: string, projectId: string, afterPosition: bigint, limit: number,
): readonly DecisionBoundEvent[] {
  const store = SqliteEventStore.openForProject(storePath, projectId);
  try {
    const page = store.readEventsAfter(afterPosition, limit);
    if (page.hasMore) {
      throw new Error(`E2E_EVENT_PAGE_TRUNCATED: limit=${String(limit)}`);
    }
    return page.items.map((event) => ({
      aggregateId: event.aggregateId,
      commandId: event.commandId,
      commandKind: event.decisionTrace?.commandKind ?? null,
      eventType: event.eventType,
    }));
  } finally {
    store.close();
  }
}

/** What the daemon's own document-source reader answered for one content address. */
export type SourceReadBack =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly kind: "VIEW"; readonly view: Readonly<Record<string, unknown>> }
  | { readonly kind: "UNLOADABLE"; readonly detail: string };

type SourceReader = (
  store: unknown, projectId: string, contentSha256: string, sourceRef?: string,
) => unknown;

/**
 * Loads `readDocumentSourceView` — the daemon's OWN document-source reader — from
 * its committed `.js` bridge and runs it against this lane's real store.
 *
 * BY FILE URL, not by import specifier, for the reason `readWireProtocolVersion`
 * documents: this directory's tsconfig cannot reach `apps/` or `packages/`
 * (TS6059), and `@moe/daemon` publishes only its root barrel, which does not
 * re-export this module. Loading the bridge is what keeps the read-back on the
 * PRODUCTION reader instead of a decoder written here — a hand-rolled decoder
 * would happily "find" a source the daemon itself could not resolve.
 */
export async function readSourceThroughProduction(
  repositoryRoot: string,
  storePath: string,
  projectId: string,
  contentSha256: string,
  sourceRef: string,
): Promise<SourceReadBack> {
  const bridge = join(
    repositoryRoot, "apps", "daemon", "src", "documents", "document-source-read.js",
  );
  const href = new URL(`file:///${bridge.replaceAll("\\", "/")}`).href;
  let loaded: { readonly readDocumentSourceView?: unknown };
  try {
    loaded = await import(href) as { readonly readDocumentSourceView?: unknown };
  } catch (error) {
    return { detail: `E2E_SOURCE_READER_IMPORT_FAILED: ${String(error)}`, kind: "UNLOADABLE" };
  }
  const read = loaded.readDocumentSourceView;
  if (typeof read !== "function") {
    return { detail: "E2E_SOURCE_READER_MISSING_EXPORT", kind: "UNLOADABLE" };
  }
  const store = SqliteEventStore.openForProject(storePath, projectId);
  try {
    const answered: unknown = (read as SourceReader)(store, projectId, contentSha256, sourceRef);
    if (!isRecord(answered)) {
      return { detail: "E2E_SOURCE_READER_ANSWER_NOT_A_RECORD", kind: "UNLOADABLE" };
    }
    if (answered["kind"] === "ABSENT") return { kind: "ABSENT" };
    if (answered["kind"] === "REFUSED") {
      const refusal = answered["refusal"];
      return {
        code: isRecord(refusal) ? String(refusal["code"] ?? "") : "",
        kind: "REFUSED",
        layer: isRecord(refusal) ? String(refusal["layer"] ?? "") : "",
      };
    }
    const view = answered["view"];
    return isRecord(view)
      ? { kind: "VIEW", view }
      : { detail: "E2E_SOURCE_READER_VIEW_NOT_A_RECORD", kind: "UNLOADABLE" };
  } finally {
    store.close();
  }
}
