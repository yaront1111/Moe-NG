/**
 * "What is the current active graph for this project?" — answered from durable
 * graph-revision events, or refused.
 *
 * WHAT THIS MODULE DOES NOT DO, which is most of what it looks like it does.
 * Lifecycle transitions, duplicate delivery, event ordering and identity
 * conflicts are ALL owned by `replayGraphRevisionEvents` in `@moe/core`. This
 * module hands each aggregate's raw history to that function and takes the state
 * it returns. It has no opinion about whether a history is well-ordered, and it
 * must never grow one: a local copy of those rules would drift from the core's,
 * and the tests would then police the copy rather than the authority.
 *
 * The same discipline applies to identity and to the epoch. Content bytes are
 * validated only by `decodeGraphContent` (via the body record), and `graphEpoch`
 * is a BOUND REFERENCE to the goal-owned epoch — the contract says
 * `goal.activate_initial_graph` is the only authority that advances one — so it
 * is REPORTED here, never computed, incremented or defaulted.
 *
 * SPLIT-BRAIN REFUSES RATHER THAN RESOLVES. Two ACTIVE revisions for one project
 * is exactly the condition a current-graph reader exists to detect. Disambiguating
 * by epoch or recency would hand out authority during the one situation where
 * nobody should have it, so it is a refusal with its own code.
 */

import { CORE_GRAPH_REVISION_REPLAY, replayGraphRevisionEvents } from "@moe/core";
import type { GraphRevisionReplayCode, GraphRevisionState } from "@moe/core";
import type { GraphRevisionContent, GraphSnapshot } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { GRAPH_BODY_RECORD_LAYER, readGraphBody } from "./graph-body-record.js";
import type { GraphBodyRefusal } from "./graph-body-record.js";

/** Names the layer that answered the caller. */
export const ACTIVE_GRAPH_PROJECTION_LAYER = "ACTIVE_GRAPH_PROJECTION" as const;

/** How many stored events one enumeration page carries. */
const ENUMERATION_PAGE = 200;

/**
 * Refusals this module originates. Codes passed through from the core replay keep
 * their own spelling and are deliberately NOT merged in here — a caller can tell
 * the two apart by prefix, and merging would let a core change silently widen
 * this module's contract.
 */
export const ACTIVE_GRAPH_PROJECTION_CODES = Object.freeze([
  "ACTIVE_GRAPH_ABSENT",
  "ACTIVE_GRAPH_BODY_UNAVAILABLE",
  "ACTIVE_GRAPH_SPLIT_BRAIN",
] as const);

export type ActiveGraphProjectionCode = (typeof ACTIVE_GRAPH_PROJECTION_CODES)[number];

export type ActiveGraphSourceLayer =
  | typeof CORE_GRAPH_REVISION_REPLAY
  | typeof GRAPH_BODY_RECORD_LAYER;

export interface ActiveGraphRefusal {
  readonly code: ActiveGraphProjectionCode | GraphRevisionReplayCode;
  readonly layer: typeof ACTIVE_GRAPH_PROJECTION_LAYER;
  readonly ok: false;
  /** The underlying code when this module is wrapping another layer's refusal. */
  readonly sourceCode: GraphBodyRefusal["code"] | null;
  /** The layer that actually refused, or `null` when this module did. */
  readonly sourceLayer: ActiveGraphSourceLayer | null;
}

export interface ActiveGraphProvenance {
  /** The aggregate the epoch and identity were read from. */
  readonly aggregateId: string;
  readonly goalRef: string;
}

export interface ActiveGraphAccepted {
  readonly content: GraphRevisionContent;
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly ok: true;
  readonly planHash: string;
  readonly provenance: ActiveGraphProvenance;
  readonly revisionId: string;
  readonly snapshot: GraphSnapshot;
  readonly snapshotIdentity: string;
}

export type ActiveGraphResult = ActiveGraphAccepted | ActiveGraphRefusal;

interface ActiveRevision {
  readonly aggregateId: string;
  readonly state: GraphRevisionState;
}

function refuse(
  code: ActiveGraphProjectionCode | GraphRevisionReplayCode,
  sourceLayer: ActiveGraphSourceLayer | null = null,
  sourceCode: GraphBodyRefusal["code"] | null = null,
): ActiveGraphRefusal {
  return Object.freeze({
    code,
    layer: ACTIVE_GRAPH_PROJECTION_LAYER,
    ok: false as const,
    sourceCode,
    sourceLayer,
  });
}

