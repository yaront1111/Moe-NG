/**
 * The FULL PRD text a goal binds, served for the planning seam — the dossier's
 * `readDocumentSourceView` deliberately returns a bounded 4KiB excerpt, which
 * cannot carry a real PRD (the record admits up to 128KiB), so the compiler's
 * reader is its own projection with the same integrity discipline. The goal's
 * binding is admitted through `decodeGoalCatalogEntry` — the production catalog
 * admission, decision-trace-bound to `goal.create_with_source`, aggregate id
 * re-derived from (projectId, sha, ref) — and the stored record is re-decoded and
 * re-hashed by the codec, so the ONLY way text leaves is if every side agrees.
 * A goal the store does not hold, a goal without a source binding, and any
 * integrity disagreement all fail closed with their own code.
 */
import type { SqliteEventStore } from "@moe/store";

import { decodeDocumentSourceRecord } from "./document-source-codec.js";
import { decodeGoalCatalogEntry } from "../http/goal-catalog-entry.js";
import { copyFixedBytes, exactDataArray, exactDataRecord } from "./document-work-safe-value.js";

const LAYER = "DAEMON_READ_MODEL";
const PAGE_KEYS = Object.freeze(["hasMore", "items", "nextCursor"]);

export const GOAL_SOURCE_READ_CODES = Object.freeze([
  "GOAL_SOURCE_READ_MALFORMED",
  "GOAL_SOURCE_UNBOUND",
  "GOAL_SOURCE_INVALID",
] as const);
export type GoalSourceReadCode = (typeof GOAL_SOURCE_READ_CODES)[number];

export interface GoalSourceText {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly displayPath: string;
  readonly mediaType: string;
  readonly ok: true;
  readonly sourceRef: string;
  readonly text: string;
}
export interface GoalSourceReadRefused {
  readonly code: GoalSourceReadCode;
  readonly layer: string;
  readonly ok: false;
}
export type GoalSourceReadResult = GoalSourceText | GoalSourceReadRefused;

export interface GoalSourceReadPort {
  read(goalRef: unknown): GoalSourceReadResult;
}

function refused(code: GoalSourceReadCode): GoalSourceReadRefused {
  return Object.freeze({ code, layer: LAYER, ok: false });
}

function eventPayloadBytes(event: unknown): Uint8Array | null {
  if (typeof event !== "object" || event === null) return null;
  return copyFixedBytes((event as { payload?: unknown }).payload);
}

function firstAggregateEvent(store: SqliteEventStore, aggregateId: string): unknown {
  const page = exactDataRecord(store.readAggregateEvents(aggregateId, 0, 1), PAGE_KEYS);
  const items = page === null ? null : exactDataArray(page["items"]);
  if (items === null || items.length !== 1) return null;
  return items[0];
}

/** Reads the goal's GoalCreated event, admits it through the production catalog
 *  decoder, then the full source record its binding names — fresh per call. */
export function createGoalSourceReadPort(options: {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): GoalSourceReadPort {
  const read = (goalRef: unknown): GoalSourceReadResult => {
    if (typeof goalRef !== "string" || goalRef.length === 0 || goalRef.length > 512) {
      return refused("GOAL_SOURCE_READ_MALFORMED");
    }
    const event = firstAggregateEvent(options.store, goalRef);
    if (event === null) return refused("GOAL_SOURCE_UNBOUND");
    const decoded = decodeGoalCatalogEntry(
      event as Parameters<typeof decodeGoalCatalogEntry>[0], options.projectId,
    );
    if (!decoded.ok || decoded.entry.goalId !== goalRef) {
      return refused("GOAL_SOURCE_UNBOUND");
    }
    const binding = decoded.entry.binding;
    if (binding === null) return refused("GOAL_SOURCE_UNBOUND");

    // The catalog admission already re-derived binding.sourceAggregateId from
    // (projectId, contentSha256, sourceRef); the codec below re-derives the sha
    // and byte length from the stored text itself.
    const version = options.store.getAggregateVersion(binding.sourceAggregateId);
    if (!Number.isSafeInteger(version) || version < 1) return refused("GOAL_SOURCE_INVALID");
    const page = exactDataRecord(
      options.store.readAggregateEvents(binding.sourceAggregateId, version - 1, 1), PAGE_KEYS,
    );
    const items = page === null ? null : exactDataArray(page["items"]);
    if (items === null || items.length !== 1) return refused("GOAL_SOURCE_INVALID");
    const payload = eventPayloadBytes(items[0]);
    if (payload === null) return refused("GOAL_SOURCE_INVALID");
    const record = decodeDocumentSourceRecord(payload);
    if (record === null || record.contentSha256 !== binding.contentSha256
      || record.byteLength !== binding.byteLength) {
      return refused("GOAL_SOURCE_INVALID");
    }
    return Object.freeze({
      byteLength: record.byteLength,
      contentSha256: record.contentSha256,
      displayPath: record.displayPath,
      mediaType: record.mediaType,
      ok: true as const,
      sourceRef: binding.sourceRef,
      text: record.text,
    });
  };
  return Object.freeze({ read });
}
