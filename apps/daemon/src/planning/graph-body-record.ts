/**
 * The durable body behind a graph revision's `graphContentHash`.
 *
 * A `GraphRevisionEvent` carries the HASH of a graph, never the graph. This
 * module holds the bytes that hash names, and it is deliberately the dumbest
 * possible custodian of them: it stores the canonical bytes `encodeGraphContent`
 * produced, verbatim, and hands them back only after `decodeGraphContent` has
 * accepted them again.
 *
 * WHAT THIS MODULE MUST NEVER DO, and why. `@moe/scheduler` publishes the codec
 * boundary while withholding the wire format and the per-field digest, stating
 * that `encodeGraphContent` is the ONLY route to a `graphContentHash`. A second
 * canonicalisation here — even a correct one — would be a second identity for the
 * same graph, and the day the two disagreed the durable record would be the one
 * that was wrong. So: no hashing, no canonicalisation, no re-serialisation. The
 * write side refuses anything that is not codec output; the read side re-runs the
 * decoder and treats ITS verdict as authority.
 *
 * REFUSAL SHAPE. `layer` always names THIS module, because this module is what
 * answered the caller. `sourceLayer` names the layer that actually refused when a
 * verdict is being passed through from the codec, and is `null` when the refusal
 * originated here. Keeping "who reported" and "who refused" in separate fields is
 * what lets a caller tell a corrupt body from a missing one without parsing
 * strings.
 */

import { decodeGraphContent } from "@moe/scheduler";
import type {
  GraphContent,
  GraphContentIssueCode,
  GraphContentLayer,
  GraphRevisionContent,
} from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

/** Names the layer that answered, matching how the core replay tags its own. */
export const GRAPH_BODY_RECORD_LAYER = "GRAPH_BODY_RECORD" as const;

/** The event type every durable body row carries. */
export const GRAPH_BODY_EVENT_TYPE = "GRAPH_BODY_RECORDED" as const;

/**
 * Refusals this module originates itself. Codes passed through from the codec
 * keep their own spelling and are NOT listed here — a reader can tell the two
 * apart by prefix, and merging the vocabularies would let a codec change
 * silently widen this module's contract.
 */
export const GRAPH_BODY_RECORD_CODES = Object.freeze([
  "GRAPH_BODY_ABSENT",
  "GRAPH_BODY_IDENTITY_MISMATCH",
  "GRAPH_BODY_NOT_ENCODED",
] as const);

export type GraphBodyRecordCode = (typeof GRAPH_BODY_RECORD_CODES)[number];

export interface GraphBodyRefusal {
  readonly code: GraphBodyRecordCode | GraphContentIssueCode;
  readonly layer: typeof GRAPH_BODY_RECORD_LAYER;
  readonly ok: false;
  /** The layer that actually refused, or `null` when this module did. */
  readonly sourceLayer: GraphContentLayer | null;
}

export interface GraphBodyPutAccepted {
  readonly graphContentHash: string;
  readonly ok: true;
}

export interface GraphBodyReadAccepted {
  readonly bytes: Uint8Array;
  readonly content: GraphRevisionContent;
  readonly graphContentHash: string;
  readonly ok: true;
  readonly snapshotIdentity: string;
}

export type GraphBodyPutResult = GraphBodyPutAccepted | GraphBodyRefusal;
export type GraphBodyReadResult = GraphBodyReadAccepted | GraphBodyRefusal;

const HEX64 = /^[0-9a-f]{64}$/u;

function refuse(
  code: GraphBodyRecordCode | GraphContentIssueCode,
  sourceLayer: GraphContentLayer | null,
): GraphBodyRefusal {
  return Object.freeze({
    code,
    layer: GRAPH_BODY_RECORD_LAYER,
    ok: false as const,
    sourceLayer,
  });
}

/**
 * One aggregate per (project, content hash). Content-addressed storage makes the
 * idempotence requirement structural rather than a check that could be forgotten:
 * the same bytes cannot land anywhere else.
 */
export function graphBodyAggregateId(projectId: string, graphContentHash: string): string {
  return `graph-body:${projectId}:${graphContentHash}`;
}

/**
 * A caller can hand us any object shaped like the codec's output. Only the codec
 * can produce bytes that decode back to their own declared hash, so that round
 * trip — not a structural check — is what actually distinguishes real codec
 * output from a hand-assembled lookalike.
 */
function isCodecOutput(candidate: GraphContent): boolean {
  if (typeof candidate.graphContentHash !== "string" || !HEX64.test(candidate.graphContentHash)) {
    return false;
  }
  if (!(candidate.bytes instanceof Uint8Array)) {
    return false;
  }
  const decoded = decodeGraphContent(candidate.bytes);
  return decoded.ok && decoded.value.graphContentHash === candidate.graphContentHash;
}

/**
 * Store the codec's canonical bytes under their own hash. Re-putting identical
 * content is a no-op rather than a second row: the body is immutable and
 * content-addressed, so a row already present is by definition the same bytes.
 */
export function putGraphBody(
  store: SqliteEventStore,
  projectId: string,
  content: GraphContent,
): GraphBodyPutResult {
  if (!isCodecOutput(content)) {
    return refuse("GRAPH_BODY_NOT_ENCODED", null);
  }
  const aggregateId = graphBodyAggregateId(projectId, content.graphContentHash);
  const existing = store.readEvents(aggregateId);
  if (existing.length > 0) {
    return Object.freeze({ graphContentHash: content.graphContentHash, ok: true as const });
  }
  store.commit({
    aggregateId,
    commandBytes: new TextEncoder().encode(`graph-body:${content.graphContentHash}`),
    commandId: `graph-body-${content.graphContentHash}`,
    committedAt: new Date(0).toISOString(),
    events: [
      {
        eventId: `graph-body-${content.graphContentHash}`,
        eventType: GRAPH_BODY_EVENT_TYPE,
        payload: content.bytes,
      },
    ],
    expectedVersion: 0,
  });
  return Object.freeze({ graphContentHash: content.graphContentHash, ok: true as const });
}

/**
 * Read a body and re-validate it through the decoder before returning anything.
 *
 * The identity check after a SUCCESSFUL decode is not redundant with the
 * decoder's own digest check: the decoder proves the bytes are self-consistent,
 * this proves they are the bytes that were ASKED FOR. Bytes filed under someone
 * else's key pass the first and fail the second.
 */
export function readGraphBody(
  store: SqliteEventStore,
  projectId: string,
  graphContentHash: string,
): GraphBodyReadResult {
  const events = store.readEvents(graphBodyAggregateId(projectId, graphContentHash));
  const row = events.find((event) => event.eventType === GRAPH_BODY_EVENT_TYPE);
  if (row === undefined) {
    return refuse("GRAPH_BODY_ABSENT", null);
  }
  const decoded = decodeGraphContent(row.payload);
  if (!decoded.ok) {
    const issue = decoded.issues[0];
    if (issue === undefined) {
      return refuse("GRAPH_BODY_IDENTITY_MISMATCH", null);
    }
    return refuse(issue.code as GraphContentIssueCode, issue.layer);
  }
  if (decoded.value.graphContentHash !== graphContentHash) {
    return refuse("GRAPH_BODY_IDENTITY_MISMATCH", null);
  }
  return Object.freeze({
    bytes: decoded.value.bytes,
    content: decoded.value.content,
    graphContentHash: decoded.value.graphContentHash,
    ok: true as const,
    snapshotIdentity: decoded.value.snapshotIdentity,
  });
}
