/**
 * The refusal vocabulary of the graph-content codec: which layer answered, which
 * stable code it answered with, and the two shapes that build a refusal.
 *
 * Separate from `graph-content.ts` so the codec boundary, the field contract and
 * the reason vocabulary each stay inside the per-file line cap without any guard
 * being trimmed to fit. A structural graph failure never acquires a code from
 * here: {@link passthrough} carries the graph kernel's own {@link GraphIssueCode}
 * out unchanged and only adds the layer.
 */
import type { GraphIssue, GraphIssueCode, GraphKey } from "./graph-model.js";

/** Which layer refused. Closed and frozen. */
export const GRAPH_CONTENT_LAYERS = Object.freeze([
  "GRAPH_CONTENT_CODEC", "GRAPH_CONTENT_IDENTITY", "GRAPH_VALIDATION",
] as const);
export type GraphContentLayer = (typeof GRAPH_CONTENT_LAYERS)[number];

/**
 * Framing, field and identity codes owned by THIS codec. A structural graph
 * failure never appears here — it keeps its own {@link GraphIssueCode}.
 *
 * `GRAPH_CONTENT_FIELD_INVALID` covers a caller-stated content field that is
 * absent, out of bounds, or not a plain data property.
 * `GRAPH_CONTENT_COMPLETION_DRIFT` covers the one fact stated twice — the
 * author's declared completion node against the accepted graph's — disagreeing.
 */
export const GRAPH_CONTENT_ISSUE_CODES = Object.freeze([
  "GRAPH_CONTENT_COMPLETION_DRIFT", "GRAPH_CONTENT_DIGEST_MISMATCH",
  "GRAPH_CONTENT_FIELD_INVALID", "GRAPH_CONTENT_MALFORMED",
  "GRAPH_CONTENT_NONCANONICAL", "GRAPH_CONTENT_NOT_BYTES",
  "GRAPH_CONTENT_TOO_LARGE", "GRAPH_CONTENT_UNREADABLE",
  "GRAPH_CONTENT_UNSUPPORTED_SCHEMA",
] as const);
export type GraphContentIssueCode = (typeof GRAPH_CONTENT_ISSUE_CODES)[number];

export interface GraphContentIssue {
  readonly code: GraphContentIssueCode | GraphIssueCode;
  readonly layer: GraphContentLayer;
  readonly message: string;
  readonly nodeKeys: readonly GraphKey[];
  readonly edgeKeys: readonly GraphKey[];
}

/** The refusal half of a codec result; never carries content authority. */
export interface GraphContentRefusal {
  readonly ok: false;
  readonly issues: readonly GraphContentIssue[];
}

export function refuse(
  code: GraphContentIssueCode,
  layer: GraphContentLayer,
  message: string,
): GraphContentRefusal {
  return Object.freeze({
    ok: false as const,
    issues: Object.freeze([Object.freeze({
      code, layer, message,
      nodeKeys: Object.freeze([]), edgeKeys: Object.freeze([]),
    })]),
  });
}

/** Surface the validator's verdict unchanged; only the layer is added. */
export function passthrough(issues: readonly GraphIssue[]): GraphContentRefusal {
  return Object.freeze({
    ok: false as const,
    issues: Object.freeze(issues.map((issue) => Object.freeze({
      code: issue.code,
      layer: "GRAPH_VALIDATION" as const,
      message: issue.message,
      nodeKeys: issue.nodeKeys,
      edgeKeys: issue.edgeKeys,
    }))),
  });
}