/** One aggregate per (project, revision). */
export function graphRevisionAggregateId(projectId: string, revisionId: string): string {
  return `graph-revision:${projectId}:${revisionId}`;
}

/**
 * Discover every revision aggregate by its AGGREGATE ID PREFIX, over all stored
 * events, not by any single event kind.
 *
 * Keying discovery on `GraphRevisionCreated` was a real defect: an aggregate
 * whose create event is absent — a genuinely corrupt durable history — was never
 * enumerated, so it never reached the replay, and the projection answered
 * `ACTIVE_GRAPH_ABSENT`: the SAME answer a clean empty project gives. A corrupt
 * history and an absent one became indistinguishable, which is exactly what this
 * projection exists to prevent. Enumerating by prefix means a history cannot
 * escape by lacking any particular event; the replay then answers with its own
 * `GRAPH_REVISION_REPLAY_MISSING_CREATE`.
 */
function enumerateAggregateIds(store: SqliteEventStore, projectId: string): readonly string[] {
  const prefix = graphRevisionAggregateId(projectId, "");
  const aggregateIds = new Set<string>();
  let cursor = 0n;
  for (;;) {
    const page = store.readEventsAfter(cursor, ENUMERATION_PAGE);
    for (const event of page.items) {
      if (event.aggregateId.startsWith(prefix) && event.eventType === "GraphRevisionCreated") aggregateIds.add(event.aggregateId);
    }
    if (!page.hasMore || page.nextCursor === null) {
      return [...aggregateIds];
    }
    cursor = page.nextCursor;
  }
}

/**
 * The stored payloads, decoded back into the shapes the core replay validates.
 * A payload that is not readable JSON is left as-is rather than dropped: the
 * replay's own `EVENT_INVALID`/`HISTORY_INVALID` codes are the right answer, and
 * silently filtering it here would hide a corrupt row behind a shorter history.
 */
function historyOf(store: SqliteEventStore, aggregateId: string): readonly unknown[] {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return store.readEvents(aggregateId).map((event) => {
    try {
      return JSON.parse(decoder.decode(event.payload)) as unknown;
    } catch {
      return null;
    }
  });
}

/**
 * Replay every aggregate. A refusal from ANY aggregate stops the whole read:
 * a project holding one unreadable revision cannot honestly answer "the current
 * graph", because the unreadable one might be the active one.
 */
function collectActive(
  store: SqliteEventStore,
  aggregateIds: readonly string[],
): { readonly active: readonly ActiveRevision[] } | { readonly refusal: ActiveGraphRefusal } {
  const active: ActiveRevision[] = [];
  for (const aggregateId of aggregateIds) {
    const replayed = replayGraphRevisionEvents(historyOf(store, aggregateId));
    if (!replayed.ok) {
      return { refusal: refuse(replayed.code, replayed.layer) };
    }
    if (replayed.state.lifecycle === "ACTIVE") {
      active.push({ aggregateId, state: replayed.state });
    }
  }
  return { active };
}

/**
 * Read the one ACTIVE graph for a project, or refuse with an exact code and the
 * layer that produced it. Never appends; every path is a read.
 */
export function readCurrentActiveGraph(
  store: SqliteEventStore,
  projectId: string,
): ActiveGraphResult {
  const collected = collectActive(store, enumerateAggregateIds(store, projectId));
  if ("refusal" in collected) {
    return collected.refusal;
  }
  if (collected.active.length === 0) {
    return refuse("ACTIVE_GRAPH_ABSENT");
  }
  if (collected.active.length > 1) {
    return refuse("ACTIVE_GRAPH_SPLIT_BRAIN");
  }
  const [current] = collected.active;
  if (current === undefined) {
    return refuse("ACTIVE_GRAPH_ABSENT");
  }
  const body = readGraphBody(store, projectId, current.state.graphContentHash);
  if (!body.ok) {
    return refuse("ACTIVE_GRAPH_BODY_UNAVAILABLE", GRAPH_BODY_RECORD_LAYER, body.code);
  }
  return Object.freeze({
    content: body.content,
    graphContentHash: current.state.graphContentHash,
    graphEpoch: current.state.graphEpoch,
    ok: true as const,
    planHash: current.state.planHash,
    provenance: Object.freeze({
      aggregateId: current.aggregateId,
      goalRef: current.state.goalRef,
    }),
    revisionId: current.state.revisionId,
    snapshot: body.content.snapshot,
    snapshotIdentity: body.snapshotIdentity,
  });
}
